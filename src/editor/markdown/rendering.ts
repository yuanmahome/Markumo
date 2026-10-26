import MarkdownIt from 'markdown-it'
import { syntaxSpans } from '../core/syntaxSpans'
import { LanguageSupport } from '@codemirror/language'
import { fenceLanguage, loadLanguage, type LanguageName } from '../languages'
import { parser } from '@lezer/markdown'
import { imageDestination } from './images'
import { markdownSemantics, markdownSyntaxExtensions } from './semantics'
import { sanitizeHtml } from './html/SafeHtmlRenderer'
import { installMarkdownMath, mathBlockParts } from './mathSemantics'
import { staticCodeLines } from './staticCode'
export interface PreviewSlot { id: string; kind: 'math-inline' | 'math-block' | 'code' | 'diagram' | 'image' | 'task'; source: string; info?: string; alt?: string; from?: number }
export interface PreviewEnvironment extends Record<PropertyKey, unknown> { slots?: PreviewSlot[]; slotPrefix?: string }
export function previewSlot(env: PreviewEnvironment, kind: PreviewSlot['kind'], source: string) {
  env.slots ??= []
  env.slotPrefix ??= `md-${crypto.randomUUID()}`
  const id = `${env.slotPrefix}-${env.slots.length}`
  env.slots.push({ id, kind, source })
  return id
}
const imageParser=parser.configure(markdownSyntaxExtensions)

// Shared semantics: GFM tables/tasks, literal punctuation, visible soft line breaks,
// no raw HTML and no renderer-created network/file resource URLs.
export { markdownSemantics } from './semantics'
export { fenceLanguage } from '../languages'
export function createMarkdownRenderer(onLanguageReady: () => void = () => {}, preview = false) {
  const md = new MarkdownIt(markdownSemantics)
  // Keep the raw spelling of a linkified URL in the rendered text, exactly like
  // the Live editor does. Decoding `%20` here would make the preview disagree
  // with the editable text and with what is stored on disk.
  md.normalizeLinkText = (url: string) => url
  // Export customizes its own renderers. Only the hydrated preview emits math
  // placeholders; static consumers must never silently lose formula source.
  if (preview) installMarkdownMath(md)
  for (const type of ['math_inline', 'math_block']) md.renderer.rules[type] = (tokens, index, _options, env: PreviewEnvironment = {}) => {
    const block = type === 'math_block', token = tokens[index]
    const source = block ? mathBlockParts(token.content)?.value ?? token.content : token.content
    const count = Number(env.mathCount || 0); env.mathCount = count + 1
    if (count >= 256) return `<${block ? 'div' : 'span'} class="md-render-error">公式达到每次预览 256 个预算：${md.utils.escapeHtml(source)}</${block ? 'div' : 'span'}>`
    const id = previewSlot(env, block ? 'math-block' : 'math-inline', source)
    const tag = block ? 'div' : 'span'
    return `<${tag} class="${block ? 'md-math-output' : 'md-inline-math'}" data-md-render="${id}"${token.map ? ` data-source-line="${token.map[0] + 1}"` : ''}></${tag}>`
  }
  const languages = new Map<LanguageName, LanguageSupport | null>()
  const pending = new Set<LanguageName>()
  md.options.highlight = (code, info) => {
    const language = fenceLanguage(info)
    if (code.length > 64 * 1024 || language === 'Plain Text') return ''
    if (!languages.has(language) && !pending.has(language)) {
      pending.add(language)
      void loadLanguage(language,'fence').then(support => { languages.set(language,support instanceof LanguageSupport ? support : null) },()=>languages.set(language,null)).finally(()=>{pending.delete(language);onLanguageReady()})
    }
    const support = languages.get(language)
    if (!support) return ''
    let result = '', position = 0
    for (const {from, to, classes} of syntaxSpans(code, support)) {
      result += md.utils.escapeHtml(code.slice(position,from)) + `<span class="${classes}">${md.utils.escapeHtml(code.slice(from,to))}</span>`; position = to
    }
    return result + md.utils.escapeHtml(code.slice(position))
  }
  md.core.ruler.after('inline','markumo-semantics', state => {
    const images:{source:string;from:number}[]=[]
    if(state.src.length<=1024*1024)imageParser.parse(state.src).iterate({enter(node){
      if(['FencedCode','CodeBlock','Table'].includes(node.name))return false
      if(node.name==='Image'){
        const url=node.node.getChild('URL')
        if(url&&images.length<64)images.push({source:state.src.slice(url.from,url.to),from:node.from})
        return false
      }
    }})
    let imageIndex=0
    let listDepth=0, tableDepth=0
    const items: typeof state.tokens = []
    for (const token of state.tokens) {
      if (token.type==='list_item_open') { listDepth++; items.push(token) }
      if (token.type==='list_item_close') { listDepth--; items.pop() }
      if (preview && listDepth > 0 && (token.type === 'paragraph_open' || token.type === 'paragraph_close')) token.hidden = false
      if (token.type==='table_open') tableDepth++
      if (token.type==='table_close') tableDepth--
      if (token.type!=='inline') continue
      const first=token.children?.[0]
      if (listDepth>0 && first?.type==='text' && /^\[[ xX]\]\s/.test(first.content)) {
        const check = new state.Token('markumo_task','input',0)
        check.meta={checked:/^\[[xX]\]/.test(first.content)}
        first.content=first.content.slice(4);token.children!.unshift(check)
        items.at(-1)?.attrJoin('class', 'md-task')
      }
      for (const child of token.children || []) if (child.type==='image') {
        const candidate=images[imageIndex],source=String(child.attrGet('src')||'')
        const match=tableDepth===0&&candidate&&imageDestination(candidate.source).path===imageDestination(source).path
        child.meta={from:match?candidate.from:undefined,inTable:tableDepth>0}
        if(match)imageIndex++
      }
    }
  })
  md.renderer.rules.markumo_task=(tokens,index,_options,env = {})=> {
    const checked = !!tokens[index].meta?.checked
    if (!preview) return `<input class="md-preview-task" type="checkbox" disabled${checked?' checked':''}>`
    const id = previewSlot(env, 'task', checked ? 'x' : ' ')
    return `<span class="md-task-slot" data-md-render="${id}"></span>`
  }
  md.renderer.rules.image = (tokens, index, _options, env = {}) => {
    const token = tokens[index], source = String(token.attrGet('src') || ''), alt = token.content
    const id = previewSlot(env, 'image', source)
    const slot = (env as PreviewEnvironment).slots!.at(-1)!
    slot.alt = alt
    slot.from = typeof token.meta?.from === 'number' ? token.meta.from : 0
    return `<span class="md-image-slot" data-md-render="${id}"></span>`
  }
  if (preview) {
    md.renderer.rules.table_open = (tokens, index, options, _env, self) => `<div class="md-table-scroll">${self.renderToken(tokens,index,options)}`
    md.renderer.rules.table_close = () => '</table></div>\n'
  }
  md.renderer.rules.fence = (tokens, index, options, env) => {
    const token = tokens[index], code = token.content.replace(/\n$/, '')
    const environment: PreviewEnvironment = env || {}
    const diagram = /^mermaid(?:\s|$)/i.test(token.info)
    const id = previewSlot(environment, diagram ? 'diagram' : 'code', code)
    const slot = environment.slots!.at(-1)!
    slot.info = token.info
    const copyIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 9h11v12H9z M5 15H3V3h12v2"/></svg>`
    const copyButton = `<button type="button" class="md-code-copy" data-md-copy title="复制代码" aria-label="复制代码">${copyIcon}</button>`
    const line = token.map ? ` data-source-line="${token.map[0] + 1}"` : ''
    if (diagram) return `<div class="md-preview-fence md-code-surface" data-md-render="${id}"${line}>${copyButton}<div class="md-diagram" role="img" aria-label="Mermaid 图表">正在渲染图表…</div></div>`
    const visible = code.slice(0, 128 * 1024).split('\n').slice(0, 5000).join('\n')
    let spans: ReturnType<typeof syntaxSpans> = []
    if (!preview) {
      // Static export path: synchronously highlight using loaded language cache.
      options.highlight?.(code, token.info, '')
      const support = languages.get(fenceLanguage(token.info))
      if (support && code.length <= 64 * 1024) spans = syntaxSpans(visible, support)
    }
    // Hydrated SplitPreview renders plain skeleton once and highlights visible fences via bounded queue.
    const rows = staticCodeLines(visible, spans, md.utils.escapeHtml)
    const warning = visible !== code ? '<small>代码预览达到 128 KiB / 5000 行预算；复制仍使用完整代码。</small>' : ''
    const languageClass = token.info.trim().split(/\s+/)[0]
    const codeClass = languageClass ? ` class="${md.utils.escapeHtml(options.langPrefix + languageClass)}"` : ''
    return `<div class="md-preview-fence md-code-surface" data-md-render="${id}"${line}>${copyButton}<pre><code${codeClass}>${rows}</code></pre>${warning}</div>`
  }
  md.renderer.rules.html_block = (tokens, index) => sanitizeHtml(tokens[index].content)
  md.renderer.rules.html_inline = (tokens, index) => sanitizeHtml(tokens[index].content)

  md.core.ruler.after('block', 'markumo_toc', state => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length - 2; i++) {
      if (tokens[i].type === 'paragraph_open' && tokens[i + 1].type === 'inline' && tokens[i + 2].type === 'paragraph_close') {
        const text = tokens[i + 1].content.trim()
        if (/^\[toc\]$/i.test(text)) {
          const tok = new state.Token('toc', 'nav', 0)
          tok.content = text
          tokens.splice(i, 3, tok)
        }
      }
    }
  })

  md.renderer.rules.toc = (_tokens, _index, _options, env) => {
    const headings: { level: number; text: string }[] = []
    const envTokens = (env?.tokens as any[]) || _tokens || []
    for (let i = 0; i < envTokens.length; i++) {
      if (envTokens[i].type === 'heading_open') {
        const level = Number(envTokens[i].tag.slice(1)) || 1
        const inline = envTokens[i + 1]
        headings.push({ level, text: inline?.content || '' })
      }
    }
    const itemsHtml = headings.length
      ? headings.map(h => `<div class="md-toc-item" style="padding-left:${(h.level - 1) * 16}px"><span class="md-toc-text">${md.utils.escapeHtml(h.text)}</span></div>`).join('')
      : '<p class="md-toc-empty">（文档中暂无标题）</p>'
    return `<nav class="md-toc-block md-toc" aria-label="内容目录"><div class="md-toc-header"><span class="md-toc-title">目录</span></div><div class="md-toc-list">${itemsHtml}</div></nav>`
  }

  return md
}
