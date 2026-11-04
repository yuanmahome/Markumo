import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Tag, tags as t } from '@lezer/highlight'
import '../../styles/syntax.css'
import { yamlScalarHighlight } from './yamlScalars'

export const syntaxStyles = ['soft', 'standard', 'vivid'] as const
export type SyntaxStyle = typeof syntaxStyles[number]
/** Read both the original settings and values saved by the theme-card version. */
export function normalizeSyntaxStyle(value: unknown): SyntaxStyle {
  if (value === 'fleet' || value === 'fleet-dark' || value === 'fleet-light') return 'soft'
  if (value === 'monokai-pro' || value === 'monokai-classic') return 'vivid'
  if (value === 'one-dark' || value === 'github-dark' || value === 'github-light') return 'standard'
  return syntaxStyles.includes(value as SyntaxStyle) ? value as SyntaxStyle : 'vivid'
}
export const syntaxRoles = [
  'foreground', 'muted', 'keyword', 'control', 'string', 'number', 'boolean', 'null', 'comment', 'doc-comment',
  'type', 'class', 'function', 'method', 'property', 'parameter', 'variable', 'constant', 'operator', 'punctuation',
  'tag', 'attribute', 'annotation', 'regexp', 'invalid', 'inserted', 'deleted', 'heading', 'link',
] as const
// Only syntax-aware parsers may emit these tags. Ordinary names are never guessed.
export const syntaxTags = {
  parameter: Tag.define(t.variableName),
  logError: Tag.define(t.invalid), logWarning: Tag.define(t.annotation),
  logInfo: Tag.define(t.typeName), logDebug: Tag.define(t.comment),
}
const role = (name: typeof syntaxRoles[number], tag: Tag | readonly Tag[]) => ({tag, class: `mk-syntax-${name}`})

// One mapping for source editors, embedded CM, Markdown fences and exports.
// Tag specificity handles parent fallbacks; specific roles follow general ones.
export const markumoHighlight = HighlightStyle.define([
  role('foreground', t.name),
  role('variable', [t.variableName, t.self]),
  role('constant', [t.atom, t.constant(t.variableName), t.constant(t.propertyName), t.color]),
  role('keyword', [t.keyword, t.modifier, t.operatorKeyword]), role('control', t.controlKeyword),
  role('string', [t.string, t.character, t.attributeValue, t.special(t.string)]),
  role('annotation', [t.meta, t.annotation, t.processingInstruction, t.macroName, t.escape]),
  role('number', [t.number, t.unit]), role('boolean', t.bool), role('null', t.null),
  role('comment', t.comment), role('doc-comment', t.docComment),
  role('type', [t.typeName, t.namespace]), role('class', t.className),
  role('function', t.function(t.variableName)), role('method', t.function(t.propertyName)),
  role('property', [t.propertyName, t.labelName]), role('parameter', syntaxTags.parameter),
  role('operator', t.operator), role('punctuation', t.punctuation),
  role('tag', t.tagName), role('attribute', t.attributeName), role('regexp', t.regexp),
  role('invalid', [t.invalid, syntaxTags.logError]), role('annotation', syntaxTags.logWarning),
  role('type', syntaxTags.logInfo), role('muted', syntaxTags.logDebug),
  role('inserted', t.inserted), role('deleted', t.deleted), role('heading', t.heading), role('link', [t.link, t.url]),
  {tag: t.strong, class: 'mk-syntax-strong'}, {tag: t.emphasis, class: 'mk-syntax-emphasis'},
  {tag: t.strikethrough, class: 'mk-syntax-strike'},
])
export const markumoSyntax = [syntaxHighlighting(markumoHighlight), yamlScalarHighlight]

/** Inheritance updates every live editor and preview without state reconstruction
 * or per-editor listeners. Only syntax classes consume these colors. */
export function applySyntaxStyle(style: SyntaxStyle | string, host = document.body) {
  host.dataset.syntaxStyle = normalizeSyntaxStyle(style)
}
