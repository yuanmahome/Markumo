import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { WindowMap } from './WindowMap'
import { segmentedBudgets, type ByteEdit, type SegmentedStatus, type SegmentedTextDocument, type TextWindow } from './protocol'

interface Pending { revision: number; edits: ByteEdit[]; bytes: number }
interface Plan { mapping: WindowMap; edits: ByteEdit[]; bytes: number }
/** Laboratory adapter, deliberately not imported by DocumentManager. Global
 * copy, exact line navigation, legacy encodings and workspace integration are
 * acceptance gates before this can become a user-facing route. */
export class SegmentedWindowEditor {
  readonly view: EditorView
  private mapping: WindowMap
  private revision: number
  private projectedRevision: number
  private byteLength: number
  private pending: Pending[] = []
  private pendingBytes = 0
  private pump?: Promise<void>
  private failure?: Error
  private readonly plans = new WeakMap<Transaction, Plan>()
  private loading = false
  private composing = false
  private disposed = false
  private requestedStart?: number
  private seekTask?: Promise<void>
  private historyLocked = false
  private exclusiveTask = false
  private get isComposing() { return this.composing || !!this.view?.compositionStarted }
  constructor(parent: HTMLElement, private readonly port: SegmentedTextDocument, window: TextWindow, status: SegmentedStatus,
    private readonly separator: '\n' | '\r\n' | '\r', private readonly notice: (error: Error) => void) {
    if (window.revision !== status.revision) throw new Error('初始窗口版本不一致。')
    this.mapping = WindowMap.from(window)
    this.revision = this.projectedRevision = status.revision
    this.byteLength = status.byteLength
    this.view = new EditorView({ parent, state: this.state(), dispatchTransactions: transactions => {
      this.view.update(transactions)
      for (const tr of transactions) {
        const plan = this.plans.get(tr)
        if (!plan) continue
        this.plans.delete(tr)
        this.byteLength += plan.mapping.endByte - this.mapping.endByte
        this.mapping = plan.mapping
        this.pendingBytes += plan.bytes
        this.pending.push({ revision: this.projectedRevision++, edits: plan.edits, bytes: plan.bytes })
      }
      this.startPump()
    } })
  }
  private state() {
    return EditorState.create({ doc: this.mapping.text, extensions: [
      // No local history: the canonical undo/redo roots belong to Rust.
      lineNumbers({ formatNumber: number => `局部 ${number}` }),
      EditorView.contentAttributes.of({ 'data-segmented-lab': 'true', 'aria-label': '分段原型编辑器（局部行号）' }),
      EditorState.transactionFilter.of(tr => {
        if (!tr.docChanged) return tr
        try {
          if (this.disposed || this.loading || this.historyLocked || this.exclusiveTask || this.failure) throw this.failure || new Error('窗口正在切换，本次编辑未插入，请稍后重试。')
          if (this.view && tr.startState.doc !== this.view.state.doc) throw new Error('原型暂不接受跨多个起始状态的批量事务；本次事务未插入。')
          const changes: { from: number; to: number; insert: string }[] = []
          tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString() }))
          const plan = this.mapping.change(changes, this.separator)
          const bytes = plan.edits.reduce((n, edit) => n + new TextEncoder().encode(edit.insert).length + 64, 0)
          if (this.pendingBytes + bytes > segmentedBudgets.pendingEditBytes || plan.mapping.endByte - plan.mapping.startByte > segmentedBudgets.maxWindowBytes)
            throw new Error('操作超出分段原型窗口/待确认编辑预算；本次内容未插入，原内容仍保留。')
          this.plans.set(tr, { ...plan, bytes })
          return tr
        } catch (error) { this.notice(error instanceof Error ? error : new Error(String(error))); return [] }
      }),
      keymap.of([
        { key: 'Mod-z', run: () => { void this.history(false).catch(error => this.notice(error)); return true } },
        { key: 'Mod-Shift-z', run: () => { void this.history(true).catch(error => this.notice(error)); return true } },
        { key: 'Mod-y', run: () => { void this.history(true).catch(error => this.notice(error)); return true } },
        // Do not let a window-local Select All pretend to select the whole file.
        { key: 'Mod-a', run: () => { this.notice(new Error('此原型尚未实现全文选择/复制；请先流式保存副本。')); return true } },
        ...defaultKeymap,
      ]),
      EditorView.domEventHandlers({
        compositionstart: () => { this.composing = true; return false },
        compositionend: () => { this.composing = false; return false },
        beforeinput: event => {
          if (!['historyUndo', 'historyRedo'].includes(event.inputType)) return false
          event.preventDefault(); void this.history(event.inputType === 'historyRedo').catch(error => this.notice(error)); return true
        },
      }),
    ] })
  }
  get metrics() {
    return { revision: this.revision, projectedRevision: this.projectedRevision, byteLength: this.byteLength,
      startByte: this.mapping.startByte, endByte: this.mapping.endByte, visibleChars: this.view.state.doc.length,
      mappingBytes: this.mapping.retainedBytes, pendingBytes: this.pendingBytes, failed: !!this.failure }
  }
  private startPump() {
    if (this.pump || this.failure || !this.pending.length) return
    this.pump = (async () => {
      while (this.pending.length) {
        const next = this.pending[0]
        const result = await this.port.edit(next.revision, next.edits)
        if (result.revision !== next.revision + 1) throw new Error('Rust 编辑确认版本不一致；保留本地编辑并暂停提交。')
        this.revision = result.revision
        this.pending.shift(); this.pendingBytes -= next.bytes
      }
    })().catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); this.notice(this.failure) }).finally(() => { this.pump = undefined; this.startPump() })
  }
  async flush() {
    if (this.disposed) throw new Error('原型视图已关闭。')
    while (this.pump || this.pending.length) {
      if (this.failure) throw this.failure
      this.startPump(); await this.pump
    }
    if (this.failure) throw this.failure
    return this.revision
  }
  /** Swaps only after edits are acknowledged; never swaps during composition.
   * At most one current window and one in-flight bounded response are retained. */
  async seek(startByte: number) {
    if (this.isComposing) throw new Error('请先完成输入法组合，再切换窗口。')
    if (this.historyLocked || this.exclusiveTask) throw new Error('独占操作进行中，请稍后定位。')
    this.requestedStart = Math.max(0, Math.min(startByte, this.byteLength))
    if (!this.seekTask) {
      this.loading = true
      this.seekTask = (async () => {
        await this.flush()
        while (this.requestedStart !== undefined) {
          const at = this.requestedStart; this.requestedStart = undefined
          const window = await this.port.window(this.revision, at, segmentedBudgets.windowBytes)
          if (this.disposed) return
          if (this.requestedStart !== undefined) continue
          this.receive(window)
        }
      })().finally(() => { this.loading = false; this.seekTask = undefined })
    }
    await this.seekTask
  }
  private receive(window: TextWindow) {
    if (window.revision !== this.revision) throw new Error('窗口返回过期版本。')
    this.mapping = WindowMap.from(window)
    this.view.setState(this.state())
  }
  async history(redo: boolean) {
    if (this.isComposing) throw new Error('请先完成输入法组合，再撤销或重做。')
    if (this.historyLocked || this.exclusiveTask) throw new Error('独占操作进行中，请稍后重试。')
    this.historyLocked = true
    try {
      await this.seekTask; this.loading = true; await this.flush()
      const result = await (redo ? this.port.redo(this.revision) : this.port.undo(this.revision))
      this.revision = this.projectedRevision = result.revision; this.byteLength = result.byteLength
      this.receive(await this.port.window(this.revision, Math.min(this.mapping.startByte, this.byteLength), segmentedBudgets.windowBytes))
    } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); throw this.failure }
    finally { this.loading = false; this.historyLocked = false }
  }
  async saveCopy(path: string) { const revision = await this.flush(); await this.port.checkpoint(revision); await this.port.saveCopy(revision, path) }
  async gotoLine(line: number) { const revision = await this.flush(); const point = await this.port.lineStart(revision, line); await this.seek(point.byte) }
  async search(query: string, start = 0) { const revision = await this.flush(); return this.port.search(revision, query, start, segmentedBudgets.resultLimit) }
  async replaceAll(query: string, replacement: string) {
    if (this.isComposing || this.loading || this.historyLocked || this.exclusiveTask) throw new Error('请完成当前输入或窗口操作后再替换。')
    this.loading = this.exclusiveTask = true
    try {
      const revision = await this.flush(), result = await this.port.replace(revision, query, replacement)
      this.revision = this.projectedRevision = result.revision; this.byteLength = result.byteLength
      this.receive(await this.port.window(this.revision, Math.min(this.mapping.startByte, this.byteLength), segmentedBudgets.windowBytes))
    } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); throw this.failure }
    finally { this.loading = this.exclusiveTask = false }
  }
  async close(discard = false) {
    if (this.disposed) return
    if (this.isComposing && !discard) throw new Error('请先完成输入法组合，再关闭。')
    if (this.historyLocked || this.exclusiveTask) throw new Error('请等待独占操作完成，再关闭。')
    this.exclusiveTask = true
    try {
      await this.seekTask; this.loading = true
      if (!discard) { const revision = await this.flush(); await this.port.checkpoint(revision) }
      else await this.pump
      await this.port.close(discard)
      // The checkpoint owns canonical content and history. Release the closed
      // projection even if its host temporarily retains this controller.
      this.disposed = true
      this.view.setState(EditorState.create())
      this.view.destroy(); this.mapping = new WindowMap('', 0); this.pending = []; this.pendingBytes = 0
    } finally { this.exclusiveTask = false; if (!this.disposed) this.loading = false }
  }
}
