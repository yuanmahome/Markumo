import type { Node } from 'prosemirror-model'
import { TextSelection, type Command } from 'prosemirror-state'

function emptyCell(cell: Node) {
  // An inline atom (image/math), a break or whitespace is still user content.
  return cell.childCount === 1 && cell.firstChild!.isTextblock && cell.firstChild!.content.size === 0
}

/** Backspace at table boundaries navigates; only an entirely empty table can
 * be removed from its first cell. Ordinary text/range deletion stays native. */
export const tableBackspace: Command = (state, dispatch, view) => {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty || view?.composing) return false
  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parentOffset !== 0) return false

  let table: Node | null = null, tablePos = 0, cellPos: number | null = null
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth), role = node.type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') cellPos = $from.before(depth)
    if (role === 'table') { table = node; tablePos = $from.before(depth); break }
  }
  if (!table) {
    if ($from.parent.type.name !== 'paragraph' || !$from.depth) return false
    const before = $from.before(), previous = state.doc.resolve(before).nodeBefore
    if (previous?.type.spec.tableRole !== 'table') return false
    table = previous; tablePos = before - previous.nodeSize
  }
  if (view && !view.editable) return true

  const cells: { node: Node; pos: number }[] = []
  table.forEach((row, rowOffset) => row.forEach((cell, cellOffset) => {
    cells.push({ node: cell, pos: tablePos + rowOffset + cellOffset + 2 })
  }))
  const index = cellPos === null ? cells.length : cells.findIndex(cell => cell.pos === cellPos)
  if (index < 0) return false
  if (cellPos !== null && !emptyCell(cells[index].node)) return true
  if (index > 0) {
    const previous = cells[index - 1]
    const target = previous.pos + previous.node.nodeSize - 1
    dispatch?.(state.tr.setSelection(TextSelection.near(state.doc.resolve(target), -1)).scrollIntoView())
  } else if (cells.every(cell => emptyCell(cell.node))) {
    const tr = state.tr.delete(tablePos, tablePos + table.nodeSize)
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tablePos, tr.doc.content.size)), -1))
    dispatch?.(tr.setMeta('isolated', true).scrollIntoView())
  }
  // Consume the boundary even when another cell contains content. Falling
  // through would let baseKeymap select/join the table on the next Backspace.
  return true
}
