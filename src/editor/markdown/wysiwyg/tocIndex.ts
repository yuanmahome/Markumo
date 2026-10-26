import type { Node, NodeType } from 'prosemirror-model'

export interface TocHeading {
  readonly pos: number
  readonly level: number
  readonly text: string
}

// Selection-only transactions retain the immutable document object; content
// edits replace it even when heading text is unchanged but positions shift.
// Weak keys release closed documents and obsolete revisions automatically.
const cache = new WeakMap<Node, Map<NodeType, readonly TocHeading[]>>()

export function headingsFor(doc: Node, headingType: NodeType): readonly TocHeading[] {
  let types = cache.get(doc)
  const existing = types?.get(headingType)
  if (existing) return existing
  const headings: TocHeading[] = []
  doc.descendants((node, pos) => {
    if (node.type === headingType) headings.push(Object.freeze({ pos, level: node.attrs.level || 1, text: node.textContent.trim() }))
  })
  if (!types) cache.set(doc, types = new Map())
  const result = Object.freeze(headings)
  types.set(headingType, result)
  return result
}
