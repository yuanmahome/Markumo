import type MarkdownIt from 'markdown-it'

/** Shared delimiter policy for the Live parser and read-only preview. */
export function mathBlockParts(source: string) {
  const match = /^([ \t]*\$\$(?:\r?\n)?)([\s\S]*?)((?:\r?\n)?\$\$[ \t]*)$/.exec(source)
    ?? /^([ \t]*\\\[(?:\r?\n)?)([\s\S]*?)((?:\r?\n)?\\\][ \t]*)$/.exec(source)
  return match ? { opening: match[1], value: match[2], closing: match[3] } : null
}

function escaped(source: string, at: number) {
  let count = 0
  while (at > 0 && source[--at] === '\\') count++
  return count % 2 === 1
}

export function mathClosingDelimiter(opening: string) {
  return opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening
}

export function inlineMathEnd(source: string, from: number): number | null {
  if ((source.startsWith('\\(', from) || source.startsWith('\\[', from)) && !escaped(source, from)) {
    const closing = mathClosingDelimiter(source.slice(from, from + 2))
    for (let end = from + 2; end < source.length; end++) {
      if (/[\r\n]/.test(source[end])) return null
      if (source.startsWith(closing, end) && !escaped(source, end) && end > from + 2) return end
    }
    return null
  }
  if (source[from] !== '$' || source[from + 1] === '$' || escaped(source, from)) return null
  if (/\s/.test(source[from + 1] || ' ') || source[from - 1] === '$') return null
  for (let end = from + 1; end < source.length; end++) {
    if (source[end] === '\n' || source[end] === '\r') return null
    if (source[end] !== '$' || escaped(source, end)) continue
    // The same currency/whitespace policy applies in both modes.
    if (source[end + 1] === '$' || /\d/.test(source[end + 1] || '') || /\s/.test(source[end - 1])) return null
    if (/^\d[\d.,]*\s+\p{L}[\p{L}\s,，。.]*$/u.test(source.slice(from + 1, end))) return null
    return end
  }
  return null
}

export function installMarkdownMath(md: ReturnType<typeof MarkdownIt>) {
  md.block.ruler.before('fence', 'markumo_math_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false
    const from = state.bMarks[startLine] + state.tShift[startLine]
    const opening = state.src.startsWith('$$', from) ? '$$' : state.src.startsWith('\\[', from) ? '\\[' : null
    if (!opening) return false
    for (let line = startLine; line < endLine; line++) {
      // Never consume a sibling block or leave the current list/quote container.
      if (line > startLine && state.sCount[line] < state.blkIndent && !state.isEmpty(line)) break
      const end = state.eMarks[line], text = state.src.slice(state.bMarks[line] + state.tShift[line], end)
      if (line > startLine && /^(?:`{3,}|~{3,})/.test(text)) break
      const closing = text.search(opening === '$$' ? /\$\$[ \t]*$/ : /\\\][ \t]*$/)
      if (closing < 0 || escaped(text, closing) || line === startLine && state.src.slice(from, end).trimEnd().length < 4) continue
      if (silent) return true
      const token = state.push('math_block', 'div', 0)
      token.block = true; token.map = [startLine, line + 1]
      token.content = state.getLines(startLine, line + 1, state.blkIndent, false).replace(/\r?\n$/, '')
      state.line = line + 1
      return true
    }
    return false
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.inline.ruler.before('escape', 'markumo_math_inline', (state, silent) => {
    const end = inlineMathEnd(state.src, state.pos)
    if (end === null) return false
    const width = state.src[state.pos] === '$' ? 1 : 2
    if (!silent) {
      const token = state.push('math_inline', 'span', 0)
      token.content = state.src.slice(state.pos + width, end)
      token.markup = state.src.slice(state.pos, state.pos + width)
    }
    state.pos = end + width
    return true
  })
}
