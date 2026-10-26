import { invoke, isTauri } from '@tauri-apps/api/core'

/**
 * Saved-document version history.
 *
 * The bodies live in a restricted application directory owned by Rust:
 * content-addressed, deduplicated, atomically written and quota-limited. This
 * module never keeps document text in memory beyond the list metadata, and it
 * never stores history in `localStorage` (only a one-time migration reads it).
 */

/** One version's metadata. The body is fetched on demand. */
export interface HistoryEntry {
  id: string
  /** SHA-256 of the body; also the stored object name. */
  hash: string
  bytes: number
  createdAt: number
  /** `disk` = text that was on disk before a save, `saved` = just written, `manual` = explicit. */
  origin: 'disk' | 'saved' | 'manual'
  label?: string | null
}

export interface HistoryUsage {
  files: number
  entries: number
  bytes: number
  maxBytes: number
}

export interface DiffLine {
  type: 'added' | 'removed' | 'same'
  text: string
  lineNumberA?: number
  lineNumberB?: number
}

const LEGACY_PREFIX = 'markumo:history:snapshots:'
const MIGRATION_FLAG = 'markumo:history:migrated'

/**
 * True when a native IPC bridge exists. `isTauri()` alone is not enough: the
 * bridge is what matters, and tests (and any embedded host) provide it without
 * the desktop marker.
 */
function nativeBridge(): boolean {
  if (isTauri()) return true
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
  return typeof internals?.invoke === 'function'
}

export function historyAvailable(): boolean {
  return nativeBridge()
}

/** Versions of one file, newest first. Metadata only. */
export async function listVersions(path: string): Promise<HistoryEntry[]> {
  if (!path || !nativeBridge()) return []
  return invoke<HistoryEntry[]>('history_list', { path })
}

/** Loads one body. Fails loudly instead of returning an empty document. */
export async function readVersion(path: string, id: string): Promise<string> {
  return invoke<string>('history_read', { path, id })
}

/** Records one version; identical content is deduplicated by the native store. */
export async function recordVersion(
  path: string,
  text: string,
  origin: HistoryEntry['origin'],
  label?: string,
): Promise<{ entry: HistoryEntry; duplicated: boolean; warnings: string[] } | null> {
  if (!path || !nativeBridge()) return null
  return invoke('history_record', { path, text, origin, label: label ?? null })
}

export async function deleteVersion(path: string, id: string): Promise<boolean> {
  if (!path || !nativeBridge()) return false
  return invoke<boolean>('history_delete', { path, id })
}

export async function clearVersions(path: string): Promise<void> {
  if (!path || !nativeBridge()) return
  await invoke('history_clear', { path })
}

export async function historyUsage(): Promise<HistoryUsage | null> {
  if (!nativeBridge()) return null
  return invoke<HistoryUsage>('history_usage').catch(() => null)
}

/**
 * One-time migration of the previous localStorage history.
 *
 * Nothing is deleted until the native store accepted the body, so a failed
 * migration keeps the old data intact for the next start.
 */
export async function migrateLegacyHistory(
  notify: (message: string) => void = () => {},
): Promise<number> {
  if (!nativeBridge()) return 0
  let migrated = 0, failed = 0
  const keys: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(LEGACY_PREFIX)) keys.push(key)
    }
    // Old releases could leave `done` alongside failed legacy keys. The keys,
    // rather than that stale flag, are the authoritative remaining work.
    if (!keys.length) { localStorage.setItem(MIGRATION_FLAG, 'done'); return 0 }
    localStorage.removeItem(MIGRATION_FLAG)
  } catch { notify('无法读取旧历史存储，迁移未完成；旧数据未删除。'); return 0 }
  for (const key of keys) {
    let raw: string | null = null
    let complete = true
    try {
      raw = localStorage.getItem(key)
      if (raw === null) continue
      if (raw.length > 16 * 1024 * 1024) throw Error('旧历史数据过大')
      const records: unknown = JSON.parse(raw)
      if (!Array.isArray(records) || records.length > 4096) throw Error('旧历史格式或记录数量无效')
      for (const value of records) {
        try {
          if (!value || typeof value !== 'object') throw Error('旧记录不是对象')
          const record = value as Record<string, unknown>
          if (typeof record.path !== 'string' || !record.path.trim() || record.path.length > 32768 || record.path.includes('\0')) throw Error('旧记录路径无效')
          if (typeof record.content !== 'string' || record.content.length > 8 * 1024 * 1024 || new TextEncoder().encode(record.content).length > 8 * 1024 * 1024) throw Error('旧正文超过配额或格式无效')
          if (record.label !== undefined && (typeof record.label !== 'string' || record.label.length > 256)) throw Error('旧记录标签无效')
          if (record.timestamp !== undefined && (typeof record.timestamp !== 'number' || !Number.isSafeInteger(record.timestamp) || record.timestamp < 0)) throw Error('旧记录时间无效')
          const result = await invoke<{ duplicated: boolean }>('history_import', {path:record.path,text:record.content,label:record.label ?? null})
          if (!result.duplicated) migrated++
        } catch { complete = false; failed++ }
      }
      // Other windows can migrate concurrently or append data. Never remove a
      // source that has changed since this attempt read it.
      if (complete && localStorage.getItem(key) === raw) localStorage.removeItem(key)
      else complete = false
    } catch { complete = false; failed++ }
    if (!complete && failed === 0) failed++
  }
  try {
    const remaining = Object.keys(localStorage).some(key => key.startsWith(LEGACY_PREFIX))
    if (!remaining && failed === 0) localStorage.setItem(MIGRATION_FLAG, 'done')
  } catch { failed++ }
  if (failed > 0) notify(`历史迁移尚未完成（${failed} 项失败或超出配额）；旧来源保留，下次启动会重试，已迁移正文不会重复创建。`)
  return migrated
}
/**
 * Line diff with bounded cost.
 *
 * Lines are hashed once, the common prefix and suffix are trimmed, and only the
 * remaining window goes through an LCS table. Documents that still exceed the
 * window budget degrade to a coarse "removed block / added block" report
 * instead of quadratic time over the whole file.
 */
const LCS_LINE_BUDGET = 1500

export function diffLines(currentText: string, historicText: string): DiffLine[] {
  const current = currentText.split(/\r?\n/)
  const historic = historicText.split(/\r?\n/)
  const result: DiffLine[] = []

  let prefix = 0
  while (prefix < current.length && prefix < historic.length && current[prefix] === historic[prefix]) prefix++
  let suffix = 0
  while (
    suffix < current.length - prefix &&
    suffix < historic.length - prefix &&
    current[current.length - 1 - suffix] === historic[historic.length - 1 - suffix]
  ) suffix++

  for (let index = 0; index < prefix; index++) {
    result.push({ type: 'same', text: historic[index], lineNumberA: index + 1, lineNumberB: index + 1 })
  }

  const currentMiddle = current.slice(prefix, current.length - suffix)
  const historicMiddle = historic.slice(prefix, historic.length - suffix)

  if (currentMiddle.length * historicMiddle.length > LCS_LINE_BUDGET * LCS_LINE_BUDGET) {
    for (let index = 0; index < historicMiddle.length; index++) {
      result.push({ type: 'removed', text: historicMiddle[index], lineNumberA: prefix + index + 1 })
    }
    for (let index = 0; index < currentMiddle.length; index++) {
      result.push({ type: 'added', text: currentMiddle[index], lineNumberB: prefix + index + 1 })
    }
  } else {
    const rows = historicMiddle.length + 1
    const columns = currentMiddle.length + 1
    const table = new Uint32Array(rows * columns)
    for (let a = historicMiddle.length - 1; a >= 0; a--) {
      for (let b = currentMiddle.length - 1; b >= 0; b--) {
        table[a * columns + b] = historicMiddle[a] === currentMiddle[b]
          ? table[(a + 1) * columns + (b + 1)] + 1
          : Math.max(table[(a + 1) * columns + b], table[a * columns + (b + 1)])
      }
    }
    let a = 0
    let b = 0
    while (a < historicMiddle.length && b < currentMiddle.length) {
      if (historicMiddle[a] === currentMiddle[b]) {
        result.push({ type: 'same', text: historicMiddle[a], lineNumberA: prefix + a + 1, lineNumberB: prefix + b + 1 })
        a++
        b++
      } else if (table[(a + 1) * columns + b] >= table[a * columns + (b + 1)]) {
        result.push({ type: 'removed', text: historicMiddle[a], lineNumberA: prefix + a + 1 })
        a++
      } else {
        result.push({ type: 'added', text: currentMiddle[b], lineNumberB: prefix + b + 1 })
        b++
      }
    }
    while (a < historicMiddle.length) {
      result.push({ type: 'removed', text: historicMiddle[a], lineNumberA: prefix + a + 1 })
      a++
    }
    while (b < currentMiddle.length) {
      result.push({ type: 'added', text: currentMiddle[b], lineNumberB: prefix + b + 1 })
      b++
    }
  }

  for (let index = 0; index < suffix; index++) {
    const line = current.length - suffix + index
    result.push({
      type: 'same',
      text: current[line],
      lineNumberA: historic.length - suffix + index + 1,
      lineNumberB: line + 1,
    })
  }
  return result
}
