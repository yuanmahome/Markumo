import { DocumentManager } from '/src/editor/core/DocumentManager.ts'
import { EditorView } from '@codemirror/view'
import { undoDepth, redoDepth } from '@codemirror/commands'
import { TextSelection } from 'prosemirror-state'
import { relativeMarkdownLink, safeMarkdownURL } from '/src/editor/markdown/links.ts'
import { createApp, h } from 'vue'
import SplitPreview from '/src/editor/markdown/splitPreview.vue'
import '/src/styles/reset.css'
import '/src/styles/variables.css'
import '/src/editor/markdown/styles.css'

const root = document.querySelector('#app')!
let manager: DocumentManager, id: string, panes: string[], preview: ReturnType<typeof createApp> | undefined
const requests: unknown[] = [], notices: unknown[] = []
const signals: AbortSignal[] = []
const addListener = EventTarget.prototype.addEventListener
EventTarget.prototype.addEventListener = function(type, listener, options) {
  if (options && typeof options === 'object' && options.signal) signals.push(options.signal)
  return addListener.call(this, type, listener, options)
}
let sourceEntries = 0
const observer = new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node instanceof Element) sourceEntries += Number(node.matches('.md-source-link')) + node.querySelectorAll('.md-source-link').length
  }
})
observer.observe(root, { childList: true, subtree: true })
// Exercise the production Tauri navigation path without opening a real browser.
Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
  invoke: async (command: string, args: unknown) => { requests.push({ kind: 'ipc', command, args }) },
} })
window.open = () => { throw Error('Navigation bypassed the Tauri interface') }
window.addEventListener('markdown-open-relative', event => requests.push({ kind: 'relative', ...(event as CustomEvent).detail }))
window.addEventListener('editor-notice', event => notices.push((event as CustomEvent).detail))

function live(pane = 'main') { return manager.liveViews.get(pane)?.editor }
function mount(pane: string) {
  const host = document.createElement('section')
  host.dataset.pane = pane
  root.append(host)
  manager.mountPane(host, pane)
}
function snapshot(pane = 'main') {
  const editor = live(pane) as any, state = manager.getState(id)!
  const native = document.getSelection()
  return {
    source: manager.getText(id), dirty: manager.metadata(id)?.dirty,
    undo: undoDepth(state), redo: redoDepth(state), canonicalSelection: state.selection.toJSON(),
    pmSelection: editor?.view.state.selection.toJSON(),
    domSelection: { text: native?.toString(), anchor: native?.anchorOffset, head: native?.focusOffset,
      anchorText: native?.anchorNode?.textContent, headText: native?.focusNode?.textContent },
    sourceEntries, sources: root.querySelectorAll('.md-source-link').length,
    properties: [...root.querySelectorAll<HTMLElement>('.md-properties')].filter(el => !el.hidden).length,
    anchors: [...root.querySelectorAll('a[data-href]')].map(el => el.outerHTML),
  }
}
(window as any).f = {
  get manager() { return manager }, get id() { return id }, get panes() { return panes },
  requests, notices, live, snapshot, relativeMarkdownLink, safeMarkdownURL,
  signals() { return signals.map(signal => signal.aborted) },
  reset(source: string, readOnly = false) {
    preview?.unmount(); preview = undefined
    manager?.dispose(); root.replaceChildren()
    manager = new DocumentManager([])
    manager.setCaretAnimation('off')
    id = manager.openFile({ token: 'fixture', path: 'C:/workspace/说明/main.md', name: 'main.md', text: source,
      version: 'fixture', encoding: 'UTF-8', bom: false, eol: /\r\n/.test(source) ? 'CRLF' : 'LF', readOnly })
    panes = ['main']; mount('main'); this.clear()
  },
  clear() { requests.length = 0; notices.length = 0; sourceEntries = 0; observer.takeRecords() },
  ready() { return panes.every(pane => manager.getMarkdownMode(id, pane) !== 'live' || live(pane)?.bridge.source === manager.getText(id)) },
  caret(text = 'Start', pane = 'main') {
    const editor = live(pane) as any
    let pos = 1
    editor.view.state.doc.descendants((node: any, at: number) => { if (node.isText && node.text.includes(text)) pos = at + node.text.indexOf(text) })
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, pos)))
    editor.view.focus()
  },
  split() { const pane = manager.splitPane('right', 'main', id); panes.push(pane); mount(pane); return pane },
  mode(mode: 'live' | 'source' | 'split') {
    preview?.unmount(); preview = undefined; root.querySelector('[data-preview]')?.remove()
    manager.setMarkdownMode(id, mode, 'main')
    if (mode === 'split') {
      const host = document.createElement('section'); host.dataset.preview = ''; root.append(host)
      preview = createApp({ render: () => h(SplitPreview, { content: manager.getText(id) }) })
      preview.mount(host)
    }
  },
  dispose() { manager.dispose(); root.replaceChildren() },
  EditorView,
}
