import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown'
import type { Mark, Node } from 'prosemirror-model'
import { markdownSchema } from './MarkdownSchema'
import { controlledImageHtml, parseControlledImageHtml } from './imageHtml'
import { tableRow } from '../tableModel'

type LinkKind = 'bare' | 'angle' | 'none'

/**
 * A bare link may omit its delimiters only while its text still *is* the
 * destination: either the exact URL, or the `www.` form linkify normalizes to
 * an http(s) href. Anything else falls back to `[text](href)` so an edited
 * target is never silently dropped.
 */
function matchesBareDestination(text: string, href: unknown): boolean {
  const target = String(href ?? '')
  if (text === target) return true
  // Markdown-it normalizes the destination of every linkified URL, which
  // percent-encodes non-ASCII and spaces. The painted text stays as typed, so a
  // bare link must compare equal to its own decoded destination too.
  if (text === safeDecodeURI(target)) return true
  if (/^www\./i.test(text)) return target === `http://${text}` || target === `https://${text}` || safeDecodeURI(target) === `http://${text}` || safeDecodeURI(target) === `https://${text}`
  return false
}

function safeDecodeURI(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

function isPlainAutolink(mark: Mark, parent: Node, index: number): boolean {
  const kind = mark.attrs.autolink as LinkKind
  if (kind === 'none' || mark.attrs.title) return false
  const content = parent.child(index)
  if (!content.isText || !matchesBareDestination(content.text ?? '', mark.attrs.href)) return false
  if (content.marks[content.marks.length - 1] !== mark) return false
  // A link that continues into the next text node cannot be a self-contained
  // autolink: the delimiters would be read back as part of the URL.
  return index === parent.childCount - 1 || !mark.isInSet(parent.child(index + 1).marks)
}

/** Serializes links by the spelling the source used, never by accident. */
const markumoLink = {
  open(state: { write: (text: string) => void } & Record<string, unknown>, mark: Mark, parent: Node, index: number) {
    const plain = isPlainAutolink(mark, parent, index)
    const kind: LinkKind = plain ? (mark.attrs.autolink as LinkKind) : 'none'
    state.markumoLinkKind = kind
    return kind === 'angle' ? '<' : kind === 'bare' ? '' : '['
  },
  close(state: Record<string, unknown>, mark: Mark) {
    const kind = state.markumoLinkKind as LinkKind | undefined
    state.markumoLinkKind = undefined
    if (kind === 'angle') return '>'
    if (kind === 'bare') return ''
    return '](' + String(mark.attrs.href ?? '').replace(/[()"]/g, '\\$&') +
      (mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : '') + ')'
  },
  mixable: true,
}

export const markdownSerializer = new MarkdownSerializer({ ...defaultMarkdownSerializer.nodes,
  soft_break(state){state.write('\n')},
  math_inline(state,node){state.write('$'+node.attrs.latex+'$')},
  footnote_reference(state,node){state.write('[^'+node.attrs.label+']')},
  html_block(state,node){state.write(node.attrs.source);state.closeBlock(node)},
  html_inline(state,node){state.write(node.attrs.source)},
  protected_source(state,node){state.write(node.attrs.source);state.closeBlock(node)},
  toc(state, node) {
    state.write(node.attrs.raw || '[TOC]')
    state.closeBlock(node)
  },
  callout(state, node) {
    const type = (node.attrs.calloutType || 'NOTE').toUpperCase()
    const title = node.attrs.title ? ` ${node.attrs.title}` : ''
    state.wrapBlock('> ', null, node, () => {
      state.write(`[!${type}]${title}\n`)
      state.renderContent(node)
    })
    state.closeBlock(node)
  },
  footnote_definition(state, node) {
    const label = node.attrs.label || '1'
    state.write(`[^${label}]: `)
    if (node.childCount > 0 && node.child(0).type.name === 'paragraph') {
      node.child(0).forEach((inlineNode, _, index) => {
        state.render(inlineNode, node.child(0), index)
      })
      for (let i = 1; i < node.childCount; i++) {
        state.write('\n    ')
        state.render(node.child(i), node, i)
      }
    } else {
      state.renderContent(node)
    }
    state.closeBlock(node)
  },
  image(state, node) {
    if (node.attrs.unresolvedReference) { state.write(node.attrs.unresolvedReference); return }
    const original = node.attrs.htmlSource && parseControlledImageHtml(node.attrs.htmlSource)
    if (original && ['src', 'alt', 'title', 'width', 'align', 'zoom'].every(key => (original[key as keyof typeof original] ?? null) === (node.attrs[key] ?? null))) {
      state.write(node.attrs.htmlSource)
      return
    }
    // A sized/aligned image is written as the one allow-listed HTML form this
    // editor can read back. Every attribute is escaped and validated first.
    const controlled = controlledImageHtml({
      src: node.attrs.src ?? '',
      alt: node.attrs.alt || '',
      title: node.attrs.title || null,
      width: node.attrs.width,
      align: node.attrs.align,
      zoom: node.attrs.zoom,
    }, !!node.attrs.htmlSource)
    if (controlled) {
      state.write(controlled)
    } else {
      const src = String(node.attrs.src ?? '')
      const destination = /[\s<>]/.test(src) ? '<' + src.replace(/</g, '%3C').replace(/>/g, '%3E') + '>' : src.replace(/[()\\]/g, '\\$&')
      state.write("![" + state.esc(node.attrs.alt || "") + "](" + destination +
                  (node.attrs.title ? ' "' + String(node.attrs.title).replace(/"/g, '\\"') + '"' : "") + ")")
    }
  },
  image_source(state, node) { state.write(node.attrs.source) },
  list_item(state,node){if(node.attrs.checked!==null)state.write(node.attrs.checked?'[x] ':'[ ] ');state.renderContent(node)},
  code_block(state,node){
    const char=node.attrs.fence?.[0]==='~'||String(node.attrs.params).includes('`')?'~':'`'
    let length=Math.max(3,node.attrs.fence?.length||3)
    for(const match of node.textContent.matchAll(new RegExp(`${char==='`'?'`':'~'}{3,}`,'g')))length=Math.max(length,match[0].length+1)
    const fence=char.repeat(length)
    state.write(fence+node.attrs.params+'\n');state.text(node.textContent,false);state.write('\n'+fence);state.closeBlock(node)
  },
  table(state,node){state.write(serializeTable(node));state.closeBlock(node)},
}, {...defaultMarkdownSerializer.marks, link: markumoLink as never, strike:{open:'~~',close:'~~',mixable:true,expelEnclosingWhitespace:true}})
export function serializeBlock(node:Node){return markdownSerializer.serialize(markdownSchema.nodes.doc.create(null,node))}
export function serializeCell(node:Node){return markdownSerializer.serialize(markdownSchema.nodes.doc.create(null,node.content)).replace(/\\\n/g,'<br>').replace(/\n/g,'<br>').replace(/\|/g,'\\|')}
export function serializeTable(node:Node){
  const lines:string[]=[]
  node.forEach((row,_,i)=>{
    const cells:string[]=[];row.forEach(cell=>{if(cell.attrs.colspan!==1||cell.attrs.rowspan!==1)throw new Error('GFM 不支持合并单元格');cells.push(serializeCell(cell))})
    lines.push('| '+cells.join(' | ')+' |')
    if(i===0){const align:string[]=[];row.forEach(cell=>align.push(cell.attrs.align==='center'?':---:':cell.attrs.align==='right'?'---:':cell.attrs.align==='left'?':---':'---'));lines.push('| '+align.join(' | ')+' |')}
  });return lines.join('\n')
}
/** Preserve the whitespace, delimiters, and untouched inline formatting of every
 * cell when the table shape has not changed. Structural operations serialize
 * only this table, never the surrounding document. */
export function patchTable(old:Node,next:Node,raw:string):string|null {
  if(old.childCount!==next.childCount)return null
  const lines=raw.split('\n'), offsets:number[]=[];let at=0
  for(const line of lines){offsets.push(at);at+=line.length+1}
  const patches:{from:number;to:number;insert:string}[]=[]
  for(let r=0;r<old.childCount;r++){
    const a=old.child(r),b=next.child(r),line=r===0?0:r+1
    if(a.childCount!==b.childCount||!lines[line])return null
    const cells=tableRow(lines[line],offsets[line]).cells
    if(cells.length!==a.childCount)return null
    for(let c=0;c<a.childCount;c++){
      if(a.child(c).eq(b.child(c)))continue
      if(!a.child(c).sameMarkup(b.child(c)))return null
      patches.push({...cells[c],insert:serializeCell(b.child(c))})
    }
  }
  for(const p of patches.reverse())raw=raw.slice(0,p.from)+p.insert+raw.slice(p.to)
  return raw
}
