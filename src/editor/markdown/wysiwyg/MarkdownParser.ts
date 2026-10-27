import MarkdownIt from 'markdown-it'
import { inlineHtmlRanges } from './HtmlSourceRanges'
import { MarkdownParser, defaultMarkdownParser } from 'prosemirror-markdown'
import type { Node } from 'prosemirror-model'
import { markdownSchema as s } from './MarkdownSchema'
import { parseControlledImageHtml } from './imageHtml'
import { installMarkdownMath } from '../mathSemantics'
import { blankLineRanges, markdownBlockEnd } from '../blankLines'

export const tokenizer = new MarkdownIt('commonmark', {html:true,linkify:true}).enable(['table','strikethrough','linkify'])
// Markdown-it decodes percent-encoding in a linkified label by default
// (`%20` becomes a space). The editor must keep the exact source spelling: a
// decoded label would be written back to the file on the next edit, silently
// corrupting the URL, and it would also stop the incremental link reconciler
// from locating the raw text. Only the label is affected; `href` is still
// normalised by markdown-it.
tokenizer.normalizeLinkText = (url: string) => url
installMarkdownMath(tokenizer)
// Markdown-it strips its hidden definition tokens before inline parsing. Keep
// the native ranges out-of-band before that step; do not reimplement its grammar.
const referenceDefinitions = new WeakMap<object, ReturnType<typeof tokenizer.parse>>()
tokenizer.core.ruler.before('strip_references', 'markumo_reference_ranges', state => {
  referenceDefinitions.set(state.env, state.tokens.filter(token => token.type === 'reference_definition' && token.level === 0))
})
const tokens = { ...defaultMarkdownParser.tokens,
  table:{block:'table'}, thead:{ignore:true}, tbody:{ignore:true}, tr:{block:'table_row'},
  th:{block:'table_header',getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({align:String(tok.attrGet('style')||'').replace('text-align:','') || null})},
  td:{block:'table_cell',getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({align:String(tok.attrGet('style')||'').replace('text-align:','') || null})},
  s:{mark:'strike'}, softbreak:{node:'soft_break'},
  reference_definition:{ignore:true},
  math_inline:{node:'math_inline',getAttrs:(tok:ReturnType<typeof tokenizer.parse>[number])=>({latex:tok.content})},
  math_block:{block:'protected_source',noCloseToken:true,getAttrs:(tok:ReturnType<typeof tokenizer.parse>[number])=>({source:tok.content})},
  footnote_reference:{node:'footnote_reference',getAttrs:(tok:ReturnType<typeof tokenizer.parse>[number])=>({label:tok.content})},
  html_inline:{node:'html_inline',getAttrs:(tok:ReturnType<typeof tokenizer.parse>[number])=>({source:tok.content})},
  controlled_image:{node:'image',getAttrs:(tok:ReturnType<typeof tokenizer.parse>[number])=>tok.meta},
  html_block:{block:'html_block',noCloseToken:true,getAttrs:(tok:ReturnType<typeof tokenizer.parse>[number])=>({source:tok.content})},
  fence:{block:'code_block',noCloseToken:true,getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({params:tok.info,fence:tok.markup})},
  bullet_list:{...defaultMarkdownParser.tokens.bullet_list,getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({bullet:tok.markup,tight:true})},
  list_item:{block:'list_item',getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({checked:tok.meta?.checked ?? null})},
  callout:{block:'callout',getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({calloutType:tok.meta?.calloutType || 'NOTE',title:tok.meta?.title || ''})},
  toc:{node:'toc',getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({raw:tok.content || '[TOC]'})},
  // Keep the spelling of every link so the serializer can round-trip it. A
  // linkified bare URL stays bare; `<...>` keeps its brackets; an explicit
  // `[text](href)` keeps its own label instead of being rewritten as a URL.
  link:{mark:'link',getAttrs:(tok: ReturnType<typeof tokenizer.parse>[number])=>({
    href:tok.attrGet('href'),
    title:tok.attrGet('title') || null,
    autolink:tok.markup==='linkify'?'bare':tok.markup==='autolink'?'angle':'none',
  })},
}
tokenizer.inline.ruler.before('escape','markumo_footnotes',(state,silent)=>{
  const note=/^\[\^([^\]\n]+)\]/.exec(state.src.slice(state.pos))
  if(!note)return false
  if(!silent){const token=state.push('footnote_reference','sup',0);token.content=note[1]}
  state.pos+=note[0].length;return true
})
// Keep unresolved full/collapsed image references repairable without inventing
// an inline destination. Resolved references still use markdown-it's grammar.
tokenizer.inline.ruler.before('image', 'markumo_missing_image_reference', (state, silent) => {
  const match = /^!\[((?:\\.|[^\]\\\n])*)\]\[([^\]\n]*)\]/.exec(state.src.slice(state.pos))
  if (!match) return false
  const label = (match[2] || match[1]).trim().replace(/\s+/g, ' ').toUpperCase()
  if (state.env.references?.[label]) return false
  if (!silent) {
    const token = state.push('controlled_image', 'img', 0)
    token.meta = { src: '', alt: match[1], unresolvedReference: match[0] }
  }
  state.pos += match[0].length
  return true
})
// Task syntax becomes a real list-item attribute. No checkbox state lives only in DOM.
tokenizer.core.ruler.after('inline','markumo_tasks', state => {
  const stack: typeof state.tokens = []
  for (const token of state.tokens) {
    if(token.type==='list_item_open') stack.push(token)
    if(token.type==='list_item_close') stack.pop()
    if(token.type!=='inline' || !stack.length) continue
    const first=token.children?.[0], match=first?.type==='text' && /^\[([ xX])\] /.exec(first.content)
    if(match){stack[stack.length-1].meta={checked:match[1]!==' '};first!.content=first!.content.slice(match[0].length)}
  }
})
// Consume paired HTML directly from source before Markdown strips delimiters.
// Cache ranges per inline parser state, never search rendered text.
const htmlRanges = new WeakMap<object, ReturnType<typeof inlineHtmlRanges>>()
tokenizer.inline.ruler.before('html_inline','markumo_html_source', (state,silent)=>{
  if(state.src[state.pos]!=='<')return false
  let ranges=htmlRanges.get(state)
  if(!ranges){ranges=inlineHtmlRanges(state.src);htmlRanges.set(state,ranges)}
  const range=ranges.find(range=>range.from===state.pos)
  if(!range)return false
  if(!silent){const token=state.push('html_inline','',0);token.content=state.src.slice(range.from,range.to)}
  state.pos=range.to;return true
})
tokenizer.core.ruler.after('markumo_tasks','markumo_cells', state=>{
  const result:typeof state.tokens=[]
  for(const token of state.tokens){
    if(token.type==='th_close'||token.type==='td_close')result.push(new state.Token('paragraph_close','p',-1))
    result.push(token)
    if(token.type==='th_open'||token.type==='td_open')result.push(new state.Token('paragraph_open','p',1))
  }
  state.tokens=result
})
// The same strict allow-list applies inside mixed paragraphs, lists and cells.
tokenizer.core.ruler.after('markumo_cells', 'markumo_inline_images', state => {
  for (const block of state.tokens) for (const token of block.children ?? []) {
    if (token.type !== 'html_inline') continue
    const image = parseControlledImageHtml(token.content)
    if (image) { token.type = 'controlled_image'; token.meta = { ...image, htmlSource: token.content } }
  }
})
tokenizer.core.ruler.after('markumo_cells', 'markumo_callouts', state => {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open') continue
    let j = i + 1, nesting = 1, closeIdx = -1
    let firstInline: (typeof tokens)[number] | null = null
    let firstParaOpen = -1, firstParaClose = -1

    while (j < tokens.length && nesting > 0) {
      if (tokens[j].type === 'blockquote_open') nesting++
      else if (tokens[j].type === 'blockquote_close') {
        nesting--
        if (nesting === 0) { closeIdx = j; break }
      }
      if (nesting === 1 && tokens[j].type === 'paragraph_open' && firstParaOpen === -1) firstParaOpen = j
      if (nesting === 1 && tokens[j].type === 'inline' && !firstInline) firstInline = tokens[j]
      if (nesting === 1 && tokens[j].type === 'paragraph_close' && firstParaClose === -1) firstParaClose = j
      j++
    }

    if (!firstInline || closeIdx === -1) continue
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]*))?/i.exec(firstInline.content)
    if (!match) continue

    const calloutType = match[1].toUpperCase()
    const title = match[2]?.trim() || ''

    tokens[i].type = 'callout_open'
    tokens[i].tag = 'div'
    tokens[i].meta = { calloutType, title }

    tokens[closeIdx].type = 'callout_close'
    tokens[closeIdx].tag = 'div'

    const fullMatchLen = match[0].length
    firstInline.content = firstInline.content.slice(fullMatchLen).replace(/^\n+/, '')

    if (firstInline.children && firstInline.children.length > 0 && firstInline.children[0].type === 'text') {
      const childMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]*))?/i.exec(firstInline.children[0].content)
      if (childMatch) {
        firstInline.children[0].content = firstInline.children[0].content.slice(childMatch[0].length).replace(/^\n+/, '')
        if (!firstInline.children[0].content && firstInline.children.length > 1) {
          firstInline.children.shift()
        }
      }
    }

    if (!firstInline.content.trim()) {
      if (firstParaClose !== -1 && closeIdx > firstParaClose + 1) {
        tokens.splice(firstParaOpen, firstParaClose - firstParaOpen + 1)
        closeIdx -= (firstParaClose - firstParaOpen + 1)
      } else {
        firstInline.content = ''
        firstInline.children = []
      }
    }
  }
})
tokenizer.core.ruler.after('markumo_callouts', 'markumo_toc', state => {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].type === 'paragraph_open' && tokens[i + 1].type === 'inline' && tokens[i + 2].type === 'paragraph_close') {
      const text = tokens[i + 1].content.trim()
      if (/^\[toc\]$/i.test(text)) {
        const token = new state.Token('toc', 'div', 0)
        token.content = text
        token.map = tokens[i].map
        tokens.splice(i, 3, token)
      }
    }
  }
})
// prosemirror-markdown still declares markdown-it 14 types; the shared runtime
// is markdown-it 15. Only this official adapter boundary needs a type bridge.
export const markdownParser = new MarkdownParser(s, tokenizer as unknown as ConstructorParameters<typeof MarkdownParser>[1], tokens as unknown as ConstructorParameters<typeof MarkdownParser>[2])
export interface SourceBlock { id:string; from:number; to:number; raw:string; prefix:string; node:Node; blank?:boolean }
let identity=0
export function parseMarkdown(source:string, referenceEnvironment:Record<string,unknown> = {}, previous?:{blocks:readonly SourceBlock[];environment:Record<string,unknown>}) {
  const starts=[0]; for(let i=0;i<source.length;i++)if(source[i]==='\n')starts.push(i+1)
  const yaml=/^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/.exec(source)
  const scan=yaml ? yaml[0].replace(/[^\n]/g,' ') + source.slice(yaml[0].length) : source
  const env: Record<string, unknown> = { ...referenceEnvironment, references: { ...referenceEnvironment.references as object } }
  const parsed=tokenizer.parse(scan,env)
  const definitions = referenceDefinitions.get(env) || []
  // Reuse immutable blocks from the current revision only. Tokenization still
  // establishes the new reference environment first; changed references force
  // normal parsing, even when the referring block's raw text is unchanged.
  const reusable=new Map<string,{blocks:SourceBlock[];used:number}>()
  if(previous && JSON.stringify(previous.environment)===JSON.stringify(env)){
    for(const block of previous.blocks){
      const entry=reusable.get(block.raw)
      if(entry)entry.blocks.push(block)
      else reusable.set(block.raw,{blocks:[block],used:0})
    }
  }
  const ranges:{from:number;to:number;raw?:boolean;isHtml?:boolean;label?:string;kind?:string}[]=[]
  if(yaml)ranges.push({from:0,to:yaml[0].replace(/\n$/,'').length,raw:true,label:'YAML Front Matter'})
  let level=0
  for(const token of [...parsed, ...definitions]){
    if(level===0 && token.map){
      const to=markdownBlockEnd(source,starts[token.map[0]],starts[token.map[1]] ?? source.length,token.type==='fence'?token.markup:undefined)
      const reference = token.type === 'reference_definition'
      const footnote = reference && String(token.meta?.label || '').startsWith('^')
      ranges.push({from:starts[token.map[0]],to,raw:token.type==='html_block'||(reference && !footnote),
        kind: reference ? footnote ? 'footnote' : 'reference' : undefined,
        label: reference ? footnote ? '脚注定义' : '链接引用定义' : token.type==='html_block'?'HTML（安全源码）':'扩展语法（保留源码）'})
    }
    level+=token.nesting
  }
  ranges.sort((a,b)=>a.from-b.from)
  const blocks:SourceBlock[]=[]; let cursor=0,hasContent=false
  const addBlanks=(to:number,edge:'start'|'between'|'end')=>{
    for(const range of blankLineRanges(source,cursor,to,edge)){
      const raw=source.slice(range.from,range.to),entry=reusable.get(raw)
      const candidate=entry && entry.used<entry.blocks.length?entry.blocks[entry.used++]:undefined
      const id=candidate?.id || `md-${++identity}`
      const node=candidate?.node || s.nodes.paragraph.create({sourceId:id},range.text?s.text(range.text):undefined)
      blocks.push({id,from:range.from,to:range.to,raw,prefix:source.slice(cursor,range.from),node,blank:true})
      cursor=range.to
    }
  }
  const add=(from:number,to:number,raw:boolean,label='扩展语法（保留源码）',kind?:string)=>{
    const original=source.slice(from,to),entry=reusable.get(original)
    kind ??= /^---\r?\n/.test(original) && from === 0 ? 'yaml' : /^\s*\[\^/.test(original) ? 'footnote'
      : /^\[toc\]$/i.test(original.trim()) ? 'toc' : /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(original) ? 'callout'
      : /^:::+/m.test(original) ? 'extension' : 'unknown'
    const candidate=entry && entry.used<entry.blocks.length?entry.blocks[entry.used++]:undefined
    // Protected blocks can depend on position (notably YAML at document start).
    const reused=!raw && candidate?.node.type.name!=='protected_source'?candidate:undefined
    const id=reused?.id || `md-${++identity}`
    let node:Node
    if(reused)node=reused.node
    else try {
      // A sized/aligned image is the only HTML this editor writes itself, so it
      // must read back as an editable image node rather than an inert HTML
      // block. Anything outside the allow-list stays protected source.
      const controlledImage = parseControlledImageHtml(original)
      const fnMatch = kind === 'footnote' && /^\s*\[\^([^\]]+)\]:\s*([\s\S]*)$/.exec(original)
      if (controlledImage) {
        node = s.nodes.paragraph.create(null, s.nodes.image.create({
          src: controlledImage.src,
          alt: controlledImage.alt,
          title: controlledImage.title,
          width: controlledImage.width,
          align: controlledImage.align,
          zoom: controlledImage.zoom ?? null,
          htmlSource: original.trim(),
        }))
      } else if (fnMatch) {
        const label = fnMatch[1]
        const body = fnMatch[2].trim() || ' '
        const parsed = markdownParser.parse(body, env)
        const content = parsed.childCount ? parsed.content : [s.nodes.paragraph.create()]
        node = s.nodes.footnote_definition.create({ label }, content)
      } else {
        const complex=raw || /(^|\n)(?: {0,3}\$\$|:::+)/i.test(original)
        if(complex) node=s.nodes.protected_source.create({source:original,label,kind})
        else {
          node=markdownParser.parse(original,env).firstChild!
          if(!node)node=s.nodes.protected_source.create({source:original,label,kind})
        }
      }
    }catch{node=s.nodes.protected_source.create({source:original,label,kind})}
    if(!reused)node=node.type.create({...node.attrs,sourceId:id},node.content,node.marks)
    blocks.push({id,from,to,raw:original,prefix:source.slice(cursor,from),node});cursor=to;hasContent=true
  }
  for(const range of ranges){
    if(range.from<cursor)continue
    const gap=source.slice(cursor,range.from)
    if(gap.trim()){const from=cursor+(gap.match(/^\s*/)?.[0].length||0);add(from,range.from-gap.match(/\s*$/)![0].length,true,'引用定义 / 扩展源码')}
    addBlanks(range.from,hasContent?'between':'start')
    add(range.from,range.to,!!range.raw,range.label,range.kind)
  }
  if(source.slice(cursor).trim())add(cursor,source.length,true,'引用定义 / 扩展源码')
  addBlanks(source.length,hasContent?'end':'start')
  // A whitespace-only document also has a final editable position after its
  // persisted paragraph spans. It owns no bytes and is distinct from the
  // editorTrailing entry used after code/table/image nodes.
  if(!hasContent && source.endsWith('\n')){
    const candidate=previous?.blocks.find(block=>block.blank&&block.from===source.length&&block.raw==='')
    const id=candidate?.id || `md-${++identity}`,node=candidate?.node || s.nodes.paragraph.create({sourceId:id})
    blocks.push({id,from:source.length,to:source.length,raw:'',prefix:'',node,blank:true})
  }
  const doc=s.nodes.doc.create(null,blocks.length?blocks.map(b=>b.node):s.nodes.paragraph.create())
  return {doc,blocks,tail:source.slice(cursor),environment:env}
}
