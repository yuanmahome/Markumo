import { invoke, isTauri } from '@tauri-apps/api/core'
import { shallowRef } from 'vue'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { ConversionResult, ConversionSelection, ImportFormat, ImportedDocument, PreparedImport } from './contracts'
import { releaseConversion } from './conversionLease'
import { importHtmlToMarkdown } from './HtmlImporter'
import { sameFilePath } from '../files/pathKey'
import { tauriFiles } from '../files/tauriFiles'

export class ImportController {
  readonly progress = shallowRef<{ phase: 'parsing' | 'choosing' | 'writing' } | null>(null)
  readonly result = shallowRef<ConversionResult | null>(null)
  private active: AbortController | null = null
  private leases = new Set<ConversionSelection>()
  constructor(private manager: DocumentManager, private notify: (message: string) => void) {}
  cancelImport(): boolean {
    if (!this.active || this.progress.value?.phase === 'writing') return false
    this.active.abort()
    for (const lease of this.leases) void releaseConversion(lease)
    return true
  }
  dispose() { this.cancelImport() }
  private check(signal: AbortSignal) { if (signal.aborted) throw new DOMException('导入已取消', 'AbortError') }
  private track<T extends ConversionSelection>(selection: T | null) {
    if (selection) this.leases.add(selection)
    return selection
  }
  async importDocument(format: ImportFormat): Promise<string | null> {
    if (this.active) { this.notify('已有导入进行中，请完成或取消后重试。'); return null }
    const task = new AbortController()
    this.active = task; this.result.value = null; this.progress.value = { phase: 'choosing' }
    try {
      return format === 'docx' ? await this.importDocx(task.signal) : await this.importHtml(task.signal)
    } catch (error) {
      if (task.signal.aborted) { this.notify('导入已取消。'); return null }
      this.notify(`导入失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      await Promise.all([...this.leases].map(releaseConversion))
      this.leases.clear(); this.active = null; this.progress.value = null
    }
  }
  private async importHtml(signal: AbortSignal): Promise<string | null> {
    let content: string
    if (isTauri()) {
      const source = this.track(await invoke<ConversionSelection | null>('import_open_dialog', { format: 'html' }))
      if (!source) return null
      this.check(signal)
      this.progress.value = { phase: 'parsing' }
      content = await invoke<string>('read_conversion_html', { token: source.token })
    } else {
      const input = document.createElement('input')
      input.type = 'file'; input.accept = '.html,.htm'
      const file = await new Promise<File | null>(resolve => {
        input.onchange = () => resolve(input.files?.[0] ?? null)
        input.oncancel = () => resolve(null)
        input.click()
      })
      if (!file) return null
      if (file.size > 16 * 1024 * 1024) throw new Error('HTML 超过 16 MiB 安全上限。')
      content = await file.text()
    }
    this.check(signal)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const converted = importHtmlToMarkdown(content)
    this.check(signal)
    this.result.value = { warnings: [] }
    const id = this.manager.createUntitled('md')
    if (!id) return null
    this.manager.dispatch(id, { changes: { from: 0, insert: converted.markdown } })
    this.manager.select(id)
    return id
  }
  private async importDocx(signal: AbortSignal): Promise<string | null> {
    if (!isTauri()) { this.notify('Word 导入需要桌面版运行环境。'); return null }
    const source = this.track(await invoke<ConversionSelection | null>('import_open_dialog', { format: 'docx' }))
    if (!source) return null
    this.check(signal)
    this.progress.value = { phase: 'parsing' }
    const prepared = this.track(await invoke<PreparedImport>('prepare_docx_import', { sourceToken: source.token }))!
    this.check(signal)
    this.result.value = { warnings: prepared.warnings, stats: prepared.stats }
    for (const warning of prepared.warnings) this.notify(warning.message)
    this.progress.value = { phase: 'choosing' }
    const target = this.track(await invoke<ConversionSelection | null>('export_save_dialog', {
      defaultName: source.path.split(/[/\\]/).pop()!.replace(/\.docx$/i, '.md'), format: 'markdown',
    }))
    if (!target) return null
    this.check(signal)
    if (this.manager.openedDocuments.some(doc => sameFilePath(doc.path, target.path) && doc.dirty)) {
      throw new Error('目标文件有未保存的编辑，请保存文档或选择其他位置。')
    }
    this.progress.value = { phase: 'writing' }
    const saved = await invoke<ImportedDocument>('commit_docx_import', { draftToken: prepared.token, targetToken: target.token })
    this.result.value = { path: saved.path, warnings: saved.warnings, stats: saved.stats }
    for (const warning of saved.warnings.filter(w => !prepared.warnings.some(p => p.kind === w.kind && p.message === w.message))) this.notify(warning.message)
    if (!saved.file) { this.notify(`已保存至 ${saved.path}，请从文件菜单打开。`); return saved.path }
    const file = saved.file
    const existing = this.manager.openedDocuments.find(doc => sameFilePath(doc.path, file.path))
    if (existing) {
      const oldToken = existing.fileToken
      if (this.manager.reloadFile(existing.id, file)) {
        if (oldToken && oldToken !== file.token) await tauriFiles.release(oldToken)
        this.manager.select(existing.id)
      } else {
        await tauriFiles.release(file.token)
        this.notify(`已保存至 ${saved.path}；当前编辑缓冲区已保留，请稍后重新加载。`)
      }
    } else if (!this.manager.openFile(file)) {
      await tauriFiles.release(file.token)
      this.notify(`已保存至 ${saved.path}，请完成当前输入后再打开。`)
    }
    return saved.path
  }
}
