import { InputRule } from 'prosemirror-inputrules'
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import { Slice } from 'prosemirror-model'
import { completedInlineLink, parseInlineSource } from './InlineSourceView'
import { parseMarkdown } from './MarkdownParser'
import type { MarkdownSourceBridge } from './MarkdownSourceBridge'
import { textPatch } from './sourcePatch'

function createInlineMarkInputRule(
  pattern: RegExp,
  expectedMarks: string[],
  currentBridge: () => MarkdownSourceBridge
) {
  return new InputRule(pattern, (state, match, start, end) => {
    const explicitLink = expectedMarks.includes('link')
    let matchedText = match[0]
    let actualStart = start
    if (explicitLink) {
      const link = completedInlineLink(matchedText, currentBridge().environment)
      if (!link) return null
      matchedText = link.raw
      actualStart += link.from
    } else if (match.length > 2 && match[1] !== undefined) {
      const offset = match[0].indexOf(match[1])
      if (offset > 0) {
        matchedText = match[0].slice(offset)
        actualStart = start + offset
      }
    }
    const innerText = match[2]
    if (!explicitLink && (!innerText || /^[*_~`]+$/.test(innerText))) return null
    const $start = state.doc.resolve(actualStart)
    const prefix = $start.parent.textBetween(0, $start.parentOffset, '', '\ufffc')
    if ((/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) return null
    if (explicitLink && prefix.endsWith('!')) return null
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
    if (explicitLink && (bridge.source.slice(from, from + 2) === '\\[' ||
      (bridge.source[from] === '[' && (/\\+$/.exec(bridge.source.slice(old.from, from))?.[0].length ?? 0) % 2))) return null
    // Preserve an explicitly source-authored escaped delimiter pair (e.g. \*\* or \*\*\*)
    const delim = match[1] || matchedText.slice(0, 1)
    if (!explicitLink && delim.length >= 2) {
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

/** Native DOM edits do not always go through handleTextInput. Complete only a
 * link touched by this text edit, before plain-text serialization escapes ')'.
 * The minimal source patch is reparsed against the entire old block, preserving
 * author escapes, unchanged spelling and all surrounding marks/structure. */
export interface InlineLinkDraft { from: number; to: number; blockId: string }

/** Own only a locally created empty template. Loaded author escapes never acquire
 * this provenance; no source snapshot or document is retained by the tracker. */
export function trackInlineLinkDraft(state: EditorState, tr: Transaction, bridge: MarkdownSourceBridge, draft: InlineLinkDraft | null): InlineLinkDraft | null {
  if (tr.getMeta('inlineSourcePatch')) return null
  if (draft) {
    const from = tr.mapping.map(draft.from, -1), to = tr.mapping.map(draft.to, 1)
    if (from < 1 || to > tr.doc.content.size || to - from > 8192) return null
    const $from = tr.doc.resolve(from), $to = tr.doc.resolve(to)
    if (!$from.sameParent($to) || tr.doc.child($from.index(0)).attrs.sourceId !== draft.blockId) return null
    const text = $from.parent.textBetween($from.parentOffset, $to.parentOffset, '', '\ufffc')
    return /^\[[^\n]*\]\([^\n]*\)$/.test(text) ? { from, to, blockId: draft.blockId } : null
  }
  if (!tr.docChanged || !tr.selection.empty) return null
  const $after = tr.selection.$from
  if (!$after.parent.isTextblock || $after.parent.type.spec.code || $after.parent.content.size > 8192) return null
  const beforePos = tr.mapping.invert().map($after.pos, -1), $before = state.doc.resolve(beforePos)
  if ($before.parent.type !== $after.parent.type) return null
  const change = textPatch($before.parent.textContent, $after.parent.textContent)
  if (!change) return null
  const text = $after.parent.textContent, at = text.lastIndexOf('[]()', $after.parentOffset)
  if (at < 0 || at > change.from + change.insert.length || at + 4 < change.from) return null
  const prefix = text.slice(0, at)
  if (prefix.endsWith('!') || (/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) return null
  const from = $after.start() + at, to = from + 4
  if (tr.doc.resolve(from).marks().some(mark => mark.type.name === 'link' || mark.type.spec.code) ||
    $before.parent.content.content.some(node => !node.isText)) return null
  // A newly typed closing delimiter is still absent from canonical source.
  // Reject a pre-existing escaped template being edited elsewhere in the block.
  const oldAt = tr.mapping.invert().map(from, -1), sourceAt = bridge.sourcePosition(oldAt)
  if (bridge.source.slice(sourceAt, sourceAt + 2) === '\\[') return null
  if ((/\\+$/.exec(bridge.source.slice(0, sourceAt))?.[0].length ?? 0) % 2) return null
  if (state.doc.textBetween(oldAt, tr.mapping.invert().map(to, 1), '', '\ufffc') === '[]()') return null
  return { from, to, blockId: tr.doc.child($after.index(0)).attrs.sourceId }
}

function completeOwnedLinkDraft(state: EditorState, tr: Transaction, bridge: MarkdownSourceBridge, draft: InlineLinkDraft): boolean {
  const next = trackInlineLinkDraft(state, tr, bridge, draft)
  if (!next) return false
  const raw = tr.doc.textBetween(next.from, next.to, '', '\ufffc')
  const link = completedInlineLink(raw, bridge.environment)
  if (!link || link.from !== 0 || link.raw !== raw) return false
  const inherited = tr.doc.resolve(next.from).marks(), content = parseInlineSource(raw, inherited, bridge.environment)
  if (!content?.childCount) return false
  const block = bridge.blocks.find(block => block.id === draft.blockId)
  const from = bridge.sourcePosition(draft.from), to = bridge.sourcePosition(draft.to)
  if (!block || from < block.from || to > block.to) return false
  const candidate = block.raw.slice(0, from - block.from) + raw + block.raw.slice(to - block.from)
  const normalized = tr.doc.replace(next.from, next.to, new Slice(content, 0, 0))
  const target = normalized.child(tr.doc.resolve(next.from).index(0)), parsed = parseMarkdown(candidate, bridge.environment).doc, node = parsed.firstChild
  if (parsed.childCount !== 1 || !node || !node.type.create({ ...node.attrs, sourceId: target.attrs.sourceId }, node.content, node.marks).eq(target)) return false
  const offset = tr.selection.from - next.from
  tr.replaceWith(next.from, next.to, content)
    .setSelection(TextSelection.create(tr.doc, next.from + content.size))
    .setStoredMarks(inherited)
    .setMeta('inlineSourcePatch', { from, to, insert: raw, blockId: block.id })
    .setMeta('isolated', true)
  if (offset >= 0 && offset < raw.length) tr.setMeta('inlineLinkDraftEdit', { pos: next.from, offset })
  return true
}

export function completeInlineLinkTransaction(state: EditorState, tr: Transaction, bridge: MarkdownSourceBridge, draft: InlineLinkDraft | null = null): Transaction {
  if ((!tr.docChanged && !tr.getMeta('inlineLinkDraftCommit')) || tr.getMeta('inlineSourcePatch') || !tr.selection.empty) return tr
  if (draft && completeOwnedLinkDraft(state, tr, bridge, draft)) return tr
  const $after = tr.selection.$from
  if (!$after.parent.isTextblock || $after.parent.type.spec.code || $after.parent.content.size > 8192) return tr
  const oldPosition = tr.mapping.invert().map($after.pos, -1)
  if (oldPosition < 0 || oldPosition > state.doc.content.size) return tr
  const $before = state.doc.resolve(oldPosition)
  if ($before.parent.type !== $after.parent.type ||
    [...$before.parent.content.content, ...$after.parent.content.content].some(node => !node.isText || node.marks.some(mark => mark.type.spec.code))) return tr
  const oldTop = state.doc.child($before.index(0)), newTop = tr.doc.child($after.index(0))
  if (oldTop.attrs.sourceId !== newTop.attrs.sourceId) return tr
  const block = bridge.blocks.find(block => block.id === oldTop.attrs.sourceId)
  if (!block || block.raw.length > 32768) return tr
  const text = $after.parent.textContent, change = textPatch($before.parent.textContent, text)
  if (!change || !text.includes('](')) return tr
  const from = bridge.sourcePosition($before.start() + change.from), to = bridge.sourcePosition($before.start() + change.to)
  if (from < block.from || to > block.to) return tr
  const candidate = block.raw.slice(0, from - block.from) + change.insert + block.raw.slice(to - block.from)
  let attempts = 0
  for (let end = text.indexOf(')', change.from); end >= 0 && attempts++ < 64; end = text.indexOf(')', end + 1)) {
    if (end < change.from + change.insert.length - 1) continue
    const link = completedInlineLink(text.slice(0, end + 1), bridge.environment)
    if (!link || link.from > change.from) continue
    const linkFrom = $after.start() + link.from, linkTo = $after.start() + end + 1
    const inherited = tr.doc.resolve(linkFrom).marks()
    if (inherited.some(mark => mark.type.name === 'link' || mark.type.spec.code)) continue
    const content = parseInlineSource(link.raw, inherited, bridge.environment)
    if (!content?.childCount) continue
    const normalized = tr.doc.replace(linkFrom, linkTo, new Slice(content, 0, 0))
    const target = normalized.child($after.index(0)), parsed = parseMarkdown(candidate, bridge.environment).doc, node = parsed.firstChild
    if (parsed.childCount !== 1 || !node || !node.type.create({ ...node.attrs, sourceId: target.attrs.sourceId }, node.content, node.marks).eq(target)) continue
    return tr.replaceWith(linkFrom, linkTo, content)
      .setSelection(TextSelection.create(tr.doc, linkFrom + content.size))
      .setStoredMarks(inherited)
      .setMeta('inlineSourcePatch', { from, to, insert: change.insert, blockId: block.id })
      .setMeta('isolated', true)
  }
  return tr
}

/** Inline formatting and explicit links, with source patches validated by a full block parse. */
export function inlineMarkdownInputRules(currentBridge: () => MarkdownSourceBridge): InputRule[] {
  return [
    createInlineMarkInputRule(/\[[^\n]*\]\([^\n]*\)$/, ['link'], currentBridge),
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
