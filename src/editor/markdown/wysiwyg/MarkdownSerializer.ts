import { MarkdownSerializer, defaultMarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown'
import { Fragment, type Mark, type Node } from 'prosemirror-model'
import { markdownSchema } from './MarkdownSchema'
import { controlledImageHtml, parseControlledImageHtml } from './imageHtml'
import { tableRow } from '../tableModel'
import { tokenizer, sameBlockSemantics } from './MarkdownParser'

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
  open(state: { write: (text: string) => void; inAutolink?: boolean } & Record<string, unknown>, mark: Mark, parent: Node, index: number) {
    const plain = isPlainAutolink(mark, parent, index)
    const kind: LinkKind = plain ? (mark.attrs.autolink as LinkKind) : 'none'
    state.markumoLinkKind = kind
    state.inAutolink = plain
    return kind === 'angle' ? '<' : kind === 'bare' ? '' : '['
  },
  close(state: { inAutolink?: boolean } & Record<string, unknown>, mark: Mark) {
    const kind = state.markumoLinkKind as LinkKind | undefined
    state.markumoLinkKind = undefined
    state.inAutolink = undefined
    if (kind === 'angle') return '>'
    if (kind === 'bare') return ''
    return '](' + String(mark.attrs.href ?? '').replace(/[()"]/g, '\\$&') +
      (mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : '') + ')'
  },
  mixable: true,
}

export const markdownSerializer = new MarkdownSerializer({ ...defaultMarkdownSerializer.nodes,
  soft_break(state){state.write('\n')},
  math_inline(state,node){state.write(node.attrs.opening+node.attrs.latex+node.attrs.closing)},
  footnote_reference(state,node){state.write('[^'+node.attrs.label+']')},
  html_block(state,node){state.write(node.attrs.source);state.closeBlock(node)},
  html_inline(state,node){state.write(node.attrs.source)},
  protected_source(state,node){state.text(node.attrs.source,false);state.closeBlock(node)},
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
    if (original && ['src', 'alt', 'title', 'width', 'height', 'align', 'zoom'].every(key => (original[key as keyof typeof original] ?? null) === (node.attrs[key] ?? null))) {
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
      height: node.attrs.height,
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
    state.write(fence+node.attrs.params+'\n');state.text(node.textContent,false);state.text('\n'+fence,false);state.closeBlock(node)
  },
  // text(false) writes each line through the state's container delimiter.
  // write(multiline) only prefixes the first row, breaking lists/quotes on reload.
  table(state,node){state.text(serializeTable(node),false);state.closeBlock(node)},
}, {...defaultMarkdownSerializer.marks, link: markumoLink as never, strike:{open:'~~',close:'~~',mixable:true,expelEnclosingWhitespace:true}})

// Copying a fragment can omit its definitions. Saving a document block can
// keep its references because the definitions remain in the source document.
const sourceSerializer = new MarkdownSerializer({
  ...markdownSerializer.nodes,
  image(state, node, parent, index) {
    if (node.attrs.referenceLabel && !node.attrs.htmlSource) {
      state.write(`![${state.esc(node.attrs.alt || '')}][${node.attrs.referenceLabel}]`)
      return
    }
    markdownSerializer.nodes.image(state, node, parent, index)
  },
}, {
  ...markdownSerializer.marks,
  link: {
    ...markumoLink,
    close(state: Parameters<typeof markumoLink.close>[0], mark: Mark) {
      const suffix = markumoLink.close(state, mark)
      return mark.attrs.referenceLabel ? `][${mark.attrs.referenceLabel}]` : suffix
    },
  } as never,
})

// A structural edit can expose whitespace or Markdown delimiters at a line
// edge. Encode those bytes only when the ordinary serializer cannot round-trip.
type ListSerializerState = MarkdownSerializerState & { inAutolink?: boolean; flushClose(size: number): void }
const emphasisMark = (mark: Mark) => ['em', 'strong', 'strike'].includes(mark.type.name)
const boundaryEntity = (value: string) => Array.from(value, char => `&#${char.codePointAt(0)};`).join('')
const escapedSourceSerializer = new MarkdownSerializer({
  ...sourceSerializer.nodes,
  text(state, node, parent, index) {
    if (!parent.isTextblock || (state as ListSerializerState).inAutolink) {
      defaultMarkdownSerializer.nodes.text(state, node, parent, index)
      return
    }
    const isBreak = (name: string) => name === 'hard_break' || name === 'soft_break'
    const start = index === 0 || isBreak(parent.child(index - 1).type.name)
    const end = index === parent.childCount - 1 || isBreak(parent.child(index + 1).type.name)
    const text = node.text!
    const marked = node.marks.some(emphasisMark)
    let head = start || marked ? /^[ \t]+/.exec(text)?.[0] ?? '' : ''
    let tail = end || marked ? /[ \t]+$/.exec(text.slice(head.length))?.[0] ?? '' : ''
    let content = text.slice(head.length, text.length - tail.length)
    const before = parent.maybeChild(index - 1), after = parent.maybeChild(index + 1)
    // Entity-encoded spaces inside emphasis are punctuation to the delimiter
    // scanner. Encode the touching character too when it would block the span.
    if (!head && before?.isText && /[ \t]$/.test(before.text!) && before.marks.some(emphasisMark)) {
      head = Array.from(content)[0] ?? ''
      content = content.slice(head.length)
    }
    if (!tail && after?.isText && /^[ \t]/.test(after.text!) && after.marks.some(emphasisMark)) {
      tail = Array.from(content).at(-1) ?? ''
      content = content.slice(0, content.length - tail.length)
    }
    const body = state.esc(content, start && !head)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\\\[/g, '&#91;')
      .replace(/^(\d+)\) /, start && !head ? '$1\\) ' : '$1) ')
    state.text(boundaryEntity(head) + body + boundaryEntity(tail), false)
  },
  list_item(state, node, parent) {
    if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] ')
    node.forEach((child, _, index) => {
      if (parent.attrs.tight && index && ['heading', 'code_block', 'blockquote', 'callout'].includes(child.type.name)) {
        (state as ListSerializerState).flushClose(1)
      }
      state.render(child, node, index)
    })
  },
  ordered_list(state, node) {
    const start = node.attrs.order ?? 1
    const width = String(Math.min(start + node.childCount - 1, 999999999)).length
    state.renderList(node, ' '.repeat(width + 2), index => String(Math.min(start + index, 999999999)).padStart(width) + '. ')
  },
}, {
  ...sourceSerializer.marks,
  em: { ...sourceSerializer.marks.em, expelEnclosingWhitespace: false },
  strong: { ...sourceSerializer.marks.strong, expelEnclosingWhitespace: false },
  strike: { ...sourceSerializer.marks.strike, expelEnclosingWhitespace: false },
  link: { ...sourceSerializer.marks.link, mixable: false },
})

function wrapFormattingInLinks(node: Node): Node {
  if (node.isInline) {
    const link = markdownSchema.marks.link.isInSet(node.marks)
    // `[*text*](url)` can follow a word directly. `*[text](url)*` can
    // instead parse as literal asterisks after a join removes the separator.
    return link && node.marks[0] !== link ? node.mark([link, ...link.removeFromSet(node.marks)]) : node
  }
  return node.isLeaf ? node : node.copy(Fragment.fromArray(node.content.content.map(wrapFormattingInLinks)))
}

export function serializeEscapedBlock(node: Node) {
  return escapedSourceSerializer.serialize(markdownSchema.nodes.doc.create(null, wrapFormattingInLinks(node)))
}

export function escapeUnescapedPipes(text: string): string {
  return text.replace(/\|/g, (_pipe, offset: number) => {
    let slashes = 0
    for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) slashes++
    return slashes % 2 === 1 ? '|' : '\\|'
  })
}

export function serializeInlineFragment(fragment: Fragment): string {
  return markdownSerializer.serialize(
    markdownSchema.nodes.doc.create(null, markdownSchema.nodes.paragraph.create(null, fragment))
  )
}

export function serializeBlock(node:Node){return sourceSerializer.serialize(markdownSchema.nodes.doc.create(null,node))}
export function serializeCell(node:Node){return escapeUnescapedPipes(markdownSerializer.serialize(markdownSchema.nodes.doc.create(null,node.content)).replace(/\\\n/g,'<br>').replace(/\n/g,'<br>'))}
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

/** Patch tables inside containers without reserializing list markers, gaps or siblings. */
export function patchContainedTables(old:Node,next:Node,raw:string):string|null {
  const changes: {before:Node;after:Node;ordinal:number}[]=[]
  let ordinal=0
  const walk=(a:Node,b:Node):boolean=>{
    if(a.type.name==='table'){
      const index=ordinal++
      if(!a.eq(b))changes.push({before:a,after:b,ordinal:index})
      return b.type===a.type
    }
    if(!a.sameMarkup(b)||a.childCount!==b.childCount)return false
    if(a.isText)return a.eq(b)
    for(let i=0;i<a.childCount;i++)if(!walk(a.child(i),b.child(i)))return false
    return true
  }
  if(!walk(old,next)||!changes.length)return null
  const maps=tokenizer.parse(raw,{}).filter(t=>t.type==='table_open').map(t=>t.map!)
  const lines=raw.split('\n'), starts=[0]
  for(const line of lines)starts.push(starts[starts.length-1]+line.length+1)
  for(const change of changes.reverse()){
    const map=maps[change.ordinal]
    if(!map)return null
    const selected=lines.slice(map[0],map[1])
    const prefixes=selected.map(line=>line.match(/^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?/)![0])
    const bare=selected.map((line,i)=>line.slice(prefixes[i].length)).join('\n').replace(/\r/g,'')
    const patched=patchTable(change.before,change.after,bare)??serializeTable(change.after)
    const continuation=prefixes[1]??prefixes[0].replace(/[-+*]|\d+[.)]/g,m=>' '.repeat(m.length))
    const replacement=patched.split('\n').map((line,i)=>(prefixes[i]??continuation)+line).join('\n')
    const from=starts[map[0]],to=map[1]<lines.length?starts[map[1]]-1:raw.length
    raw=raw.slice(0,from)+replacement+raw.slice(to)
  }
  return raw
}

/** Prove table semantics AND their container paths survive canonical source. */
export function sameTables(a:Node,b:Node):boolean {
  const tables=(root:Node)=>{
    const result:{path:string;node:Node}[]=[]
    const walk=(node:Node,path:string)=>{
      if(node.type.name==='table'){result.push({path,node});return}
      node.forEach((child,_,index)=>walk(child,`${path}/${node.type.name}:${index}`))
    }
    walk(root,'');return result
  }
  const left=tables(a),right=tables(b)
  return left.length===right.length&&left.every((table,i)=>table.path===right[i].path&&sameBlockSemantics(table.node,right[i].node))
}
