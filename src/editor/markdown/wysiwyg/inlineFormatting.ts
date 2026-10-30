import { Fragment, type Mark } from 'prosemirror-model'
import { MarkdownParser } from 'prosemirror-markdown'
import { markdownParser, tokenizer } from './MarkdownParser'

// A local formatting edit is inline syntax even when its remaining text is
// '*' or '***'. Running the block grammar here turns ordinary deletion into a
// list/rule and prevents the edit from reaching the canonical document.
const inlineTokenizer = Object.create(tokenizer) as typeof tokenizer
const [paragraphOpen, , paragraphClose] = tokenizer.parse('x', {})
inlineTokenizer.parse = (raw, environment) => [
  paragraphOpen,
  ...tokenizer.parseInline(raw, environment),
  paragraphClose,
]
const inlineParser = new MarkdownParser(markdownParser.schema, inlineTokenizer, markdownParser.tokens)

export function parseFormattingSource(raw: string, inherited: readonly Mark[] = [], environment: Record<string, unknown> = {}): Fragment | null {
  if (raw.length > 8192 || /\n[\t ]*\n/.test(raw)) return null
  if (!raw) return Fragment.empty
  try {
    const doc = inlineParser.parse(raw, { ...environment, references: { ...environment.references as object } })
    return Fragment.from(doc.firstChild!.content.content.map(node => {
      let marks = node.marks
      for (const mark of inherited) marks = mark.addToSet(marks)
      return node.mark(marks)
    }))
  } catch { return null }
}

export function isFormattingKind(kind: string) {
  return ['strong', 'em', 'strike', 'code'].includes(kind)
}
