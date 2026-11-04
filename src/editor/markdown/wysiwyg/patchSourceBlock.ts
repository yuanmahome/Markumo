import { Mark, type Node } from 'prosemirror-model'
import { tableRow } from '../tableModel'
import { parseMarkdown, sameBlockSemantics, tokenizer } from './MarkdownParser'
import { escapeUnescapedPipes, serializeInlineFragment } from './MarkdownSerializer'
import { textPatch } from './sourcePatch'

interface Difference {
  before: Node
  after: Node
  offset: number
  code?: boolean
  inTable?: boolean
}

function textSpanDifference(
  before: Node,
  after: Node,
  offset = 0,
  inTable = false
): { before: Node; after: Node; offset: number; inTable: boolean } | null {
  if (before.eq(after) || !before.sameMarkup(after)) return null
  const tableHere = inTable || before.type.name === 'table'
  if (before.isTextblock && after.isTextblock) {
    const text = [...before.content.content, ...after.content.content]
    return text.every(node => node.isText) &&
      (before.childCount === 0 ||
        after.childCount === 0 ||
        text.some(node => node.marks.some(mark => mark.type.name === 'link' && mark.attrs.autolink !== 'none')))
      ? { before, after, offset, inTable: tableHere }
      : null
  }
  if (before.childCount !== after.childCount) return null
  let result: ReturnType<typeof textSpanDifference> = null
  let at = 0
  for (let i = 0; i < before.childCount; i++) {
    const a = before.child(i)
    const b = after.child(i)
    if (!a.eq(b)) {
      if (result) return null
      result = textSpanDifference(a, b, offset + at + 1, tableHere)
      if (!result) return null
    }
    at += a.nodeSize
  }
  return result
}

function singleDifference(before: Node, after: Node, offset = 0, inTable = false): Difference | null {
  if (before.eq(after)) return null
  const tableHere = inTable || before.type.name === 'table'
  if (!before.sameMarkup(after) || before.isText || after.isText) {
    return { before, after, offset, inTable: tableHere }
  }
  if (before.childCount !== after.childCount) {
    return before.isTextblock && after.isTextblock ? { before, after, offset, inTable: tableHere } : null
  }
  let difference: Difference | null = null
  let at = 0
  for (let index = 0; index < before.childCount; index++) {
    const a = before.child(index)
    const b = after.child(index)
    if (!a.eq(b)) {
      if (difference) {
        return before.isTextblock && after.isTextblock ? { before, after, offset, inTable: tableHere } : null
      }
      difference = singleDifference(a, b, offset + at + 1, tableHere)
      if (!difference) return null
    }
    at += a.nodeSize
  }
  return difference
    ? { ...difference, code: difference.code || before.type.name === 'code_block', inTable: difference.inTable || tableHere }
    : null
}

/** Decode only lexical text escapes, retaining atomic source boundaries. The
 * segments store exceptions, not one retained offset per document character. */
export function decodedText(raw: string, verbatim = false, indent = '') {
  const atoms: { from: number; to: number; start: number; end: number }[] = []
  const parts: string[] = []
  let cursor = 0
  let size = 0
  const escaped =
    /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);|\r\n/g
  const prefix = indent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp((verbatim ? '\\r\\n' : escaped.source) + (indent ? '|^' + prefix : ''), 'gm')
  for (const match of raw.matchAll(pattern)) {
    const value =
      indent && match[0] === indent ? '' : match[0] === '\r\n' ? '\n' : tokenizer.utils.unescapeAll(match[0])
    if (value === match[0]) continue
    const plain = raw.slice(cursor, match.index)
    parts.push(plain, value)
    size += plain.length
    atoms.push({ from: match.index, to: match.index + match[0].length, start: size, end: size + value.length })
    size += value.length
    cursor = match.index + match[0].length
  }
  parts.push(raw.slice(cursor))
  return {
    text: parts.join(''),
    indent,
    original(position: number) {
      let delta = 0
      for (const atom of atoms) {
        if (position < atom.from) break
        if (position < atom.to) return atom.start
        delta = atom.to - atom.end
      }
      return position - delta
    },
    offset(position: number): number | null {
      let delta = 0
      for (const atom of atoms) {
        if (position < atom.start) break
        if (position === atom.start) return atom.start === atom.end ? atom.to : atom.from
        if (position < atom.end) return null
        if (position === atom.end) return atom.to
        delta = atom.to - atom.end
      }
      return position + delta
    },
  }
}

/** Map source/display coordinates using the same sparse lexical boundaries as
 * text patches. Delimiters and stripped indentation map to the nearest text
 * edge; entities are indivisible. No map survives the current call/revision. */
export function sourceTextPosition(node: Node, raw: string, position: number, reverse = false) {
  const ranges: {
    from: number
    to: number
    start: number
    end: number
    source: (n: number) => number
    display: (n: number) => number
  }[] = []
  let cursor = 0
  const opening = node.type.name === 'code_block' ? /^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/.exec(raw)?.[0].length || 0 : 0
  const body = raw.slice(opening)
  const plain = decodedText(body)
  const verbatim = decodedText(body, true)
  let itemIndex = 0
  let itemTokens: ReturnType<typeof tokenizer.parse> | undefined
  let lineStarts: number[] | undefined
  let tableRowIdx = -1
  let tableColIdx = 0
  let rawLines: string[] | undefined

  const ensureLineStarts = () => {
    if (!lineStarts) {
      lineStarts = [0]
      for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') lineStarts.push(i + 1)
    }
    return lineStarts
  }

  node.descendants((child, pos, parent) => {
    if (child.type.name === 'table_row') {
      tableRowIdx++
      tableColIdx = 0
    } else if (child.type.name === 'table_cell' || child.type.name === 'table_header') {
      const col = tableColIdx++
      if (child.firstChild?.isTextblock && !child.firstChild.content.size && node.type.name === 'table') {
        const starts = ensureLineStarts()
        rawLines ??= raw.split('\n')
        const rawLine = tableRowIdx === 0 ? 0 : tableRowIdx + 1
        if (rawLines[rawLine] !== undefined && starts[rawLine] !== undefined) {
          const cells = tableRow(rawLines[rawLine].replace(/\r$/, ''), starts[rawLine]).cells
          const cellSpan = cells[col]
          if (cellSpan) {
            const caret = pos + 2
            const at = cellSpan.from
            ranges.push({ from: caret, to: caret, start: at, end: at, source: () => at, display: () => caret })
          }
        }
      }
    }
    if (child.type.name === 'list_item') {
      const index = itemIndex++
      if (child.firstChild?.isTextblock && !child.firstChild.content.size) {
        // Empty items have no text atom to map. Their caret belongs after the
        // marker (and task checkbox), not at the preceding item's last word.
        itemTokens ??= tokenizer.parse(raw, {}).filter(token => token.type === 'list_item_open')
        const starts = ensureLineStarts()
        const line = itemTokens[index]?.map?.[0]
        if (line !== undefined) {
          const start = starts[line]
          const newline = raw.indexOf('\n', start)
          let at = newline < 0 ? raw.length : newline
          if (raw[at - 1] === '\r') at--
          const caret = pos + 2
          ranges.push({ from: caret, to: caret, start: at, end: at, source: () => at, display: () => caret })
        }
      }
    }
    if (parent?.type.name === 'blockquote' && child.isTextblock && !child.content.size) {
      const quoteMatch = /^([ \t]*(?:>[ \t]*)+)/m.exec(raw.slice(cursor))
      if (quoteMatch) {
        const at = cursor + quoteMatch.index + quoteMatch[0].length
        const caret = pos + 1
        ranges.push({ from: caret, to: caret, start: at, end: at, source: () => at, display: () => caret })
      }
    }
    if (child.type.name === 'image_source' || child.type.name === 'html_inline') {
      const source = String(child.attrs.source ?? '')
      const at = source ? raw.indexOf(source, cursor) : -1
      if (at >= 0) {
        ranges.push({
          from: pos,
          to: pos + child.nodeSize,
          start: at,
          end: at + source.length,
          source: n => (n === pos ? at : at + source.length),
          display: n => (n === at + source.length ? pos + child.nodeSize : pos),
        })
        cursor = at + source.length
      }
    }
    if (!child.isText) return
    const code = parent?.type.name === 'code_block' || child.marks.some(mark => mark.type.name === 'code')
    const variants = [code ? verbatim : plain]
    const text = child.text!
    if (code) {
      const line = text.split('\n').find(value => value.trim())
      if (line) {
        let count = 0
        for (let at = body.indexOf(line); at >= 0 && count++ < 16; at = body.indexOf(line, at + 1)) {
          const prefix = body.slice(body.lastIndexOf('\n', at - 1) + 1, at)
          if (/^[ \t>]+$/.test(prefix)) variants.unshift(decodedText(body, true, prefix))
        }
      }
    }
    for (const variant of variants) {
      const at = variant.text.indexOf(text, variant.original(Math.max(0, cursor - opening)))
      if (at < 0) continue
      const start = variant.offset(at)
      const end = variant.offset(at + text.length)
      if (start === null || end === null) continue
      ranges.push({
        from: pos,
        to: pos + text.length,
        start: opening + start,
        end: opening + end,
        source: n => opening + (variant.offset(at + n - pos) ?? start),
        display: n => pos + variant.original(n - opening) - at,
      })
      cursor = opening + end
      break
    }
  })
  for (const range of ranges) {
    if (reverse && position >= range.start && position <= range.end) {
      return Math.max(range.from, Math.min(range.to, range.display(position)))
    }
    if (!reverse && position >= range.from && (position < range.to || (position === range.from && range.from === range.to))) {
      return range.source(position)
    }
  }
  if (!reverse) {
    const end = ranges.find(range => position === range.to)
    if (end) return end.source(position)
  }
  let nearest: { distance: number; position: number } | undefined
  for (const range of ranges) {
    for (const edge of reverse
      ? [
          [range.start, range.from],
          [range.end, range.to],
        ]
      : [
          [range.from, range.start],
          [range.to, range.end],
        ]) {
      const distance = Math.abs(position - edge[0])
      if (!nearest || distance < nearest.distance) nearest = { distance, position: edge[1] }
    }
  }
  return nearest?.position ?? Math.max(0, Math.min(reverse ? node.content.size : raw.length, position))
}

/**
 * Tier 1 minimal inline escape: escapes ONLY inline Markdown delimiters (`\`, `` ` ``, `*`, `_`, `[`, `]`, `$`,
 * paired `~~`, and HTML/autolink `<`), leaving ordinary prose characters (`-`, `+`, `(`, `)`, `{`, `}`, `=`, `!`, `#`, `&`) untouched.
 */
function minimalLiteral(text: string, verbatim: boolean, inTable = false): string {
  if (verbatim) return text
  let out = text
    .replace(/[\\`*_[\]$]/g, '\\$&')
    .replace(/(?<=~)~|~(?=~)/g, '\\~')
    .replace(/<(?=[a-zA-Z/!?]|https?:|mailto:)/g, '\\<')
  if (inTable) out = escapeUnescapedPipes(out)
  return out
}

/** Tier 2 full fallback escape (used only when Tier 0 direct and Tier 1 minimalLiteral both fail AST verification). */
function fullLiteral(text: string, verbatim: boolean, inTable = false): string {
  if (verbatim) return text
  let out = text.replace(/&/g, '&amp;').replace(/[\\`*_[\]<>!#~+(){}=\-$]/g, '\\$&')
  if (inTable) out = escapeUnescapedPipes(out)
  return out
}

const DELIMITER_PREFIXES = ['***', '___', '**', '__', '~~', '*', '_']

function expandEnclosingDelimiters(raw: string, start: number, end: number): Array<[number, number]> {
  const candidates: Array<[number, number]> = [[start, end]]
  for (const delim of DELIMITER_PREFIXES) {
    if (start >= delim.length && raw.slice(start - delim.length, start) === delim && raw.slice(end, end + delim.length) === delim) {
      candidates.push([start - delim.length, end + delim.length])
    }
  }
  // Inline code backtick fence around [start, end]
  const leadingTicks = /(`+[ \t]?)$/.exec(raw.slice(0, start))?.[1]
  if (leadingTicks) {
    const tickCount = leadingTicks.match(/^`+/)![0].length
    // A closing fence must use exactly the same number of backticks; a backtick
    // character cannot appear in a template literal, so build it by concatenation.
    const closeRe = new RegExp('^[ \\t]?' + '`'.repeat(tickCount) + '(?!`)')
    const trailingMatch = closeRe.exec(raw.slice(end))
    if (trailingMatch) {
      candidates.push([start - leadingTicks.length, end + trailingMatch[0].length])
    }
  }
  return candidates
}

/**
 * Tolerant raw-offset alignment for one textblock. Inline atoms (math, footnote refs, images,
 * HTML) and source markup (delimiters, escapes, `>` prefixes) occupy raw bytes that the
 * ProseMirror text does not contain, so an exact `indexOf` of the whole text node can fail.
 * Every candidate built from this mapping is still verified by a full block parse, so a
 * misalignment degrades to the existing serialization fallback instead of corrupting source.
 */
function alignTextblockRange(
  textblock: Node,
  raw: string,
  startHint: number,
  textFrom: number,
  textTo: number
): { start: number; end: number } | null {
  const text = textblock.textContent
  const from = Math.max(0, Math.min(text.length, textFrom))
  const to = Math.max(from, Math.min(text.length, textTo))
  let i = 0
  let j = Math.max(0, Math.min(raw.length, startHint))
  let start = -1
  while (i <= to && j <= raw.length) {
    if (i === to) {
      if (from === to) return { start: j, end: j }
      return start >= 0 ? { start, end: j } : null
    }
    if (i === from) start = j
    if (i >= text.length) return null
    if (j < raw.length && raw[j] === text[i]) {
      i++
      j++
      continue
    }
    if (j >= raw.length) return null
    // Skip one raw byte that the rendered text does not include (markup, escapes, atoms).
    // An escaped punctuation pair consumes both bytes so the literal character lines up.
    j += raw[j] === '\\' && j + 1 < raw.length ? 2 : 1
  }
  return null
}

/**
 * Patch only the changed inline subrange inside a single modified textblock when marks or child
 * counts changed (e.g., pasting Markdown into a rich paragraph, or toggling Bold/Code on one word),
 * preserving all surrounding Markdown syntax (`__bold__`, `&amp;`, `[ref][id]`, sibling table cells) untouched.
 */
function patchInlineSubrange(
  beforeBlock: Node,
  a: Node,
  b: Node,
  aContentOffset: number,
  raw: string,
  inTable: boolean,
  accepts: (candidate: string) => boolean
): string | null {
  if (!a.isTextblock || !b.isTextblock || !a.sameMarkup(b) || a.type.spec.code) return null
  const diffStart = a.content.findDiffStart(b.content)
  if (diffStart === null) return null
  const diffEnd = a.content.findDiffEnd(b.content)
  if (!diffEnd) return null

  const overlap = Math.max(0, diffStart - Math.min(diffEnd.a, diffEnd.b))
  const startA = diffStart
  const endA = diffEnd.a + overlap
  const endB = diffEnd.b + overlap

  // If the entire top-level paragraph/heading changed, let normal block fallback run.
  if (beforeBlock === a && startA === 0 && endA === a.content.size) {
    return null
  }

  const changedSlice = b.slice(startA, endB).content
  let replacement = serializeInlineFragment(changedSlice)
  if (inTable) {
    replacement = escapeUnescapedPipes(replacement.replace(/\\\n/g, '<br>').replace(/\n/g, '<br>'))
  }

  const exactStart = sourceTextPosition(beforeBlock, raw, aContentOffset + startA)
  const exactEnd = sourceTextPosition(beforeBlock, raw, aContentOffset + endA)
  const mappings: Array<[number, number]> = []
  if (exactStart >= 0 && exactEnd >= exactStart && exactEnd <= raw.length) mappings.push([exactStart, exactEnd])

  const textStart = a.textBetween(0, startA, '', '').length
  const textEnd = a.textBetween(0, endA, '', '').length
  const aligned = alignTextblockRange(a, raw, exactStart, textStart, textEnd)
  if (aligned && !mappings.some(([s, e]) => s === aligned.start && e === aligned.end)) {
    mappings.push([aligned.start, aligned.end])
  }

  for (const [rawStart, rawEnd] of mappings) {
    for (const [s, e] of expandEnclosingDelimiters(raw, rawStart, rawEnd)) {
      const candidate = raw.slice(0, s) + replacement + raw.slice(e)
      if (accepts(candidate)) return candidate
      if (s === e && raw.slice(0, s).match(/(?:^|\n)[ \t]*(?:[-+*]|\d+[.)]|>+)$/)) {
        const withSpace = raw.slice(0, s) + ' ' + replacement + raw.slice(e)
        if (accepts(withSpace)) return withSpace
      }
      if (inTable && s === e && raw[e] === '|') {
        const withCellPad = raw.slice(0, s) + replacement + ' ' + raw.slice(e)
        if (accepts(withCellPad)) return withCellPad
      }
    }
  }

  return null
}

/** Preserve all unaffected source, accepting a candidate only when parsing it
 * produces the intended PM block semantics. Ambiguous repeated words are tested
 * against the whole block rather than matched by text alone. */
export function patchSourceBlock(
  before: Node,
  after: Node,
  raw: string,
  environment: Record<string, unknown>
): string | null {
  const accepts = (candidate: string) => {
    try {
      const parsed = parseMarkdown(candidate, environment)
      if (parsed.blocks.length !== 1) return false
      return sameBlockSemantics(parsed.blocks[0].node, after)
    } catch {
      return false
    }
  }

  // Empty paragraphs and linkification change the text-node count, so the
  // single-node path below no longer applies. Preserve the exact typed source
  // before falling back to serialization, which would escape pending [label](
  // or opening ` / * delimiters.
  const linked = textSpanDifference(before, after)
  if (linked) {
    const change = textPatch(linked.before.textContent, linked.after.textContent)
    if (change) {
      const from = sourceTextPosition(before, raw, linked.offset + change.from)
      const to = sourceTextPosition(before, raw, linked.offset + change.to)
      const variants = [
        change.insert,
        minimalLiteral(change.insert, false, linked.inTable),
        fullLiteral(change.insert, false, linked.inTable),
      ]
      const needsLeadingSpace =
        linked.before.childCount === 0 && /(?:^|\n)[ \t]*(?:[-+*]|\d+[.)]|>+)$/.test(raw.slice(0, from))
      const needsTrailingSpace = linked.inTable && linked.before.childCount === 0 && raw[to] === '|'

      for (const ins of variants) {
        const candidates = [
          raw.slice(0, from) + (needsLeadingSpace ? ' ' : '') + ins + (needsTrailingSpace ? ' ' : '') + raw.slice(to),
          raw.slice(0, from) + ins + raw.slice(to),
        ]
        for (const candidate of candidates) {
          if (accepts(candidate)) return candidate
        }
      }
    }
  }

  const difference = singleDifference(before, after)
  if (!difference) return null
  const { before: a, after: b } = difference

  if (a.isText && b.isText && Mark.sameSet(a.marks, b.marks)) {
    const change = textPatch(a.text!, b.text!)
    if (!change) return raw
    const verbatim = !!difference.code || before.type.name === 'code_block' || a.marks.some(mark => mark.type.name === 'code')
    const variants = [{ text: raw, indent: '', offset: (position: number): number | null => position }]
    if (!verbatim || raw.includes('\r\n')) variants.push(decodedText(raw, verbatim))
    if (verbatim && a.text!.includes('\n')) {
      const line = a.text!.split('\n').find(line => line.trim())
      if (line) {
        let count = 0
        for (let at = raw.indexOf(line); at >= 0 && count++ < 16; at = raw.indexOf(line, at + 1)) {
          const prefix = raw.slice(raw.lastIndexOf('\n', at - 1) + 1, at)
          if (/^[ \t>]+$/.test(prefix)) variants.push(decodedText(raw, true, prefix))
        }
      }
    }
    let attempts = 0
    for (const variant of variants) {
      for (let at = variant.text.indexOf(a.text!); at >= 0 && attempts < 64; at = variant.text.indexOf(a.text!, at + 1)) {
        attempts++
        let from = change.from
        let to = change.to
        while (from > 0 && variant.offset(at + from) === null) from--
        while (to < a.text!.length && variant.offset(at + to) === null) to++
        const start = variant.offset(at + from)
        const end = variant.offset(at + to)
        if (start === null || end === null) continue
        const insert = a.text!.slice(from, change.from) + change.insert + a.text!.slice(change.to, to)
        const direct = raw.slice(0, start) + insert.replace(/\n/g, '\n' + variant.indent) + raw.slice(end)
        if (accepts(direct)) return direct

        const minEscaped = minimalLiteral(insert, verbatim, !!difference.inTable).replace(/\n/g, '\n' + variant.indent)
        const minCandidate = raw.slice(0, start) + minEscaped + raw.slice(end)
        if (minCandidate !== direct && accepts(minCandidate)) return minCandidate

        const fullEscaped = fullLiteral(insert, verbatim, !!difference.inTable).replace(/\n/g, '\n' + variant.indent)
        const fullCandidate = raw.slice(0, start) + fullEscaped + raw.slice(end)
        if (fullCandidate !== minCandidate && fullCandidate !== direct && accepts(fullCandidate)) return fullCandidate

        // Removing boundary whitespace can make underscore emphasis intraword.
        // Expand only to the touching delimiters; keep entities and all other
        // source untouched, and prove the resulting block semantics again.
        if (!verbatim) {
          for (const marker of ['__', '_']) {
            if (raw.startsWith(marker, end)) {
              let closing = raw.indexOf(marker, end + marker.length)
              let count = 0
              while (closing >= 0 && count++ < 16) {
                const repaired =
                  raw.slice(0, start) +
                  minimalLiteral(insert, false, !!difference.inTable) +
                  '*'.repeat(marker.length) +
                  raw.slice(end + marker.length, closing) +
                  '*'.repeat(marker.length) +
                  raw.slice(closing + marker.length)
                if (accepts(repaired)) return repaired
                closing = raw.indexOf(marker, closing + marker.length)
              }
            }
            if (raw.slice(0, start).endsWith(marker)) {
              let opening = raw.lastIndexOf(marker, start - marker.length - 1)
              let count = 0
              while (opening >= 0 && count++ < 16) {
                const repaired =
                  raw.slice(0, opening) +
                  '*'.repeat(marker.length) +
                  raw.slice(opening + marker.length, start - marker.length) +
                  '*'.repeat(marker.length) +
                  minimalLiteral(insert, false, !!difference.inTable) +
                  raw.slice(end)
                if (accepts(repaired)) return repaired
                opening = raw.lastIndexOf(marker, opening - 1)
              }
            }
          }
        }
      }
    }
  }

  if (a.isTextblock && b.isTextblock && a.sameMarkup(b)) {
    // `difference.offset` is already the content-relative position of the changed
    // textblock inside `before`, so it is the base for raw-source mapping.
    const subrangePatched = patchInlineSubrange(before, a, b, difference.offset, raw, !!difference.inTable, accepts)
    if (subrangePatched !== null) return subrangePatched
  }

  if (a.type.name === 'heading' && b.type === a.type && a.content.eq(b.content)) {
    const match = /^( {0,3})(#{1,6})(?=[ \t]|$)/.exec(raw)
    if (match) {
      const candidate = match[1] + '#'.repeat(b.attrs.level) + raw.slice(match[0].length)
      if (accepts(candidate)) return candidate
    }
    const setext = /^(.*\r?\n)([ \t]*)(=+|-+)([ \t]*)$/.exec(raw)
    if (setext && b.attrs.level <= 2) {
      const candidate = setext[1] + setext[2] + (b.attrs.level === 1 ? '=' : '-').repeat(setext[3].length) + setext[4]
      if (accepts(candidate)) return candidate
    }
  }
  if (a.type.name === 'image' && b.type === a.type && a.attrs.src !== b.attrs.src) {
    const needle = String(a.attrs.src)
    const insert = String(b.attrs.src)
    if (needle) {
      for (let at = raw.indexOf(needle); at >= 0; at = raw.indexOf(needle, at + needle.length)) {
        const candidate = raw.slice(0, at) + insert + raw.slice(at + needle.length)
        if (accepts(candidate)) return candidate
      }
    }
  }
  if (a.type.name === 'list_item' && b.type === a.type && a.content.eq(b.content)) {
    for (const match of raw.matchAll(/^([ \t]*[-+*][ \t]+\[)[ xX](\][ \t])/gm)) {
      const at = match.index + match[1].length
      const candidate = raw.slice(0, at) + (b.attrs.checked ? 'x' : ' ') + raw.slice(at + 1)
      if (accepts(candidate)) return candidate
    }
  }
  return null
}
