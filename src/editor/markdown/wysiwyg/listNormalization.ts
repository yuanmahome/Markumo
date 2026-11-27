import { visitChangedBlocks } from './changedBlocks'
import { Plugin } from 'prosemirror-state'
import { canJoin } from 'prosemirror-transform'

const isBreak = (name: string) => name === 'hard_break' || name === 'soft_break'
const isList = (name: string) => name === 'bullet_list' || name === 'ordered_list'

/** Adjacent lists with the same marker have no boundary in Markdown. Join
 * them in the editing document too, so a later reparse cannot change it. An
 * editable gap paragraph or a different bullet marker keeps lists separate. */
export function listNormalizationPlugin() {
  return new Plugin({
    appendTransaction(transactions, _before, state) {
      if (!transactions.some(tr => tr.docChanged) ||
        transactions.some(tr => tr.getMeta('trailingParagraphSync'))) return null
      const tr = state.tr
      const deleting = transactions.some(transaction => transaction.steps.some(step => {
        let deletesContent = false
        step.getMap().forEach((from, to, start, end) => { if (to - from > end - start) deletesContent = true })
        return deletesContent
      }))
      if (deleting) {
        const repairs: (() => void)[] = []
        visitChangedBlocks(_before.doc, state.doc, (node, pos, parent, index) => {
          if (node.type.name === 'list_item' && node.attrs.checked != null && node.firstChild?.type.name !== 'paragraph') {
            // A checkbox belongs to a paragraph even when its text was
            // removed and the first surviving block is a nested list.
            repairs.push(() => tr.insert(pos + 1, state.schema.nodes.paragraph.create()))
          }
          if (node.type.name !== 'paragraph' || !parent || !['list_item', 'blockquote', 'callout'].includes(parent.type.name)) return
          // Markdown has no empty continuation paragraphs inside a container.
          // Keep an item's sole paragraph and a task's checkbox paragraph.
          if (!node.content.size && parent.childCount > 1 && (index > 0 || parent.attrs.checked == null) &&
            (index > 0 || parent.content.content.some(child => child.type !== node.type || child.content.size))) {
            repairs.push(() => tr.delete(pos, pos + node.nodeSize))
            return
          }
          // Deleting a line's text can strand a break at the paragraph edge.
          let first = 0, last = node.childCount
          while (first < last && isBreak(node.child(first).type.name)) first++
          while (last > first && isBreak(node.child(last - 1).type.name)) last--
          if (first) repairs.push(() => tr.delete(pos + 1, pos + 1 + first))
          node.forEach((child, offset, index) => {
            // Adjacent soft line breaks would split this Markdown paragraph.
            // Make the second break explicit so both visible breaks survive.
            if (index > first && index < last && child.type.name === 'soft_break' && isBreak(node.child(index - 1).type.name)) {
              repairs.push(() => tr.setNodeMarkup(pos + 1 + offset, state.schema.nodes.hard_break, null, child.marks))
            }
          })
          if (last < node.childCount) repairs.push(() => tr.delete(pos + node.nodeSize - 1 - (node.childCount - last), pos + node.nodeSize - 1))
        })
        for (const repair of repairs.reverse()) repair()
      }
      const boundaries: number[] = []
      // An empty sublist cannot interrupt a paragraph: '-' becomes a Setext
      // underline, other markers become plain text. A loose parent supplies
      // the required blank boundary, preserving the real nested structure.
      visitChangedBlocks(_before.doc, tr.doc, (node, pos, parent, index) => {
        if (!isList(node.type.name)) return
        const previous = index ? parent?.child(index - 1) : null
        if (previous?.type === node.type && previous.attrs.bullet === node.attrs.bullet) boundaries.push(pos)

        if (!node.attrs.tight) {
          // Once the last checkbox or paragraph text is deleted, parsing the
          // remaining empty markers cannot recover a loose-list attribute.
          const hasParagraph = node.content.content.some(item => item.content.content.some(child =>
            child.type.name === 'paragraph' && (child.content.size || item.attrs.checked != null)))
          if (deleting && !hasParagraph) tr.setNodeMarkup(pos, undefined, { ...node.attrs, tight: true })
          return
        }
        let needsBoundary = false
        node.forEach(item => item.forEach((child, _offset, index) => {
          if (!index) return
          if (child.type.name === 'paragraph' || (isList(child.type.name) &&
            child.firstChild?.attrs.checked == null && child.firstChild?.childCount === 1 && child.firstChild.firstChild?.type.name === 'paragraph' &&
            !child.firstChild.firstChild.content.size)) needsBoundary = true
        }))
        if (needsBoundary) tr.setNodeMarkup(pos, undefined, { ...node.attrs, tight: false })
      })
      for (const pos of boundaries.reverse()) {
        if (!canJoin(tr.doc, pos)) continue
        const { nodeBefore: left, nodeAfter: right } = tr.doc.resolve(pos)
        const from = pos - left!.nodeSize
        const tight = left!.attrs.tight && right!.attrs.tight
        tr.join(pos)
        if (tight !== left!.attrs.tight) tr.setNodeMarkup(from, undefined, { ...left!.attrs, tight })
      }
      return tr.docChanged ? tr : null
    },
  })
}
