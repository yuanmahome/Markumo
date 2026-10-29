import { InputRule } from 'prosemirror-inputrules'
import { TextSelection } from 'prosemirror-state'
import type { Schema } from 'prosemirror-model'
import { parseInlineSource } from './InlineSourceView'
import { parseMarkdown } from './MarkdownParser'
import type { MarkdownSourceBridge } from './MarkdownSourceBridge'

function createInlineMarkInputRule(
  pattern: RegExp,
  expectedMarks: string[],
  currentBridge: () => MarkdownSourceBridge
) {
  return new InputRule(pattern, (state, match, start, end) => {
    let matchedText = match[0]
    let actualStart = start
    if (match.length > 2 && match[1] !== undefined) {
      const offset = match[0].indexOf(match[1])
      if (offset > 0) {
        matchedText = match[0].slice(offset)
        actualStart = start + offset
      }
    }
    const innerText = match[2]
    if (!innerText || /^[*_~`]+$/.test(innerText)) return null
    const $start = state.doc.resolve(actualStart)
    const prefix = $start.parent.textBetween(0, $start.parentOffset, '', '\ufffc')
    if ((/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) return null
    const inherited = $start.marks(), bridge = currentBridge()
    const content = parseInlineSource(matchedText, inherited, bridge.environment)
    if (!content?.childCount || !content.content.every(node => expectedMarks.every(name => node.marks.some(mark => mark.type.name === name)))) {
      return null
    }
    const tr = state.tr.replaceWith(actualStart, end, content)
    const target = tr.doc.child($start.index(0))
    const old = bridge.blocks.find(block => block.id === target.attrs.sourceId)
    const from = bridge.sourcePosition(actualStart), to = bridge.sourcePosition(end)
    if (!old || from < old.from || to > old.to) return null
    // Preserve an explicitly source-authored escaped delimiter pair (e.g. \*\* or \*\*\*)
    const delim = match[1] || matchedText.slice(0, 1)
    if (delim.length >= 2) {
      const escapedDelim = delim.split('').map(c => '\\' + c).join('')
      if (bridge.source.slice(from, from + escapedDelim.length) === escapedDelim) return null
    }
    const candidate = old.raw.slice(0, from - old.from) + matchedText + old.raw.slice(to - old.from)
    const parsed = parseMarkdown(candidate, bridge.environment).doc
    const node = parsed.firstChild
    if (parsed.childCount !== 1 || !node || !node.type.create({ ...node.attrs, sourceId: target.attrs.sourceId }, node.content, node.marks).eq(target)) {
      return null
    }
    return tr.setSelection(TextSelection.create(tr.doc, actualStart + content.size))
      .setStoredMarks(inherited)
      .setMeta('inlineSourcePatch', { from, to, insert: matchedText, blockId: old.id })
      .setMeta('isolated', true)
      .scrollIntoView()
  }, { inCodeMark: false })
}

/** Input rule for creating a horizontal rule when typing ---, or asterisks/underscores with space. */
export function horizontalRuleInputRule(schema: Schema) {
  return new InputRule(/^(?:-{3,}|(?:\*{3,}|_{3,})\s+)$/, (state, _match, start, _end) => {
    const $start = state.doc.resolve(start)
    if ($start.parent.type === schema.nodes.paragraph && $start.parent.childCount <= 1) {
      const from = $start.before(), to = $start.after()
      return state.tr.replaceWith(from, to, schema.nodes.horizontal_rule.create()).setMeta('isolated', true)
    }
    return null
  })
}

/** Comprehensive inline formatting rules (bold-italic, bold, italic, strike, inline code). */
export function inlineMarkdownInputRules(currentBridge: () => MarkdownSourceBridge): InputRule[] {
  return [
    // Bold + Italic: ***text*** or ___text___
    createInlineMarkInputRule(/(?:^|[^*_])(\*\*\*|___)(?=\S)([^\n]*?\S)\1$/, ['strong', 'em'], currentBridge),
    // Bold: **text** or __text__
    createInlineMarkInputRule(/(?:^|[^*_])(\*\*|__)(?=\S)([^\n]*?\S)\1$/, ['strong'], currentBridge),
    // Italic: *text* or _text_
    createInlineMarkInputRule(/(?:^|[^*_])(\*|_)(?=\S)([^\n]*?\S)\1$/, ['em'], currentBridge),
    // Strikethrough: ~~text~~
    createInlineMarkInputRule(/(?:^|[^~])(~~)(?=\S)([^\n]*?\S)\1$/, ['strike'], currentBridge),
    // Inline code: `text`
    createInlineMarkInputRule(/(?:^|[^`])(`)([^`\n]+)\1$/, ['code'], currentBridge),
  ]
}

/** Backward-compatible export for strongInputRule */
export function strongInputRule(currentBridge: () => MarkdownSourceBridge) {
  return createInlineMarkInputRule(/(?:^|[^*_])(\*\*|__)(?=\S)([^\n]*?\S)\1$/, ['strong'], currentBridge)
}
