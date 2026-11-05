import { AllSelection, TextSelection, type EditorState, type Selection } from 'prosemirror-state'
import { DOMSerializer, Fragment, Slice, type Node } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { CellSelection } from 'prosemirror-tables'
import { parser as lezerMarkdownParser } from '@lezer/markdown'
import MarkdownIt from 'markdown-it'
import { installCjkEmphasis } from '../cjkEmphasis'
import DOMPurify from 'dompurify'
import { sanitizeMarkup } from '../html/sanitize'
import { markdownSyntaxExtensions } from '../semantics'
import { markdownSerializer } from './MarkdownSerializer'
import { parseMarkdown, sameBlockSemantics } from './MarkdownParser'
import { sourceTextPosition } from './patchSourceBlock'
import { crossesTableCells } from './tableTextSelection'
import type { MarkdownSourceBridge } from './MarkdownSourceBridge'
import type { MarkdownClipboardSettings } from './contracts'
import { textClipboard, writeRichClipboard } from '../../../features/shell/clipboard'

export type LiveClipboardOperation =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'select-all'
  | 'markdown'
  | 'html'
  | 'simplified'
  | 'paste-plain'

// The serializer deliberately preserves auto-links as bare Markdown URLs.
// Re-rendering clipboard HTML must recognize those links just like Live/preview.
const renderer = new MarkdownIt({ html: false, linkify: true })
installCjkEmphasis(renderer)
const inlineSyntaxParser = lezerMarkdownParser.configure(markdownSyntaxExtensions)
const LEZER_NAME_TO_KIND: Record<string, string> = {
  InlineCode: 'code',
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'strike',
}

/** True only when clipboard HTML contains genuine rich document semantics (not IDE/terminal code wrappers). */
export function hasSemanticRichHtml(html: string): boolean {
  if (!html) return false
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // VS Code / Monaco / JetBrains code copy wraps plain text in <div style="font-family:..."><span style="color:...">
  return !!doc.body.querySelector(
    'strong, b, em, i, s, del, strike, code, a[href], h1, h2, h3, h4, h5, h6, ul, ol, li, table, thead, tbody, tr, td, th, blockquote, img[src], hr'
  )
}

function navigateChildPath(root: Node, indices: number[]): Node | null {
  let cur: Node = root
  for (const idx of indices) {
    if (idx < 0 || idx >= cur.childCount) return null
    cur = cur.child(idx)
  }
  return cur
}

/** Keep the selected ancestors (list/quote/heading attributes), but exclude
 * boundary textblocks whose content never entered the range. Ascending through
 * first/last children also avoids empty quote and list wrappers at the edges. */
function selectedBlockContent(selection: TextSelection): Fragment {
  const { $from, $to } = selection
  let from = selection.from
  let to = selection.to
  if ($from.parent.isTextblock && $from.parent.content.size > 0 && $from.parentOffset === $from.parent.content.size) {
    let depth = $from.depth
    while (depth > 1 && $from.index(depth - 1) === $from.node(depth - 1).childCount - 1) depth--
    from = $from.after(depth)
  }
  if ($to.parent.isTextblock && $to.parentOffset === 0) {
    let depth = $to.depth
    while (depth > 1 && $to.index(depth - 1) === 0) depth--
    to = $to.before(depth)
  }
  if (from >= to) return Fragment.empty
  const selected = $from.doc.slice(from, to, true).content
  const start = $from.doc.resolve(from)
  // Slicing the second item of an ordered list keeps the list's attributes.
  // Advance its starting number to the first actually selected item, including
  // nested lists on the open left edge. Fully selected lists stay untouched.
  const numberedStart = (node: Node, depth: number): Node => {
    if (depth > start.depth || node.type !== start.node(depth).type) return node
    const first = node.firstChild
    const content = first
      ? Fragment.from(numberedStart(first, depth + 1)).append(node.content.cut(first.nodeSize))
      : node.content
    const attrs =
      node.type.name === 'ordered_list' ? { ...node.attrs, order: node.attrs.order + start.index(depth) } : node.attrs
    return node.type.create(attrs, content, node.marks)
  }
  return selected.firstChild
    ? Fragment.from(numberedStart(selected.firstChild, 1)).append(selected.cut(selected.firstChild.nodeSize))
    : selected
}

/** The logical source line, never a soft-wrapped screen row. */
function lineSelection(state: EditorState): Selection {
  const { $from } = state.selection
  if (!$from.parent.isTextblock) return state.selection
  const text = $from.parent.textBetween(0, $from.parent.content.size, '\n', node =>
    /^(soft_break|hard_break)$/.test(node.type.name) ? '\n' : '\ufffc'
  )
  const start = $from.parentOffset ? text.lastIndexOf('\n', $from.parentOffset - 1) + 1 : 0
  const newline = text.indexOf('\n', $from.parentOffset)
  const end = newline < 0 ? text.length : newline + 1
  return TextSelection.create(state.doc, $from.start() + start, $from.start() + end)
}

function tryExtractAuthoritativeSourceSlice(
  selection: TextSelection,
  bridge: MarkdownSourceBridge,
  markdownContent: Fragment
): string | null {
  if (!markdownContent.childCount) return null
  const { $from, $to } = selection
  if ($from.depth < 1 || $to.depth < 1) return null

  const firstTop = $from.doc.child($from.index(0))
  const lastTop = $to.doc.child($to.index(0))
  const firstBlock = bridge.blocks.find(b => b.id === firstTop.attrs.sourceId)
  const lastBlock = bridge.blocks.find(b => b.id === lastTop.attrs.sourceId)
  if (!firstBlock || !lastBlock) return null

  const atBlockStart = $from.depth === 1 ? true : $from.parentOffset === 0 && $from.pos === $from.start(1) + ($from.depth - 1)
  const atBlockEnd =
    $to.depth === 1
      ? true
      : $to.parentOffset === $to.parent.content.size && $to.pos === $to.end(1) - ($to.depth - 1)

  const rawStart = atBlockStart ? firstBlock.from : bridge.sourcePosition(selection.from)
  const rawEnd = atBlockEnd ? lastBlock.to : bridge.sourcePosition(selection.to)
  if (rawStart < 0 || rawEnd <= rawStart || rawEnd > bridge.source.length) return null

  const slice = bridge.source.slice(rawStart, rawEnd)
  if (!slice) return null

  // A selection edge can sit exactly on a block terminator, which would leave a
  // leading or trailing blank line in the slice. Prefer the trimmed spellings,
  // but only accept one that parses back to the selected slice semantics.
  const candidates = [
    slice.replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
    slice.replace(/^\r?\n/, ''),
    slice.replace(/\r?\n$/, ''),
    slice,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = parseMarkdown(candidate, {}).doc
      if (parsed.childCount !== markdownContent.childCount) continue
      let same = true
      for (let i = 0; i < parsed.childCount && same; i++) {
        if (!sameBlockSemantics(parsed.child(i), markdownContent.child(i))) same = false
      }
      if (same) return candidate
    } catch {
      // Try the next spelling
    }
  }
  return null
}

export class LiveClipboard {
  constructor(
    private view: EditorView,
    private settings: () => MarkdownClipboardSettings,
    private bridge: () => MarkdownSourceBridge,
    private editable: () => boolean,
    private alive: () => boolean
  ) {}

  private selection(state: EditorState) {
    return state.selection.empty && this.settings().copyWholeLine ? lineSelection(state) : state.selection
  }

  content(state = this.view.state) {
    const selection = this.selection(state)
    if (selection.empty) return null
    const slice = selection.content()
    const full = selection instanceof AllSelection
    const singleCell = selection instanceof CellSelection && selection.$anchorCell.pos === selection.$headCell.pos
    const cellNode = singleCell ? selection.$anchorCell.nodeAfter : null
    const acrossCells = selection instanceof TextSelection && crossesTableCells(selection)
    const inline =
      selection instanceof TextSelection && selection.$from.sameParent(selection.$to) && selection.$from.parent.isTextblock
    const crossesBlocks = selection instanceof TextSelection && !selection.$from.sameParent(selection.$to)
    let selected = inline
      ? Fragment.from(selection.$from.parent.cut(selection.$from.parentOffset, selection.$to.parentOffset))
      : crossesBlocks && !acrossCells
        ? selectedBlockContent(selection)
        : slice.content
    if (selected.lastChild?.attrs.editorTrailing) {
      selected = selected.cut(0, selected.size - selected.lastChild.nodeSize)
    }
    if (selection instanceof CellSelection && selected.firstChild?.type.spec.tableRole === 'row') {
      selected = Fragment.from(state.schema.nodes.table.create(null, selected))
    }
    const table =
      !singleCell && !acrossCells && selected.childCount === 1 && selected.firstChild?.type.spec.tableRole === 'table'
        ? selected.firstChild
        : null
    let markdownContent = selected
    if (table && table.firstChild?.firstChild?.type.spec.tableRole !== 'header_cell') {
      const headers: Node[] = []
      table.firstChild?.forEach(cell =>
        headers.push(state.schema.nodes.table_header.create(cell.attrs, state.schema.nodes.paragraph.create()))
      )
      const header = state.schema.nodes.table_row.create(null, headers)
      markdownContent = Fragment.from(table.copy(Fragment.from(header).append(table.content)))
    }
    const leafText = (node: Node) => {
      if (node.type.name === 'image') return node.attrs.alt || ''
      return node.attrs.latex || node.attrs.source || (/^(soft_break|hard_break)$/.test(node.type.name) ? '\n' : '')
    }
    const plain = singleCell
      ? cellNode
        ? cellNode.textBetween(0, cellNode.content.size, '\n', leafText)
        : ''
      : acrossCells
        ? state.doc.textBetween(selection.from, selection.to, '\n', leafText)
        : selected.textBetween(0, selected.size, '\n', leafText)

    const preservedSlice =
      !singleCell && !acrossCells && !full && selection instanceof TextSelection
        ? tryExtractAuthoritativeSourceSlice(selection, this.bridge(), markdownContent)
        : null

    const markdown =
      singleCell || acrossCells
        ? plain
        : full
          ? this.bridge().source
          : (preservedSlice ?? markdownSerializer.serialize(state.schema.nodes.doc.create(null, markdownContent)))

    let rich = renderer.render(markdown)
    if (singleCell && cellNode) {
      const container = document.createElement('div')
      container.appendChild(DOMSerializer.fromSchema(state.schema).serializeFragment(cellNode.content))
      rich = container.innerHTML
    } else if (table) {
      const container = document.createElement('div')
      container.appendChild(DOMSerializer.fromSchema(state.schema).serializeFragment(selected))
      rich = container.innerHTML
    } else if (acrossCells) {
      const native = window.getSelection()
      const container = document.createElement('div')
      if (native && native.rangeCount > 0 && this.view.dom.contains(native.anchorNode)) {
        container.appendChild(native.getRangeAt(0).cloneContents())
      } else {
        for (const line of plain.split('\n')) {
          const paragraph = document.createElement('p')
          paragraph.textContent = line
          container.append(paragraph)
        }
      }
      rich = container.innerHTML
    }
    const html = sanitizeMarkup(DOMPurify, rich, { USE_PROFILES: { html: true } })
    let textblocks = 0
    if (!(selection instanceof TextSelection)) {
      selected.descendants(node => {
        if (node.isTextblock && !node.attrs.editorTrailing) textblocks++
      })
    }
    const useMarkdown =
      !singleCell && !acrossCells && (table || (this.settings().copyAcrossBlocks && (crossesBlocks || textblocks > 1)))
    return { selection, markdown, plain, html, text: useMarkdown ? markdown : plain }
  }

  /** Native Ctrl+C/X and WebView edit commands use the same representations as
   * the app menus. Setting both MIME types avoids copying the editor's UI DOM. */
  event(event: ClipboardEvent, cut: boolean) {
    if (event.target instanceof Element && event.target.closest('input,textarea,.cm-editor')) return false
    if (cut && !this.editable()) {
      event.preventDefault()
      return true
    }
    const content = this.content()
    if (!content || !event.clipboardData) return false
    event.preventDefault()
    event.clipboardData.setData('text/plain', content.text)
    event.clipboardData.setData('text/html', content.html)
    if (cut) this.remove(content.selection)
    return true
  }

  /**
   * Handle native DOM `paste` events consistently with `run('paste')`:
   * plain text and IDE/terminal code-styled HTML wrappers (`<div><span>`AuthController`</span></div>`)
   * are pasted as Markdown rather than stripped to unmarked plain text and backslash-escaped.
   */
  pasteEvent(event: ClipboardEvent): boolean {
    if (
      event.target instanceof Element &&
      event.target.closest('input,textarea,.cm-editor,.md-inline-source-input')
    ) {
      return false
    }
    if (!this.editable()) {
      event.preventDefault()
      return true
    }
    const data = event.clipboardData
    if (!data) return false
    const plain = data.getData('text/plain')
    if (!plain) return false
    const html = data.getData('text/html')

    if (this.inCodeBlock(this.view.state)) {
      event.preventDefault()
      this.view.dispatch(
        this.view.state.tr.insertText(plain.replace(/\r\n?/g, '\n')).setMeta('isolated', true).scrollIntoView()
      )
      return true
    }

    if (!html || !hasSemanticRichHtml(html)) {
      event.preventDefault()
      this.pasteMarkdownText(plain)
      return true
    }

    return false
  }

  pasteMarkdownText(rawText: string) {
    const state = this.view.state
    const text = rawText.replace(/\r\n?/g, '\n')
    if (!text) return

    if (this.inCodeBlock(state)) {
      this.view.dispatch(state.tr.insertText(text).setMeta('isolated', true).scrollIntoView())
      return
    }

    const bridge = this.bridge()
    const { $from, $to } = state.selection

    // Single-line paste inside one textblock: try localized source patch first so both
    // the pasted Markdown spelling AND all surrounding block syntax remain untouched!
    if (
      !text.includes('\n') &&
      $from.sameParent($to) &&
      $from.parent.isTextblock &&
      !$from.parent.type.spec.code &&
      $from.depth >= 1 &&
      $from.marks().length === 0 &&
      $to.marks().length === 0
    ) {
      const topNode = state.doc.child($from.index(0))
      const block = bridge.blocks.find(b => b.id === topNode.attrs.sourceId)
      if (block) {
        const from = bridge.sourcePosition(state.selection.from)
        const to = bridge.sourcePosition(state.selection.to)
        if (from >= block.from && to <= block.to && from <= to) {
          const relFrom = from - block.from
          const relTo = to - block.from
          const needsLeadingSpace =
            $from.parent.childCount === 0 && /(?:^|\n)[ \t]*(?:[-+*]|\d+[.)]|>+)$/.test(block.raw.slice(0, relFrom))
          const needsTrailingSpace =
            topNode.type.name === 'table' && $from.parent.childCount === 0 && block.raw[relTo] === '|'
          const effectiveInsert = (needsLeadingSpace ? ' ' : '') + text + (needsTrailingSpace ? ' ' : '')
          const candidateRaw = block.raw.slice(0, relFrom) + effectiveInsert + block.raw.slice(relTo)

          const parsed = parseMarkdown(candidateRaw, bridge.environment)
          if (parsed.blocks.length === 1) {
            const pathIndices: number[] = []
            for (let d = 1; d < $from.depth; d++) pathIndices.push($from.index(d))
            const parsedTop = parsed.blocks[0].node
            const parsedTB = navigateChildPath(parsedTop, pathIndices)
            if (parsedTB && parsedTB.isTextblock && parsedTB.type === $from.parent.type) {
              const topStart = $from.before(1)
              const simulatedTop = topNode.replace(
                $from.start() - topStart - 1,
                $from.end() - topStart - 1,
                new Slice(parsedTB.content, 0, 0)
              )
              if (sameBlockSemantics(parsedTop, simulatedTop)) {
                const tbStart = $from.start()
                const tbEnd = $from.end()
                const newRawCaret = relFrom + (needsLeadingSpace ? 1 : 0) + text.length
                const tr = state.tr.replaceWith(tbStart, tbEnd, parsedTB.content)
                const mappedDisplay = sourceTextPosition(parsedTop, candidateRaw, newRawCaret, true)
                const docCaret = Math.max(tbStart, Math.min(tbStart + parsedTB.content.size, topStart + 1 + mappedDisplay))

                let formattingMeta: { kind: string; spanFrom: number; spanTo: number } | null = null
                inlineSyntaxParser.parse(candidateRaw).iterate({
                  enter(node) {
                    const kind = LEZER_NAME_TO_KIND[node.name]
                    if (!kind) return
                    if (node.from <= newRawCaret && node.to >= relFrom + (needsLeadingSpace ? 1 : 0) && newRawCaret === node.to) {
                      formattingMeta = { kind, spanFrom: node.from, spanTo: node.to }
                      return false
                    }
                  },
                })

                tr.setSelection(TextSelection.near(tr.doc.resolve(docCaret)))
                  .setStoredMarks(null)
                  .setMeta('inlineSourcePatch', { from, to, insert: effectiveInsert, blockId: block.id })
                  .setMeta('isolated', true)
                  .scrollIntoView()

                if (formattingMeta) {
                  const fm: { kind: string; spanFrom: number; spanTo: number } = formattingMeta
                  const spanDisplayStart = topStart + 1 + sourceTextPosition(parsedTop, candidateRaw, fm.spanFrom, true)
                  const safePos = Math.max(tbStart, Math.min(tbStart + parsedTB.content.size, spanDisplayStart + 1))
                  tr.setMeta('inlineFormattingEdit', {
                    pos: safePos,
                    kind: fm.kind,
                    offset: newRawCaret - fm.spanFrom,
                  })
                }

                this.view.dispatch(tr)
                return
              }
            }
          }
        }
      }
    }

    const parsedDoc = parseMarkdown(text, bridge.environment).doc
    // Block-level Markdown must not be merged into the surrounding paragraph:
    // `Slice.maxOpen` would fold a pasted heading's text into the paragraph and
    // drop its `##` marker. Split the current textblock instead so the pasted
    // source keeps its own block structure, falling back when the container
    // (for example a table cell) cannot hold block nodes.
    const blockInserted = this.replaceTextblockWithBlocks(state, parsedDoc)
    if (blockInserted) {
      this.view.dispatch(blockInserted.setMeta('isolated', true).scrollIntoView())
      return
    }
    this.view.dispatch(state.tr.replaceSelection(Slice.maxOpen(parsedDoc.content)).setMeta('isolated', true).scrollIntoView())
  }

  /** Insert parsed blocks by splitting the current textblock, keeping the text before/after the caret. */
  private replaceTextblockWithBlocks(state: EditorState, parsed: Node) {
    if (!parsed.childCount) return null
    if (parsed.childCount === 1 && parsed.firstChild!.isTextblock && parsed.firstChild!.type.name === 'paragraph') {
      // A single paragraph is inline Markdown; the normal slice path keeps its marks.
      return null
    }
    const { $from, $to } = state.selection
    if ($from.depth < 1 || !$from.sameParent($to) || !$from.parent.isTextblock) return null
    const depth = $from.depth
    const container = $from.node(depth - 1)
    const index = $from.index(depth - 1)
    const start = $from.before(depth)
    const end = $to.after(depth)
    const type = $from.parent.type
    const attrs = $from.parent.attrs
    const parts: Node[] = []
    const beforeText = $from.parent.cut(0, $from.parentOffset)
    const afterText = $to.parent.cut($to.parentOffset)
    if (beforeText.content.size) parts.push(type.create(attrs, beforeText.content))
    let pastedSize = 0
    parsed.forEach(node => {
      parts.push(node)
      pastedSize += node.nodeSize
    })
    if (afterText.content.size) parts.push(type.create(attrs, afterText.content))
    const content = Fragment.fromArray(parts)
    if (!container.canReplace(index, index + 1, content)) return null
    const tr = state.tr.replaceWith(start, end, content)
    // Place the caret at the end of the pasted content, before any retained suffix.
    const caretAt = Math.min(
      tr.doc.content.size,
      start + (beforeText.content.size ? beforeText.content.size + 2 : 0) + pastedSize - 1
    )
    return tr.setSelection(TextSelection.near(tr.doc.resolve(caretAt), -1))
  }

  private remove(selection: Selection) {
    this.view.dispatch(
      this.view.state.tr.setSelection(selection).deleteSelection().setMeta('isolated', true).scrollIntoView()
    )
  }

  async run(operation: LiveClipboardOperation) {
    const state = this.view.state
    if (operation === 'select-all') {
      this.view.dispatch(state.tr.setSelection(new AllSelection(state.doc)))
      return
    }
    const mutates = operation === 'cut' || operation === 'paste' || operation === 'paste-plain'
    if (mutates && !this.editable()) return
    if (operation === 'paste' || operation === 'paste-plain') {
      const text = await textClipboard.readText()
      if (!this.alive() || !this.editable()) return
      if (this.view.state !== state) throw new Error('读取剪贴板期间文档或选区变化，已取消粘贴')
      if (!text) return
      if (this.inCodeBlock(state)) {
        this.view.dispatch(state.tr.insertText(text.replace(/\r\n?/g, '\n')).setMeta('isolated', true).scrollIntoView())
        return
      }
      if (operation === 'paste-plain') {
        this.view.dispatch(
          state.tr
            .insertText(text.replace(/\r\n?/g, '\n'))
            .setMeta('pastePlain', true)
            .setMeta('isolated', true)
            .scrollIntoView()
        )
      } else {
        this.pasteMarkdownText(text)
      }
      return
    }
    const content = this.content(state)
    if (!content) return
    if (operation === 'markdown') await textClipboard.writeText(content.markdown)
    else if (operation === 'html') await textClipboard.writeText(content.html)
    else await writeRichClipboard(operation === 'simplified' ? content.plain : content.text, content.html)
    if (operation === 'cut' && this.alive() && this.editable() && this.view.state === state) this.remove(content.selection)
  }

  inCodeBlock(state: EditorState) {
    const { $from, $to } = state.selection
    return $from.parent.type.name === 'code_block' && $from.sameParent($to)
  }
}
