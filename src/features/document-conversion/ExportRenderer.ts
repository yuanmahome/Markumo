import { createMarkdownRenderer } from '../../editor/markdown/rendering'
import { detectMimeType, imageDestination, type MarkdownResources } from '../../editor/markdown/images'
import { sanitizeHtml } from '../../editor/markdown/html/SafeHtmlRenderer'
import { installMarkdownMath } from '../../editor/markdown/mathSemantics'
import { installExportFootnotes, type ExportNote } from './ExportSemantics'
import { exportMathHtml } from './ExportMath'
import { compileExportDiagram } from './ExportMedia'
import { LanguageSupport } from '@codemirror/language'
import { syntaxSpans } from '../../editor/core/syntaxSpans'
import { fenceLanguage, loadLanguage } from '../../editor/languages'

export interface RenderResult {
  title: string
  warnings: import('./nativeDocxExport').DocxWarning[]
  bodyHtml: string
}

export function extractDocumentTitle(markdown: string, fallback = 'Untitled'): string {
  // Check for first H1 header '# Title'
  const match = /^#\s+(.+)$/m.exec(markdown)
  if (match && match[1]) {
    return match[1].trim()
  }
  return fallback
}

function cleanHtmlForExport(html: string): string {
  if (typeof window !== 'undefined') {
    return sanitizeHtml(html)
  }
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
}

export async function renderMarkdownForExport(
  markdown: string,
  resources?: MarkdownResources,
  embedImages = true,
  codeLineNumbers = true,
  resolveLink?: (href: string) => Promise<string | null>,
): Promise<RenderResult> {
  const warnings: import('./nativeDocxExport').DocxWarning[] = []
  const title = extractDocumentTitle(markdown)
  const renderer = createMarkdownRenderer()
  installMarkdownMath(renderer)
  const notes: ExportNote[] = []
  installExportFootnotes(renderer, notes)
  const links: string[] = []
  renderer.renderer.rules.link_open = (tokens, index) => {
    links.push(String(tokens[index].attrGet('href') || ''))
    return '<a data-export-link="' + (links.length - 1) + '">'
  }
  const math: string[] = []
  for (const type of ['math_inline', 'math_block']) renderer.renderer.rules[type] = (tokens, index) => {
    const id = math.length
    try { math.push(exportMathHtml(tokens[index].content, type === 'math_block')) }
    catch (error) { math.push(renderer.utils.escapeHtml(tokens[index].content)); warnings.push({kind:'math',message:`公式渲染失败，已保留源码：${String(error)}`}) }
    return '<span data-export-math="' + id + '"></span>'
  }
  // Export is a single static snapshot. Await parsers instead of relying on
  // the preview renderer's later re-render callback (which never runs here).
  const parsed=renderer.parse(markdown,{})
  notes.length = 0
  const supports=new Map<string,LanguageSupport|null>()
  await Promise.all([...new Set(parsed.filter(t=>t.type==='fence').map(t=>fenceLanguage(t.info)))].map(async name=>{
    try{const support=await loadLanguage(name,'fence');supports.set(name,support instanceof LanguageSupport?support:null)}catch{supports.set(name,null)}
  }))
  renderer.options.highlight=(code,info)=>{
    const support=supports.get(fenceLanguage(info))
    if(!support)return renderer.utils.escapeHtml(code)
    let result='',position=0
    for(const {from,to,classes} of syntaxSpans(code,support)){
      result+=renderer.utils.escapeHtml(code.slice(position,from))+`<span class="${classes}">${renderer.utils.escapeHtml(code.slice(from,to)).split('\n').join(`</span>\n<span class="${classes}">`)}</span>`;position=to
    }
    return result+renderer.utils.escapeHtml(code.slice(position))
  }
  renderer.renderer.rules.markumo_task = (tokens, index) => tokens[index].meta?.checked ? '☑ ' : '☐ '
  // Static formats have no working clipboard controls. Use semantic <pre>
  // directly and keep exactly one code element for content selection/copy.
  renderer.renderer.rules.fence=(tokens,index,options)=>{
    const token=tokens[index],info=token.info.trim().split(/\s+/)[0]
    const highlighted=options.highlight?.(token.content,token.info,'')||renderer.utils.escapeHtml(token.content)
    const count=token.content.replace(/\n$/,'').split('\n').length
    const lines=highlighted.split('\n').slice(0,count).map((line,i)=>`<span class="markumo-code-line">${codeLineNumbers?`<span class="markumo-code-number" data-line="${i+1}" aria-hidden="true"></span>`:''}<span class="markumo-code-text">${line}</span></span>`).join('\n')
    return `<pre class="markumo-code${codeLineNumbers?` numbered code-digits-${String(count).length}`:''}"><code${info?` class="language-${renderer.utils.escapeHtml(info)}"`:''}>${lines}${token.content.endsWith('\n')?'\n':''}</code></pre>\n`
  }
  renderer.renderer.rules.image=(tokens,index)=>{
    const token=tokens[index]
    return `<img src="${renderer.utils.escapeHtml(String(token.attrGet('src')||''))}" alt="${renderer.utils.escapeHtml(token.content)}"${token.attrGet('title')?` title="${renderer.utils.escapeHtml(String(token.attrGet('title')))}"`:''}>`
  }
  let rendered = cleanHtmlForExport(renderer.render(markdown))
  if (notes.length) {
    warnings.push({kind:'footnote',message:'脚注以文末列表形式导出'})
    rendered += '<section><h2>脚注</h2>' + notes.map(n => '<p>[^' + renderer.utils.escapeHtml(n.label) + ']: ' + renderer.utils.escapeHtml(n.text) + '</p>').join('') + '</section>'
  }

  // If in browser / DOM environment, process interactive features
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<div>${rendered}</div>`, 'text/html')
    const container = doc.body.firstElementChild as HTMLElement

    for (const node of container.querySelectorAll('[data-export-math]')) node.outerHTML = math[Number(node.getAttribute('data-export-math'))] || ''
    for (const anchor of container.querySelectorAll('a[data-export-link]')) {
      const href = links[Number(anchor.getAttribute('data-export-link'))] || ''
      anchor.removeAttribute('data-export-link')
      if (/^(https?:|mailto:)/i.test(href)) anchor.setAttribute('href', href)
      else if (href && resolveLink) {
        try {
          const target = await resolveLink(href)
          if (target?.startsWith('file:///')) anchor.setAttribute('href', target)
          else warnings.push({kind:'content',message:'链接无法安全定位，已保留文字：' + href})
        } catch { warnings.push({kind:'content',message:'链接无法安全定位，已保留文字：' + href}) }
      } else if (href) warnings.push({kind:'content',message:'相对链接需要已保存源文档及授权目录，已保留文字：' + href})
    }
    for (const details of container.querySelectorAll('details')) details.setAttribute('open', '')
    // 1. Process Mermaid diagrams if any exist
    const mermaidBlocks = container.querySelectorAll<HTMLElement>('pre > code.language-mermaid')
    if (mermaidBlocks.length > 0) {
      try {

        for (const block of Array.from(mermaidBlocks)) {
          const source = block.textContent || ''
          try {
            const cleanSvg = await compileExportDiagram(source)
            const wrapper = doc.createElement('div')
            wrapper.className = 'markumo-diagram-export'
            wrapper.innerHTML = cleanSvg
            block.parentElement?.replaceWith(wrapper)
          } catch (e) {
            warnings.push({ kind: 'diagram', message: 'Mermaid 编译失败，已保留源码：' + String(e) })
          }
        }
      } catch (e) {
        console.warn('Failed to load mermaid for export:', e)
      }
    }

    // 2. Process KaTeX math formulas if any exist
    const mathDisplay = container.querySelectorAll<HTMLElement>('pre > code.language-math, .math-display')
    if (mathDisplay.length > 0) {
      try {
        const { default: katex } = await import('katex')
        for (const block of Array.from(mathDisplay)) {
          const source = block.textContent || ''
          const host = doc.createElement('div')
          host.className = 'katex-display'
          katex.render(source, host, { displayMode: true, throwOnError: false })
          block.parentElement?.replaceWith(host)
        }
      } catch (e) {
        console.warn('Failed to render math for export:', e)
      }
    }

    // 3. Process images: embed local images as Data URI if requested
    {
      const images = container.querySelectorAll<HTMLImageElement>('img')
      for (const img of Array.from(images)) {
        const src = img.getAttribute('src') || ''
        if (!src || src.startsWith('data:')) continue

        const dest = imageDestination(src)
        if (dest.kind === 'remote' || dest.kind === 'blocked') {
          img.removeAttribute('src'); warnings.push({kind:'image',message:'图片未授权，未加载：' + src}); continue
        }
        if (embedImages && resources && dest.kind === 'local') {
          try {
            const bytes = await resources.loadLocal(dest.path, { full: true })
            const dataUri = uint8ArrayToDataUri(bytes)
            img.setAttribute('src', dataUri)
          } catch (e) {
            img.removeAttribute('src'); warnings.push({kind:'image',message:'本地图片未能嵌入：' + src + '：' + String(e)})
          }
        }
      }
    }
    rendered = container.innerHTML
  }

  // 4. Sanitize final HTML to ensure strict XSS safety
  // Generated SVG and KaTeX have their own safety policy. Never re-sanitize them as ordinary HTML.
  const cleanHtml = rendered

  return {
    title,
    warnings,
    bodyHtml: cleanHtml,
  }
}

function uint8ArrayToDataUri(bytes: Uint8Array): string {
  const mimeType = detectMimeType(bytes)

  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}
