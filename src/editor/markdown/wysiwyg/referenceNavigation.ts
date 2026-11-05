import { Plugin, TextSelection, NodeSelection, Selection } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'
import { Mapping } from 'prosemirror-transform'

export const isReferenceDefinition = (node: Node | null | undefined) =>
  node?.type.name === 'protected_source' && node.attrs.kind === 'reference'

/** Invisible source atoms keep their positions, but are not caret stops or
 * implicit deletion targets. Explicit source edits opt out of this protection. */
export function referenceNavigation() {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.isComposing || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Backspace','Delete'].includes(event.key)) return false
        const selection = view.state.selection
        const direction = ['ArrowLeft','ArrowUp','Backspace'].includes(event.key) ? -1 : 1
        if (selection instanceof NodeSelection && isReferenceDefinition(selection.node)) {
          const at = direction < 0 ? selection.from : selection.to
          const target = Selection.findFrom(view.state.doc.resolve(at), direction, true)
            || Selection.findFrom(view.state.doc.resolve(at), -direction, true)
          if (target) view.dispatch(view.state.tr.setSelection(target).scrollIntoView())
          return true
        }
        if (!selection.empty) return false
        const axis = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : direction < 0 ? 'left' : 'right'
        if (!view.endOfTextblock(axis)) return false
        const $head = selection.$head
        if (!$head.depth) return false
        // A list/table may have more textblocks before its outer boundary.
        // Never jump out of an earlier item merely because a definition follows
        // the complete list/table at top level.
        for (let depth = 1; depth < $head.depth; depth++) {
          if ($head.index(depth) !== (direction < 0 ? 0 : $head.node(depth).childCount - 1)) return false
        }
        let at = direction < 0 ? $head.before(1) : $head.after(1), skipped = false
        while (true) {
          const $at = view.state.doc.resolve(at)
          const next = direction < 0 ? $at.nodeBefore : $at.nodeAfter
          if (!isReferenceDefinition(next)) break
          at += direction * next!.nodeSize
          skipped = true
        }
        if (!skipped) return false
        const target = Selection.findFrom(view.state.doc.resolve(at), direction, true)
        if (target) view.dispatch(view.state.tr.setSelection(event.shiftKey && event.key.startsWith('Arrow')
          ? TextSelection.create(view.state.doc, selection.anchor, target.head) : target).scrollIntoView())
        return true
      },
    },
    appendTransaction(transactions, before, state) {
      const tr = state.tr
      if (transactions.some(t => t.docChanged) && !transactions.some(t => t.getMeta('referenceDefinitionEdit'))) {
        const remaining = new Set<string>()
        state.doc.forEach(node => { if (isReferenceDefinition(node)) remaining.add(node.attrs.sourceId) })
        const mapping = new Mapping()
        transactions.forEach(t => mapping.appendMapping(t.mapping))
        before.doc.forEach((node, pos) => {
          if (!isReferenceDefinition(node) || remaining.has(node.attrs.sourceId)) return
          const at = tr.mapping.map(mapping.map(pos, -1))
          tr.insert(at, node)
        })
      }
      if (tr.selection instanceof NodeSelection && isReferenceDefinition(tr.selection.node)) {
        const direction = tr.selection.from >= before.selection.from ? 1 : -1
        const at = direction > 0 ? tr.selection.to : tr.selection.from
        const selection = Selection.findFrom(tr.doc.resolve(at), direction, true)
          || Selection.findFrom(tr.doc.resolve(at), -direction, true)
        if (selection) tr.setSelection(selection)
      }
      return tr.docChanged || tr.selectionSet ? tr : null
    },
  })
}
