import { AllSelection, TextSelection, type EditorState, type Selection } from 'prosemirror-state'
import { DOMSerializer, Fragment, Slice, type Node } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { CellSelection } from 'prosemirror-tables'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { markdownSerializer } from './MarkdownSerializer'
import { parseMarkdown } from './MarkdownParser'
import { crossesTableCells } from './tableTextSelection'
import type { MarkdownSourceBridge } from './MarkdownSourceBridge'
import type { MarkdownClipboardSettings } from './contracts'
import { textClipboard, writeRichClipboard } from '../../../features/shell/clipboard'

export type LiveClipboardOperation = 'copy' | 'cut' | 'paste' | 'select-all' | 'markdown' | 'html' | 'simplified' | 'paste-plain'
// The serializer deliberately preserves auto-links as bare Markdown URLs.
// Re-rendering clipboard HTML must recognize those links just like Live/preview.
const renderer = new MarkdownIt({ html: false, linkify: true })

/** Keep the selected ancestors (list/quote/heading attributes), but exclude
 * boundary textblocks whose content never entered the range. Ascending through
 * first/last children also avoids empty quote and list wrappers at the edges. */
function selectedBlockContent(selection: TextSelection): Fragment {
  const { $from, $to } = selection
  let from = selection.from, to = selection.to
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
    const content = first ? Fragment.from(numberedStart(first, depth + 1)).append(node.content.cut(first.nodeSize)) : node.content
    const attrs = node.type.name === 'ordered_list' ? { ...node.attrs, order: node.attrs.order + start.index(depth) } : node.attrs
    return node.type.create(attrs, content, node.marks)
  }
  return selected.firstChild ? Fragment.from(numberedStart(selected.firstChild, 1)).append(selected.cut(selected.firstChild.nodeSize)) : selected
}

/** The logical source line, never a soft-wrapped screen row. */
function lineSelection(state: EditorState): Selection {
  const { $from } = state.selection
  if (!$from.parent.isTextblock) return state.selection
  const text = $from.parent.textBetween(0, $from.parent.content.size, '\n', node => /^(soft_break|hard_break)$/.test(node.type.name) ? '\n' : '\ufffc')
  const start = $from.parentOffset ? text.lastIndexOf('\n', $from.parentOffset - 1) + 1 : 0
  const newline = text.indexOf('\n', $from.parentOffset)
  const end = newline < 0 ? text.length : newline + 1
  return TextSelection.create(state.doc, $from.start() + start, $from.start() + end)
}

export class LiveClipboard {
  constructor(
    private view: EditorView,
    private settings: () => MarkdownClipboardSettings,
    private bridge: () => MarkdownSourceBridge,
    private editable: () => boolean,
    private alive: () => boolean,
  ) {}

  private selection(state: EditorState) {
    return state.selection.empty && this.settings().copyWholeLine ? lineSelection(state) : state.selection
  }

  content(state = this.view.state) {
    const selection = this.selection(state)
    if (selection.empty) return null
    const slice = selection.content()
    const full = selection instanceof AllSelection
    // A one-cell structural selection is not a table copy. Triple click and
    // programmatic single-cell selections must yield the cell's text, never a
    // one-cell Markdown table.
    const singleCell = selection instanceof CellSelection && selection.$anchorCell.pos === selection.$headCell.pos
    const cellNode = singleCell ? selection.$anchorCell.nodeAfter : null
    // Native mouse drags become CellSelection at the cell boundary. A cross-cell
    // TextSelection can still be produced programmatically (or by an external
    // selection API); keep that copy textual rather than inventing unselected
    // cells from the open slice.
    const acrossCells = selection instanceof TextSelection && crossesTableCells(selection)
    // A text selection inside one cell includes open table/row/cell wrappers in
    // its slice. Serialize the selected textblock alone, retaining inline marks
    // without inventing a table header and separators around a copied word.
    const inline = selection instanceof TextSelection && selection.$from.sameParent(selection.$to) && selection.$from.parent.isTextblock
    // Ending at the next textblock's offset zero still selects the paragraph
    // boundary, even though no character in that next block was selected.
    const crossesBlocks = selection instanceof TextSelection && !selection.$from.sameParent(selection.$to)
    let selected = inline ? Fragment.from(selection.$from.parent.cut(selection.$from.parentOffset, selection.$to.parentOffset))
      : crossesBlocks && !acrossCells ? selectedBlockContent(selection) : slice.content
    // The final editing affordance is not a selected source paragraph.
    if (selected.lastChild?.attrs.editorTrailing) selected = selected.cut(0, selected.size - selected.lastChild.nodeSize)
    // Partial rectangular selections contain rows, while a whole-table selection
    // already contains a table. Close the former before invoking the serializer.
    if (selection instanceof CellSelection && selected.firstChild?.type.spec.tableRole === 'row') {
      selected = Fragment.from(state.schema.nodes.table.create(null, selected))
    }
    const table = !singleCell && !acrossCells && selected.childCount === 1 && selected.firstChild?.type.spec.tableRole === 'table' ? selected.firstChild : null
    let markdownContent = selected
    if (table && table.firstChild?.firstChild?.type.spec.tableRole !== 'header_cell') {
      // GFM requires a header. A data-only selection gets an empty header in the
      // Markdown fallback; the HTML copy keeps the original td/th semantics.
      const headers: Node[] = []
      table.firstChild?.forEach(cell => headers.push(state.schema.nodes.table_header.create(cell.attrs, state.schema.nodes.paragraph.create())))
      const header = state.schema.nodes.table_row.create(null, headers)
      markdownContent = Fragment.from(table.copy(Fragment.from(header).append(table.content)))
    }
    // `slice.content` can keep open cell/row wrappers, which would make a
    // cross-cell text copy include unselected cells. Ask the document for the
    // exact range instead; block boundaries become newlines. Structural cell
    // selections keep their table-aware slice text.
    const leafText = (node: Node) => {
      if (node.type.name === 'image') return node.attrs.alt || ''
      return node.attrs.latex || node.attrs.source || (/^(soft_break|hard_break)$/.test(node.type.name) ? '\n' : '')
    }
    const plain = singleCell
      ? cellNode ? cellNode.textBetween(0, cellNode.content.size, '\n', leafText) : ''
      : acrossCells
        ? state.doc.textBetween(selection.from, selection.to, '\n', leafText)
        : selected.textBetween(0, selected.size, '\n', leafText)
    // A partial cross-cell text selection has no exact Markdown table
    // representation: serializing the open slice would add cells the user did
    // not select. Use the selected plain range for every copy mode. A single
    // cell is never represented as Markdown, even through the explicit
    // copy-Markdown command.
    const markdown = singleCell || acrossCells ? plain : full ? this.bridge().source : markdownSerializer.serialize(state.schema.nodes.doc.create(null, markdownContent))
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
      // A DOM Range preserves the exact partial cells of a text drag. The open
      // ProseMirror slice would serialize the rest of those cells and rows.
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
    const html = DOMPurify.sanitize(rich, { USE_PROFILES: { html: true } })
    let textblocks = 0
    if (!(selection instanceof TextSelection)) selected.descendants(node => { if (node.isTextblock && !node.attrs.editorTrailing) textblocks++ })
    const useMarkdown = !singleCell && !acrossCells && (table || (this.settings().copyAcrossBlocks && (crossesBlocks || textblocks > 1)))
    return { selection, markdown, plain, html, text: useMarkdown ? markdown : plain }
  }

  /** Native Ctrl+C/X and WebView edit commands use the same representations as
   * the app menus. Setting both MIME types avoids copying the editor's UI DOM. */
  event(event: ClipboardEvent, cut: boolean) {
    if (event.target instanceof Element && event.target.closest('input,textarea,.cm-editor')) return false
    if (cut && !this.editable()) { event.preventDefault(); return true }
    const content = this.content()
    if (!content || !event.clipboardData) return false
    event.preventDefault()
    event.clipboardData.setData('text/plain', content.text)
    event.clipboardData.setData('text/html', content.html)
    if (cut) this.remove(content.selection)
    return true
  }

  private remove(selection: Selection) {
    this.view.dispatch(this.view.state.tr.setSelection(selection).deleteSelection().setMeta('isolated', true).scrollIntoView())
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
      // Inside a code block the canonical representation is raw text. Parsing
      // the clipboard as Markdown and replacing a ProseMirror selection would
      // turn following lines into block nodes and lift them out of the fence.
      // Both menu paste and the global Ctrl+V route arrive here, so keep one
      // transaction and let the embedded CodeMirror NodeView mirror it.
      if (this.inCodeBlock(state)) {
        this.view.dispatch(state.tr.insertText(text).setMeta('isolated', true).scrollIntoView())
        return
      }
      if (operation === 'paste-plain') this.view.dispatch(state.tr.insertText(text).setMeta('isolated', true).scrollIntoView())
      else this.view.dispatch(state.tr.replaceSelection(Slice.maxOpen(parseMarkdown(text).doc.content)).setMeta('isolated', true).scrollIntoView())
      return
    }
    const content = this.content(state)
    if (!content) return
    if (operation === 'markdown') await textClipboard.writeText(content.markdown)
    else if (operation === 'html') await textClipboard.writeText(content.html)
    else await writeRichClipboard(operation === 'simplified' ? content.plain : content.text, content.html)
    if (operation === 'cut' && this.alive() && this.editable() && this.view.state === state) this.remove(content.selection)
  }

  private inCodeBlock(state: EditorState) {
    const { $from, $to } = state.selection
    return $from.parent.type.name === 'code_block' && $from.sameParent($to)
  }
}
