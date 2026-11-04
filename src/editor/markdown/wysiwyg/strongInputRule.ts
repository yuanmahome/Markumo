import { InputRule } from 'prosemirror-inputrules'
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import { Mark, Slice, type Node as PMNode } from 'prosemirror-model'
import { parser as lezerMarkdownParser } from '@lezer/markdown'
import { markdownSyntaxExtensions } from '../semantics'
import { completedInlineLink, parseInlineSource } from './InlineSourceView'
import { parseMarkdown, sameBlockSemantics } from './MarkdownParser'
import type { MarkdownSourceBridge } from './MarkdownSourceBridge'
import { sourceTextPosition } from './patchSourceBlock'
import { textPatch } from './sourcePatch'

const inlineSyntaxParser = lezerMarkdownParser.configure(markdownSyntaxExtensions)
const LEZER_NAME_TO_KIND: Record<string, string> = {
  InlineCode: 'code',
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'strike',
}

function createInlineMarkInputRule(
  pattern: RegExp,
  expectedMarks: string[],
  currentBridge: () => MarkdownSourceBridge
) {
  return new InputRule(
    pattern,
    (state, match, start, end) => {
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
      const inherited = $start.marks()
      const bridge = currentBridge()
      const content = parseInlineSource(matchedText, inherited, bridge.environment)
      if (
        !content?.childCount ||
        !content.content.every(node => expectedMarks.every(name => node.marks.some(mark => mark.type.name === name)))
      ) {
        return null
      }
      const tr = state.tr.replaceWith(actualStart, end, content)
      const target = tr.doc.child($start.index(0))
      const old = bridge.blocks.find(block => block.id === target.attrs.sourceId)
      const from = bridge.sourcePosition(actualStart)
      const to = bridge.sourcePosition(end)
      if (!old || from < old.from || to > old.to) return null
      if (
        explicitLink &&
        (bridge.source.slice(from, from + 2) === '\\[' ||
          (bridge.source[from] === '[' && (/\\+$/.exec(bridge.source.slice(old.from, from))?.[0].length ?? 0) % 2))
      ) {
        return null
      }
      // Preserve explicitly source-authored escaped delimiters (e.g. \`, \*, \*\*, \*\*\*)
      const delim = match[1] || matchedText.slice(0, 1)
      if (!explicitLink && delim.length >= 1) {
        const escapedDelim = delim.split('').map(c => '\\' + c).join('')
        if (
          bridge.source.slice(from, from + escapedDelim.length) === escapedDelim ||
          bridge.source.slice(from, from + 2) === '\\' + delim[0] ||
          (from > old.from && (/\\+$/.exec(bridge.source.slice(old.from, from))?.[0].length ?? 0) % 2 === 1)
        ) {
          return null
        }
      }

      const relFrom = from - old.from
      const relTo = to - old.from
      const needsLeadingSpace =
        $start.parent.childCount === 0 && /(?:^|\n)[ \t]*(?:[-+*]|\d+[.)]|>+)$/.test(old.raw.slice(0, relFrom))
      const needsTrailingSpace = old.node.type.name === 'table' && $start.parent.childCount === 0 && old.raw[relTo] === '|'
      const effectiveInsert = (needsLeadingSpace ? ' ' : '') + matchedText + (needsTrailingSpace ? ' ' : '')

      const candidate = old.raw.slice(0, relFrom) + effectiveInsert + old.raw.slice(relTo)
      const parsed = parseMarkdown(candidate, bridge.environment).doc
      const node = parsed.firstChild
      if (parsed.childCount !== 1 || !node || !sameBlockSemantics(node, target)) {
        return null
      }
      if (!explicitLink) {
        tr.setMeta('inlineFormattingEdit', { pos: actualStart, kind: expectedMarks[0], offset: matchedText.length })
      }
      return tr
        .setSelection(TextSelection.create(tr.doc, actualStart + content.size))
        .setStoredMarks(inherited)
        .setMeta('inlineSourcePatch', { from, to, insert: effectiveInsert, blockId: old.id })
        .setMeta('isolated', true)
        .scrollIntoView()
    },
    { inCodeMark: false }
  )
}

/** Native DOM edits do not always go through handleTextInput. Complete only a
 * construct touched by this text edit, before plain-text serialization escapes it.
 * The minimal source patch is reparsed against the entire old block, preserving
 * author escapes, unchanged spelling and all surrounding marks/structure. */
export interface InlineLinkDraft {
  from: number
  to: number
  blockId: string
}

/** Own only a locally created empty template. Loaded author escapes never acquire
 * this provenance; no source snapshot or document is retained by the tracker. */
export function trackInlineLinkDraft(
  state: EditorState,
  tr: Transaction,
  bridge: MarkdownSourceBridge,
  draft: InlineLinkDraft | null
): InlineLinkDraft | null {
  if (tr.getMeta('inlineSourcePatch') || tr.getMeta('pastePlain')) return null
  if (draft) {
    const from = tr.mapping.map(draft.from, -1)
    const to = tr.mapping.map(draft.to, 1)
    if (from < 1 || to > tr.doc.content.size || to - from > 8192) return null
    const $from = tr.doc.resolve(from)
    const $to = tr.doc.resolve(to)
    if (!$from.sameParent($to) || tr.doc.child($from.index(0)).attrs.sourceId !== draft.blockId) return null
    const text = $from.parent.textBetween($from.parentOffset, $to.parentOffset, '', '\ufffc')
    return /^\[[^\n]*\]\([^\n]*\)$/.test(text) ? { from, to, blockId: draft.blockId } : null
  }
  if (!tr.docChanged || !tr.selection.empty) return null
  const $after = tr.selection.$from
  if (!$after.parent.isTextblock || $after.parent.type.spec.code || $after.parent.content.size > 8192) return null
  const beforePos = tr.mapping.invert().map($after.pos, -1)
  const $before = state.doc.resolve(beforePos)
  if ($before.parent.type !== $after.parent.type) return null
  const change = textPatch($before.parent.textContent, $after.parent.textContent)
  if (!change) return null
  const text = $after.parent.textContent
  const at = text.lastIndexOf('[]()', $after.parentOffset)
  if (at < 0 || at > change.from + change.insert.length || at + 4 < change.from) return null
  const prefix = text.slice(0, at)
  if (prefix.endsWith('!') || (/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) return null
  const from = $after.start() + at
  const to = from + 4
  if (
    tr.doc.resolve(from).marks().some(mark => mark.type.name === 'link' || mark.type.spec.code) ||
    $before.parent.content.content.some(node => !node.isText)
  ) {
    return null
  }
  // A newly typed closing delimiter is still absent from canonical source.
  // Reject a pre-existing escaped template being edited elsewhere in the block.
  const oldAt = tr.mapping.invert().map(from, -1)
  const sourceAt = bridge.sourcePosition(oldAt)
  if (bridge.source.slice(sourceAt, sourceAt + 2) === '\\[') return null
  if ((/\\+$/.exec(bridge.source.slice(0, sourceAt))?.[0].length ?? 0) % 2) return null
  if (state.doc.textBetween(oldAt, tr.mapping.invert().map(to, 1), '', '\ufffc') === '[]()') return null
  return { from, to, blockId: tr.doc.child($after.index(0)).attrs.sourceId }
}

function completeOwnedLinkDraft(
  state: EditorState,
  tr: Transaction,
  bridge: MarkdownSourceBridge,
  draft: InlineLinkDraft
): boolean {
  const next = trackInlineLinkDraft(state, tr, bridge, draft)
  if (!next) return false
  const raw = tr.doc.textBetween(next.from, next.to, '', '\ufffc')
  const link = completedInlineLink(raw, bridge.environment)
  if (!link || link.from !== 0 || link.raw !== raw) return false
  const inherited = tr.doc.resolve(next.from).marks()
  const content = parseInlineSource(raw, inherited, bridge.environment)
  if (!content?.childCount) return false
  const block = bridge.blocks.find(block => block.id === draft.blockId)
  const from = bridge.sourcePosition(draft.from)
  const to = bridge.sourcePosition(draft.to)
  if (!block || from < block.from || to > block.to) return false
  const candidate = block.raw.slice(0, from - block.from) + raw + block.raw.slice(to - block.from)
  const normalized = tr.doc.replace(next.from, next.to, new Slice(content, 0, 0))
  const target = normalized.child(tr.doc.resolve(next.from).index(0))
  const parsed = parseMarkdown(candidate, bridge.environment).doc
  const node = parsed.firstChild
  if (parsed.childCount !== 1 || !node || !sameBlockSemantics(node, target)) return false
  const offset = tr.selection.from - next.from
  tr.replaceWith(next.from, next.to, content)
    .setSelection(TextSelection.create(tr.doc, next.from + content.size))
    .setStoredMarks(inherited)
    .setMeta('inlineSourcePatch', { from, to, insert: raw, blockId: block.id })
    .setMeta('isolated', true)
  if (offset >= 0 && offset < raw.length) tr.setMeta('inlineLinkDraftEdit', { pos: next.from, offset })
  return true
}

/**
 * Counts delimited inline constructs that the per-keystroke `InputRule`s do NOT cover:
 * inline code, links (including angle autolinks) and inline atoms (math, footnotes,
 * images, HTML). Emphasis/strong/strike stay owned by the input rules, because a
 * half-typed `**` must never be reinterpreted before its closing delimiter is typed.
 */
function countDelimitedInlineConstructs(tb: PMNode): number {
  let count = 0
  tb.forEach(child => {
    if (['math_inline', 'footnote_reference', 'image', 'html_inline'].includes(child.type.name)) {
      count++
    }
    for (const m of child.marks) {
      if (m.type.name === 'code') count++
      else if (m.type.name === 'link' && m.attrs.autolink !== 'bare') count++
    }
  })
  return count
}

function findSingleTextblockEdit(
  beforeTB: PMNode,
  afterTB: PMNode
): { localFrom: number; localTo: number; insert: string } | null {
  if (beforeTB.childCount === 0 && afterTB.childCount === 1 && afterTB.firstChild?.isText && afterTB.firstChild.marks.length === 0) {
    return { localFrom: 0, localTo: 0, insert: afterTB.firstChild.text ?? '' }
  }
  const diffStart = beforeTB.content.findDiffStart(afterTB.content)
  if (diffStart === null) return null
  const diffEnd = beforeTB.content.findDiffEnd(afterTB.content)
  if (!diffEnd) return null
  const overlap = Math.max(0, diffStart - Math.min(diffEnd.a, diffEnd.b))
  const endA = diffEnd.a + overlap
  const endB = diffEnd.b + overlap
  const insertedSlice = afterTB.slice(diffStart, endB).content
  if (insertedSlice.childCount !== 1 || !insertedSlice.firstChild?.isText) return null
  const marksAtStart = beforeTB.resolve(diffStart).marks()
  if (marksAtStart.some(m => m.type.spec.code) || !Mark.sameSet(marksAtStart, insertedSlice.firstChild.marks)) {
    return null
  }
  return {
    localFrom: diffStart,
    localTo: endA,
    insert: insertedSlice.firstChild.text ?? '',
  }
}

function navigateChildPath(root: PMNode, indices: number[]): PMNode | null {
  let cur: PMNode = root
  for (const idx of indices) {
    if (idx < 0 || idx >= cur.childCount) return null
    cur = cur.child(idx)
  }
  return cur
}

/**
 * Generalized completion for inline Markdown constructs when text is inserted in ways `InputRule`
 * does not cover: typing inside paired backticks (`|`), prepending an opening delimiter, multi-char
 * insertions (`insertText` / IME commit), reference links `[label][id]`, footnotes `[^1]`,
 * inline math `$x_1$`, and `<https://...>` angle autolinks.
 */
function completeGeneralInlineSyntax(
  state: EditorState,
  tr: Transaction,
  bridge: MarkdownSourceBridge
): Transaction {
  const $after = tr.selection.$from
  if (!$after.parent.isTextblock || $after.parent.type.spec.code || $after.parent.content.size > 8192) return tr
  const afterText = $after.parent.textContent
  // Zero-overhead fast exit for ordinary prose without inline Markdown delimiters
  if (!/[`*_~\[\]$<>]/.test(afterText)) return tr

  const oldPosition = tr.mapping.invert().map($after.pos, -1)
  if (oldPosition < 0 || oldPosition > state.doc.content.size) return tr
  const $before = state.doc.resolve(oldPosition)
  if ($before.depth !== $after.depth || $before.index(0) !== $after.index(0)) return tr
  if ($before.parent.type !== $after.parent.type) return tr

  const pathIndices: number[] = []
  for (let d = 1; d < $after.depth; d++) {
    if ($before.index(d) !== $after.index(d)) return tr
    pathIndices.push($after.index(d))
  }

  const oldTop = state.doc.child($before.index(0))
  const newTop = tr.doc.child($after.index(0))
  if (oldTop.attrs.sourceId !== newTop.attrs.sourceId) return tr
  const block = bridge.blocks.find(b => b.id === oldTop.attrs.sourceId)
  if (!block || block.raw.length > 32768) return tr

  const edit = findSingleTextblockEdit($before.parent, $after.parent)
  if (!edit || !edit.insert || edit.insert.includes('\n') || edit.insert.endsWith('\\')) return tr
  // Cheap prefilter: only edits that type or sit next to an inline delimiter can
  // complete a construct, so ordinary prose never pays for a block re-parse.
  const inlineDelimiter = /[`*_~\[\]$<>]/
  if (
    !inlineDelimiter.test(edit.insert) &&
    !inlineDelimiter.test(afterText.charAt($after.parentOffset - 1)) &&
    !inlineDelimiter.test(afterText.charAt($after.parentOffset))
  ) {
    return tr
  }

  // Verify nothing outside this single textblock changed inside the top-level block
  const beforeTopStart = $before.before(1)
  const relTbContentStart = $before.start() - beforeTopStart - 1
  const relTbContentEnd = $before.end() - beforeTopStart - 1
  if (!sameBlockSemantics(oldTop.replace(relTbContentStart, relTbContentEnd, new Slice($after.parent.content, 0, 0)), newTop)) {
    return tr
  }

  const rawStart = sourceTextPosition(oldTop, block.raw, relTbContentStart + edit.localFrom)
  const rawEnd = sourceTextPosition(oldTop, block.raw, relTbContentStart + edit.localTo)
  if (rawStart < 0 || rawEnd < rawStart || rawEnd > block.raw.length) return tr

  // Respect explicit author backslash escapes immediately preceding the edit site
  if (rawStart > 0 && (/\\+$/.exec(block.raw.slice(0, rawStart))?.[0].length ?? 0) % 2 === 1) {
    return tr
  }

  const needsLeadingSpace =
    $before.parent.childCount === 0 && /(?:^|\n)[ \t]*(?:[-+*]|\d+[.)]|>+)$/.test(block.raw.slice(0, rawStart))
  const needsTrailingSpace = oldTop.type.name === 'table' && $before.parent.childCount === 0 && block.raw[rawEnd] === '|'
  const effectiveInsert = (needsLeadingSpace ? ' ' : '') + edit.insert + (needsTrailingSpace ? ' ' : '')
  const candidateRaw = block.raw.slice(0, rawStart) + effectiveInsert + block.raw.slice(rawEnd)

  const parsed = parseMarkdown(candidateRaw, bridge.environment)
  if (parsed.blocks.length !== 1) return tr
  const parsedTop = parsed.blocks[0].node
  const parsedTB = navigateChildPath(parsedTop, pathIndices)
  if (!parsedTB || !parsedTB.isTextblock || parsedTB.type !== $after.parent.type) return tr

  // Must actually introduce at least one new delimited inline construct (mark or inline atom)
  if (countDelimitedInlineConstructs(parsedTB) <= countDelimitedInlineConstructs($after.parent)) {
    return tr
  }

  const afterTopStart = $after.before(1)
  const afterRelTbStart = $after.start() - afterTopStart - 1
  const afterRelTbEnd = $after.end() - afterTopStart - 1
  const simulatedTop = newTop.replace(afterRelTbStart, afterRelTbEnd, new Slice(parsedTB.content, 0, 0))
  if (!sameBlockSemantics(parsedTop, simulatedTop)) {
    return tr
  }

  const tbStart = $after.start()
  const tbEnd = $after.end()
  const newRawCaret = rawStart + (needsLeadingSpace ? 1 : 0) + edit.insert.length

  // Check if the edit completed or filled a formatting span (`code`, `strong`, `em`, `strike`)
  let formattingMeta: { kind: string; spanFrom: number; spanTo: number } | null = null
  inlineSyntaxParser.parse(candidateRaw).iterate({
    enter(node) {
      const kind = LEZER_NAME_TO_KIND[node.name]
      if (!kind) return
      // Match the outermost formatting span covering the newly edited range
      if (node.from <= rawStart + (needsLeadingSpace ? 1 : 0) + edit.insert.length && node.to >= rawStart + (needsLeadingSpace ? 1 : 0)) {
        if (newRawCaret >= node.from && newRawCaret <= node.to) {
          formattingMeta = { kind, spanFrom: node.from, spanTo: node.to }
          return false
        }
      }
    },
  })

  tr.replaceWith(tbStart, tbEnd, parsedTB.content)

  const mappedDisplayOffset = sourceTextPosition(parsedTop, candidateRaw, newRawCaret, true)
  const clampedDocCaret = Math.max(
    tbStart,
    Math.min(tbStart + parsedTB.content.size, afterTopStart + 1 + mappedDisplayOffset)
  )
  tr.setSelection(TextSelection.near(tr.doc.resolve(clampedDocCaret)))
    .setStoredMarks(null)
    .setMeta('inlineSourcePatch', {
      from: block.from + rawStart,
      to: block.from + rawEnd,
      insert: effectiveInsert,
      blockId: block.id,
    })
    .setMeta('isolated', true)
    .scrollIntoView()

  if (formattingMeta) {
    const fm: { kind: string; spanFrom: number; spanTo: number } = formattingMeta
    const spanDisplayStart = afterTopStart + 1 + sourceTextPosition(parsedTop, candidateRaw, fm.spanFrom, true)
    const safePos = Math.max(tbStart, Math.min(tbStart + parsedTB.content.size, spanDisplayStart + 1))
    tr.setMeta('inlineFormattingEdit', {
      pos: safePos,
      kind: fm.kind,
      offset: newRawCaret - fm.spanFrom,
    })
  }

  return tr
}

export function completeInlineLinkTransaction(
  state: EditorState,
  tr: Transaction,
  bridge: MarkdownSourceBridge,
  draft: InlineLinkDraft | null = null
): Transaction {
  if (
    (!tr.docChanged && !tr.getMeta('inlineLinkDraftCommit')) ||
    tr.getMeta('inlineSourcePatch') ||
    tr.getMeta('pastePlain') ||
    tr.getMeta('historySelection') ||
    !tr.selection.empty
  ) {
    return tr
  }
  if (draft && completeOwnedLinkDraft(state, tr, bridge, draft)) return tr

  const $after = tr.selection.$from
  if ($after.parent.isTextblock && !$after.parent.type.spec.code && $after.parent.content.size <= 8192) {
    const oldPosition = tr.mapping.invert().map($after.pos, -1)
    if (oldPosition >= 0 && oldPosition <= state.doc.content.size) {
      const $before = state.doc.resolve(oldPosition)
      if (
        $before.parent.type === $after.parent.type &&
        ![...$before.parent.content.content, ...$after.parent.content.content].some(
          node => !node.isText || node.marks.some(mark => mark.type.spec.code)
        )
      ) {
        const oldTop = state.doc.child($before.index(0))
        const newTop = tr.doc.child($after.index(0))
        if (oldTop.attrs.sourceId === newTop.attrs.sourceId) {
          const block = bridge.blocks.find(b => b.id === oldTop.attrs.sourceId)
          if (block && block.raw.length <= 32768) {
            const text = $after.parent.textContent
            const change = textPatch($before.parent.textContent, text)
            if (change && text.includes('](')) {
              const from = bridge.sourcePosition($before.start() + change.from)
              const to = bridge.sourcePosition($before.start() + change.to)
              if (from >= block.from && to <= block.to) {
                const candidate = block.raw.slice(0, from - block.from) + change.insert + block.raw.slice(to - block.from)
                let attempts = 0
                for (let end = text.indexOf(')', change.from); end >= 0 && attempts++ < 64; end = text.indexOf(')', end + 1)) {
                  if (end < change.from + change.insert.length - 1) continue
                  const link = completedInlineLink(text.slice(0, end + 1), bridge.environment)
                  if (!link || link.from > change.from) continue
                  const linkFrom = $after.start() + link.from
                  const linkTo = $after.start() + end + 1
                  const inherited = tr.doc.resolve(linkFrom).marks()
                  if (inherited.some(mark => mark.type.name === 'link' || mark.type.spec.code)) continue
                  const content = parseInlineSource(link.raw, inherited, bridge.environment)
                  if (!content?.childCount) continue
                  const normalized = tr.doc.replace(linkFrom, linkTo, new Slice(content, 0, 0))
                  const target = normalized.child($after.index(0))
                  const parsed = parseMarkdown(candidate, bridge.environment).doc
                  const node = parsed.firstChild
                  if (parsed.childCount !== 1 || !node || !sameBlockSemantics(node, target)) continue
                  return tr
                    .replaceWith(linkFrom, linkTo, content)
                    .setSelection(TextSelection.create(tr.doc, linkFrom + content.size))
                    .setStoredMarks(inherited)
                    .setMeta('inlineSourcePatch', { from, to, insert: change.insert, blockId: block.id })
                    .setMeta('isolated', true)
                }
              }
            }
          }
        }
      }
    }
  }

  return completeGeneralInlineSyntax(state, tr, bridge)
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
    // Inline code: single or multi-backtick (`text`, ``text``, `` `text` ``)
    createInlineMarkInputRule(/(?:^|[^`])(`+)(?!`)([^\n]+?)(?<!`)\1$/, ['code'], currentBridge),
  ]
}

/** Backward-compatible export for strongInputRule */
export function strongInputRule(currentBridge: () => MarkdownSourceBridge) {
  return createInlineMarkInputRule(/(?:^|[^*_])(\*\*|__)(?=\S)([^\n]*?\S)\1$/, ['strong'], currentBridge)
}
