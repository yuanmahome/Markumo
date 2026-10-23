import { Fragment, type Node } from 'prosemirror-model'
import { Plugin } from 'prosemirror-state'
import { markdownSchema as schema } from './MarkdownSchema'

export function isTrailingParagraph(node: Node) {
  return node.type === schema.nodes.paragraph && node.attrs.editorTrailing === true
}

function needsTrailingParagraph(node: Node) {
  return ['code_block', 'table', 'horizontal_rule', 'html_block', 'protected_source'].includes(node.type.name) ||
    node.type === schema.nodes.paragraph && node.childCount === 1 && ['image', 'image_source'].includes(node.firstChild?.type.name ?? '')
}

function placeholder() {
  return schema.nodes.paragraph.create({ sourceId: 'editor-trailing', editorTrailing: true })
}

/** The editable canvas has a trailing paragraph; canonical Markdown does not
 * acquire extra bytes or a dirty flag until the user actually enters content. */
export function withTrailingParagraph(doc: Node) {
  return doc.lastChild && needsTrailingParagraph(doc.lastChild)
    ? doc.copy(doc.content.append(Fragment.from(placeholder()))) : doc
}

export function withoutTrailingParagraph(doc: Node) {
  const last = doc.lastChild
  return last && isTrailingParagraph(last) && !last.content.size
    ? doc.copy(doc.content.cut(0, doc.content.size - last.nodeSize)) : doc
}

export function trailingParagraphPlugin() {
  return new Plugin({
    appendTransaction: (transactions, _before, state) => {
      // Remote transactions already contain the originating pane's appended
      // steps. Replaying them must not normalize them a second time locally.
      if (transactions.some(transaction => transaction.getMeta('trailingParagraphSync')) ||
        !transactions.some(transaction => transaction.docChanged)) return null
      const tr = state.tr
      state.doc.forEach((node, pos, index) => {
        if (!isTrailingParagraph(node)) return
        const at = tr.mapping.map(pos)
        if (node.content.size || index !== state.doc.childCount - 1) {
          tr.setNodeMarkup(at, undefined, { ...node.attrs, editorTrailing: false })
        } else if (index === 0 || !needsTrailingParagraph(state.doc.child(index - 1))) {
          tr.delete(at, at + node.nodeSize)
        }
      })
      if (tr.doc.lastChild && needsTrailingParagraph(tr.doc.lastChild)) tr.insert(tr.doc.content.size, placeholder())
      return tr.docChanged ? tr : null
    },
  })
}
