export type ExportFormat = 'pdf' | 'html' | 'html-plain' | 'docx' | 'png'
export type ImportFormat = 'html' | 'docx'

/** Native, single-use authorization. Never persist this in export settings. */
export interface ConversionSelection { path: string; token: string }

export interface ConversionWarning { kind: string; message: string }
export interface ConversionResult { path?: string; warnings: ConversionWarning[]; stats?: Record<string, number> }
export interface PreparedImport extends ConversionSelection { warnings: ConversionWarning[]; stats: Record<string, number> }
export interface ImportedDocument extends ConversionResult { path: string; file: import('../files/contracts').OpenFile | null }

export interface PdfOptions {
  paperSize: 'A4' | 'Letter'
  orientation: 'portrait' | 'landscape'
  margins: 'default' | 'compact' | 'loose'
  printBackground: boolean
  codeWrap: boolean
}

export interface HtmlExportOptions {
  includeStyles: boolean
  embedImages: boolean
}

export interface PngExportOptions {
  width: number
  scale: number
  backgroundColor: string
}

export interface ConversionSettings {
  defaultExportDir?: string
  askSaveLocation: boolean
  embedImagesAsDataUri: boolean
  pdf: PdfOptions
  html: HtmlExportOptions
  png: PngExportOptions
}

export interface LastExportRecord {
  format: ExportFormat
  targetPath?: string
  options: Partial<ConversionSettings>
  timestamp: number
}
