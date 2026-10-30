import { Plugin } from 'prosemirror-state'
import { canJoin } from 'prosemirror-transform'

/** Adjacent lists with the same marker have no boundary in Markdown. Join
 * them in the editing document too, so a later reparse cannot change it. An
 * editable gap paragraph or a different bullet marker keeps lists separate. */
export function listNormalizationPlugin() {
  return new Plugin({
    appendTransaction(transactions, _before, state) {
      if (!transactions.some(tr => tr.docChanged) ||
        transactions.some(tr => tr.getMeta('trailingParagraphSync'))) return null
      const boundaries: number[] = []
      state.doc.descendants((node, pos, parent, index) => {
        if (!parent || !index || !['bullet_list', 'ordered_list'].includes(node.type.name)) return
        const previous = parent.child(index - 1)
        if (previous.type === node.type && previous.attrs.bullet === node.attrs.bullet) boundaries.push(pos)
      })
      const tr = state.tr
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
