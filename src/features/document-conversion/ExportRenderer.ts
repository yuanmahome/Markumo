import { createMarkdownRenderer } from '../../editor/markdown/rendering'
import { imageDestination, type MarkdownResources } from '../../editor/markdown/images'
import { sanitizeHtml } from '../../editor/markdown/html/SafeHtmlRenderer'
import { LanguageSupport } from '@codemirror/language'
import { syntaxSpans } from '../../editor/core/syntaxSpans'
import { fenceLanguage, loadLanguage } from '../../editor/languages'

export interface RenderResult {
  title: string
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
): Promise<RenderResult> {
  const title = extractDocumentTitle(markdown)
  const renderer = createMarkdownRenderer()
  // Export is a single static snapshot. Await parsers instead of relying on
  // the preview renderer's later re-render callback (which never runs here).
  const parsed=renderer.parse(markdown,{})
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
  let rendered = renderer.render(markdown)

  // If in browser / DOM environment, process interactive features
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<div>${rendered}</div>`, 'text/html')
    const container = doc.body.firstElementChild as HTMLElement

    // 1. Process Mermaid diagrams if any exist
    const mermaidBlocks = container.querySelectorAll<HTMLElement>('pre > code.language-mermaid')
    if (mermaidBlocks.length > 0) {
      try {
        const { compileSafeMermaidSvg } = await import('../../editor/markdown/wysiwyg/renderers')
        for (const block of Array.from(mermaidBlocks)) {
          const source = block.textContent || ''
          try {
            const cleanSvg = await compileSafeMermaidSvg(source, { theme: 'default', useCache: true })
            const wrapper = doc.createElement('div')
            wrapper.className = 'markumo-diagram-export'
            wrapper.innerHTML = cleanSvg
            block.parentElement?.replaceWith(wrapper)
          } catch (e) {
            console.warn('Mermaid export render fallback:', e)
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
    if (embedImages && resources) {
      const images = container.querySelectorAll<HTMLImageElement>('img')
      for (const img of Array.from(images)) {
        const src = img.getAttribute('src') || ''
        if (!src || src.startsWith('data:')) continue

        const dest = imageDestination(src)
        if (dest.kind === 'local') {
          try {
            const bytes = await resources.loadLocal(dest.path)
            const dataUri = uint8ArrayToDataUri(bytes)
            img.setAttribute('src', dataUri)
          } catch (e) {
            console.warn(`Export: Could not embed local image "${src}":`, e)
          }
        }
      }
    }
    rendered = container.innerHTML
  }

  // 4. Sanitize final HTML to ensure strict XSS safety
  const cleanHtml = cleanHtmlForExport(rendered)

  return {
    title,
    bodyHtml: cleanHtml,
  }
}

function uint8ArrayToDataUri(bytes: Uint8Array): string {
  let mimeType = 'image/png'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    mimeType = 'image/png'
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg'
  } else if (bytes[0] === 0x47 && bytes[1] === 0x49) {
    mimeType = 'image/gif'
  } else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    mimeType = 'image/webp'
  }

  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}
