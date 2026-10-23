import type { MarkdownTypography } from './wysiwyg/contracts'
import './presentation.css'

export function markdownTypographyStyle(settings: MarkdownTypography, isSplit = false) {
  return {
    '--md-content-width': isSplit ? '100%' : `${settings.width}px`,
    '--md-font-size': `${settings.fontSize}px`,
    '--md-line-height': String(settings.lineHeight),
    '--md-font-family': settings.fontFamily === 'system'
      ? '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", system-ui, sans-serif'
      : settings.fontFamily === 'serif' ? 'Georgia, "Noto Serif CJK SC", "SimSun", serif' : '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  }
}
