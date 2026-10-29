import { MapMode, RangeSet, RangeSetBuilder, RangeValue, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'

type Ending = '\n' | '\r\n' | '\r'
class EndingValue extends RangeValue {
  point = true
  startSide = 1
  endSide = 1
  mapMode = MapMode.TrackDel
  constructor(readonly ending: Ending) { super() }
  eq(other: EndingValue) { return this.ending === other.ending }
}
const values = new Map<Ending, EndingValue>(['\n', '\r\n', '\r'].map(ending => [ending as Ending, new EndingValue(ending as Ending)]))
export type LineEndingSnapshot = RangeSet<EndingValue>

// CM stores normalized text. This field maps surviving original line separators
// through transactions (including undo), so mixed EOLs never silently normalize.
export function lineEndings(source: string) {
  const counts = new Map<Ending, number>()
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0] as Ending
    counts.set(ending, (counts.get(ending) || 0) + 1)
  }
  const fallback = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '\n'
  const mixed = counts.size > 1
  const restore = StateEffect.define<RangeSet<EndingValue>>({ map: (value, changes) => value.map(changes) })
  // Uniform files need no per-line metadata. Mixed files keep the existing
  // ordered markers: colliding mapped breaks must retain their old precedence.
  const builder = new RangeSetBuilder<EndingValue>()
  if (mixed) {
    let removed = 0
    for (const match of source.matchAll(/\r\n|\r|\n/g)) {
      const at = match.index! - removed
      builder.add(at, at, values.get(match[0] as Ending)!)
      removed += match[0].length - 1
    }
  }
  const initialSet = builder.finish()
  const field = StateField.define<RangeSet<EndingValue>>({
    create: () => initialSet,
    update(value, transaction) {
      let restored: RangeSet<EndingValue> | undefined
      // Merged undo events put the earliest snapshot last.
      for (const effect of transaction.effects) if (effect.is(restore)) restored = effect.value
      if (restored) return restored
      if (!transaction.docChanged) return value
      // Persistent RangeSet maps unchanged chunks without copying every line
      // on each keystroke or retaining full arrays in undo history.
      if (!mixed) return value
      const additions: Range<EndingValue>[] = []
      transaction.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
        let offset = fromB
        for (let line = 1; line < inserted.lines; line++) {
          offset += inserted.line(line).length
          additions.push(values.get(fallback)!.range(offset))
          offset++
        }
      })
      return value.map(transaction.changes).update({ add: additions, sort: true })
    },
  })
  return {
    field,
    history: invertedEffects.of(transaction => transaction.docChanged ? [restore.of(transaction.startState.field(field))] : []),
    snapshot(state: EditorState) { return state.field(field) },
    equal(a: EditorState, b: LineEndingSnapshot) { return RangeSet.eq([a.field(field)], [b]) },
    serialize(state: EditorState) {
      if (state.field(field).size === 0) return state.doc.sliceString(0, state.doc.length, fallback)
      const breaks = state.field(field).iter()
      const parts: string[] = []
      let from = 0
      let previousBreak = -1
      // Join whole unchanged spans instead of materializing two array entries
      // per line. Each exception replaces one normalized CM line separator.
      while (breaks.value) {
        // TrackDel can leave a point at a replacement boundary that is now
        // ordinary text. The dense serializer ignored those points too.
        if (breaks.from !== previousBreak && state.doc.sliceString(breaks.from, breaks.from + 1) === '\n') {
          previousBreak = breaks.from
          if (breaks.value.ending !== fallback) {
            parts.push(state.doc.sliceString(from, breaks.from, fallback), breaks.value.ending)
            from = breaks.from + 1
          }
        }
        breaks.next()
      }
      parts.push(state.doc.sliceString(from, state.doc.length, fallback))
      return parts.join('')
    },
  }
}
