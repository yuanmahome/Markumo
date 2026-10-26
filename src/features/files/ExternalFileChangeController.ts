import { ref, shallowRef } from 'vue'
import type { Text } from '@codemirror/state'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { FileController } from './FileController'
import type { ExternalFileHint, OpenFile, WatchStatus } from './contracts'

export type ExternalPhase = 'normal' | 'checking' | 'changed-clean' | 'conflict' | 'deleted' | 'unavailable' | 'resolving'
export interface ExternalState {
  id: string; token: string; path: string; knownVersion: string | null; detectedVersion: string | null
  localRevision: number; saveRevision: number; checkedAt: number; phase: ExternalPhase; operation: 'check' | 'reload' | 'compare' | 'confirm' | null
  conflictValid: boolean; hidden: boolean; error?: string
}
interface Binding { state: ExternalState; text?: Text; sequence: number; cancelCheck?: () => void; autoReloadRevision?: number }
export interface ReloadIntent { id: string; token: string; version: string; revision: number; dirty: boolean }
export interface ExternalDiff { id: string; name: string; disk: string; local: string; diskVersion: string; revision: number; capturedAt: number; encoding: string; bom: boolean; eol: string; diskFormat: string }
const errorCode = (e: unknown) => e && typeof e === 'object' && 'code' in e ? String(e.code) : 'io'
const message = (e: unknown) => e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)
// Versions retain the backend's timestamp for conditional writes. Only comparison
// of content hashes may classify a metadata-only notification as harmless.
const contentVersion = (v: string | null) => v?.split(':').slice(0, 2).join(':')
export const DIFF_MAX_CHARS = 256 * 1024
export const DIFF_MAX_LINES = 20000
export function diffWithinBudget(a: string, b: string) {
  return a.length + b.length <= DIFF_MAX_CHARS && a.split('\n').length + b.split('\n').length <= DIFF_MAX_LINES
}

/** One authority per canonical DocumentManager id, independent of pane and toast lifetimes. */
export class ExternalFileChangeController {
  readonly revision = ref(0)
  readonly monitoringError = ref<string | null>(null)
  readonly watchStatus = shallowRef<WatchStatus | null>(null)
  readonly diff = shallowRef<ExternalDiff | null>(null)
  readonly confirmation = shallowRef<ReloadIntent | null>(null)
  private bindings = new Map<string, Binding>()
  private listeners = new Set<() => void>()
  private queued = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private disposed = false
  private enabled = false
  private autoReload = true
  private started = false
  private generation = 0
  private signature = ''
  private lease = 0
  private watchWrites = Promise.resolve()
  private unlisten?: () => void
  private unfocus?: () => void
  private listenerFailed = false
  private stop: () => void
  private lastFocus = -Infinity
  private beforeReload?: (id: string) => Promise<boolean>
  constructor(private manager: DocumentManager, private files: FileController, private notify: (s: string) => void) {
    this.stop = manager.subscribe(() => this.reconcile())
    this.reconcile()
  }
  setRecoveryCheckpoint(checkpoint?: (id: string) => Promise<boolean>) { this.beforeReload = checkpoint }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish() { this.revision.value++; for (const listener of this.listeners) listener() }
  state(id: string) { this.revision.value; return this.bindings.get(id)?.state }
  // Observation and I/O errors are not evidence of a disk conflict. Native
  // conditional writes remain the authority when monitoring is inconclusive.
  blocked(id: string) { const s = this.state(id); return !!s && (s.conflictValid || s.phase === 'resolving') }
  checking(id: string) { return this.state(id)?.operation === 'check' }
  resolving(id: string) { return this.state(id)?.phase === 'resolving' }
  get resolvingCount() { this.revision.value; return [...this.bindings.values()].filter(b => b.state.phase === 'resolving').length }
  configure(enabled: boolean, autoReload = true) {
    const changed = enabled !== this.enabled
    this.enabled = enabled; this.autoReload = autoReload
    if (!autoReload) for (const b of this.bindings.values()) b.autoReloadRevision = undefined
    if (!enabled) this.monitoringError.value = null
    else if (this.listenerFailed) this.monitoringError.value = '实时事件订阅不可用，将在窗口获得焦点时检查。'
    if (changed) { this.signature = ''; this.reconcile(); if (enabled && this.started) this.checkAll() }
  }
  async start() {
    if (this.started || this.disposed) return
    this.started = true
    try {
      this.lease = await this.files.gateway.beginExternalWatch?.() ?? 0
      if (this.disposed) { await this.files.gateway.endExternalWatch?.(this.lease); return }
      this.unlisten = await this.files.gateway.listenExternal?.(hint => this.hint(hint))
      if (this.disposed) { this.unlisten?.(); this.unlisten = undefined; return }
    } catch (e) { this.listenerFailed = true; if (this.enabled) this.monitoringError.value = `实时监测未启动，将在窗口获得焦点时检查：${message(e)}` }
    window.addEventListener('focus', this.onFocus)
    try {
      const release = await this.files.gateway.listenFocus?.(this.onFocus)
      if (this.disposed) { release?.(); return }
      this.unfocus = release
    } catch { /* DOM focus remains available on older hosts. */ }
    this.signature = ''; this.reconcile()
    await this.watchWrites
    if (this.enabled) this.checkAll()
  }
  private onFocus = () => { this.focus() }
  focus(now = Date.now()) {
    if (!this.enabled || this.disposed || now - this.lastFocus < 5000) return
    this.lastFocus = now; this.checkAll()
  }
  private reconcile() {
    if (this.disposed) return
    const ids = new Set<string>()
    let changed = false
    for (const doc of this.manager.openedDocuments) {
      if (!doc.fileToken) continue
      ids.add(doc.id)
      let binding = this.bindings.get(doc.id)
      const text = this.manager.getState(doc.id)?.doc
      if (!binding || binding.state.token !== doc.fileToken || binding.state.path !== doc.path) {
        const previous = binding?.state.token === doc.fileToken ? binding.state : undefined
        if (binding) this.invalidateCheck(binding)
        if (this.diff.value?.id === doc.id) this.diff.value = null
        if (this.confirmation.value?.id === doc.id) this.confirmation.value = null
        binding = { state: { id: doc.id, token: doc.fileToken, path: doc.path, knownVersion: doc.lastDiskVersion, detectedVersion: null, localRevision: 0, saveRevision: 0, checkedAt: 0, phase: 'normal', operation: null, conflictValid: false, hidden: false }, text, sequence: 0 }
        if (previous?.conflictValid) Object.assign(binding.state, { phase: doc.dirty ? 'conflict' : 'changed-clean', conflictValid: true, hidden: previous.hidden })
        this.bindings.set(doc.id, binding); changed = true
        if (this.enabled && this.started) this.queue(doc.id)
      } else {
        if (binding.text !== text) { binding.text = text; binding.state.localRevision++; binding.autoReloadRevision = undefined; changed = true }
        if (binding.state.knownVersion !== doc.lastDiskVersion) {
          // A save, reload or metadata acknowledgement has established a newer
          // baseline. Results captured against the old baseline cannot apply.
          this.invalidateCheck(binding); changed = true
        }
        binding.state.knownVersion = doc.lastDiskVersion
        if (binding.state.phase === 'changed-clean' && doc.dirty) { binding.state.phase = 'conflict'; binding.state.conflictValid = true; changed = true }
      }
    }
    for (const id of this.bindings.keys()) if (!ids.has(id)) {
      this.invalidateCheck(this.bindings.get(id)!)
      this.bindings.delete(id); this.queued.delete(id); changed = true
      if (this.diff.value?.id === id) this.diff.value = null
      if (this.confirmation.value?.id === id) this.confirmation.value = null
    }
    const tokens = [...this.bindings.values()].map(b => b.state.token).sort()
    const signature = JSON.stringify([this.enabled, tokens, [...this.bindings.values()].map(b=>b.state.path)])
    if (this.started && this.signature !== signature) {
      this.signature = signature
      const generation = ++this.generation
      this.watchWrites = this.watchWrites.then(async () => {
        if (this.disposed || generation !== this.generation) return
        try {
          if (this.files.gateway.watchExternal) this.watchStatus.value = await this.files.gateway.watchExternal(this.enabled ? tokens : [], generation, this.lease)
          if (generation === this.generation && (!this.listenerFailed || !this.enabled)) this.monitoringError.value = null
        } catch (e) { if (generation === this.generation && this.enabled) this.monitoringError.value = message(e) }
      })
    }
    if (changed) this.publish()
    // Composition/lifecycle notifications also wake parked work when no text
    // changed. Waiting for a new filesystem event can otherwise strand it.
    this.schedule()
  }
  hint(hint: ExternalFileHint) {
    if (this.disposed || !this.enabled || hint.generation !== this.generation) return
    if (hint.error) this.monitoringError.value = hint.error
    const tokens = new Set(hint.tokens)
    for (const [id,b] of this.bindings) if (tokens.has(b.state.token)) this.queue(id)
  }
  checkAll() { for (const id of this.bindings.keys()) this.queue(id) }
  private queue(id: string) {
    if (this.disposed || !this.bindings.has(id)) return
    this.queued.add(id)
    this.schedule()
  }
  private schedule() {
    // Active operations wake the queue on completion. Do not poll unresolved
    // Promises or confirmation dialogs, even under a watcher hint storm.
    const ready = [...this.queued].some(id => !this.bindings.get(id)?.state.operation && !this.busy(id))
    if (!this.disposed && ready && !this.timer && !this.running) this.timer = setTimeout(() => { this.timer = undefined; void this.drain() }, 180)
  }
  private async drain() {
    this.running = true
    try { for (const id of [...this.queued]) {
      if (this.bindings.get(id)?.state.operation || this.busy(id)) continue
      this.queued.delete(id); await this.check(id)
    } }
    finally { this.running = false; this.schedule() }
  }
  private current(id: string, binding: Binding, sequence: number) {
    return !this.disposed && this.bindings.get(id) === binding && binding.sequence === sequence && this.manager.metadata(id)?.fileToken === binding.state.token
  }
  private busy(id: string) { return this.files.saving.has(id) || this.files.workspaceBusy || this.manager.isComposing }
  private async stableVersion(token: string) {
    const check = this.files.gateway.checkExternal
    if (!check) throw Error('当前文件服务不支持外部检查。')
    let previous: string | null = null, lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const next = await check(token)
        if (previous === next) return next
        previous = next; lastError = { code: 'busy', message: '文件仍在被写入，请稍后刷新。' }
      } catch (e) { previous = null; lastError = e }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 120))
    }
    throw lastError
  }
  async check(id: string) {
    const b = this.bindings.get(id)
    if (!b || this.disposed) return
    // A hint delivered during a read requests one follow-up read, not another
    // concurrent check, and is not lost when the current operation finishes.
    if (b.state.operation) { this.queue(id); return }
    if (this.busy(id)) { this.queue(id); return }
    const sequence = ++b.sequence, revision = b.state.localRevision, previous = b.state.phase, hadConflict = b.state.conflictValid
    if (!b.state.conflictValid) b.state.phase = 'checking'
    const cancelled = new Promise<null>(resolve => { b.cancelCheck = () => resolve(null) })
    b.state.operation = 'check'; this.publish()
    try {
      // read_disk already verifies the handle, size and modification metadata
      // around its SHA-256 read. Polling twice hashes every unchanged file twice.
      if (!this.current(id,b,sequence)) return
      if (!this.files.gateway.checkExternal) throw Error('当前文件服务不支持外部检查。')
      const version = await Promise.race([this.files.gateway.checkExternal(b.state.token), cancelled])
      if (version === null) return
      if (!this.current(id,b,sequence)) return
      b.state.checkedAt = Date.now(); b.state.detectedVersion = version; b.state.error = undefined
      const doc = this.manager.metadata(id)!
      if (version === doc.lastDiskVersion && !b.state.conflictValid) { b.state.phase = 'normal'; return }
      if (contentVersion(version) === contentVersion(doc.lastDiskVersion) && !b.state.conflictValid && doc.kind !== 'image' && doc.kind !== 'pdf') {
        this.manager.acknowledgeDiskMetadata(id, b.state.token, doc.lastDiskVersion, version)
        b.state.knownVersion = version; b.state.phase = 'normal'; return
      }
      b.state.conflictValid = true
      b.state.phase = doc.dirty ? 'conflict' : 'changed-clean'
      if (this.autoReload && (!hadConflict || b.autoReloadRevision === revision) && !doc.dirty && revision === b.state.localRevision && !b.state.hidden) {
        // This permission belongs only to an untouched clean buffer. A genuine
        // dirty conflict, delete, edit/undo or explicit keep never gets it.
        b.autoReloadRevision = revision
        if (this.busy(id)) { this.queue(id); return }
        const file = await Promise.race([this.read(id, version), cancelled])
        if (file === null) return
        if (!this.current(id,b,sequence)) return
        if (revision !== b.state.localRevision || this.manager.metadata(id)?.dirty) { b.autoReloadRevision = undefined; b.state.phase = this.restingPhase(b); return }
        if (!this.autoReload || b.state.hidden) { b.autoReloadRevision = undefined; return }
        if (this.busy(id)) { b.state.phase = 'changed-clean'; this.queue(id); return }
        if (this.manager.reloadFile(id, file)) { this.resolved(b, file); this.publish() }
      }
    } catch (e) {
      if (this.current(id,b,sequence)) this.failed(b, e)
    } finally {
      if (this.current(id,b,sequence)) {
        if (b.state.phase === 'checking') b.state.phase = previous
        b.cancelCheck = undefined; b.state.operation = null; this.publish(); this.schedule()
      }
    }
  }
  private async read(id: string, version: string): Promise<OpenFile> {
    const doc = this.manager.metadata(id)!
    if (!this.files.gateway.readExternal) return Promise.reject(Error('当前文件服务不支持安全重载。'))
    const token = doc.fileToken!
    const file = await this.files.gateway.readExternal(token, version, doc.kind === 'javaClass' ? 'ClassInfo' : doc.kind === 'image' || doc.kind === 'pdf' ? 'Media' : doc.encoding)
    // The file can change after the native read validates it but before its
    // IPC result reaches this operation. Reject that stale result as well.
    if (file.version !== version || await this.files.gateway.checkExternal!(token) !== version) {
      throw { code: 'conflict', message: '读取期间磁盘版本再次变化，旧操作已失效，请重新加载并确认。' }
    }
    return file
  }
  private resolved(b: Binding, file: OpenFile) {
    b.autoReloadRevision = undefined
    b.state.phase = 'normal'; b.state.conflictValid = false; b.state.hidden = false; b.state.error = undefined
    b.state.knownVersion = file.version; b.state.detectedVersion = file.version
  }
  private restingPhase(b: Binding): ExternalPhase {
    return b.state.conflictValid ? (this.manager.metadata(b.state.id)?.dirty ? 'conflict' : 'changed-clean') : 'normal'
  }
  private invalidateCheck(b: Binding) {
    if (b.state.operation !== 'check') return
    b.cancelCheck?.(); b.cancelCheck = undefined
    b.sequence++
    b.state.operation = null
    if (b.state.phase === 'checking') b.state.phase = this.restingPhase(b)
  }
  /** Fence checks before entering native save, and bind failures to this exact
   * capability lifetime (closing/reopening may reuse a document id). */
  saveStarted(id: string) {
    const b = this.bindings.get(id)
    if (b) { this.invalidateCheck(b); this.publish() }
    return (error: unknown) => { if (b && this.bindings.get(id) === b && !this.disposed) this.saveFailed(id, error) }
  }
  saved(id: string) {
    this.reconcile()
    const b = this.bindings.get(id), doc = this.manager.metadata(id)
    if (b && doc) {
      this.invalidateCheck(b)
      b.sequence++
      b.state.operation = null
      b.autoReloadRevision = undefined
      b.state.phase = 'normal'; b.state.conflictValid = false; b.state.hidden = false; b.state.error = undefined
      b.state.knownVersion = doc.lastDiskVersion; b.state.detectedVersion = doc.lastDiskVersion
      b.state.saveRevision++
      if (this.diff.value?.id === id) this.diff.value = null
      this.publish()
    }
    // Do not suppress own-write hints: another process could write immediately
    // afterwards. One coalesced check against the new baseline catches that.
    if (this.enabled) this.queue(id)
  }
  saveFinished() { this.schedule() }
  resumeChecks() { this.schedule() }
  private failed(b: Binding, e: unknown, saving = false) {
    const code = errorCode(e)
    if (code === 'deleted' || (saving && code === 'conflict')) {
      b.autoReloadRevision = undefined
      b.state.conflictValid = true; b.state.hidden = false
      b.state.phase = code === 'deleted' ? 'deleted' : 'conflict'
    } else {
      // A read racing an active writer can itself return `conflict`; it has
      // not established a version different from our baseline. Keep any prior
      // confirmed conflict, but never promote an uncertain read into one.
      b.state.phase = 'unavailable'
    }
    b.state.error = message(e)
  }
  saveFailed(id: string, e: unknown) {
    const b = this.bindings.get(id)
    if (!b) return
    this.invalidateCheck(b); this.failed(b, e, true)
    this.publish()
    if (this.enabled) this.queue(id)
  }
  keep(id: string, hidden = true) { const b = this.bindings.get(id), s = b?.state; if (b && s && (!s.operation || !hidden)) { b.autoReloadRevision = undefined; s.hidden = hidden; this.publish() } }
  async compare(id: string) {
    const b = this.bindings.get(id), doc = this.manager.metadata(id)
    if (!b || !doc || b.state.operation || doc.kind === 'javaClass' || doc.kind === 'image' || doc.kind === 'pdf' || doc.encoding === 'Hex' || b.state.phase === 'deleted') return
    b.autoReloadRevision = undefined
    const sequence = ++b.sequence
    b.state.operation = 'compare'; this.publish()
    try {
      const version = await this.stableVersion(b.state.token)
      if (!this.current(id,b,sequence)) return
      const disk = await this.read(id, version)
      if (!this.current(id,b,sequence)) return
      const local = this.manager.saveSnapshot(id)?.text
      if (local === undefined || (disk.kind && disk.kind !== 'text')) throw Error('请先完成输入法输入，再比较文本。')
      b.state.detectedVersion = version
      this.diff.value = { id, name: doc.name, disk: disk.text, local, diskVersion: version, revision: b.state.localRevision, capturedAt: Date.now(), encoding: doc.encoding, bom: doc.bom, eol: doc.eol, diskFormat: `${disk.encoding}${disk.bom ? ' BOM' : ''} · ${disk.eol}` }
    } catch (e) { if (this.current(id,b,sequence)) { b.state.error = message(e); this.notify(message(e)) } }
    finally { if (this.current(id,b,sequence)) { b.state.operation = null; this.publish(); if (this.enabled) this.queue(id) } }
  }
  diffStale() {
    this.revision.value
    const d = this.diff.value, s = d && this.state(d.id)
    return !!d && (!s || s.detectedVersion !== d.diskVersion || s.localRevision !== d.revision || s.phase === 'deleted' || s.phase === 'unavailable')
  }
  async requestReload(id: string) {
    const b = this.bindings.get(id)
    if (!b || b.state.operation || this.busy(id)) { this.notify('请先完成输入法输入、保存或当前文件操作。'); return }
    b.autoReloadRevision = undefined
    const sequence = ++b.sequence, revision = b.state.localRevision
    b.state.phase = 'resolving'; b.state.operation = 'reload'; this.publish()
    try {
      const version = await this.stableVersion(b.state.token)
      if (!this.current(id,b,sequence)) return
      if (contentVersion(version) !== contentVersion(this.manager.metadata(id)?.lastDiskVersion ?? null)) b.state.conflictValid = true
      b.state.detectedVersion = version
      if (revision !== b.state.localRevision || this.busy(id)) throw Error('内容已变化，请重新选择加载磁盘。')
      this.confirmation.value = { id, token: b.state.token, version, revision, dirty: !!this.manager.metadata(id)?.dirty }
      b.state.operation = 'confirm'
    } catch (e) { if (this.current(id,b,sequence)) { this.failed(b,e); b.state.operation = null; this.notify(message(e)) } }
    finally { this.publish(); this.schedule() }
  }
  cancelReload() {
    const intent = this.confirmation.value; this.confirmation.value = null
    const b = intent && this.bindings.get(intent.id)
    if (b) { b.state.operation = null; b.state.phase = this.restingPhase(b); this.publish(); this.schedule() }
  }
  async confirmReload() {
    const intent = this.confirmation.value, b = intent && this.bindings.get(intent.id)
    if (!intent || !b || b.state.operation !== 'confirm') return false
    this.confirmation.value = null
    const sequence = ++b.sequence
    b.state.operation = 'reload'; this.publish()
    const valid = () => this.current(intent.id,b,sequence) && b.state.token === intent.token && b.state.localRevision === intent.revision && !this.busy(intent.id)
    try {
      if (!valid()) throw Error('编辑内容已变化，请重新加载并确认。')
      const version = await this.files.gateway.checkExternal!(intent.token)
      if (!this.current(intent.id,b,sequence)) return false
      if (version !== intent.version) {
        b.state.conflictValid = true
        throw Error('磁盘版本已变化，原确认已失效，请重新加载并确认。')
      }
      if (!valid()) throw Error('编辑内容已变化，请重新加载并确认。')
      if (intent.dirty && (!this.beforeReload || !await this.beforeReload(intent.id))) throw Error('当前内容尚未可靠写入恢复快照，请先另存当前内容后再加载。')
      if (!valid()) throw Error('快照保存期间内容已变化，请重新确认。')
      const file = await this.read(intent.id, intent.version)
      if (!valid()) throw Error('读取期间内容已变化，请重新确认。')
      if (!this.manager.reloadFile(intent.id,file,true)) throw Error('当前不能加载，请先完成输入。')
      this.resolved(b,file)
      return true
    } catch (e) { if (this.current(intent.id,b,sequence)) { this.failed(b,e); this.notify(message(e)) }; return false }
    finally { if (this.current(intent.id,b,sequence)) { b.state.operation = null; this.publish(); this.schedule() } }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.generation++; this.stop(); this.unlisten?.(); this.unfocus?.(); window.removeEventListener('focus',this.onFocus)
    for (const b of this.bindings.values()) this.invalidateCheck(b)
    if (this.timer) clearTimeout(this.timer)
    if (this.started) this.watchWrites = this.watchWrites.then(async () => {
      if (this.files.gateway.endExternalWatch) await this.files.gateway.endExternalWatch(this.lease)
      else await this.files.gateway.watchExternal?.([],this.generation,this.lease)
    }).catch(() => {})
    this.bindings.clear(); this.queued.clear(); this.diff.value = null; this.confirmation.value = null; this.listeners.clear()
  }
}
