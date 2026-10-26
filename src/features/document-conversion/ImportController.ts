import { invoke, isTauri } from '@tauri-apps/api/core'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { ImportFormat, ConversionSelection } from './contracts'
import { releaseConversion } from './conversionLease'
import { importHtmlToMarkdown } from './HtmlImporter'
import { getPandocStatus, importDocxToMarkdown } from './PandocBridge'

export class ImportController {
  constructor(
    private manager: DocumentManager,
    private notify: (message: string) => void
  ) {}

  async importDocument(format: ImportFormat): Promise<string | null> {
    if (format === 'html') {
      return this.importHtml()
    } else if (format === 'docx') {
      return this.importDocx()
    }
    return null
  }

  private async importHtml(): Promise<string | null> {
    let source: ConversionSelection | null = null

    try {
      this.notify('正在读取并转换 HTML…')

      let htmlContent = ''
      if (isTauri()) {
        source = await invoke<ConversionSelection | null>('import_open_dialog', { format: 'html' })
        if (!source) return null
        htmlContent = await invoke<string>('read_conversion_html', { token: source.token })
      } else {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.html,.htm'
        const picked = await new Promise<File | null>(resolve => {
          input.onchange = () => resolve(input.files?.[0] || null)
          input.oncancel = () => resolve(null)
          input.click()
        })
        if (!picked) return null
        htmlContent = await picked.text()
      }

      const result = importHtmlToMarkdown(htmlContent)

      // Create new Untitled Markdown document in DocumentManager
      const docId = this.manager.createUntitled('md')
      if (docId) {
        this.manager.dispatch(docId, {
          changes: { from: 0, insert: result.markdown },
        })
        this.manager.select(docId)
        return docId
      }
      return null
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.notify(`导入 HTML 失败：${msg}`)
      throw error
    } finally {
      await releaseConversion(source)
    }
  }

  private async importDocx(): Promise<string | null> {
    if (!isTauri()) {
      this.notify('Word 导入需要桌面版运行环境。')
      return null
    }

    const status = await getPandocStatus()
    if (!status.available) {
      this.notify('未检测到 Pandoc。Word 导入需要安装 Pandoc，请先前往 https://pandoc.org 安装。')
      return null
    }

    let source: ConversionSelection | null = null
    let target: ConversionSelection | null = null
    try {
      source = await invoke<ConversionSelection | null>('import_open_dialog', { format: 'docx' })
      if (!source) return null

      // 2. Pick target md path
      const defaultMdName = source.path.replace(/\.docx$/i, '.md').split(/[/\\]/).pop() || 'Imported.md'
      target = await invoke<ConversionSelection | null>('export_save_dialog', {
        defaultName: defaultMdName,
        format: 'markdown',
      })
      if (!target) return null

      this.notify('正在使用 Pandoc 转换 Word 文档…')
      const markdown = await importDocxToMarkdown(source, target)

      // Create new document or open file in DocumentManager
      const docId = this.manager.createUntitled('md')
      if (docId) {
        this.manager.dispatch(docId, {
          changes: { from: 0, insert: markdown },
        })
        this.manager.select(docId)
      }

      return target.path
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.notify(`导入 Word 失败：${msg}`)
      throw error
    } finally {
      await releaseConversion(source)
      await releaseConversion(target)
    }
  }
}
