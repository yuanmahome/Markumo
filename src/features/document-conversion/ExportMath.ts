import katex from 'katex'
import rawCss from 'katex/dist/katex.min.css?raw'
import { mathBlockParts } from '../../editor/markdown/mathSemantics'
const fonts = import.meta.glob('/node_modules/katex/dist/fonts/*.woff2', { query: '?inline', import: 'default', eager: true }) as Record<string, string>
export const exportMathCss = rawCss.replace(/src:[^;}]+/g, source => {
  const name = /fonts\/([^"')]+\.woff2)/.exec(source)?.[1]
  return name && fonts['/node_modules/katex/dist/fonts/' + name] ? 'src:url(' + fonts['/node_modules/katex/dist/fonts/' + name] + ') format("woff2")' : source
})
export function exportMathHtml(source: string, displayMode: boolean) {
  return katex.renderToString(displayMode ? mathBlockParts(source)?.value ?? source : source, { displayMode, throwOnError: true, trust: false, output: 'html', maxExpand: 1000 })
}

export async function renderExportMath(source: string, display: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px;height:500px;border:0'
  document.body.append(frame)
  try {
    const doc = frame.contentDocument!
    doc.open(); doc.write('<!doctype html><meta charset="utf-8"><style>' + exportMathCss + '</style><body style="margin:0;background:white"><span id="formula" style="display:inline-block;padding:4px;font-size:20px">' + exportMathHtml(source, display) + '</span>'); doc.close()
    await doc.fonts.ready
    const host = doc.getElementById('formula')!
    const box = host.getBoundingClientRect()
    if (!box.width || !box.height || box.width * box.height > 4_000_000) throw new Error('公式超出预算')
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(host, { scale: 2, logging: false, backgroundColor: '#ffffff' })
    try {
      signal?.throwIfAborted()
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('公式转换失败')
      return { data: new Uint8Array(await blob.arrayBuffer()), alt: source, width: box.width, height: box.height }
    } finally { canvas.width = canvas.height = 0 }
  } finally { frame.remove() }
}
