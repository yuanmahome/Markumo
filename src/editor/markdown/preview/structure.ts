import MarkdownIt from 'markdown-it'
import { installMarkdownMath } from '../mathSemantics'

export interface PreviewGroup { from: number; to: number; line: number; endLine: number; blocks: number }
export interface StructureBatch { groups: PreviewGroup[]; complete: boolean; references: Record<string, unknown>; lines: number }

/** The renderer's actual block rules own the boundaries, including nested
 * containers. Never infer safety from a blank line or a fixed character cut. */
export function* structureBatches(source: string): Generator<StructureBatch> {
  const md = new MarkdownIt({ html: true })
  installMarkdownMath(md)
  const environment = {}
  const state = new md.block.State(source, md, environment, [])
  const rules = md.block.ruler.getRules('')
  let from = 0, firstLine = 0, blocks = 0, empty = false
  let groups: PreviewGroup[] = [], started = performance.now()
  // Front matter belongs to the document start, even when it contains blank
  // lines, list markers or headings that ordinary Markdown rules would split.
  const yaml = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source)
  if (yaml) {
    const to = yaml[0].length
    while (state.line < state.lineMax && state.bMarks[state.line] < to) state.line++
    yield { groups: [{ from: 0, to, line: 1, endLine: state.line + 1, blocks: 1 }], complete: false, references: {}, lines: state.lineMax }
    from = to; firstLine = state.line
  }
  while (state.line < state.lineMax) {
    state.line = state.skipEmptyLines(state.line)
    if (state.line >= state.lineMax) break
    const before = state.line
    let matched = false
    for (const rule of rules) {
      if (rule(state, before, state.lineMax, false)) { matched = true; break }
    }
    if (!matched || state.line <= before) throw new Error('Markdown 分区规则未前进')
    if (/^ {0,3}\[\^[^\]\r\n]+\]:/.test(source.slice(state.bMarks[before], state.eMarks[before]))) {
      // Footnote continuation paragraphs are part of the same structure.
      while (state.line < state.lineMax && (state.isEmpty(state.line) || /^(?: {4}|\t)/.test(source.slice(state.bMarks[state.line], state.eMarks[state.line])))) state.line++
    }
    state.tight = !empty
    if (state.isEmpty(state.line - 1)) empty = true
    if (state.line < state.lineMax && state.isEmpty(state.line)) { empty = true; state.line++ }
    // Tokens are temporary: retain coordinates, never the full AST/inline text.
    state.tokens.length = 0
    blocks++
    const to = state.bMarks[state.line] ?? source.length
    if (to - from >= 16384 || blocks >= 32) {
      groups.push({ from, to, line: firstLine + 1, endLine: state.line + 1, blocks })
      from = to; firstLine = state.line; blocks = 0
    }
    if (groups.length && performance.now() - started >= 6) {
      yield { groups, complete: false, references: {}, lines: state.lineMax }
      groups = []; started = performance.now()
    }
  }
  if (from < source.length || !groups.length && !from) groups.push({ from, to: source.length, line: firstLine + 1, endLine: state.lineMax + 1, blocks })
  yield { groups, complete: true, references: (environment as { references?: Record<string, unknown> }).references || {}, lines: state.lineMax }
}
