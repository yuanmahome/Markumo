import { Schema, type NodeSpec } from 'prosemirror-model'
import { schema as commonmark } from 'prosemirror-markdown'
import { tableNodes } from 'prosemirror-tables'
import { safeMarkdownURL } from '../links'

const nodes: Record<string, NodeSpec> = {}
commonmark.spec.nodes.forEach((name, spec) => { nodes[name] = name==='text'?spec:{ ...spec, attrs: { ...spec.attrs, sourceId: { default: null } } } })
nodes.paragraph.attrs = { ...nodes.paragraph.attrs, editorTrailing: { default: false } }
nodes.code_block.attrs = { ...nodes.code_block.attrs, fence: { default: '```' } }
nodes.heading.content='inline*'
nodes.bullet_list.attrs = { ...nodes.bullet_list.attrs, bullet: { default: '-' } }
nodes.list_item.attrs = { ...nodes.list_item.attrs, checked: { default: null } }
nodes.soft_break = { inline: true, group: 'inline', selectable: false, toDOM: () => ['br', { 'data-soft': 'true' }], parseDOM: [{tag:'br[data-soft]'}] }
nodes.math_inline={inline:true,group:'inline',atom:true,attrs:{latex:{default:''}},toDOM:node=>['span',{'data-math':'true'},node.attrs.latex]}
nodes.footnote_reference={inline:true,group:'inline',atom:true,attrs:{label:{default:''}},toDOM:node=>['sup',{'data-footnote':'true'},node.attrs.label]}
nodes.html_block = {
  group: 'block', atom: true, selectable: true, isolating: true,
  attrs: { sourceId: {default:null}, source: {default:''} },
  toDOM: () => ['div', {'data-html-block':'true', class:'md-html-block-node'}],
}
nodes.html_inline = {
  group: 'inline', inline: true, atom: true, selectable: true,
  attrs: { source: {default:''} },
  toDOM: node => ['span', {'data-html-inline':'true', class:'md-html-inline-node'}, node.attrs.source],
}
// A transient, inert atom holds the exact text of an image being edited. It
// serializes to ordinary source; no private draft is kept outside the document.
nodes.image_source = {
  group: 'inline', inline: true, atom: true,
  attrs: { source: { default: '' } },
  toDOM: node => ['span', { class: 'md-image-draft' }, node.attrs.source],
}
nodes.protected_source = {
  group: 'block', atom: true, selectable: true, isolating: true,
  attrs: { sourceId: {default:null}, source: {default:''}, label: {default:'受保护源码'}, kind: {default:'unknown'} },
  toDOM: node => ['pre', {'data-protected-source':'true'}, node.attrs.source],
}
nodes.toc = {
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,
  attrs: {
    sourceId: { default: null },
    raw: { default: '[TOC]' },
  },
  parseDOM: [{
    tag: 'div[data-toc]',
    getAttrs: dom => ({ raw: (dom as HTMLElement).getAttribute('data-toc-raw') || '[TOC]' }),
  }],
  toDOM: node => ['div', { 'data-toc': 'true', 'data-toc-raw': node.attrs.raw, class: 'md-toc-block' }],
}
nodes.footnote_definition = {
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  attrs: {
    sourceId: { default: null },
    label: { default: '1' },
  },
  parseDOM: [{
    tag: 'div[data-footnote-definition]',
    getAttrs: dom => ({ label: (dom as HTMLElement).getAttribute('data-footnote-label') || '1' }),
  }],
  toDOM: node => ['div', {
    class: 'md-footnote-definition-node',
    'data-footnote-definition': 'true',
    'data-footnote-label': node.attrs.label,
  }, 0],
}
nodes.callout = {
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  attrs: {
    sourceId: { default: null },
    calloutType: { default: 'NOTE' },
    title: { default: '' },
  },
  parseDOM: [{
    tag: 'div[data-callout-type]',
    getAttrs: dom => {
      const el = dom as HTMLElement
      return {
        calloutType: el.getAttribute('data-callout-type') || 'NOTE',
        title: el.getAttribute('data-callout-title') || '',
      }
    },
  }],
  toDOM: node => ['div', {
    class: `md-callout md-callout-${String(node.attrs.calloutType).toLowerCase()}`,
    'data-callout-type': node.attrs.calloutType,
    'data-callout-title': node.attrs.title,
  }, 0],
}
Object.assign(nodes, tableNodes({ tableGroup:'block', cellContent:'paragraph', cellAttributes:{
  align: {default:null, getFromDOM: dom => dom.style.textAlign || null, setDOMAttr: (value, attrs) => { if (value) attrs.style = `text-align:${value}` }},
} }))
nodes.table.attrs = { sourceId: { default: null } }
nodes.image = {
  ...nodes.image,
  attrs: {
    ...nodes.image.attrs,
    width: { default: null },
    align: { default: null },
    htmlSource: { default: null },
    zoom: { default: null },
    unresolvedReference: { default: null },
  },
  parseDOM: [
    {
      tag: 'img[src]',
      getAttrs: dom => {
        const el = dom as HTMLElement
        return {
          src: el.getAttribute('src'),
          title: el.getAttribute('title') || null,
          alt: el.getAttribute('alt') || null,
          width: el.getAttribute('width') || el.style.width || null,
          align: el.getAttribute('align') || (el.style.textAlign || el.style.float || null),
        }
      },
    },
  ],
  toDOM: node => ['span', { 'data-image-source': node.attrs.src, width: node.attrs.width || undefined, align: node.attrs.align || undefined }, node.attrs.alt || '图片'],
}
const baseLink = commonmark.spec.marks.get('link')!
export const markdownSchema = new Schema({ nodes, marks: commonmark.spec.marks.append({
  strike: {parseDOM:[{tag:'s'},{tag:'del'}], toDOM:()=>['s',0]},
}).update('link', {
  ...baseLink,
  // `autolink` records how the source spelled this link so serialization can
  // put it back unchanged: a bare linkified URL must stay bare, an angle
  // autolink keeps its brackets, and an explicit `[text](href)` keeps both.
  attrs: { ...baseLink.attrs, autolink: { default: 'none' } },
  toDOM: mark => ['a', {
    href: safeMarkdownURL(mark.attrs.href) || undefined,
    'data-href': mark.attrs.href,
    'data-autolink': mark.attrs.autolink,
    title: mark.attrs.title,
  }, 0],
}) })
