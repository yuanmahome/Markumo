// Resolve editor packages through Vite's normal graph so annotation identities
// are shared with production history, rather than importing a second dep URL.
export { MarkdownSourceBridge } from '../../src/editor/markdown/wysiwyg/MarkdownSourceBridge'
export { EditorState } from 'prosemirror-state'
export { isolateHistory, undoDepth, redoDepth } from '@codemirror/commands'
export { tokenizer } from '../../src/editor/markdown/wysiwyg/MarkdownParser'
