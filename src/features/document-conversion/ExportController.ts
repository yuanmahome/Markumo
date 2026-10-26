import { invoke, isTauri } from '@tauri-apps/api/core'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import { createMarkdownResources } from '../../editor/markdown/images'
import type { ExportFormat, ConversionSettings, ConversionSelection } from './contracts'
import { releaseConversion } from './conversionLease'
import { loadConversionSettings, saveLastExport, loadLastExport } from './conversionSettings'
import { renderMarkdownForExport, extractDocumentTitle } from './ExportRenderer'
import { buildCompleteHtml } from './ExportStyles'
import { exportAppearance } from './ExportAppearance'
import { shallowRef } from 'vue'

export class ExportController {
  readonly progress = shallowRef<{phase:'generating'|'writing'}|null>(null)
  private activeExport: AbortController | null = null
  cancelExport(): boolean {
    if (!this.activeExport || this.progress.value?.phase !== 'generating') return false
    this.activeExport.abort(); return true
  }
  dispose() { this.cancelExport() }
  constructor(
    private manager: DocumentManager,
    private notify: (message: string) => void
  ) {}

  canExportActive(): boolean {
    const doc = this.manager.activeDocument
    if (!doc) return false
    // Document must be a Markdown file or in markdown mode
    return (
      (!doc.kind || doc.kind === 'text') &&
      doc.encoding !== 'Hex' &&
      (doc.mode !== undefined || /\.(md|markdown|mdown|mkd)$/i.test(doc.name))
    )
  }

  async exportDocument(format: ExportFormat, customSettings?: Partial<ConversionSettings>): Promise<string | null> {
    if(this.activeExport){this.notify('已有 Word 导出进行中，请完成或取消后重试。');return null}
    if (!this.canExportActive()) {
      this.notify('当前活动文件不是 Markdown 文档，无法导出。')
      return null
    }

    const doc = this.manager.activeDocument!
    const textSnapshot = this.manager.getText(doc.id) ?? ''
    const settings = { ...loadConversionSettings(), ...(customSettings || {}) }

    // Derive base name from title or file name
    const rawName = doc.name.replace(/\.(md|markdown|mdown|mkd)$/i, '') || 'Untitled'
    const docTitle = extractDocumentTitle(textSnapshot, rawName)
    const ext = format === 'docx' ? 'docx' : format === 'pdf' ? 'pdf' : format === 'png' ? 'png' : 'html'
    const defaultFilename = `${rawName}.${ext}`

    let target: ConversionSelection | null = null
    const cancellation = format === 'docx' ? new AbortController() : null
    if(cancellation)this.activeExport=cancellation

    try {
      if (isTauri()) {
        target = await invoke<ConversionSelection | null>('export_save_dialog', {
          defaultName: defaultFilename,
          format: format === 'html-plain' ? 'html' : format,
        })
        if (!target) {
          // User cancelled dialog
          return null
        }
      } else {
        target = { path: defaultFilename, token: '' }
      }

      const targetPath = target.path
      this.notify('正在准备导出…')

      if (format === 'html' || format === 'html-plain') {
        await this.exportHtml(textSnapshot, docTitle, target, format === 'html', settings, doc.fileToken)
      } else if (format === 'pdf') {
        await this.exportPdf(textSnapshot, docTitle, target, settings, doc.fileToken)
      } else if (format === 'docx') {
        this.progress.value={phase:'generating'}
        await this.exportDocx(textSnapshot, docTitle, doc.path, target, doc.fileToken, cancellation!.signal)
      } else if (format === 'png') {
        await this.exportPng(textSnapshot, target, settings, doc.fileToken)
      }

      saveLastExport({
        format,
        targetPath,
        options: settings,
        timestamp: Date.now(),
      })

      return targetPath
    } catch (error) {
      if(cancellation?.signal.aborted)return null
      const msg = error instanceof Error ? error.message : String(error)
      this.notify(`导出失败：${msg}`)
      throw error
    } finally {
      if(this.activeExport===cancellation){this.activeExport=null;this.progress.value=null}
      await releaseConversion(target)
    }
  }

  async exportRepeat(): Promise<string | null> {
    const last = loadLastExport()
    if (!last) {
      this.notify('尚无上一次导出记录，请从“文件 → 导出”选择格式。')
      return null
    }
    return this.exportDocument(last.format, last.options)
  }

  private async exportHtml(
    markdown: string,
    title: string,
    target: ConversionSelection,
    includeStyles: boolean,
    settings: ConversionSettings,
    documentToken?: string
  ): Promise<void> {
    const resources = createMarkdownResources(() => documentToken)
    const appearance=exportAppearance(this.manager.getMarkdownTypography())
    const { bodyHtml } = await renderMarkdownForExport(markdown, resources, settings.embedImagesAsDataUri, includeStyles&&appearance.typography.codeLineNumbers)
    const fullHtml = buildCompleteHtml(title, bodyHtml, includeStyles,undefined,appearance)

    const bytes = new TextEncoder().encode(fullHtml)
    if (isTauri()) {
      await invoke('save_binary_file', {
        token: target.token,
        format: 'html',
        bytes: Array.from(bytes),
      })
    } else {
      this.downloadBlob(new Blob([bytes], { type: 'text/html;charset=utf-8' }), target.path)
    }
  }

  private async exportPdf(
    markdown: string,
    title: string,
    target: ConversionSelection,
    settings: ConversionSettings,
    documentToken?: string
  ): Promise<void> {
    const resources = createMarkdownResources(() => documentToken)
    const appearance=exportAppearance(this.manager.getMarkdownTypography())
    const { bodyHtml } = await renderMarkdownForExport(markdown, resources, true,appearance.typography.codeLineNumbers)
    const fullHtml = buildCompleteHtml(title, bodyHtml, true, settings.pdf,appearance)

    if (isTauri()) {
      await invoke('print_to_pdf', {
        htmlContent: fullHtml,
        token: target.token,
        options: settings.pdf,
      })
    } else {
      // Browser fallback: trigger print dialog on generated window
      const win = window.open('', '_blank')
      if (win) {
        win.document.write(fullHtml)
        win.document.close()
        setTimeout(() => win.print(), 500)
      } else {
        throw new Error('浏览器阻止了打印窗口，请允许弹出窗口后重试。')
      }
    }
  }

  private async exportDocx(
    markdown: string,
    title: string,
    docPath?: string,
    target?: ConversionSelection,
    documentToken?: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!target) throw new Error('未指定导出路径')
    // Pandoc stays available as the advanced path, but the native writer runs
    // first because it needs no external tool and reports its own warnings.
    const resources = createMarkdownResources(() => documentToken)
    const { generateDocx } = await import('./docxWorkerClient')
    const result = await generateDocx(markdown, {
      signal,
      title,
      resolveImage: async source => {
        if (!source || /^(?:https?:)?\/\//i.test(source)) return null
        try {
          const bytes = await resources.loadLocal(source)
          return { data: bytes, alt: source }
        } catch {
          return null
        }
      },
    })
    for (const warning of result.warnings) this.notify(warning.message)
    const bytes = result.bytes
    if(signal?.aborted)throw new DOMException('导出已取消','AbortError')
    if(bytes.byteLength > 16*1024*1024)throw new Error('Word 输出超过 16 MiB 安全上限，未写入文件；请拆分文档后导出。')
    // Cancellation is available through generation. Once this atomic commit
    // starts, the UI reports "writing" and never claims it was cancelled.
    this.progress.value={phase:'writing'}
    if (isTauri()) {
      await invoke('save_docx_bytes', bytes, { headers: {'x-markumo-conversion-token':target.token} })
    } else {
      this.downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), target.path)
    }
    void docPath
  }

  private async exportPng(
    markdown: string,
    target: ConversionSelection,
    settings: ConversionSettings,
    documentToken?: string
  ): Promise<void> {
    const resources = createMarkdownResources(() => documentToken)
    const appearance=exportAppearance(this.manager.getMarkdownTypography())
    const { bodyHtml } = await renderMarkdownForExport(markdown, resources, true,appearance.typography.codeLineNumbers)

    // Isolate export CSS from the editor and give html2canvas a complete,
    // styled document rather than an unstyled offscreen fragment.
    const frame=document.createElement('iframe')
    frame.style.cssText=`position:absolute;left:-99999px;top:0;width:${settings.png.width}px;height:1px;border:0`
    document.body.appendChild(frame)

    try {
      const exported=frame.contentDocument!
      exported.open();exported.write(buildCompleteHtml('',bodyHtml,true,undefined,appearance));exported.close()
      await exported.fonts.ready
      await Promise.all([...exported.images].map(image=>image.decode().catch(()=>{})))
      const container=exported.body
      container.style.background=settings.png.backgroundColor||appearance.colors.editor
      // Check document height
      const totalHeight = container.scrollHeight
      if (totalHeight > 30000) {
        throw new Error('文档超出图片最大安全画布尺寸（30,000像素），建议改用 PDF 格式导出。')
      }
      frame.style.height=`${totalHeight}px`

      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(container, {
        scale: settings.png.scale || 2,
        backgroundColor: settings.png.backgroundColor || '#ffffff',
        useCORS: true,
        logging: false,
      })

      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('生成 PNG 图像失败')

      const buffer = await blob.arrayBuffer()
      const bytes = new Uint8Array(buffer)

      if (isTauri()) {
        await invoke('save_binary_file', {
          token: target.token,
          format: 'png',
          bytes: Array.from(bytes),
        })
      } else {
        this.downloadBlob(blob, target.path)
      }
    } finally {
      frame.remove()
    }
  }

  private downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
}
