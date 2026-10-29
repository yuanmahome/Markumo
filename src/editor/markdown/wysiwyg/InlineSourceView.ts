import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { parser } from '@lezer/markdown'
import { markdownSyntaxExtensions } from '../semantics'
import { markdownParser } from './MarkdownParser'
import { parseControlledImageHtml, imagePathPlaceholderOffset } from './imageHtml'
import type { MarkdownSourceBridge, SourcePatch } from './MarkdownSourceBridge'
import { textClipboard } from '../../../features/shell/clipboard'
import type { LiveClipboardOperation } from './LiveClipboard'

const syntax = parser.configure(markdownSyntaxExtensions)
const syntaxNames: Record<string, string> = { link: 'Link', image: 'Image', strong: 'StrongEmphasis', em: 'Emphasis', strike: 'Strikethrough', code: 'InlineCode' }
/** Find a trailing explicit link; the Markdown parser validates its destination,
 * title and nested label. Lezer's shortcut-reference grammar differs here. */
export function completedInlineLink(raw: string, environment: Record<string, unknown>): { from: number; raw: string } | null {
  if (raw.length > 8192) return null
  const escaped = (at: number) => {
    let count = 0
    while (at > 0 && raw[--at] === '\\') count++
    return count % 2 !== 0
  }
  for (let close = raw.lastIndexOf(']('); close > 0; close = raw.lastIndexOf('](', close - 1)) {
    if (escaped(close)) continue
    let depth = 1
    for (let from = close - 1; from >= 0; from--) {
      if (escaped(from)) continue
      if (raw[from] === ']') depth++
      if (raw[from] !== '[') continue
      if (--depth !== 0) continue
      const candidate = raw.slice(from)
      const content = parseInlineSource(candidate, [], environment)
      if (content?.childCount && content.content.every(node => node.isText && node.marks.some(mark => mark.type.name === 'link' && mark.attrs.autolink === 'none'))) {
        return { from, raw: candidate }
      }
      break
    }
  }
  return null
}
export function parseInlineSource(raw: string, inherited: readonly Mark[] = [], environment:Record<string,unknown> = {}): Fragment | null {
  if (raw.length > 8192) return null
  if (!raw) return Fragment.empty
  try {
    const image = parseControlledImageHtml(raw)
    if (image) return Fragment.from(markdownParser.schema.nodes.image.create({ ...image, htmlSource: raw }, null, inherited))
    const doc = markdownParser.parse(raw, {...environment,references:{...environment.references as object}})
    if (doc.childCount !== 1 || doc.firstChild?.type.name !== 'paragraph') return null
    const nodes: PMNode[] = []
    doc.firstChild.forEach(node => {
      let marks = node.marks
      for (const mark of inherited) marks = mark.addToSet(marks)
      nodes.push(node.mark(marks))
    })
    return Fragment.from(nodes)
  } catch { return null }
}

export function inlineSourceRange(bridge: MarkdownSourceBridge, doc: PMNode, from: number, to: number, kind: string): { raw:string; sourceFrom:number; sourceTo:number; inherited:readonly Mark[];blockId:string } | null {
  const expected = doc.slice(from, to).content
  const inherited = expected.firstChild?.marks.filter(mark => mark.type.name !== kind) || []
  if (kind === 'image') {
    const matches = (raw: string) => {
      const content = parseInlineSource(raw, inherited, bridge.environment)
      if (content?.eq(expected)) return true
      // Attribute edits may have rewritten HTML while the atom still retains
      // its previous spelling. Compare image semantics without that spelling.
      const image = content?.firstChild, target = expected.firstChild
      return !!(content?.childCount === 1 && expected.childCount === 1 && image && target && image.type === target.type &&
        (image.attrs.alt ?? '') === (target.attrs.alt ?? '') && (image.attrs.title ?? null) === (target.attrs.title ?? null) &&
        image.type.create({ ...image.attrs, alt: target.attrs.alt, title: target.attrs.title,
          ...(parseControlledImageHtml(raw) ? { htmlSource: target.attrs.htmlSource } : {}),
        }, image.content, image.marks).eq(target))
    }
    // Source syntax and PM atoms share document order, including duplicate
    // images and images nested in lists, quotes and table cells.
    let base = 0
    for (const block of bridge.blocks) {
      if (from >= base + block.node.nodeSize) { base += block.node.nodeSize; continue }
      if (block.raw.length > 1024*1024) return null
      let ordinal = 0, target = -1
      block.node.descendants((child, offset) => {
        if (child.type.name === 'image') {
          if (base + offset + 1 === from) target = ordinal
          ordinal++
        }
      })
      let index = 0, result: {raw:string;sourceFrom:number;sourceTo:number;inherited:readonly Mark[];blockId:string} | null = null
      syntax.parse(block.raw).iterate({ enter(node) {
        const candidate = block.raw.slice(node.from, node.to)
        if (node.name !== 'Image' && !(['HTMLTag', 'HTMLBlock'].includes(node.name) && parseControlledImageHtml(candidate))) return
        if (index++ === target) {
          const raw = block.raw.slice(node.from,node.to)
          if (matches(raw)) result = {
            raw,sourceFrom:block.from+node.from,sourceTo:block.from+node.to,inherited,blockId:block.id,
          }
        }
        return false
      } })
      return result
    }
    return null
  }
  const position = bridge.sourcePosition(from)
  const block = bridge.blocks.find(block => position >= block.from && position <= block.to)
  if (!block || block.raw.length > 32768) return null
  let result: { raw: string; sourceFrom: number; sourceTo: number; inherited: readonly Mark[];blockId:string } | null = null
  const formatNamesToMark: Record<string, string> = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'strike', InlineCode: 'code' }
  syntax.parse(block.raw).iterate({ enter(node) {
    if (result || node.name !== syntaxNames[kind]) return
    let sourceFrom = block.from + node.from, sourceTo = block.from + node.to
    if (position < sourceFrom || position > sourceTo) return
    let raw = block.raw.slice(node.from, node.to)
    let curInherited = inherited
    if (parseInlineSource(raw, curInherited, bridge.environment)?.eq(expected)) {
      let curr = node.node
      while (curr.parent && formatNamesToMark[curr.parent.name]) {
        const p = curr.parent
        const parentMark = formatNamesToMark[p.name]
        const nextInherited = curInherited.filter(m => m.type.name !== parentMark)
        const parentRaw = block.raw.slice(p.from, p.to)
        if (parseInlineSource(parentRaw, nextInherited, bridge.environment)?.eq(expected)) {
          curr = p
          curInherited = nextInherited
          sourceFrom = block.from + p.from
          sourceTo = block.from + p.to
          raw = parentRaw
        } else {
          break
        }
      }
      result = { raw, sourceFrom, sourceTo, inherited: curInherited, blockId: block.id }
    }
  } })
  return result
}

let identity = 0
export type InlineCommand = 'select-all' | 'find' | 'replace' | 'enter' | 'hard-break' | 'bold' | 'italic' | 'strike' | 'inline-code'

// A native inline editing surface keeps the browser's text caret and paragraph
// flow. CodeMirror remains the editor for fenced code, not for a word in prose.
export class InlineSourceView {
  readonly dom = document.createElement('span')
  readonly input = document.createElement('span')
  readonly key = `inline-source-${++identity}`
  private dead = false
  private accepted: string
  private expected: Fragment
  private draft: string
  private composingInput = false
  private status = document.createElement('span')
  private pointerDown=false
  private blurPending=false
  private blurTimer:ReturnType<typeof setTimeout>|undefined
  private insertText: (text: string) => void = () => {}
  private onPointerDown=()=>{this.pointerDown=true}
  private onPointerUp=()=>{
    this.pointerDown=false
    if(this.blurPending)this.blurTimer=setTimeout(()=>this.finishBlur(),16)
  }
  private finishBlur(){
    this.blurPending=false
    if (!this.dead && document.activeElement !== this.input && !this.pending && !this.composing) this.close()
  }
  constructor(
    public from: number, public to: number, public sourceFrom: number, public sourceTo: number,
    readonly kind: string, raw: string, readonly inherited: readonly Mark[], expected: Fragment, environment:()=>Record<string,unknown>,readonly blockId:string,
    private publish: (editor: InlineSourceView, raw: string, content: Fragment) => boolean,
    private close: (focus?: boolean, position?: number) => void, history: (forward: boolean) => void,
    private documentCommand: (command: InlineCommand, selection: {anchor:number;head:number} | null) => void,
  ) {
    this.accepted = this.draft = raw; this.expected = expected
    this.dom.className = `md-local-source md-source-${kind}`
    this.dom.contentEditable = 'false'
    this.input.className = 'md-inline-source-input'
    this.input.contentEditable = 'true'
    this.input.setAttribute('role', 'textbox')
    this.input.setAttribute('aria-label', kind === 'image' ? '图片局部源码' : '行内 Markdown 源码')
    this.input.spellcheck = false
    this.status.className = 'md-inline-source-warning'
    this.status.setAttribute('role','status'); this.status.hidden = true
    this.dom.append(this.input, this.status)
    document.addEventListener('pointerdown',this.onPointerDown,true)
    document.addEventListener('pointerup',this.onPointerUp,true)
    document.addEventListener('pointercancel',this.onPointerUp,true)
    const publishInput = (raw: string, content: Fragment) => {
      const focused = document.activeElement === this.input
      const accepted = this.publish(this, raw, content)
      // Replacing an image atom by incomplete source may move its preceding
      // widget in PM's DOM reconciliation. Keep the editing surface focused.
      if (focused && !this.dead && this.dom.isConnected) this.input.focus({ preventScroll: true })
      return accepted
    }
    const accept = () => {
      if (this.dead || this.composing) return
      this.draft = this.input.innerText.replace(/\r\n?/g, '\n')
      if (this.kind === 'image' && !this.draft.trim()) {
        if (publishInput('', Fragment.empty)) {
          this.accepted = ''
          this.expected = Fragment.empty
          this.close(true, this.from)
          return
        }
      }
      let content = parseInlineSource(this.draft, this.inherited, environment())
      if (this.kind === 'image' && (!content || content.childCount !== 1 || content.firstChild?.type.name !== 'image')) {
        content = Fragment.from(markdownParser.schema.nodes.image_source.create({ source: this.draft }, null, this.inherited))
      }
      const selection = this.selection()
      if (content && publishInput(this.draft, content)) { this.accepted = this.draft; this.expected = content }
      this.dom.classList.toggle('md-local-source-invalid', this.pending)
      this.status.hidden = !this.pending
      this.status.textContent = this.pending ? '此局部修改尚未应用。请修正为行内 Markdown，或按 Esc 取消未应用内容。' : ''
      this.paint()
      if (selection) this.select(selection.anchor, selection.head)
    }
    this.input.oninput = accept
    this.insertText = text => {
      const selection = this.selection()
      if (!selection || this.dead || this.composing) return
      const start = Math.min(selection.anchor, selection.head), end = Math.max(selection.anchor, selection.head)
      this.draft = this.draft.slice(0, start) + text + this.draft.slice(end)
      this.input.textContent = this.draft
      this.select(start + text.length, start + text.length)
      accept()
    }
    this.input.addEventListener('compositionstart', () => { this.composingInput = true })
    this.input.addEventListener('compositionend', () => { this.composingInput = false; accept() })
    this.input.onbeforeinput = event => {
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault(); history(event.inputType === 'historyRedo')
      }
    }
    this.input.onpaste = event => {
      event.preventDefault()
      const selection = this.selection()
      if (!selection) return
      const text = (event.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n')
      this.draft = this.draft.slice(0, Math.min(selection.anchor, selection.head)) + text + this.draft.slice(Math.max(selection.anchor, selection.head))
      this.input.textContent = this.draft
      const at = Math.min(selection.anchor, selection.head) + text.length
      this.select(at, at); accept()
    }
    this.input.onkeydown = event => {
      if (event.isComposing || this.composing) return
      const modifier = event.ctrlKey || event.metaKey
      const command = (name: InlineCommand) => {
        event.preventDefault()
        if (this.pending) return
        const selection = this.selection()
        this.close()
        queueMicrotask(() => this.documentCommand(name, selection))
      }
      if (modifier && ['z','y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); history(event.key.toLowerCase() === 'y' || event.shiftKey); return
      }
      if (modifier && ['a','f','r'].includes(event.key.toLowerCase())) {
        if (this.kind === 'image' && event.key.toLowerCase() === 'a') {
          event.preventDefault(); this.select(0, this.draft.length); return
        }
        command(event.key.toLowerCase() === 'a' ? 'select-all' : event.key.toLowerCase() === 'f' ? 'find' : 'replace')
        return
      }
      if (modifier && (['b','i','`'].includes(event.key.toLowerCase()) || (event.shiftKey && event.key.toLowerCase() === 'x'))) {
        command(event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : event.key === '`' ? 'inline-code' : 'strike'); return
      }
      if (event.key === 'Enter') {
        if (this.kind === 'image') {
          const selection = this.selection()
          if (!selection) return
          if (selection.anchor === this.draft.length && selection.head === this.draft.length) {
            command(event.shiftKey ? 'hard-break' : 'enter')
            return
          }
          event.preventDefault()
          const start = Math.min(selection.anchor, selection.head), end = Math.max(selection.anchor, selection.head)
          this.draft = this.draft.slice(0, start) + '\n' + this.draft.slice(end)
          this.input.textContent = this.draft
          this.select(start + 1, start + 1); accept()
        } else command(event.shiftKey ? 'hard-break' : 'enter')
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (this.pending) { this.draft = this.accepted; this.paint() }
        if (!this.pending) this.close(true)
        return
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !this.draft.trim()) {
        event.preventDefault()
        if (this.kind === 'image') {
          this.publish(this, '', Fragment.empty)
        }
        this.close(true, this.from)
        return
      }
      const sel = this.selection()
      if (!event.shiftKey && sel && sel.anchor === sel.head && !this.pending) {
        if ((event.key === 'ArrowLeft' && sel.head === 0) || (event.key === 'ArrowRight' && sel.head === this.draft.length)) {
          event.preventDefault(); this.close(true, event.key === 'ArrowLeft' ? this.from : this.to)
        }
      }
    }
    this.input.onblur = () => {
      // Removing a source widget on mousedown moves the node under the cursor
      // before click is delivered. Keep geometry until the gesture completes.
      if(this.pointerDown){this.blurPending=true;return}
      queueMicrotask(()=>this.finishBlur())
    }
    this.paint()
  }
  get pending() { return this.draft !== this.accepted }
  get composing() { return this.composingInput }
  async clipboard(operation: LiveClipboardOperation) {
    const selection = this.selection(), draft = this.draft
    if (!selection || this.dead || this.composing) return
    if (operation === 'select-all') { this.select(0, draft.length); return }
    const text = draft.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head))
    const paste = operation === 'paste' || operation === 'paste-plain'
    const inserted = paste ? (await textClipboard.readText()).replace(/\r\n?/g, '\n') : ''
    if (!paste) await textClipboard.writeText(text)
    if (paste || operation === 'cut') {
      const current = this.selection()
      if (this.dead || this.composing || this.draft !== draft || !current || current.anchor !== selection.anchor || current.head !== selection.head) return
      this.insertText(inserted)
    }
  }
  selection() {
    const selection = document.getSelection()
    if (!selection?.anchorNode || !selection.focusNode || !this.input.contains(selection.anchorNode) || !this.input.contains(selection.focusNode)) return null
    const offset = (node: globalThis.Node, at: number) => {
      const range = document.createRange(); range.selectNodeContents(this.input); range.setEnd(node, at); return range.toString().length
    }
    return { anchor: offset(selection.anchorNode, selection.anchorOffset), head: offset(selection.focusNode, selection.focusOffset) }
  }
  private select(anchor: number, head: number) {
    const point = (at: number): [globalThis.Node, number] => {
      const walker = document.createTreeWalker(this.input, NodeFilter.SHOW_TEXT)
      let node: globalThis.Node | null, remaining = Math.max(0, Math.min(at, this.draft.length))
      while ((node = walker.nextNode())) {
        if (remaining <= (node.textContent?.length || 0)) return [node, remaining]
        remaining -= node.textContent?.length || 0
      }
      return [this.input, this.input.childNodes.length]
    }
    const [a, ao] = point(anchor), [h, ho] = point(head)
    document.getSelection()?.setBaseAndExtent(a, ao, h, ho)
  }
  private paint() {
    const ranges: {from:number;to:number;name:string}[] = []
    const classes: Record<string,string> = { StrongEmphasis:'strong', Emphasis:'em', Strikethrough:'strike', InlineCode:'code', Link:'link', Image:'image', URL:'destination', LinkTitle:'destination' }
    syntax.parse(this.draft).iterate({ enter(node) {
      const name = /Mark$/.test(node.name) ? 'delimiter' : classes[node.name]
      if (name) ranges.push({from:node.from,to:node.to,name})
    } })
    const placeholder = this.kind === 'image' ? imagePathPlaceholderOffset(this.draft) : null
    const cuts = [...new Set([0,this.draft.length,...(placeholder === null ? [] : [placeholder]),...ranges.flatMap(r=>[r.from,r.to])])].sort((a,b)=>a-b)
    const fragment = document.createDocumentFragment()
    for (let i=1;i<cuts.length;i++) {
      const span = document.createElement('span'), from=cuts[i-1], to=cuts[i]
      if (from === placeholder) {
        const hint = document.createElement('span'); hint.className = 'md-image-empty-path'; hint.setAttribute('aria-hidden', 'true'); fragment.append(hint)
      }
      span.className = ranges.filter(r=>r.from<=from && r.to>=to).map(r=>`md-raw-${r.name}`).join(' ')
      span.textContent = this.draft.slice(from,to); fragment.append(span)
    }
    this.input.replaceChildren(fragment)
  }
  focus(offset?: number, selectAll = false) {
    this.input.focus({preventScroll:true})
    if (selectAll) this.select(0, this.draft.length)
    else if (this.kind === 'image' && offset === undefined) {
      if (/^!\[(?:\\.|[^\]\\])*\]\(\s*\)$/.test(this.draft)) {
        const path = this.draft.lastIndexOf('(') + 1
        this.select(path, path)
        return
      }
      const alt = /^!\[([^\]]*)\]/.exec(this.draft)
      const at = alt ? 2 : this.draft.length
      this.select(at, alt ? at + alt[1].length : at)
    } else this.select(offset ?? 0, offset ?? 0)
  }
  decorations(doc: PMNode) {
    if (this.dead || this.to > doc.content.size) return DecorationSet.empty
    const decorations = [Decoration.widget(this.kind === 'image' ? this.from : this.to, this.dom, { key:this.key, side:this.kind === 'image' ? -1 : 1, stopEvent:event=>this.kind !== 'image' || event.type !== 'contextmenu', ignoreSelection:true })]
    if (this.kind === 'image' && this.from < this.to) decorations.push(Decoration.node(this.from, this.to, {
      class: doc.nodeAt(this.from)?.type.name === 'image_source' ? 'md-image-draft-covered' : 'md-image-source-open',
    }))
    if (this.kind !== 'image' && this.from < this.to) decorations.push(Decoration.inline(this.from, this.to, { class: 'md-local-source-covered' }))
    return DecorationSet.create(doc, decorations)
  }
  map(tr: Transaction) {
    if (this.dead || !tr.docChanged || tr.getMeta('inlineSourceEditor') === this) return
    const from = tr.mapping.mapResult(this.from, 1), to = tr.mapping.mapResult(this.to, -1)
    const shouldFocus = document.activeElement === this.input || this.dom.contains(document.activeElement)
    if (from.deleted || to.deleted || from.pos > to.pos || !tr.doc.slice(from.pos, to.pos).content.eq(this.expected)) {
      this.close(shouldFocus, from.pos)
    } else {
      this.from = from.pos
      this.to = to.pos
    }
  }
  mapSource(patch: SourcePatch | null, own = false) {
    if (!patch || this.dead || own) return
    if (patch.to <= this.sourceFrom) { const delta = patch.insert.length - (patch.to - patch.from); this.sourceFrom += delta; this.sourceTo += delta }
    else if (patch.from < this.sourceTo) this.close()
  }
  acceptRange(to: number, sourceTo: number, expected?: Fragment) { this.to = to; this.sourceTo = sourceTo; if (expected) this.expected = expected }
  destroy() {
    if (this.dead) return
    this.dead=true
    if(this.blurTimer)clearTimeout(this.blurTimer)
    document.removeEventListener('pointerdown',this.onPointerDown,true)
    document.removeEventListener('pointerup',this.onPointerUp,true)
    document.removeEventListener('pointercancel',this.onPointerUp,true)
    this.dom.remove()
  }
}
