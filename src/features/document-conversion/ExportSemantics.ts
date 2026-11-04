import type MarkdownIt from 'markdown-it'
export interface ExportNote { label: string; text: string }
/** Parse definitions before reference links, but only at Markdown block boundaries.
 * Fenced/code blocks are consumed by their own rules and remain byte-for-byte text. */
export function installExportFootnotes(md: ReturnType<typeof MarkdownIt>, notes: ExportNote[]) {
  md.block.ruler.before('reference', 'export_footnotes', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
    const match = /^\[\^([^\]]+)\]:[ \t]*(.*)$/.exec(line)
    if (!match) return false
    if (silent) return true
    const parts = [match[2]]
    let next = start + 1
    while (next < end && state.sCount[next] - state.blkIndent >= 4) {
      parts.push(state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next])); next++
    }
    notes.push({ label: match[1], text: parts.join('\n') }); state.line = next
    return true
  }, { alt: ['paragraph', 'reference'] })
}
