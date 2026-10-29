import type { DocumentManager } from '../../editor/core/DocumentManager'
import type {
  Encoding,
  FileOpenEncoding,
  FileGateway,
  OpenBatch,
  OpenFile,
  SaveDiagnosticStatus,
  SaveExecutionResult,
  SaveTarget,
} from './contracts'
import { sameFilePath } from './pathKey'
import { isMedia } from './media'
import { ExternalFileChangeController } from './ExternalFileChangeController'
import { recordVersion } from '../history/historyService'

export function fileError(error: unknown) {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return '文件操作失败；编辑内容仍保留。'
}

// A single save per document. Snapshot completion uses its original CM Text,
// allowing edits during IPC without incorrectly clearing the dirty flag.
export class FileController {
  readonly external: ExternalFileChangeController
  readonly saving = new Set<string>()
  get activeOperationCount() { return this.saving.size + this.external.resolvingCount }
  private workspaceOperation = false
  get workspaceBusy() { return this.workspaceOperation }
  set workspaceBusy(value: boolean) {
    if (this.workspaceOperation === value) return
    this.workspaceOperation = value
    if (!value) this.external.resumeChecks()
  }
  private disposed = false
  private automaticErrors = new Map<string, Set<string>>()
  private readonly stopRelease: () => void
  constructor(readonly manager: DocumentManager, readonly gateway: FileGateway, private readonly notify: (message: string) => void, private saved?: (id: string) => void | Promise<void>) {
    this.stopRelease = manager.onFileRelease(token => { void gateway.release(token).catch(error => notify(fileError(error))) })
    this.external = new ExternalFileChangeController(manager, this, notify)
  }
  setSavedHandler(handler: (id: string) => void | Promise<void>) { this.saved = handler }

  accept(file: OpenFile, preview = false, pane = this.manager.activePane, activatePane = true) {
    if (this.disposed) { void this.gateway.release(file.token).catch(() => {}); return false }
    const existing = this.manager.openedDocuments.find(doc => doc.fileToken && sameFilePath(doc.path, file.path))
    if (!this.manager.openFile(file, preview, pane, activatePane)) {
      if (file.token !== existing?.fileToken) void this.gateway.release(file.token).catch(() => {})
      this.notify('请先完成输入法输入，再重新打开文件。')
      return false
    }
    if (existing && isMedia(existing) && existing.lastDiskVersion !== file.version) {
      // Reopening a read-only preview should pick up external changes, without duplicating the document.
      if (this.manager.reloadFile(existing.id, file)) {
        if (existing.fileToken && existing.fileToken !== file.token) void this.gateway.release(existing.fileToken).catch(() => {})
        return true
      }
    }
    if (existing && existing.fileToken !== file.token) void this.gateway.release(file.token).catch(error => this.notify(fileError(error)))
    if (existing && existing.lastDiskVersion !== file.version) void this.external.check(existing.id)
    else if (file.warning) this.notify(file.warning)
    return true
  }
  acceptBatch(batch: OpenBatch) {
    for (const file of batch.files) this.accept(file)
    if (batch.errors.length) this.notify(batch.errors.join('\n'))
  }
  async open(encoding?: FileOpenEncoding) {
    try { this.acceptBatch(await this.gateway.openDialog(encoding)) }
    catch (error) { this.notify(fileError(error)) }
  }
  async recent(path: string, encoding?: FileOpenEncoding, preview = false) {
    try { this.accept(await this.gateway.openRecent(path, encoding), preview) }
    catch (error) { this.notify(fileError(error)) }
  }
  async save(id: string, saveAs = false, encoding?: Encoding, bom?: boolean): Promise<boolean> {
    const result = await this.performSave(id, saveAs, encoding, bom, false)
    return result.code === 'saved'
  }
  async saveDetailed(id: string, saveAs = false, encoding?: Encoding, bom?: boolean): Promise<SaveExecutionResult> {
    return this.performSave(id, saveAs, encoding, bom, false)
  }
  async autoSave(id: string): Promise<'saved' | 'changed' | 'failed' | 'skipped'> {
    const doc = this.manager.metadata(id)
    if (!doc?.fileToken || doc.kind === 'javaClass' || !doc.dirty || doc.readOnly || this.manager.isComposing || this.workspaceBusy || this.saving.has(id) || this.external.checking(id)) return 'skipped' as const
    const result = await this.performSave(id, false, undefined, undefined, true)
    if (result.code === 'saved') return 'saved'
    if (result.code === 'changed') return 'changed'
    if (['failed', 'permission', 'conflict', 'already_open', 'target_unavailable', 'read_only'].includes(result.code)) return 'failed'
    return 'skipped'
  }
  private async performSave(id: string, saveAs: boolean, encoding: Encoding | undefined, bom: boolean | undefined, automatic: boolean): Promise<SaveExecutionResult> {
    const doc = this.manager.metadata(id)
    if (!doc) {
      return { code: 'failed', success: false, message: '文档不存在或已关闭' }
    }
    if (this.external.resolving(id) || (!saveAs && this.external.blocked(id))) {
      if (!automatic) this.external.keep(id, false)
      return { code: 'blocked', success: false, message: '原文件存在外部变化冲突，已阻止直接保存；请先处理外部变化或另存为新文件。' }
    }
    if (isMedia(doc)) {
      return { code: 'read_only', success: false, message: '媒体文件仅供查看，不能保存为文本。' }
    }
    if (doc.kind === 'javaClass') {
      if (!automatic) this.notify('ClassFile 仅供只读查看，不能作为文本保存或另存为。')
      return { code: 'read_only', success: false, message: 'ClassFile 仅供只读查看，不能作为文本保存或另存为。' }
    }
    if (doc.encoding === 'Hex' && encoding && encoding !== 'Hex') {
      const msg = '字节编辑内容请直接保存或另存为；不能把十六进制显示文字作为原文件的文本编码保存。'
      this.notify(msg)
      return { code: 'failed', success: false, message: msg }
    }
    if (doc.readOnly && !saveAs && doc.fileToken) {
      const msg = '原文件为只读模式，已阻止直接保存；请使用另存为。'
      if (!automatic) this.notify(msg)
      return { code: 'permission', success: false, message: msg }
    }
    if (this.workspaceBusy) {
      if (!automatic) this.notify('工作区文件操作进行中，请稍后保存。')
      return { code: 'busy', success: false, message: '工作区文件操作进行中，请稍后保存。' }
    }
    if (this.disposed || this.saving.has(id)) {
      return { code: 'busy', success: false, message: '保存正在进行中，请稍后。' }
    }
    const snapshot = this.manager.saveSnapshot(id)
    if (!snapshot) {
      if (!automatic) this.notify('请先完成输入法输入，再保存。')
      return { code: 'composing', success: false, message: '请先完成输入法输入，再保存。' }
    }
    this.saving.add(id)
    const saveFailed = this.external.saveStarted(id)
    let targetToken: string | undefined
    const source = snapshot.metadata
    try {
      let token = source.fileToken
      let version = source.lastDiskVersion
      if (!token || saveAs) {
        let target: SaveTarget | null
        try {
          target = await this.gateway.saveTarget(token ?? null, source.name)
        } catch (dialogError) {
          const errMsg = fileError(dialogError)
          if (!automatic) this.notify(`无法打开保存窗口：${errMsg}`)
          return { code: 'target_unavailable', success: false, message: errMsg }
        }
        if (!target) {
          return { code: 'cancelled', success: false, message: '已取消保存，未保存修改与恢复快照仍保留。' }
        }
        targetToken = target.token
        if (this.disposed) {
          return { code: 'failed', success: false, message: '操作已终止。' }
        }
        if (source.fileToken && sameFilePath(target.path, source.path)) {
          const msg = '另存为不能覆盖当前打开的原文件，请选择其他文件名；原文件仍受版本保护。'
          this.notify(msg)
          return { code: 'conflict', success: false, message: msg }
        }
        token = target.token
        version = target.version
      }
      const targetEncoding = encoding || source.encoding as Encoding
      const targetBom = bom !== undefined ? bom : (encoding ? false : source.bom)
      if (this.disposed || !this.manager.metadata(id) || this.manager.metadata(id)?.fileToken !== source.fileToken) {
        return { code: 'failed', success: false, message: '保存期间文档状态已改变。' }
      }
      if (!saveAs && this.external.blocked(id)) {
        return { code: 'blocked', success: false, message: '检测到外部修改冲突，已阻止写入。' }
      }
      // Preserve the version that is still on disk *before* it is replaced. This
      // is the only point where the old body can be captured; recording the new
      // text afterwards is not a substitute for it.
      const baselinePath = !saveAs ? source.path || null : null
      if (!this.gateway.historyTransactional && baselinePath) {
        const diskBaseline = this.manager.getBaselineText(id)
        if (diskBaseline !== null) {
          try {
            const archived = await recordVersion(baselinePath, diskBaseline, 'disk')
            for (const warning of archived?.warnings ?? []) this.notify(warning)
          } catch (error) {
            throw new Error(`保存前历史备份失败，已取消写入，原文件和当前编辑内容均保留：${fileError(error)}`)
          }
        }
      }
      if (this.disposed || this.manager.metadata(id)?.fileToken !== source.fileToken) {
        return { code: 'failed', success: false, message: '历史归档期间文档已关闭或身份改变，未执行写入。' }
      }
      if (!saveAs && this.external.blocked(id)) return { code: 'blocked', success: false, message: '历史归档期间检测到外部冲突，未执行写入。' }
      const result = await this.gateway.save(token!, snapshot.text, version, targetEncoding, targetBom)
      targetToken = undefined
      const accepted = snapshot.complete(result)
      // Publish the authoritative native version before any asynchronous
      // recovery/release callback can let an older check run.
      if (accepted) {
        this.external.saved(id)
        if (result.path && !this.gateway.historyTransactional) {
          try {
            const record = await recordVersion(result.path, snapshot.text.toString(), 'saved', automatic ? '自动保存' : '手动保存')
            for (const warning of record?.warnings ?? []) this.notify(warning)
          } catch (error) {
            this.notify(`正文已保存，但本次新版本未能写入历史：${fileError(error)}`)
          }
        }
      }
      if (accepted) this.automaticErrors.delete(id)
      if (accepted && source.fileToken && source.fileToken !== result.token) await this.gateway.release(source.fileToken).catch(() => {})
      if (!accepted) {
        await this.gateway.release(result.token).catch(() => {})
        return { code: 'failed', success: false, message: '保存完成处理未被接受。' }
      }
      if (accepted) await Promise.resolve().then(() => this.saved?.(id)).catch(error => this.notify(fileError(error)))
      if (accepted && result.warning) this.notify(result.warning)

      const isStillDirty = !!this.manager.metadata(id)?.dirty
      if (isStillDirty) {
        return { code: 'changed', success: true, message: '已成功写入磁盘，但保存期间有新的编辑，仍保留未保存状态。' }
      }
      return { code: 'saved', success: true, message: '文件已成功保存。' }
    } catch (error) {
      if (!saveAs) saveFailed(error)
      const errStr = fileError(error)
      const signature = `${source.fileToken}|${errStr}`

      let diagnosticCode: SaveDiagnosticStatus = 'failed'
      if (errStr.includes('already_open') || errStr.includes('其他标签打开')) {
        diagnosticCode = 'already_open'
      } else if (errStr.includes('conflict') || errStr.includes('变化或被删除') || errStr.includes('外部修改') || errStr.includes('版本')) {
        diagnosticCode = 'conflict'
      } else if (errStr.includes('permission') || errStr.includes('只读') || errStr.includes('拒绝访问') || errStr.includes('PermissionDenied') || errStr.includes('Access is denied')) {
        diagnosticCode = 'permission'
      } else if (errStr.includes('scope') || errStr.includes('路径') || errStr.includes('目标不可用')) {
        diagnosticCode = 'target_unavailable'
      }

      if (!automatic || !this.automaticErrors.get(id)?.has(signature)) {
        if (automatic) {
          const errors = this.automaticErrors.get(id) ?? new Set<string>()
          errors.add(signature); this.automaticErrors.set(id, errors)
        }
        const prefix = !automatic ? '' : this.external.blocked(id) ? '自动保存已暂停：' : '自动保存失败，将有限重试；持续失败后暂停：'
        this.notify(`${prefix}${errStr}\n内容仍保留；可重试或使用另存为保存到其他文件。`)
      }
      return { code: diagnosticCode, success: false, message: errStr }
    } finally {
      if (targetToken && targetToken !== source.fileToken) await this.gateway.release(targetToken).catch(() => {})
      this.saving.delete(id)
      this.external.saveFinished()
    }
  }
  async reopen(encoding: FileOpenEncoding, force = false) {
    const doc = this.manager.activeDocument
    if (isMedia(doc)) return
    if (doc?.kind === 'javaClass' && encoding !== 'Hex') { this.notify('请使用“编辑文件字节”切回可编辑内容。'); return }
    if (!doc?.fileToken) { this.notify('请先打开真实文件。'); return }
    if (this.external.blocked(doc.id)) { this.notify('请先处理外部变化，再切换文件编码。'); return }
    if (!force && (doc.dirty || this.manager.isComposing || this.saving.has(doc.id))) {
      this.notify('请先保存修改并完成输入，再用其他编码重开。'); return
    }
    try {
      const file = await this.gateway.reopen(doc.fileToken, encoding)
      if (!this.manager.reloadFile(doc.id, file, force)) {
        if (file.token !== doc.fileToken) await this.gateway.release(file.token).catch(() => {})
        this.notify('重开期间文档已修改，保留现有编辑内容。')
      } else {
        if (file.token !== doc.fileToken) await this.gateway.release(doc.fileToken).catch(() => {})
        if (file.warning) this.notify(file.warning)
      }
    } catch (error) { this.notify(fileError(error)) }
  }
  close(id: string, discard = false, pane: string = this.manager.activePane) {
    if(this.workspaceBusy){this.notify('文件操作或标签移交进行中，请稍后关闭。');return 'saving' as const}
    if (this.external.resolving(id)) { this.notify('文件处理进行中，请稍后关闭。'); return 'saving' as const }
    if (this.saving.has(id)) { this.notify('保存进行中，请稍后关闭。'); return 'saving' as const }
    const result = this.manager.close(id, discard, pane)
    return result
  }
  async classHex(id: string, offset: number) {
    const doc = this.manager.metadata(id)
    if (this.disposed || doc?.kind !== 'javaClass' || !doc.fileToken || !doc.lastDiskVersion || !this.gateway.readClassHex) throw new Error('ClassFile 查看授权不可用。')
    return this.gateway.readClassHex(doc.fileToken,doc.lastDiskVersion,offset)
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.external.dispose()
    this.automaticErrors.clear()
    this.stopRelease()
    // HMR can dispose the frontend while the Rust process keeps running.
    for (const token of new Set(this.manager.openedDocuments.map(doc => doc.fileToken).filter((token): token is string => !!token))) {
      void this.gateway.release(token).catch(() => {})
    }
  }
}
