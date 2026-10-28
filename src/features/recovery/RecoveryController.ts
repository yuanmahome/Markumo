import { ref } from 'vue'
import type { Text } from '@codemirror/state'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { FileController } from '../files/FileController'
import type { FileOpenEncoding } from '../files/contracts'
import { sameFilePath } from '../files/pathKey'
import { isMedia } from '../files/media'
import type { EditorDocument, MarkdownMode } from '../../types'
import type {
  RecoveryClaim,
  RecoveryClaimKind,
  RecoveryDiff,
  RecoveryGateway,
  RecoveryList,
  RecoveryMode,
  RecoveryPane,
  RecoverySaveInput,
  RecoverySummary,
} from './types'

const DEBOUNCE_MS = 2500
const RETRY_MS = 500
const MAX_TEXT_BYTES = 8 * 1024 * 1024

type Pending = { text: Text; due: number }

/**
 * Owns debounced, body-preserving snapshots. It observes immutable CM Text
 * identities; it never serializes on every keystroke and never writes the
 * original file. Recovery records are independent of last-session.json.
 *
 * A record is only associated with a document by an explicit act of this
 * session: writing a snapshot for a dirty document (`active`) or restoring a
 * record the user chose (`recovered`). A record loaded from disk stays
 * `unclaimed` even when its path matches an open document, so an ordinary save
 * can never delete a draft the user has not handled.
 */
export class RecoveryController {
  readonly records = ref<RecoverySummary[]>([])
  readonly warnings = ref<string[]>([])
  readonly visible = ref(false)
  readonly busy = ref(false)
  readonly lastError = ref<string | null>(null)
  readonly diff = ref<RecoveryDiff | null>(null)
  /** Canonical document id -> the one snapshot this session owns. Keying by
   * document (not pane or path) gives every pane a single recovery identity. */
  private readonly claims = new Map<string, RecoveryClaim>()
  // metadata() returns a fresh display projection on every read. Track the
  // document id instead, and prune it on close so a reused id gets a new token.
  private readonly generations = new Map<string, object>()
  private readonly pending = new Map<string, Pending>()
  private readonly failed = new Map<string, Text>()
  private readonly lastSaved = new Map<string, Text>()
  private readonly savedSummaries = new Map<string, RecoverySummary>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> = Promise.resolve()
  private unsubscribe: () => void
  private started = false
  private disposed = false
  private readonly debounceMs: number

  constructor(
    private readonly manager: DocumentManager,
    private readonly files: FileController,
    private readonly gateway: RecoveryGateway,
    private readonly notify: (message: string) => void,
    options: { debounceMs?: number } = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS
    this.unsubscribe = manager.subscribe(() => this.refresh())
  }

  async start() {
    if (this.started || this.disposed) return
    this.started = true
    this.refresh()
    try {
      await this.reload()
      if (this.records.value.length) this.visible.value = true
    } catch (error) {
      this.lastError.value = `无法检查恢复快照：${String(error)}`
      this.notify(this.lastError.value)
    }
  }

  async open() {
    await this.reload()
    this.visible.value = true
  }

  close() {
    this.visible.value = false
    this.diff.value = null
  }

  async reload() {
    if (this.disposed) return
    let result: RecoveryList
    try {
      result = await this.gateway.list()
    } catch (error) {
      this.lastError.value = `无法读取恢复目录：${String(error)}`
      throw error
    }
    this.warnings.value = result.warnings
    if (result.warnings.length) this.notify(result.warnings.join('\n'))
    // A claim survives only while its document is still open. Nothing is
    // inferred from a path here: an unclaimed draft that happens to share a
    // path with an open document stays visible and untouched until the user
    // restores or discards it.
    for (const documentId of [...this.claims.keys()]) {
      if (!this.manager.metadata(documentId)) this.claims.delete(documentId)
    }
    const claimed = this.claimedRecordIds()
    this.records.value = result.records.filter(record => !claimed.has(record.id))
  }

  /** Called only after the controller has been attached to the main window. */
  refresh() {
    if (!this.started || this.disposed) return
    const seen = new Set<string>()
    const now = Date.now()
    for (const doc of this.manager.openedDocuments) {
      seen.add(doc.id)
      if (!this.eligible(doc)) { this.pending.delete(doc.id); continue }
      const text = this.manager.getState(doc.id)?.doc
      if (!text || this.failed.get(doc.id) === text || this.lastSaved.get(doc.id) === text) { this.pending.delete(doc.id); continue }
      const current = this.pending.get(doc.id)
      if (!current || current.text !== text) this.pending.set(doc.id, { text, due: now + this.debounceMs })
    }
    for (const cache of [this.pending, this.failed, this.lastSaved, this.savedSummaries, this.generations]) {
      for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id)
    }
    this.schedule()
  }

  async flushForClose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const item of this.pending.values()) item.due = 0
    await this.flush()
  }

  /** A destructive reload must wait for this exact buffer to reach durable storage.
   * The retained snapshot is deliberately detached from subsequent normal saves:
   * after a successful checkpoint it becomes an unclaimed recovery draft, so a
   * later save of the reloaded document cannot delete the only copy of the
   * discarded buffer. */
  async checkpointBeforeReload(id: string): Promise<boolean> {
    const doc = this.manager.metadata(id), text = this.manager.getState(id)?.doc
    if (!doc) return false
    if (!doc?.dirty) return true
    if (!this.started || this.disposed || !text || !this.eligible(doc) || this.manager.isComposing) return false
    const generation = this.generation(id), token = doc.fileToken
    const valid = () => !this.disposed && this.generation(id) === generation &&
      this.manager.metadata(id)?.fileToken === token && this.manager.getState(id)?.doc === text && !this.manager.isComposing
    await this.flushing.catch(() => {})
    if (!valid()) return false
    this.failed.delete(id)
    this.lastSaved.delete(id)
    this.savedSummaries.delete(id)
    this.pending.set(id, { text, due: 0 })
    await this.flush()
    const snapshot = this.savedSummaries.get(id)
    if (!valid() || this.lastSaved.get(id) !== text || !snapshot || this.claims.get(id)?.recordId !== snapshot.id) return false
    // Detach only the association. The snapshot itself stays on disk and will
    // be listed as unclaimed if the reload discards this buffer.
    this.bumpGeneration(id)
    this.claims.delete(id)
    this.lastSaved.delete(id)
    this.savedSummaries.delete(id)
    this.pending.delete(id)
    this.records.value = [snapshot, ...this.records.value.filter(record => record.id !== snapshot.id)]
    return true
  }

  async onSaved(documentId: string) {
    if (this.disposed) return
    this.bumpGeneration(documentId)
    const doc = this.manager.metadata(documentId)
    if (doc?.dirty) {
      // Edits arrived while the file was being written: keep protecting them.
      const text = this.manager.getState(documentId)?.doc
      if (text) this.pending.set(documentId, { text, due: Date.now() + this.debounceMs })
      this.schedule()
      return
    }
    this.pending.delete(documentId)
    this.failed.delete(documentId)
    this.lastSaved.delete(documentId)
    this.savedSummaries.delete(documentId)
    // Only a snapshot this session explicitly associated with this document
    // may be removed. Unclaimed same-path drafts are not touched.
    await this.releaseClaim(documentId)
  }

  async discardDocument(documentId: string) {
    await this.flushing.catch(() => {})
    if (this.disposed) return
    this.bumpGeneration(documentId)
    this.pending.delete(documentId)
    this.failed.delete(documentId)
    this.lastSaved.delete(documentId)
    this.savedSummaries.delete(documentId)
    await this.releaseClaim(documentId)
  }

  async discardActive() {
    await this.flushing.catch(() => {})
    for (const id of new Set([...this.pending.keys(), ...this.claims.keys()])) this.bumpGeneration(id)
    this.pending.clear()
    this.failed.clear()
    this.lastSaved.clear()
    this.savedSummaries.clear()
    // "Discard everything" refers to this session's dirty documents. Recovery
    // drafts from earlier runs are still unclaimed user data and must survive.
    for (const documentId of [...this.claims.keys()]) await this.releaseClaim(documentId)
    this.records.value = this.records.value.filter(record => !this.claimedRecordIds().has(record.id))
    this.visible.value = false
    this.diff.value = null
  }
  async discardAll() {
    if (this.disposed || this.busy.value) return
    await this.discardRecords([...this.records.value])
    if (!this.records.value.length) this.close()
  }
  async discard(record: RecoverySummary) {
    await this.discardRecords([record])
  }

  /** Delete only the listed drafts the user confirmed, never this session's
   * active recovery claims or records that appeared after the confirmation. */
  private async discardRecords(records: RecoverySummary[]) {
    if (this.disposed || this.busy.value) return
    this.busy.value = true
    this.lastError.value = null
    try {
      await this.flushing.catch(() => {})
      if (this.disposed) return
      let failures = 0, claimed = 0, reason = ''
      for (const record of records) {
        if (this.disposed) break
        if (this.claimedRecordIds().has(record.id)) { claimed++; continue }
        if (!this.records.value.some(item => item.id === record.id)) continue
        try {
          await this.gateway.remove(record.id)
          this.records.value = this.records.value.filter(item => item.id !== record.id)
          if (this.diff.value?.id === record.id) this.diff.value = null
        } catch (error) { failures++; reason = String(error) }
      }
      if (failures || claimed) {
        this.lastError.value = [failures ? `${failures} 个恢复稿丢弃失败，已保留，可重试：${reason}` : '', claimed ? `${claimed} 个恢复稿已被当前文档使用，未删除；请先处理对应文档。` : ''].filter(Boolean).join('\n')
        this.notify(this.lastError.value)
      }
    } finally { this.busy.value = false }
  }

  async showDiff(record: RecoverySummary) {
    this.busy.value = true
    try {
      const body = await this.gateway.read(record.id)
      let diskText: string | null = null
      let diffSource: 'disk' | 'session' | 'none' = 'none'
      let error: string | undefined

      const current = record.path
        ? this.manager.openedDocuments.find(doc => doc.path && sameFilePath(doc.path, record.path!))
        : undefined

      if (current) {
        const baseline = this.manager.getBaselineText(current.id)
        if (current.dirty && baseline !== null) {
          diskText = baseline
          diffSource = 'disk'
        } else {
          diskText = this.manager.getText(current.id) ?? ''
          diffSource = current.dirty ? 'session' : 'disk'
        }
      } else if (record.path && record.diskExists) {
        try {
          const file = await this.files.gateway.openRecent(record.path, body.encoding as FileOpenEncoding)
          diskText = file.text
          diffSource = 'disk'
          if (file.token) {
            void this.files.gateway.release(file.token).catch(() => {})
          }
        } catch {
          diffSource = 'none'
          error = '原文件未在当前会话打开，仅展示恢复稿内容'
        }
      } else if (!record.path) {
        diffSource = 'none'
        diskText = null
      } else {
        diffSource = 'none'
        diskText = null
        error = '原文件在磁盘上不存在或已被删除'
      }

      this.diff.value = {
        id: record.id,
        name: record.name,
        path: record.path,
        recoveryText: body.text,
        diskText,
        error,
        diffSource,
      }
    } catch (error) {
      this.lastError.value = `读取恢复快照失败：${String(error)}`
      this.notify(this.lastError.value)
    } finally {
      this.busy.value = false
    }
  }

  clearDiff() { this.diff.value = null }

  async restore(record: RecoverySummary): Promise<boolean> {
    if (this.disposed || this.busy.value) return false
    if (this.manager.isComposing || (this.files.saving?.size ?? 0) || this.files.workspaceBusy === true) {
      this.lastError.value = '请先完成输入法输入、保存或工作区文件操作，再恢复文档'
      this.notify(this.lastError.value)
      return false
    }
    await this.flushing.catch(() => {})
    this.busy.value = true
    try {
      const active = [...this.claims.entries()].find(([, claim]) => claim.recordId === record.id)?.[0]
      if (active && this.manager.metadata(active)) return await this.persistRestored(active)
      const body = await this.gateway.read(record.id)
      let docId: string | null = null
      let opened: EditorDocument | undefined
      let isRestoredToOriginal = false

      if (body.path && record.diskExists) {
        opened = this.manager.openedDocuments.find(doc => doc.path && sameFilePath(doc.path, body.path!))
        if (!opened) {
          try {
            await this.files.recent(body.path, body.encoding as FileOpenEncoding)
            opened = this.manager.openedDocuments.find(doc => doc.path && sameFilePath(doc.path, body.path!))
          } catch {
            opened = undefined
          }
        }
      }

      if (this.disposed || this.manager.isComposing || (this.files.saving?.size ?? 0) || this.files.workspaceBusy) {
        throw Error('恢复期间文件操作状态已变化，请重试')
      }

      const reusable = !!(opened && !opened.dirty && !this.claims.has(opened.id) &&
        body.diskVersion !== null && body.diskVersion === opened.lastDiskVersion &&
        opened.kind !== 'javaClass' && opened.encoding !== 'Hex' && !isMedia(opened))

      if (reusable && this.manager.restoreRecoveredText(opened!.id, body.text, (body.mode || undefined) as MarkdownMode | undefined)) {
        docId = opened!.id
        isRestoredToOriginal = true
      } else {
        docId = this.createDraft(body)
        isRestoredToOriginal = false
      }

      if (!docId) throw Error('无法创建恢复文档')
      this.applyPlacements(docId, body.panes.length ? body.panes : [{ pane: 'main', mode: body.mode || undefined }])

      if (this.manager.metadata(docId)) {
        const owned = [...this.claims.entries()].some(([documentId, claim]) => documentId !== docId && claim.recordId === body.id)
        if (!owned) this.claims.set(docId, { recordId: body.id, kind: 'recovered', version: body.version })
        const persisted = await this.persistRestored(docId)
        if (!persisted) return false
      }

      if (isRestoredToOriginal) {
        this.notify('已恢复未保存修改，可保存至原文件 (Ctrl+S)')
      } else {
        this.notify('已打开恢复副本，请选择保存位置 (Ctrl+S 另存为)')
      }

      this.visible.value = false

      return true
    } catch (error) {
      this.lastError.value = `恢复文档失败：${String(error)}`
      this.notify(this.lastError.value)
      return false
    } finally {
      this.busy.value = false
    }
  }

  private async persistRestored(documentId: string): Promise<boolean> {
    const text = this.manager.getState(documentId)?.doc
    if (!text || !this.manager.metadata(documentId)?.dirty || this.manager.isComposing) return false
    this.failed.delete(documentId); this.lastSaved.delete(documentId); this.savedSummaries.delete(documentId)
    this.pending.set(documentId, { text, due: 0 })
    await this.flush()
    if (this.lastSaved.get(documentId) !== text || this.manager.getState(documentId)?.doc !== text) {
      this.lastError.value = `恢复内容已保留，但恢复快照更新未成功：${this.lastError.value || '内容或操作状态已变化'}`
      return false
    }
    const recordId = this.claims.get(documentId)?.recordId
    this.records.value = this.records.value.filter(record => record.id !== recordId)
    this.diff.value = null
    return true
  }

  async restoreAll() {
    let failures = 0
    const records = [...this.records.value]
    for (const record of records) {
      if (!(await this.restore(record))) failures++
    }
    this.visible.value = false
    if (failures) this.notify(`${failures} 个恢复文档未能打开；原恢复快照仍保留，可重试。`)
    else if (records.length) this.notify(`已全部打开 ${records.length} 个恢复文档，请核对后保存`)
  }

  dispose() {
    this.disposed = true
    this.unsubscribe()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.failed.clear()
    this.lastSaved.clear()
    this.claims.clear()
    this.savedSummaries.clear()
    this.generations.clear()
  }

  private eligible(doc: EditorDocument): boolean {
    return !!doc.dirty && doc.kind !== 'javaClass' && doc.encoding !== 'Hex' && !isMedia(doc)
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || !this.pending.size) return
    let due = Infinity
    for (const item of this.pending.values()) due = Math.min(due, item.due)
    this.timer = setTimeout(() => { void this.flush() }, Math.max(0, due - Date.now()))
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.performFlush())
    return this.flushing
  }

  private async performFlush() {
    if (this.disposed || !this.pending.size) return
    if (this.manager.isComposing) {
      this.timer = setTimeout(() => { void this.flush() }, RETRY_MS)
      return
    }
    const items = [...this.pending]
    for (const [documentId, item] of items) {
      if (this.disposed) break
      const doc = this.manager.metadata(documentId)
      if (!doc || !this.eligible(doc)) { this.pending.delete(documentId); continue }
      if (item.due > Date.now()) continue
      const current = this.manager.getState(documentId)?.doc
      if (!current) { this.pending.delete(documentId); continue }
      const panes = this.panesFor(documentId)
      const claim = this.claims.get(documentId)
      const input: RecoverySaveInput = {
        id: claim?.recordId || null,
        name: doc.name,
        path: doc.path || null,
        text: item.text.toString(),
        encoding: allowedEncoding(doc.encoding),
        bom: doc.bom,
        eol: doc.eol,
        mode: (doc.mode || null) as RecoveryMode | null,
        panes,
        diskVersion: doc.lastDiskVersion,
        expectedVersion: claim?.version ?? null,
      }
      if (new TextEncoder().encode(input.text).length > MAX_TEXT_BYTES) {
        this.failed.set(documentId, item.text)
        this.pending.delete(documentId)
        this.lastError.value = `恢复快照超过 ${MAX_TEXT_BYTES / (1024 * 1024)} MiB；当前文档未获得崩溃恢复保护`
        this.notify(this.lastError.value)
        continue
      }
      const generation = this.generation(documentId)
      try {
        const result = await this.gateway.save(input)
        if (generation !== this.generation(documentId)) {
          // A save/discard completed while this write was in flight.
          if (!this.manager.metadata(documentId)?.dirty) await this.removeSnapshot(result.record.id)
          continue
        }
        const kind: RecoveryClaimKind = claim?.kind === 'recovered' ? 'recovered' : 'active'
        this.claims.set(documentId, { recordId: result.record.id, kind, version: result.version })
        this.failed.delete(documentId)
        this.lastError.value = null
        if (result.warnings.length) this.notify(result.warnings.join('\n'))
        const latest = this.manager.getState(documentId)?.doc
        if (!latest || latest !== item.text) {
          if (latest) this.pending.set(documentId, { text: latest, due: Date.now() + this.debounceMs })
        } else {
          this.lastSaved.set(documentId, item.text)
          this.savedSummaries.set(documentId, result.record)
          this.pending.delete(documentId)
        }
      } catch (error) {
        if (generation !== this.generation(documentId)) continue
        this.failed.set(documentId, item.text)
        const latest = this.manager.getState(documentId)?.doc
        if (latest && latest !== item.text) this.pending.set(documentId, { text: latest, due: Date.now() + this.debounceMs })
        else this.pending.delete(documentId)
        this.lastError.value = `恢复快照未保存：${String(error)}`
        this.notify(this.lastError.value)
      }
    }
    this.schedule()
  }

  private panesFor(documentId: string): RecoveryPane[] {
    const panes: RecoveryPane[] = []
    for (const pane of this.manager.layout.getAllPanes()) {
      if (!pane.group.tabs.some(tab => tab.documentId === documentId)) continue
      panes.push({ pane: pane.id, mode: (this.manager.getMarkdownMode(documentId, pane.id) || null) as RecoveryMode | null })
    }
    return panes.length ? panes : [{ pane: 'main', mode: null }]
  }

  private createDraft(body: { id: string; name: string; text: string; encoding: string; bom?: boolean; eol?: 'LF' | 'CRLF' | 'CR' | 'Mixed'; mode?: RecoveryMode | null }): string | null {
    let id = `recovered-${body.id}`
    if (this.manager.metadata(id)) id = `${id}-${Date.now()}`
    return this.manager.createRecoveredDocument({ id, name: body.name, text: body.text, encoding: body.encoding, bom: body.bom, eol: body.eol, mode: (body.mode || undefined) as MarkdownMode | undefined })
  }

  private applyPlacements(documentId: string, panes: RecoveryPane[]) {
    const leaves = this.manager.layout.getAllLeafIds()
    const primary = leaves[0] || 'main'
    this.manager.open(documentId, false, primary, true)
    const extra = panes.find(pane => pane.pane !== 'main')
    if (extra) {
      let target = leaves.find(id => id !== primary)
      if (!target) target = this.manager.splitPane('right', primary, documentId)
      if (target) {
        this.manager.open(documentId, false, target, false)
        if (extra.mode) this.manager.setMarkdownMode(documentId, extra.mode, target)
      }
    }
    for (const placement of panes) {
      if (!placement.mode) continue
      if (this.manager.layout.getPane(placement.pane)) this.manager.setMarkdownMode(documentId, placement.mode, placement.pane)
    }
    this.manager.pin(documentId)
    this.manager.focusPane(primary, true)
  }

  private generation(documentId: string) {
    if (this.disposed || !this.manager.metadata(documentId)) return undefined
    let token = this.generations.get(documentId)
    if (!token) { token = {}; this.generations.set(documentId, token) }
    return token
  }

  private bumpGeneration(documentId: string) {
    if (!this.disposed && this.manager.metadata(documentId)) this.generations.set(documentId, {})
  }

  private claimedRecordIds() {
    return new Set([...this.claims.values()].map(claim => claim.recordId))
  }

  /** Remove only the exact record this document owns, and only after the
   * snapshot backend confirms deletion. A failure leaves the record on disk
   * (not falsely reported as deleted); a later reload lists it again so the
   * user can retry. */
  private async releaseClaim(documentId: string): Promise<boolean> {
    const claim = this.claims.get(documentId)
    if (!claim) return true
    const removed = await this.removeSnapshot(claim.recordId)
    if (this.claims.get(documentId) === claim) this.claims.delete(documentId)
    return removed
  }

  private async removeSnapshot(id: string): Promise<boolean> {
    try {
      await this.gateway.remove(id)
      this.records.value = this.records.value.filter(record => record.id !== id)
      return true
    } catch (error) {
      this.lastError.value = `清理恢复快照失败：${String(error)}`
      this.notify(this.lastError.value)
      return false
    }
  }
}

function allowedEncoding(encoding: string) {
  return ['UTF-8', 'UTF-16LE', 'UTF-16BE', 'GB18030', 'windows-1252'].includes(encoding) ? encoding : 'UTF-8'
}
