import { DocumentManager } from '/src/editor/core/DocumentManager.ts'
import { EditorView as CMView } from '@codemirror/view'
import { Transaction as CMTransaction, EditorSelection } from '@codemirror/state'
import { undoDepth, redoDepth } from '@codemirror/commands'
import { TextSelection, NodeSelection } from 'prosemirror-state'
import { CellSelection, TableMap } from 'prosemirror-tables'
import { markdownResources } from '/src/editor/markdown/images.ts'
import { textClipboard } from '/src/features/shell/clipboard.ts'
import '/src/styles/reset.css'
import '/src/styles/variables.css'
import '/src/editor/markdown/styles.css'

// Count explicit registrations without retaining detached DOM trees. Property
// handlers and the browser's own listeners are deliberately not counted.
const listeners = new WeakMap()
const add = EventTarget.prototype.addEventListener
const remove = EventTarget.prototype.removeEventListener
const capture = options => typeof options === 'boolean' ? options : !!options?.capture
EventTarget.prototype.addEventListener = function(type, fn, options) {
  if (fn) {
    let entries = listeners.get(this)
    if (!entries) listeners.set(this, entries = [])
    if (!entries.some(entry => entry.type === type && entry.fn === fn && entry.capture === capture(options))) entries.push({ type, fn, capture: capture(options) })
  }
  return add.call(this, type, fn, options)
}
EventTarget.prototype.removeEventListener = function(type, fn, options) {
  const entries = listeners.get(this)
  const index = entries?.findIndex(entry => entry.type === type && entry.fn === fn && entry.capture === capture(options)) ?? -1
  if (index >= 0) entries.splice(index, 1)
  return remove.call(this, type, fn, options)
}

const root = document.querySelector('#app')
const canvas = document.createElement('canvas')
canvas.width = 120; canvas.height = 80
canvas.getContext('2d').fillRect(0, 0, 120, 80)
const pixel = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))
let manager, id, panes = [], publications = []
window.notices = []
window.addEventListener('editor-notice', event => window.notices.push(event.detail))
const count = target => listeners.get(target)?.length || 0

window.f = {
  get manager() { return manager }, get id() { return id }, get panes() { return panes },
  get publications() { return publications },
  listenerCount(target, type) { return (listeners.get(target) || []).filter(entry => !type || entry.type === type).length },
  reset(source, clean = false, readOnly = false) {
    manager?.dispose()
    root.replaceChildren()
    manager = new DocumentManager([], async () => [])
    manager.setCaretAnimation('off')
    id = clean ? manager.openFile({ token: 'live-fixture', path: 'C:/fixture/live.md', name: 'live.md', text: source,
      version: 'fixture-v1', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly }) : manager.createUntitled('md')
    if (!clean) manager.dispatch(id, { changes: { from: 0, insert: source }, annotations: CMTransaction.addToHistory.of(false) })
    manager.getState(id).facet(markdownResources).loadLocal = window.__globalLoadLocal || (async (p) => {
      if (String(p).includes('broken')) throw new Error('File not found')
      return pixel
    })
    publications = []
    const dispatch = manager.dispatch.bind(manager)
    manager.dispatch = (documentId, spec) => {
      if (manager.liveOrigin && spec.changes) publications.push({ pane: manager.liveOrigin.pane, patch: { ...spec.changes }, userEvent: spec.userEvent, before: manager.getText(documentId) })
      return dispatch(documentId, spec)
    }
    panes = ['main']
    this.mount('main')
    return id
  },
  mount(pane) {
    const host = document.createElement('section')
    host.dataset.pane = pane
    host.style.cssText = 'height:720px;flex:1;min-width:0;overflow:hidden;position:relative'
    root.append(host)
    manager.mountPane(host, pane)
  },
  split() { const pane = manager.splitPane('right', 'main', id); panes.push(pane); this.mount(pane); return pane },
  live(pane = manager.activePane) { return manager.liveViews.get(pane)?.editor },
  ready() { return panes.every(pane => manager.getMarkdownMode(id, pane) !== 'live' || this.live(pane)?.bridge.source === this.source()) },
  source() { return manager.getText(id) },
  range(text, pane = manager.activePane) {
    const editor = this.live(pane), view = editor.view
    let from
    view.state.doc.descendants((node, pos) => {
      if (from === undefined && node.isText && node.text.includes(text)) from = pos + node.text.indexOf(text)
    })
    if (from === undefined) throw Error('Missing text: ' + text)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length)))
    view.focus()
    return from
  },
  caret(text, end = true, pane = manager.activePane) {
    const from = this.range(text, pane), view = this.live(pane).view
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + (end ? text.length : 0))))
    return view
  },
  insert(text, pane = manager.activePane, isolated = true) { const view = this.live(pane).view; view.dispatch(view.state.tr.insertText(text).setMeta('isolated', isolated)) },
  node(type, ordinal = 0, pane = manager.activePane) {
    let found
    this.live(pane).view.state.doc.descendants((node, pos) => { if (node.type.name === type && ordinal-- === 0) found = { node, pos } })
    if (!found) throw Error('Missing node: ' + type)
    return found
  },
  history() { const state = manager.getState(id); return { undo: undoDepth(state), redo: redoDepth(state) } },
  undo() { manager.command('undo') }, redo() { manager.command('redo') },
  paste(text) { textClipboard.readText = async () => text; return this.live().clipboard('paste') },
  snapshot() {
    const live = [...manager.liveViews.values()].map(item => item.editor)
    const cms = [...root.querySelectorAll('.cm-editor')].map(dom => CMView.findFromDOM(dom)).filter(Boolean)
    return { dom: root.querySelectorAll('*').length, pm: live.filter(editor => !editor.view.isDestroyed).length, cm: cms.filter(view => !view.destroyed).length,
      listeners: [...root.querySelectorAll('*'), root].reduce((sum, node) => sum + count(node), 0),
      rootMouse: live.reduce((sum, editor) => sum + (listeners.get(editor.dom)?.filter(entry => entry.type === 'mousedown').length || 0), 0),
      globalListeners: count(document) + count(window), toolbars: root.querySelectorAll('.md-table-tools').length }
  },
  dispose() {
    const editors = [...manager.liveViews.values()].map(item => item.editor)
    const cms = [...root.querySelectorAll('.cm-editor')].map(dom => CMView.findFromDOM(dom)).filter(Boolean)
    manager.dispose()
    return { pmDestroyed: editors.every(editor => editor.view.isDestroyed), cmDestroyed: cms.every(view => view.destroyed), rootsRemoved: editors.every(editor => !editor.dom.isConnected),
      globalListeners: count(document) + count(window), remaining: root.querySelectorAll('.markdown-live,.cm-editor,.md-table-tools').length }
  },
  CMView, CMTransaction, EditorSelection, TextSelection, NodeSelection, CellSelection, TableMap,
}
