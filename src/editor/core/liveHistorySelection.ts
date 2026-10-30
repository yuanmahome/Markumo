import { StateEffect, StateField, Transaction, type EditorSelection } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'

// Markdown structural patches can start after the visual caret (for example,
// after a list item's terminating newline). Mapping that caret through the
// inverse patch is lossy, so retain both actual selections with the event.
const generation = StateField.define({
  create: () => 0,
  update: (value, tr) => value + (tr.docChanged && tr.annotation(Transaction.addToHistory) === false ? 1 : 0),
})
const restore = StateEffect.define<{ selection: EditorSelection; inverse: EditorSelection; generation: number }>()

export const liveHistorySelection = [generation, invertedEffects.of(tr => {
  const epoch = tr.startState.field(generation)
  const effects = tr.effects.filter(effect => effect.is(restore) && effect.value.generation === epoch)
  if (effects.length) {
    // A grouped undo carries inverse effects newest first. Its inverse restores
    // the newest post-edit selection; the next undo restores the oldest start.
    return [restore.of({ selection: effects[0].value.inverse, inverse: effects[effects.length - 1].value.selection, generation: epoch })]
  }
  // Include source edits too: adjacent Live and Source input can belong to
  // one CM history group, whose final selection must include either origin.
  return tr.docChanged && tr.annotation(Transaction.addToHistory) !== false && !tr.isUserEvent('undo') && !tr.isUserEvent('redo')
    ? [restore.of({ selection: tr.startState.selection, inverse: tr.newSelection, generation: epoch })] : []
})]

export function liveHistoryTarget(tr: Transaction): EditorSelection | undefined {
  const epoch = tr.startState.field(generation)
  // These positions belong to the exact before/after versions of the event,
  // rather than to the current document. Do not map them while grouping edits.
  // Out-of-history document changes invalidate them; CM's mapped selection is
  // then authoritative instead of applying an obsolete absolute position.
  for (let i = tr.effects.length - 1; i >= 0; i--) {
    const effect = tr.effects[i]
    if (effect.is(restore) && effect.value.generation === epoch) return effect.value.selection
  }
}
