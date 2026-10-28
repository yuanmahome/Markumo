import { InputRule } from 'prosemirror-inputrules'
import { TextSelection } from 'prosemirror-state'
import { parseInlineSource } from './InlineSourceView'
import { parseMarkdown } from './MarkdownParser'
import type { MarkdownSourceBridge } from './MarkdownSourceBridge'

/** Completed typed delimiters are Markdown intent, before ordinary text
 * serialization can escape them. Explicit escapes and code stay literal. */
export function strongInputRule(currentBridge: () => MarkdownSourceBridge) {
  return new InputRule(/\*\*(?=\S)([^\n]*?\S)\*\*$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start)
    const prefix = $start.parent.textBetween(0, $start.parentOffset, '', '\ufffc')
    if ((/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) return null
    const inherited = $start.marks(), bridge = currentBridge()
    const content = parseInlineSource(match[0], inherited, bridge.environment)
    if (!content?.childCount || !content.content.every(node => node.marks.some(mark => mark.type.name === 'strong'))) return null
    const tr = state.tr.replaceWith(start, end, content)
    const target = tr.doc.child($start.index(0))
    const old = bridge.blocks.find(block => block.id === target.attrs.sourceId)
    const from = bridge.sourcePosition(start), to = bridge.sourcePosition(end)
    if (!old || from < old.from || to > old.to) return null
    // Preserve a source-authored escaped pair. Auto-escaping a lone first
    // star while typing an empty block escapes only that first star.
    if (bridge.source.slice(from, bridge.sourcePosition(start + 2)) === '\\*\\*') return null
    const candidate = old.raw.slice(0, from - old.from) + match[0] + old.raw.slice(to - old.from)
    const parsed = parseMarkdown(candidate, bridge.environment).doc
    const node = parsed.firstChild
    // Prove the whole affected block, including surrounding text and nested
    // list/table context. Keep every byte outside the typed token unchanged.
    if (parsed.childCount !== 1 || !node || !node.type.create({ ...node.attrs, sourceId: target.attrs.sourceId }, node.content, node.marks).eq(target)) return null
    return tr.setSelection(TextSelection.create(tr.doc, start + content.size))
      .setStoredMarks(inherited)
      .setMeta('inlineSourcePatch', { from, to, insert: match[0], blockId: old.id })
      .setMeta('isolated', true)
      .scrollIntoView()
  }, { inCodeMark: false })
}
