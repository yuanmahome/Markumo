// Resolve editor packages through Vite's normal graph so annotation identities
// are shared with production history, rather than importing a second dep URL.
export { MarkdownSourceBridge } from '../../src/editor/markdown/wysiwyg/MarkdownSourceBridge'
export { EditorState,TextSelection } from 'prosemirror-state'
export { isolateHistory, undoDepth, redoDepth } from '@codemirror/commands'
export { tokenizer } from '../../src/editor/markdown/wysiwyg/MarkdownParser'
export { default as DOMPurify } from 'dompurify'
export { sanitizeMarkup } from '../../src/editor/markdown/html/sanitize'
