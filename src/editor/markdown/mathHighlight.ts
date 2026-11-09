import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import MarkdownIt from 'markdown-it'
import { installMarkdownMath, mathClosingDelimiter } from './mathSemantics'

const parser = new MarkdownIt({ html: true })
installMarkdownMath(parser)
const mark = Decoration.mark({ class: 'tok-math', attributes: { 'data-math-source': 'true' } })

/** Use the renderer's token boundaries, including code/container exclusions. */
export const mathHighlight = [ViewPlugin.fromClass(class {
  decorations
  constructor(view: EditorView) { this.decorations = decorations(view.state.doc.toString()) }
  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = decorations(update.state.doc.toString())
  }
}, { decorations: plugin => plugin.decorations }), EditorView.baseTheme({ '.tok-math': { color: 'var(--bright)', fontFamily: 'var(--font-mono)' } })]

function decorations(source: string) {
  if (!source.includes('$') && !source.includes(String.fromCharCode(92))) return Decoration.none
  const starts = [0]
  for (let at = 0; at < source.length; at++) if (source[at] === '\n') starts.push(at + 1)
  const ranges: { from: number; to: number }[] = []
  for (const token of parser.parse(source, {})) {
    if (!token.map) continue
    const from = starts[token.map[0]], to = starts[token.map[1]] ?? source.length
    if (token.type === 'math_block') ranges.push({ from, to })
    else if (token.type === 'inline') {
      let cursor = from
      for (const child of token.children ?? []) {
        const raw = child.type === 'math_inline'
          ? child.markup + child.content + mathClosingDelimiter(child.markup)
          : child.type === 'code_inline' ? child.markup + child.content + child.markup : child.content
        if (!raw) continue
        const at = source.indexOf(raw, cursor)
        if (at < 0 || at + raw.length > to) continue
        cursor = at + raw.length
        if (child.type === 'math_inline') ranges.push({ from: at, to: cursor })
      }
    }
  }
  return Decoration.set(ranges.filter(range => range.to > range.from).map(range => mark.range(range.from, range.to)), true)
}
