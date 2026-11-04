import type { PdfOptions } from './contracts'
import { exportMathCss } from './ExportMath'
import syntaxCss from '../../styles/syntax.css?raw'
import { exportAppearance, type ExportAppearance } from './ExportAppearance'

export function getHighlightCss(): string {
  return syntaxCss
}

export function getDocumentCss(codeWrap = true, appearance:ExportAppearance=exportAppearance()): string {
  return `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
  --text: #24292e;
  --bg: #ffffff;
  --border: #e1e4e8;
  --code-bg: #f6f8fa;
  --quote-text: #6a737d;
  --table-border: #dfe2e5;
  --accent: #0366d6;
}

body {
  margin: 0;
  padding: 40px;
  color: var(--text);
  background: var(--bg);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.markumo-document {
  max-width: 860px;
  margin: 0 auto;
}

h1, h2, h3, h4, h5, h6 {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
  color: #1a1a1a;
}

h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
h5 { font-size: 0.875em; }
h6 { font-size: 0.85em; color: var(--quote-text); }

p, blockquote, ul, ol, dl, table, pre {
  margin-top: 0;
  margin-bottom: 16px;
}

hr {
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  background-color: var(--border);
  border: 0;
}

blockquote {
  padding: 0 1em;
  color: var(--quote-text);
  border-left: 0.25em solid #dfe2e5;
  margin-left: 0;
  margin-right: 0;
}

ul, ol {
  padding-left: 2em;
}

li + li {
  margin-top: 0.25em;
}

li input[type="checkbox"] {
  margin: 0 0.2em 0.25em -1.4em;
  vertical-align: middle;
}

code {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  background-color: var(--code-bg);
  border-radius: 3px;
  font-family: var(--font-mono);
}

pre {
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  background-color: var(--code-bg);
  border-radius: 6px;
  border: 1px solid var(--border);
}

pre code {
  display: inline;
  padding: 0;
  margin: 0;
  background: transparent;
  border: 0;
  font-size: 100%;
  white-space: ${codeWrap ? 'pre-wrap' : 'pre'};
  word-break: ${codeWrap ? 'break-all' : 'normal'};
}

table {
  border-spacing: 0;
  border-collapse: collapse;
  width: 100%;
  overflow: auto;
  margin-bottom: 16px;
}

table th, table td {
  padding: 6px 13px;
  border: 1px solid var(--table-border);
}

table tr {
  background-color: #fff;
  border-top: 1px solid #c6cbd1;
}

table tr:nth-child(2n) {
  background-color: var(--code-bg);
}

table th {
  font-weight: 600;
  background-color: var(--code-bg);
}

img {
  max-width: 100%;
  box-sizing: border-box;
  vertical-align: middle;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.markumo-diagram-export svg { max-width:100%; height:auto; }
/* KaTeX formula centering */
.katex-display {
  margin: 1em 0;
  text-align: center;
}

${exportMathCss}
${getHighlightCss()}
${getAppearanceCss(appearance,codeWrap)}
`
}

function getAppearanceCss({typography:t,colors:c}:ExportAppearance,wrap:boolean){
  const font=t.fontFamily==='serif'?'Georgia, "Noto Serif CJK SC", "SimSun", serif':t.fontFamily==='mono'?'"JetBrains Mono", "Cascadia Code", Consolas, monospace':'-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", system-ui, sans-serif'
  return `
:root,body { ${Object.entries(c).map(([name,value])=>`--${name}:${value};`).join('')} --text:var(--ink); --bg:var(--editor); --code-bg:var(--md-code-bg); --border:var(--line); --table-border:var(--line); --quote-text:var(--muted); }
body { padding:30px; font-family:${font}; font-size:${t.fontSize}px; line-height:${t.lineHeight}; }
.markumo-document { max-width:${t.width}px; }
h1,h2,h3,h4,h5,h6 { color:var(--text); margin:1rem 0; line-height:1.4; }
h1 { font-size:2.25em; line-height:1.2; } h2 { font-size:1.75em; line-height:1.225; } h3 { font-size:1.5em; line-height:1.43; } h4 {font-size:1.25em}
p { margin:.8em 0; }
table tr {background:var(--bg)}
pre.markumo-code { padding:8px 12px; font:13px/1.65 var(--font-mono); }
pre.markumo-code > code { display:block; white-space:normal; }
.markumo-code-line { display:grid; grid-template-columns:minmax(0,1fr); min-height:1.65em; }
.numbered .markumo-code-line { grid-template-columns:calc(3ch + 12px) minmax(0,1fr); }
${Array.from({length:8},(_,index)=>`.numbered.code-digits-${index+1} .markumo-code-line { grid-template-columns:calc(${Math.max(2,index+1)}ch + 12px) minmax(0,1fr); }`).join('\n')}
.markumo-code-number { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; text-align:right; padding-right:12px; white-space:nowrap; word-break:normal; overflow-wrap:normal; user-select:none; }
.markumo-code-number::before { content:attr(data-line); }
.markumo-code-text { min-width:0; white-space:${wrap?'pre-wrap':'pre'}; overflow-wrap:${wrap?'anywhere':'normal'}; }
`
}

export function getPrintCss(pdfOptions?: PdfOptions): string {
  const paper = pdfOptions?.paperSize === 'Letter' ? 'letter' : 'a4'
  const orientation = pdfOptions?.orientation === 'landscape' ? 'landscape' : 'portrait'
  const marginSize =
    pdfOptions?.margins === 'compact' ? '12mm' :
    pdfOptions?.margins === 'loose' ? '25mm' : '18mm'

  return `
@page {
  size: ${paper} ${orientation};
  margin: ${marginSize};
}

@media print {
  body {
    padding: 0 !important;
    background: ${pdfOptions?.printBackground === false ? '#ffffff' : 'var(--bg)'} !important;
    color: ${pdfOptions?.printBackground === false ? '#000000' : 'var(--text)'} !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  .markumo-document {
    max-width: 100% !important;
    margin: 0 !important;
  }

  h1, h2, h3, h4, h5, h6 {
    page-break-after: avoid;
    break-after: avoid;
  }

  img, .katex-display {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  pre, blockquote, table { break-inside: auto; overflow: visible; }
  pre.markumo-code > code { white-space: normal !important; }
  .markumo-code-line { break-inside: avoid; }
  .markumo-code-text { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
  thead { display: table-header-group; }
  a, td { overflow-wrap: anywhere; }
  .markumo-diagram-export svg { max-width: 100%; max-height: 240mm; width: auto; height: auto; }
  .markumo-diagram-export { break-inside: avoid; }
  p:has(+ .markumo-diagram-export) { break-after: avoid; }
  tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  a {
    color: inherit !important;
    text-decoration: none !important;
  }
}
`
}

export function buildCompleteHtml(
  title: string,
  bodyContent: string,
  includeStyles: boolean,
  pdfOptions?: PdfOptions,
  appearance:ExportAppearance=exportAppearance()
): string {
  const styleTag = includeStyles
    ? `<style>\n${getDocumentCss(pdfOptions?.codeWrap ?? appearance.typography.codeWrap,appearance)}\n${pdfOptions ? getPrintCss(pdfOptions) : ''}\n</style>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${styleTag}
</head>
<body>
  <article class="markumo-document${includeStyles ? ' styled' : ' plain'}">
    ${bodyContent}
  </article>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
