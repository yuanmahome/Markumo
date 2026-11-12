import type { Node } from 'prosemirror-model'
import { Selection, TextSelection, type Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { CellSelection, cellAround, nextCell, tableEditing } from 'prosemirror-tables'

/**
 * `tableEditing()` already implements the Typora-style hybrid we want:
 *
 * - a mousedown installs its mousemove listener but does not cancel the native
 *   text selection, so a drag that stays inside one cell remains a normal
 *   `TextSelection`;
 * - once the pointer crosses into another cell, the listener switches to a
 *   rectangular `CellSelection`;
 * - shift+click and triple click keep their structural table behavior.
 *
 * Add visual-column preservation for vertical text navigation and prevent
 * native drag-and-drop from moving a selected table fragment into the document.
 */
export function tableEditingWithDragGuard(): Plugin {
  const plugin = tableEditing()
  const baseDragStart = plugin.props.handleDOMEvents?.dragstart as
    | ((view: EditorView, event: Event) => boolean)
    | undefined
  const baseMouseDown = plugin.props.handleDOMEvents?.mousedown
  const baseKeyDown = plugin.props.handleKeyDown
  const goals = new WeakMap<EditorView, { left: number; head: number; doc: Node }>()

  plugin.props.handleKeyDown = (view, event) => {
    const vertical = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey &&
      !event.isComposing && !view.composing && ['ArrowUp', 'ArrowDown'].includes(event.key)
    if (!vertical) goals.delete(view)
    const selection = view.state.selection
    if (vertical && selection instanceof TextSelection && selection.empty && selection.$head.parent.isTextblock) {
      const direction = event.key === 'ArrowUp' ? -1 : 1
      const $cell = cellAround(selection.$head)
      // A wrapped line or another paragraph in this cell still belongs to the
      // browser. Cross a row only at the cell's first/last visual line.
      let boundary = !!$cell
      for (let depth = selection.$head.depth - 1; $cell && depth > $cell.depth; depth--) {
        if (selection.$head.index(depth) !== (direction < 0 ? 0 : selection.$head.node(depth).childCount - 1)) boundary = false
      }
      if ($cell && boundary && view.endOfTextblock(direction < 0 ? 'up' : 'down')) {
        const $next = nextCell($cell, 'vert', direction)
        if ($next) {
          const previous = goals.get(view)
          const left = previous?.head === selection.head && previous.doc === view.state.doc
            ? previous.left : view.coordsAtPos(selection.head).left
          const edge = direction > 0 ? $next.pos + 1 : $next.pos + $next.nodeAfter!.nodeSize - 1
          let target = Selection.near(view.state.doc.resolve(edge), direction)
          const cellDOM = view.nodeDOM($next.pos)
          if (cellDOM instanceof HTMLElement) {
            const bounds = cellDOM.getBoundingClientRect(), line = view.coordsAtPos(target.head)
            const hit = view.posAtCoords({ left: Math.max(bounds.left + 1, Math.min(left, bounds.right - 1)), top: (line.top + line.bottom) / 2 })
            if (hit && cellRangeAt(view.state.doc, hit.pos)?.from === $next.pos) {
              const near = Selection.near(view.state.doc.resolve(hit.pos), direction)
              if (cellRangeAt(view.state.doc, near.head)?.from === $next.pos) target = near
            }
          }
          goals.set(view, { left, head: target.head, doc: view.state.doc })
          view.dispatch(view.state.tr.setSelection(target).scrollIntoView())
          return true
        }
      }
    }
    return baseKeyDown ? baseKeyDown.call(plugin, view, event) : false
  }

  plugin.props.handleDOMEvents = {
    ...plugin.props.handleDOMEvents,
    mousedown(view, event) {
      goals.delete(view)
      return baseMouseDown ? baseMouseDown.call(plugin, view, event) : false
    },
    dragstart(view, event) {
      if (selectionTouchesCell(view.state.selection)) {
        event.preventDefault()
        return true
      }
      return baseDragStart ? baseDragStart.call(plugin, view, event) : false
    },
  }
  return plugin
}

function cellRangeAt(doc: Node, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = $pos.node(depth).type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') return { from: $pos.before(depth), to: $pos.after(depth) }
  }
  return null
}

/** True when a text selection starts and ends in different table cells. */
export function crossesTableCells(selection: Selection): boolean {
  if (!(selection instanceof TextSelection) || selection.empty) return false
  const from = cellRangeAt(selection.$from.doc, selection.$from.pos)
  const to = cellRangeAt(selection.$to.doc, selection.$to.pos)
  return !!from && !!to && from.from !== to.from
}

function selectionTouchesCell(selection: Selection): boolean {
  if (selection instanceof CellSelection) return true
  if (!(selection instanceof TextSelection)) return false
  return !!(
    cellRangeAt(selection.$from.doc, selection.$from.pos) ||
    cellRangeAt(selection.$to.doc, selection.$to.pos)
  )
}
