import MarkdownIt from 'markdown-it'
import { InlineContext, type MarkdownConfig } from '@lezer/markdown'

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u
const punctuation = /\p{P}/u
function adjacent(source: string, start: number, end: number) {
  const last = source.charCodeAt(start - 1)
  const before = start ? source.slice(start - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1), start) : ' '
  const after = end < source.length ? String.fromCodePoint(source.codePointAt(end)!) : ' '
  return { before, after, open: cjk.test(before) && punctuation.test(after), close: punctuation.test(before) && cjk.test(after) }
}

/** CJK text has no word spaces. Permit double/triple asterisks at its
 * punctuation boundaries, leaving pairing, escapes and code to each parser.
 * Neither source bytes nor offsets are rewritten. Underscores keep CommonMark.
 */
export function installCjkEmphasis(md: ReturnType<typeof MarkdownIt>) {
  md.inline.ruler.before('emphasis', 'markumo_cjk_strong', (state, silent) => {
    if (silent || state.src.charCodeAt(state.pos) !== 42) return false
    const scanned = state.scanDelims(state.pos, true)
    if (scanned.length !== 2 && scanned.length !== 3) return false
    const flags = adjacent(state.src, state.pos, state.pos + scanned.length)
    if (!flags.open && !flags.close) return false
    for (let i = 0; i < scanned.length; i++) {
      const token = state.push('text', '', 0); token.content = '*'
      state.delimiters.push({ marker: 42, length: scanned.length, token: state.tokens.length - 1,
        end: -1, open: scanned.can_open || flags.open, close: scanned.can_close || flags.close })
    }
    state.pos += scanned.length
    return true
  })
}

export const cjkEmphasisSyntax: MarkdownConfig = {
  parseInline: [{ name: 'CjkStrong', before: 'Emphasis', parse(cx, next, start) {
    if (next !== 42) return -1
    let end = start + 1
    while (cx.char(end) === 42) end++
    if (end - start !== 2 && end - start !== 3) return -1
    const flags = adjacent(cx.text, start - cx.offset, end - cx.offset)
    if (!flags.open && !flags.close) return -1
    const pBefore = punctuation.test(flags.before), pAfter = punctuation.test(flags.after)
    const sBefore = /\s/.test(flags.before), sAfter = /\s/.test(flags.after)
    const open = flags.open || !sAfter && (!pAfter || sBefore || pBefore)
    const close = flags.close || !sBefore && (!pBefore || sAfter || pAfter)
    return cx.addDelimiter(InlineContext.emphasisAsterisk, start, end, open, close)
  } }],
}
