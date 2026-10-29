import { Annotation, ChangeSet, Compartment, EditorState, EditorSelection, Prec, Transaction, Text, type Extension, type StateEffect, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { undo, redo, undoSelection, redoSelection, undoDepth, redoDepth, isolateHistory, deleteLine, copyLineDown, moveLineUp, moveLineDown, toggleComment } from '@codemirror/commands'
import { findNext, findPrevious } from '@codemirror/search'
import { showEditorSearch } from './searchPanel'
import { createSearchQuery, expandReplacement } from './searchQuery'
import { indentUnit, foldCode, unfoldCode } from '@codemirror/language'
import { bracketHighlight, type BracketMode } from './brackets'
import { coreExtensions, editorTheme } from './extensions'
import { detectLanguage, loadLanguage, type LanguageName } from '../languages'
import { TabGroup } from '../../features/tabs/TabGroup'
import { EditorLayoutManager } from '../layout/EditorLayoutManager'
import type { SplitDirection } from '../layout/types'
import type { SerializedLayoutNode } from '../layout/types'
import type { EditorDocument, Theme, MarkdownMode } from '../../types'
import { lineEndings, type LineEndingSnapshot } from './lineEndings'
import type { FileMetadata, OpenFile, ClassInfo, MediaMetadata } from '../../features/files/contracts'
import { classSummary } from '../../features/files/classSummary'
import { defaultMarkdownTypography, defaultMarkdownClipboard, type MarkdownClipboardSettings, type MarkdownTypography, type LiveEditor, type MarkdownToolbarState, type MarkdownToolbarCommand } from '../markdown/wysiwyg/contracts'
import { markdownFormatTransaction, markdownSelectionInCodeBlock, type MarkdownFormat } from '../markdown/formatCommands'
import { captureLineBaseline, savedLineBaseline } from './changeGutter'
import { createMarkdownResources, evictUnreferencedBlobsByPrefix, markdownResources, refreshMarkdownResources } from '../markdown/images'
import { imageImportBookmarks } from '../markdown/imageImport'
import { sourceSlashExtension } from '../markdown/slash/SourceSlashExtension'
import { sameFilePath } from '../../features/files/pathKey'
import { isMedia, type MediaViewState } from '../../features/files/media'
import { MediaDocumentStore } from './mediaDocumentStore'
import { cancelSmoothScroll, smoothScrollTo } from './smoothScroll'
import { smoothCaret } from './smoothCaret'
import { typewriterExtension } from './typewriterScroll'
import type { CaretAnimation } from './caretMotion'

export interface DocumentSeed { id: string; name: string; path: string; text: string; pinned?: boolean; mode?: MarkdownMode; kind?: 'text' | 'javaClass'; classInfo?: ClassInfo; encoding?: string; bom?: boolean; eol?: EditorDocument['eol'] }
export type Pane = string
const sharedConfiguration = Annotation.define<boolean>()
// CSS preload event handlers live with the stylesheet. Their import closure
// must not capture showActive's record or pane host after the last tab closes.
const loadLiveEditor = () => import('../markdown/wysiwyg/MarkdownEditorController')
interface CachedDocument {
  meta: EditorDocument
  state: EditorState
  baseline: Text
  baselineEndings: LineEndingSnapshot
  endings: ReturnType<typeof lineEndings>
  language: Compartment
  wrap: Compartment
  theme: Compartment
  markdownMode: Compartment
  indent: Compartment
  caret: Compartment
  brackets: Compartment
  typewriter: Compartment
  handoff:Compartment
  languageGeneration: number
  readyLanguageGeneration: number | null
  scroll: { top: number; left: number }
  panes: Record<string, { selection: EditorSelection; top: number; left: number; mode?: MarkdownMode; snapshot?: ReturnType<EditorView['scrollSnapshot']>; snapshotText?: Text }>
}

export class DocumentManager {
  readonly layout = new EditorLayoutManager()
  private readonly views = new Map<string, EditorView>()
  private readonly viewDocuments=new Map<string,string>()
  private readonly restoreFrames=new Map<string,number>()
  private readonly stopLayout:()=>void
  private readonly hosts = new Map<string, HTMLElement>()
  private readonly rehosting = new Map<string, {host:HTMLElement;id:string|null;focused:boolean}>()
  private readonly liveViews = new Map<string, {id:string; editor:LiveEditor}>()
  private readonly liveLoads = new Map<string, object>()
  private liveOrigin: {pane:string;update:unknown}|null = null
  private markdownTypography = defaultMarkdownTypography()
  private markdownClipboard = defaultMarkdownClipboard()
  private caretAnimation: CaretAnimation = 'smooth'
  private bracketMode: BracketMode = 'matching'
  private typewriterMode = false
  private shortcutLabels: Record<string,string> = {}
  setShortcutLabels(labels:Record<string,string>) {this.shortcutLabels={...labels}}
  private readonly records = new Map<string, CachedDocument>()
  // Media documents deliberately have no EditorState, selection, undo history or text baseline.
  private readonly media = new MediaDocumentStore()
  private readonly seeds = new Map<string, DocumentSeed>()
  private readonly listeners = new Set<() => void>()
  private readonly releaseListeners = new Set<(token: string) => void>()
  private readonly deferred = new Map<string, StateEffect<unknown>[]>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextUntitled = 1
  private wordWrap = false
  private theme: Theme = 'dark'
  private defaultMarkdownMode: MarkdownMode = 'live'
  private indentSize = 2
  private useTabs = false
  private applying = false
  private fileModes: Record<string, MarkdownMode> = {}
  private disposed = false
  private readonly paneNavigation = new Map<string, number>()
  navigationRevision(pane: string) { return this.paneNavigation.get(pane) || 0 }

  constructor(seeds: DocumentSeed[] = [], private readonly languageLoader = loadLanguage) {
    for (const seed of seeds) this.seeds.set(seed.id, seed)
    this.stopLayout=this.layout.subscribe(() => this.notify())
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  onFileRelease(listener: (token: string) => void) { this.releaseListeners.add(listener); return () => this.releaseListeners.delete(listener) }
  notify() { for (const listener of this.listeners) listener() }

  get isSplit() { return this.layout.getAllLeafIds().length > 1 }
  get group() { return this.layout.getPane(this.layout.activePaneId)?.group || this.layout.getPrimaryPane().group }
  get secondaryGroup() {
    const leaves = this.layout.getAllLeafIds()
    const otherId = leaves.find(id => id !== this.layout.activePaneId) || 'secondary'
    return this.layout.getPane(otherId)?.group || new TabGroup(otherId)
  }
  get activePaneId() { return this.layout.activePaneId }
  get activePane(): string { return this.layout.activePaneId }
  set activePane(id: string) { this.focusPane(id) }
  get activeId() { return this.layout.getPane(this.layout.activePaneId)?.group.activeId || null }
  get activeDocument() { return this.activeId ? this.metadata(this.activeId) : null }
  get activeEditorView() { return this.views.get(this.layout.activePaneId) || null }
  get activeLiveEditor() { return this.liveViews.get(this.layout.activePaneId)?.editor || null }
  /** Source offset at the active pane's reading anchor; independent of its caret. */
  outlineViewportPosition(): number | null {
    const live = this.activeLiveEditor
    if (live) return live.viewportSourcePosition?.() ?? null
    // Split's source/preview interpolation can differ around block margins.
    // Read the rendered heading boundaries directly for the reading surface.
    const preview = this.hosts.get(this.activePane)?.parentElement?.querySelector<HTMLElement>('.split-preview-content')
    const document = this.activeId && this.getState(this.activeId)?.doc
    if (preview && document) {
      const top = preview.getBoundingClientRect().top + 24
      let line = 1
      for (const heading of Array.from(preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).slice(0, 1000)) {
        if (heading.getBoundingClientRect().top > top) break
        const number = Number(heading.closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine)
        if (Number.isInteger(number) && number > 0) line = number
      }
      return document.line(Math.min(document.lines, line)).from
    }
    const view = this.activeEditorView
    if (!view || !view.dom.isConnected || view.scrollDOM.clientHeight <= 0) return null
    const height = Math.max(0, view.scrollDOM.getBoundingClientRect().top + 24 - view.documentTop)
    return view.lineBlockAtHeight(height).from
  }
  get view() { return this.views.get('main') || this.views.get(this.layout.activePaneId) || null }
  get secondaryView() {
    const leaves = this.layout.getAllLeafIds()
    const otherId = leaves.find(id => id !== 'main')
    return (otherId && this.views.get(otherId)) || null
  }
  get hasDirtyDocuments() { return [...this.records.values()].some(record => record.meta.dirty) }
  get isComposing() {
    return this.layout.getAllLeafIds().some(pane => {
      const id = this.paneGroup(pane).activeId
      return !!id && this.records.has(id) && (!!this.paneView(pane)?.compositionStarted || !!this.liveViews.get(pane)?.editor.composing)
    })
  }
  get catalog() { return [...this.seeds.values()].map(({ id, name, path }) => ({ id, name, path })) }
  get openedDocuments() {
    const allDocIds = new Set<string>()
    for (const pane of this.layout.getAllPanes()) {
      for (const tab of pane.group.tabs) allDocIds.add(tab.documentId)
    }
    return [...allDocIds].map(id => this.metadata(id)!).filter(Boolean)
  }
  get mainOpenedDocuments() { return this.layout.getPrimaryPane().group.tabs.map(tab => this.metadata(tab.documentId)!).filter(Boolean) }
  get secondaryOpenedDocuments() {
    const leaves = this.layout.getAllLeafIds()
    const other = leaves.find(id => id !== 'main')
    return other ? (this.layout.getPane(other)?.group.tabs.map(tab => this.metadata(tab.documentId)!).filter(Boolean) || []) : []
  }

  metadata(id: string): EditorDocument | null {
    const isPinned = this.layout.getAllPanes().some(p => p.group.tabs.some(t => t.documentId === id && t.pinned))
    const media = this.media.metadata(id, isPinned)
    if (media) return media
    const record = this.records.get(id)
    if (!record) return null
    const pane = this.activePane
    if (!record.panes[pane]) record.panes[pane] = { selection: record.state.selection, top: 0, left: 0 }
    const selection = this.paneGroup(pane).activeId === id ? this.paneView(pane)?.state.selection || record.panes[pane].selection : record.state.selection
    const head = Math.min(selection.main.head, record.state.doc.length), line = record.state.doc.lineAt(head)
    return { ...record.meta, line: line.number, column: head - line.from + 1, pinned: isPinned }
  }
  getState(id: string) { return this.records.get(id)?.state }
  getText(id: string) { return this.records.get(id)?.state.doc.toString() }
  holdForHandoff(id:string){
    if(this.media.has(id))return ()=>{}
    const record=this.records.get(id);if(!record||this.disposed||this.isComposing)return null
    this.effects(record,[record.handoff.reconfigure([EditorState.readOnly.of(true),EditorView.editable.of(false),EditorState.transactionFilter.of(tr=>tr.docChanged?[]:tr)])])
    let held=true;return ()=>{if(!held)return;held=false;if(!this.disposed&&this.records.get(id)===record)this.effects(record,[record.handoff.reconfigure([])])}
  }
  getBaselineText(id: string) { return this.records.get(id)?.baseline?.toString() ?? null }
  mediaViewState(id: string, pane: string): MediaViewState {
    return this.media.viewState(id, pane)
  }
  updateMediaMetadata(id: string, media: MediaMetadata, version: string) {
    if (this.media.updateMetadata(id, media, version)) this.notify()
  }
  private copyMediaViewState(id: string, from: string, to: string) {
    this.media.copyViewState(id, from, to)
  }

  private createMedia(id: string, file: Extract<OpenFile, { kind: 'image' | 'pdf' }>) {
    this.media.create(id, file)
  }

  private create(seed: DocumentSeed) {
    const language = new Compartment(), wrap = new Compartment(), theme = new Compartment(), markdownMode = new Compartment(), indent = new Compartment(), caret = new Compartment()
    const endings = lineEndings(seed.text)
    const binary = seed.kind === 'javaClass'
    const byteEditor = seed.encoding === 'Hex'
    const isMd = !binary && !byteEditor && /\.(md|markdown)$/i.test(seed.name)
    const initialMdMode: MarkdownMode | undefined = isMd ? (seed.mode || this.defaultMarkdownMode) : undefined

    const brackets = new Compartment(), typewriter = new Compartment(),handoff=new Compartment()
    const state = EditorState.create({
      doc: seed.text,
      extensions: [
        coreExtensions,
        handoff.of([]),
        brackets.of(bracketHighlight(binary || byteEditor ? 'off' : this.bracketMode)),
        caret.of(smoothCaret(this.caretAnimation)),
        typewriter.of(typewriterExtension({
          enabled: this.typewriterMode,
          isPaneActive: (view: EditorView) => this.paneView(this.activePane) === view,
        })),
        imageImportBookmarks,
        markdownResources.of(createMarkdownResources(() => this.records.get(seed.id)?.meta.fileToken,()=>{const meta=this.records.get(seed.id)?.meta;return `${meta?.fileToken||''}|${meta?.path||''}`})),
        isMd ? sourceSlashExtension() : [],
        binary ? [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorState.transactionFilter.of(tr => tr.docChanged ? [] : tr)] : [],
        indent.of([EditorState.tabSize.of(this.indentSize), indentUnit.of(this.useTabs ? '\t' : ' '.repeat(this.indentSize))]),
        Prec.highest(keymap.of([
          { key: 'Mod-z', run: () => { this.command('undo'); return true } },
          { key: 'Mod-Shift-z', run: () => { this.command('redo'); return true } },
          { key: 'Mod-y', run: () => { this.command('redo'); return true } },
          { key: 'Mod-b', run: () => { this.formatMarkdown('bold'); return true } },
          { key: 'Mod-i', run: () => { this.formatMarkdown('italic'); return true } },
          { key: 'Mod-u', run: () => { this.historyCommand(false, true); return true } },
          { key: 'Alt-u', mac: 'Mod-Shift-u', run: () => { this.historyCommand(true, true); return true } },
        ])),
        Prec.highest(EditorView.domEventHandlers({
          compositionstart: () => { queueMicrotask(() => { if (!this.disposed) this.notify() }); return false },
          compositionend: () => { queueMicrotask(() => { if (!this.disposed) this.notify() }); return false },
          compositioncancel: (_event, view) => {
          // Some hosts expose cancellation separately. End it through CM's public
          // event route, including Chromium EditContext, without touching internals.
          if (view.compositionStarted) {
            const target = (view.contentDOM as HTMLElement & { editContext?: EventTarget }).editContext || view.contentDOM
            target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
          }
          return false
        }, beforeinput: event => {
          if (!['historyUndo','historyRedo'].includes(event.inputType)) return false
          event.preventDefault(); this.command(event.inputType === 'historyUndo' ? 'undo' : 'redo'); return true
        } })),
        endings.field,
        endings.history,
        language.of([]),
        markdownMode.of([]),
        wrap.of(this.wordWrap ? EditorView.lineWrapping : []),
        theme.of(editorTheme(this.theme)),
        EditorView.contentAttributes.of({ 'aria-label': '文本编辑器', spellcheck: 'false' }),
        EditorView.updateListener.of(update => {
          if (this.applying) return
          if (update.focusChanged && update.view.hasFocus) {
            const pane = [...this.views].find(([, view]) => view === update.view)?.[0]
            if (pane) this.focusPane(pane, false)
          }
        }),
      ],
    })
    const record: CachedDocument = {
      meta: {
        id: seed.id, uri: seed.id.startsWith('untitled-') ? `untitled:${seed.id}` : `sample:${seed.id}`, name: seed.name, path: seed.path,
        kind: seed.kind || 'text', classInfo: seed.classInfo,
        language: binary || byteEditor ? 'Plain Text' : detectLanguage(seed.name), languageStatus: binary ? 'ready' : 'loading', dirty: false, pinned: seed.pinned ?? true,
        encoding: seed.encoding || 'UTF-8', eol: seed.eol || (/\r\n/.test(seed.text) ? 'CRLF' : 'LF'), bom: seed.bom ?? false, readOnly: false, lastDiskVersion: null,
        charCount: state.doc.length, line: 1, column: 1, mode: initialMdMode,
      },
      state, baseline: state.doc, baselineEndings: endings.snapshot(state), endings, language, wrap, theme, markdownMode, indent, caret, brackets, typewriter,handoff, languageGeneration: 0, readyLanguageGeneration: null, scroll: { top: 0, left: 0 },
      panes: { main: { selection: state.selection, top: 0, left: 0 }, secondary: { selection: state.selection, top: 0, left: 0 } },
    }
    this.records.set(seed.id, record)
    if (!binary) void this.setLanguage(seed.id, record.meta.language)
    return record
  }

  openFile(file: OpenFile, preview = false, pane = this.activePane, activatePane = true) {
    if (this.disposed || this.isComposing || !this.layout.getPane(pane)) return null
    // A second open must never reload a dirty editor or reset its undo history.
    // The same file may arrive with a different spelling (case, separators) from
    // the shell, so the lookup uses the shared path key rather than exact text.
    const existing = [...this.records.values()].find(record => record.meta.fileToken && sameFilePath(record.meta.path, file.path))
      || this.media.findByPath(file.path)
    if (existing) { this.open(existing.meta.id, preview, pane, activatePane); return existing.meta.id }
    const id = `file:${file.token}`
    if (file.kind === 'image' || file.kind === 'pdf') { this.createMedia(id, file); this.open(id, preview, pane, activatePane); return id }
    const seed: DocumentSeed = { id, name: file.name, path: file.path, text: file.kind === 'javaClass' ? classSummary(file.classInfo) : file.text, pinned: !preview,
      kind: file.kind || 'text', classInfo: file.kind === 'javaClass' ? file.classInfo : undefined, encoding: file.encoding }
    this.seeds.set(id, seed)
    const record = this.create(seed)
    this.attachMetadata(record, file)
    this.restoreFileMode(record)
    this.open(id, preview, pane, activatePane)
    return id
  }

  private attachMetadata(record: CachedDocument, file: FileMetadata) {
    const previousToken=record.meta.fileToken,previousPath=record.meta.path
    Object.assign(record.meta, { path: file.path, name: file.name, uri: `file:${file.path}`, fileToken: file.token,
      encoding: file.encoding, bom: file.bom, eol: file.eol, readOnly: record.meta.kind === 'javaClass' || file.readOnly, lastDiskVersion: file.version })
    if(previousToken!==file.token||previousPath!==file.path)this.effects(record,[refreshMarkdownResources.of(null)])
    // File seeds must not retain a second full text copy after closing.
    this.seeds.delete(record.meta.id)
  }
  private restoreFileMode(record: CachedDocument) {
    if (record.meta.kind === 'javaClass' || record.meta.encoding === 'Hex') return
    const mode = this.fileModes[record.meta.path]
    if (mode && /\.(md|markdown)$/i.test(record.meta.name) && record.meta.mode !== mode) {
      record.meta.mode = mode
      this.effects(record, [record.markdownMode.reconfigure([])])
    }
  }

  saveSnapshot(id: string) {
    const record = this.records.get(id)
    if (!record || record.meta.kind === 'javaClass' || this.isComposing) return null
    const state = record.state
    const savedLines = captureLineBaseline(state)
    return { text: record.endings.serialize(state), metadata: this.metadata(id)!,
      complete: (file: FileMetadata) => {
        if (this.disposed || this.records.get(id) !== record) return false
        const previousName = record.meta.name
        record.baseline = state.doc
        record.baselineEndings = record.endings.snapshot(state)
        this.effects(record,[savedLineBaseline.of(savedLines)])
        this.attachMetadata(record, file)
        this.updateMarkdownType(record, previousName)
        record.meta.dirty = !record.state.doc.eq(state.doc) || !record.endings.equal(record.state, record.baselineEndings)
        this.group.pin(id)
        if (previousName !== file.name) void this.setLanguage(id, detectLanguage(file.name))
        this.notify()
        return true
      },
    }
  }

  reloadFile(id: string, file: OpenFile, force = false) {
    if (this.media.has(id)) {
      if (this.disposed || this.isComposing) return false
      const previous = this.media.get(id)!
      if (file.kind === 'image' || file.kind === 'pdf') {
        this.createMedia(id, file); this.media.get(id)!.panes = previous.panes
      } else {
        this.media.delete(id)
        const next = this.create({ id, name: file.name, path: file.path, text: file.kind === 'javaClass' ? classSummary(file.classInfo) : file.text,
          kind: file.kind, classInfo: file.kind === 'javaClass' ? file.classInfo : undefined, encoding: file.encoding })
        this.attachMetadata(next, file)
      }
      for (const pane of this.layout.getAllLeafIds()) if (this.paneGroup(pane).activeId === id) this.showActive(pane)
      this.notify(); return true
    }
    const record = this.records.get(id)
    if (!record || (!force && record.meta.dirty) || this.isComposing || this.disposed) return false
    this.deferred.delete(id)
    // Capture each view independently before rebuilding. A disk reload starts a
    // fresh undo history; discarded local buffers are retained by Recovery.
    for (const pane of this.layout.getAllLeafIds()) if (this.paneGroup(pane).activeId === id) this.captureScroll(pane)
    const placements = { ...record.panes }, originalMode = record.meta.mode
    const hadFocus = [...this.hosts.entries()].find(([pane, host]) => this.paneGroup(pane).activeId === id && host.contains(document.activeElement))?.[0]
    // Source panes can keep their DOM shells and focus while receiving a fresh
    // state/history. Live callbacks capture the old record and must be rebound.
    const retainedViews = new Map<Pane, EditorView>()
    const scrollSnapshots = new Map<Pane, ReturnType<EditorView['scrollSnapshot']>>()
    for (const pane of this.layout.getAllLeafIds()) if (this.paneGroup(pane).activeId === id) {
      if (this.liveViews.has(pane) || this.liveLoads.has(pane) || file.kind === 'image' || file.kind === 'pdf') this.destroyView(pane)
      else {
        const view = this.views.get(pane)
        // Fresh-record initialization dispatches configuration effects. Until
        // initialization is complete those effects must not target old states.
        if (view) {
          this.cancelPaneScroll(pane); scrollSnapshots.set(pane, view.scrollSnapshot())
          retainedViews.set(pane, view); this.views.delete(pane)
        }
      }
    }
    const seed: DocumentSeed = { id, name: file.name, path: file.path, text: file.kind === 'javaClass' ? classSummary(file.classInfo) : file.text,
      kind: file.kind === 'image' || file.kind === 'pdf' ? 'text' : file.kind || 'text', classInfo: file.kind === 'javaClass' ? file.classInfo : undefined, encoding: file.encoding }
    if (file.kind === 'image' || file.kind === 'pdf') {
      this.records.delete(id); this.createMedia(id, file)
      for (const pane of this.layout.getAllLeafIds()) if (this.paneGroup(pane).activeId === id) this.showActive(pane)
      this.notify(); return true
    }
    try {
      const next = this.create(seed)
      this.attachMetadata(next, file)
      this.restoreFileMode(next)
      next.meta.mode = originalMode
      const preservePosition = (position: number) => {
        const line = record.state.doc.lineAt(position), target = next.state.doc.line(Math.min(line.number, next.state.doc.lines))
        return target.from + Math.min(position - line.from, target.length)
      }
      const preserveSelection = (selection: EditorSelection) => EditorSelection.create(selection.ranges.map(r => EditorSelection.range(preservePosition(r.anchor), preservePosition(r.head))), selection.mainIndex)
      next.state = next.state.update({ selection: preserveSelection(record.state.selection), annotations: Transaction.addToHistory.of(false) }).state
      for (const [pane, position] of Object.entries(placements)) {
        next.panes[pane] = { ...position, selection: preserveSelection(position.selection) }
      }
      for (const [pane, snapshot] of scrollSnapshots) {
        const anchor = snapshot.value.range.head
        // Map just the scroll reference to its new line/column. Text.slice
        // shares the existing tree; this needs neither a full diff nor a copy.
        const mapped = snapshot.map(ChangeSet.of({ from: 0, to: anchor, insert: next.state.doc.slice(0, preservePosition(anchor)) }, record.state.doc.length))
        if (mapped) scrollSnapshots.set(pane, mapped)
      }
    } finally {
      for (const [pane, view] of retainedViews) {
        if (this.disposed) view.destroy()
        else this.views.set(pane, view)
      }
    }
    if (this.disposed) return false
    for (const pane of this.layout.getAllLeafIds()) if (this.paneGroup(pane).activeId === id) this.showActive(pane, hadFocus === pane)
    // Let CodeMirror restore after its new height map is measured. A raw
    // scrollTop write can be undone by its subsequent scroll-anchor adjustment.
    for (const [pane, snapshot] of scrollSnapshots) this.views.get(pane)?.dispatch({ effects: snapshot, annotations: Transaction.addToHistory.of(false) })
    if (hadFocus) { this.views.get(hadFocus)?.focus(); this.liveViews.get(hadFocus)?.editor.focus() }
    this.notify()
    return true
  }

  acknowledgeDiskMetadata(id: string, token: string, previous: string | null, version: string) {
    const record = this.records.get(id)
    if (!record || record.meta.fileToken !== token || record.meta.lastDiskVersion !== previous) return false
    record.meta.lastDiskVersion = version
    this.notify()
    return true
  }

  renamePath(oldPath: string, newPath: string, newName: string): boolean {
    if (this.media.renamePath(oldPath, newPath, newName)) { this.notify(); return true }
    const record = [...this.records.values()].find(r => r.meta.path === oldPath)
    if (!record) return false
    const previousName = record.meta.name
    record.meta.path = newPath
    record.meta.name = newName
    record.meta.uri = `file:${newPath}`
    this.updateMarkdownType(record, previousName)
    this.effects(record,[refreshMarkdownResources.of(null)])
    void this.setLanguage(record.meta.id, detectLanguage(newName))
    this.notify()
    return true
  }

  revealOutline(id: string, item: { lineNumber: number; from?: number }) {
    const state = this.getState(id)
    if (!state) return
    const line = state.doc.line(Math.min(state.doc.lines, Math.max(1, item.lineNumber)))
    const at = item.from === undefined ? line.from : Math.min(state.doc.length, Math.max(0, item.from))
    const target = state.doc.lineAt(at)
    this.revealPosition(id, target.number, at - target.from + 1, 'start')
  }

  revealPosition(id: string, lineNumber: number, columnNumber: number, align: 'nearest' | 'start' = 'nearest') {
    const record = this.records.get(id)
    if (!record || this.isComposing) return
    const doc = record.state.doc
    const targetLine = Math.min(Math.max(1, lineNumber), doc.lines)
    const line = doc.line(targetLine)
    const col = Math.min(Math.max(1, columnNumber), line.length + 1)
    const pos = line.from + (col - 1)
    const live=this.liveViews.get(this.activePane)
    if(live?.id===id){live.editor.reveal(pos,align);live.editor.focus();return}
    const view = this.activeId === id ? this.paneView(this.activePane) : null
    cancelSmoothScroll(view?.scrollDOM)
    if (align === 'start' && view) {
      const pane = this.activePane, before = view.scrollDOM.scrollTop
      view.dispatch({ selection: { anchor: pos, head: pos } })
      view.focus()
      view.scrollDOM.scrollTop = before
      const document = view.state.doc
      smoothScrollTo(view.scrollDOM, () => (view.coordsAtPos(pos)?.top ?? view.lineBlockAt(pos).top + view.documentTop) - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop - 24,
        () => this.paneView(pane) === view && this.activePane === pane && view.state.doc === document)
      return
    }
    this.dispatch(id, {
      selection: { anchor: pos, head: pos },
      ...(align === 'start' ? { effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) } : { scrollIntoView: true }),
    })
    if (this.activeId === id) this.paneView(this.activePane)?.focus()
  }

  resolvePaneId(pane: Pane): string {
    if (this.layout.panes.has(pane)) return pane
    if (pane === 'secondary') {
      const leaves = this.layout.getAllLeafIds()
      const other = leaves.find(id => id !== 'main')
      if (other) return other
    }
    if (pane === 'main') {
      return this.layout.getPrimaryPane().id
    }
    return pane
  }

  open(id: string, preview = true, pane: Pane = this.activePane, activatePane = true) {
    if (this.disposed || this.isComposing) return false
    const targetPane = this.resolvePaneId(pane)
    if (!this.layout.getPane(targetPane)) return false
    let record = this.records.get(id)
    if (!record && !this.media.has(id)) {
      const seed = this.seeds.get(id)
      if (!seed) return false
      record = this.create(seed)
    }
    this.paneNavigation.set(targetPane, this.navigationRevision(targetPane) + 1)
    this.captureScroll(targetPane)
    const isMarkdown = !!record && /\.(md|markdown)$/i.test(record.meta.name)
    if (record && !record.panes[targetPane]) {
      record.panes[targetPane] = {
        selection: record.state.selection,
        top: 0,
        left: 0,
        mode: isMarkdown ? (record.meta.mode || this.defaultMarkdownMode || 'live') : undefined,
      }
    } else if (record && isMarkdown && !record.panes[targetPane].mode) {
      record.panes[targetPane].mode = record.meta.mode || this.defaultMarkdownMode || 'live'
    }
    const group = this.paneGroup(targetPane), previousId = group.activeId
    const canReplace = (docId: string) => {
      const rec = this.records.get(docId)
      return !rec?.meta.dirty
    }
    const replaced = group.open(id, preview && !record?.meta.dirty, canReplace)
    if (replaced) this.release(replaced)
    if (activatePane) this.activePane = targetPane
    if (previousId !== id) this.showActive(targetPane)
    this.notify()
    return true
  }

  select(id: string, pane: Pane = this.activePane) {
    const targetPane = this.resolvePaneId(pane)
    if (!this.paneGroup(targetPane).tabs.some(tab => tab.documentId === id)) return false
    return this.open(id, true, targetPane)
  }
  pin(id: string, pane?: Pane) {
    for (const item of this.layout.getAllPanes()) if (!pane || item.id === pane) item.group.pin(id)
    this.notify()
  }
  createUntitled(extension: 'txt' | 'md' = 'txt') {
    if (this.isComposing || this.disposed) return null
    const count = this.nextUntitled++
    const id = `untitled-${count}`
    this.seeds.set(id, { id, name: `Untitled-${count}.${extension}`, path: '', text: '' })
    this.open(id, false)
    if (this.records.has(id)) this.seeds.delete(id)
    this.paneView(this.activePane)?.focus()
    return id
  }

  /** Recreate a recovered untitled draft without granting it a disk target.
   * A missing/changed original stays pathless so Save must go through Save As. */
  createRecoveredDocument(seed: { id: string; name: string; text: string; encoding?: string; bom?: boolean; eol?: EditorDocument['eol']; mode?: MarkdownMode }): string | null {
    if (this.isComposing || this.disposed) return null
    this.seeds.set(seed.id, { id: seed.id, name: seed.name, path: '', text: seed.text, encoding: seed.encoding, bom: seed.bom, eol: seed.eol, mode: seed.mode })
    this.open(seed.id, false)
    const record = this.records.get(seed.id)
    this.seeds.delete(seed.id)
    if (!record) return null
    record.meta.encoding = seed.encoding || 'UTF-8'
    record.meta.bom = seed.bom ?? false
    if (seed.eol) record.meta.eol = seed.eol
    record.meta.dirty = true
    record.meta.charCount = seed.text.length
    record.meta.line = 1
    record.meta.column = 1
    record.baseline = Text.empty
    this.pin(seed.id)
    this.notify()
    return seed.id
  }

  /** Replace the canonical text with a recovered body. The disk baseline and
   * last disk version are kept, so the result stays dirty and a later save is
   * an explicit user action against that exact version. */
  restoreRecoveredText(id: string, text: string, mode?: MarkdownMode): boolean {
    const record = this.records.get(id)
    if (!record || this.disposed || this.isComposing || record.meta.kind === 'javaClass' || record.meta.encoding === 'Hex') return false
    this.dispatch(id, {
      changes: { from: 0, to: record.state.doc.length, insert: text },
      annotations: Transaction.addToHistory.of(false),
      userEvent: 'recovery.restore',
    })
    if (mode && ['live', 'source', 'split'].includes(mode)) this.setMarkdownMode(id, mode)
    record.meta.dirty = true
    this.pin(id)
    this.notify()
    return true
  }

  close(id: string, discard = false, pane: Pane = this.activePane): 'closed' | 'dirty' | 'composing' | 'missing' {
    return this.closeTab(id,discard,pane,false)
  }

  /** Native deletion is already committed: remove every view, including an
   * in-progress composition in another window, without saving it back. */
  closeDeletedFile(id:string) {
    for(const pane of [...this.layout.getAllLeafIds()])this.closeTab(id,true,pane,true)
  }

  private closeTab(id:string,discard:boolean,pane:Pane,deleted:boolean): 'closed' | 'dirty' | 'composing' | 'missing' {
    const targetPane = this.resolvePaneId(pane)
    const group = this.paneGroup(targetPane)
    if ((!this.records.has(id) && !this.media.has(id)) || !group.tabs.some(t => t.documentId === id)) return 'missing'
    if (!deleted && this.isComposing) return 'composing'

    const isLastRef = !this.layout.getAllPanes().some(p => p.id !== targetPane && p.group.tabs.some(t => t.documentId === id))
    if (isLastRef && this.records.get(id)?.meta.dirty && !discard) return 'dirty'
    this.paneNavigation.set(targetPane, this.navigationRevision(targetPane) + 1)

    this.captureScroll(targetPane)
    const wasActive = group.activeId === id, wasActivePane = this.activePane === targetPane
    const res = this.layout.closeTab(targetPane, id)
    if (isLastRef) {
      this.release(id)
      if (!this.records.has(id) && id.startsWith('untitled-')) this.seeds.delete(id)
    }

    if (res.paneRemoved) {
      this.destroyView(targetPane)
      this.hosts.delete(targetPane)
      this.purgeRemovedPaneState(targetPane)
      if (wasActivePane) this.showActive(this.layout.activePaneId)
    } else if (wasActive) {
      this.showActive(targetPane)
    }
    this.notify()
    return 'closed'
  }

  private purgeRemovedPaneState(paneId: string) {
    if (this.layout.getPane(paneId)) return
    this.media.deletePane(paneId)
    this.paneNavigation.delete(paneId)
    this.rehosting.delete(paneId)
    for (const record of this.records.values()) {
      if (paneId !== 'main') delete record.panes[paneId]
    }
  }

  private release(id: string) {
    if (this.layout.getAllPanes().some(p => p.group.tabs.some(t => t.documentId === id))) return
    const meta = this.metadata(id)
    const token = meta?.fileToken
    const resourceIdentity = `${token || ''}|${meta?.path || ''}`
    this.records.delete(id); this.media.delete(id); this.deferred.delete(id)
    evictUnreferencedBlobsByPrefix(resourceIdentity)
    // Views attached to the closing tab destroy synchronously right after release() in close();
    // sweep once on the microtask turn after their LiveImageViews decrement refCounts to 0.
    queueMicrotask(() => evictUnreferencedBlobsByPrefix(resourceIdentity))
    if (token) for (const listener of this.releaseListeners) listener(token)
  }
  paneGroup(pane: Pane) {
    const resolved = this.resolvePaneId(pane)
    return this.layout.getPane(resolved)?.group || this.layout.getPrimaryPane().group
  }
  paneView(pane: Pane) {
    const resolved = this.resolvePaneId(pane)
    return this.views.get(resolved) || null
  }
  private cancelPaneScroll(pane: Pane) {
    cancelSmoothScroll(this.paneView(pane)?.scrollDOM)
    cancelSmoothScroll(this.hosts.get(pane)?.querySelector<HTMLElement>('.markdown-live'))
  }
  focusPane(pane: Pane, focus = true) {
    const resolved = this.resolvePaneId(pane)
    if (resolved !== this.activePane && this.isComposing) return
    if (resolved !== this.activePane) this.cancelPaneScroll(this.activePane)
    this.layout.focusPane(resolved)
    if (focus) { this.views.get(resolved)?.focus();this.liveViews.get(resolved)?.editor.focus() }
    this.notify()
  }
  private captureScroll(pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const id = this.paneGroup(resolved).activeId, record = id && this.records.get(id), view = this.paneView(resolved)
    const live=this.liveViews.get(resolved)
    if(record&&live&&live.id===id){
      const selection=live.editor.selection,root=this.hosts.get(resolved)?.querySelector('.markdown-live')
      record.panes[resolved]={...record.panes[resolved],selection:EditorSelection.single(selection.anchor,selection.head),top:root?.scrollTop||0,left:root?.scrollLeft||0,snapshot:undefined,snapshotText:undefined}
      return
    }
    if (record && view) {
      record.panes[resolved] = { ...record.panes[resolved], selection: view.state.selection, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft, snapshot:view.scrollSnapshot(),snapshotText:view.state.doc }
      if (resolved === 'main') record.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }
    }
  }
  /**
   * Snapshot of one pane's caret and scroll for a document handoff. Capturing
   * first means a detach carries the live selection rather than a stale one.
   */
  paneSnapshot(id: string, pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    this.captureScroll(resolved)
    const record = this.records.get(id)
    const state = record?.panes[resolved]
    const selection = state?.selection?.main
    return {
      anchor: selection?.anchor ?? 0,
      head: selection?.head ?? 0,
      top: state?.top ?? 0,
      left: state?.left ?? 0,
      mode: this.getMarkdownMode(id, resolved),
    }
  }
  /**
   * Places the caret of an adopted document without creating an undo step and
   * without scrolling the view: a handoff restores absolute offsets instead of
   * a line/column pair, so the original caret survives exactly.
   */
  setSelectionOffsets(id: string, anchor: number, head: number, pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const record = this.records.get(id)
    if (!record || this.disposed) return false
    const size = record.state.doc.length
    const clamp = (value: number) => Math.max(0, Math.min(size, Math.round(value)))
    const selection = EditorSelection.single(clamp(anchor), clamp(head))
    // Only the pane snapshot is written: the view restores it on the next
    // `showActive`, exactly like every other position restoration in this class.
    record.panes[resolved] = { ...record.panes[resolved], selection, top: record.panes[resolved]?.top ?? 0, left: record.panes[resolved]?.left ?? 0 }
    const view = this.paneView(resolved)
    if (view && this.paneGroup(resolved).activeId === id) {
      view.dispatch({ selection: EditorSelection.single(clamp(anchor), clamp(head)) })
    }else if(resolved===this.activePane)record.state=record.state.update({selection,annotations:Transaction.addToHistory.of(false)}).state
    this.notify()
    return true
  }

  /** Restores the scroll offset captured by a handoff on the next paint. */
  restoreScroll(id: string, top: number, left = 0, pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const record = this.records.get(id)
    if (!record || this.disposed) return false
    if (record.panes[resolved]) record.panes[resolved] = { ...record.panes[resolved], top, left }
    else record.panes[resolved] = { selection: record.state.selection, top, left }
    const scroll = () => {
      this.restoreFrames.delete(resolved)
      if(this.disposed||this.records.get(id)!==record||this.paneGroup(resolved).activeId!==id)return
      const root = this.hosts.get(resolved)?.querySelector<HTMLElement>('.markdown-live, .cm-scroller')
      if (root) {
        root.scrollTop = top
        root.scrollLeft = left
      }
    }
    cancelAnimationFrame(this.restoreFrames.get(resolved)||0)
    scroll()
    this.restoreFrames.set(resolved,requestAnimationFrame(scroll))
    return true
  }

  private showActive(pane: Pane = this.activePane, restoreFocus = false) {
    const resolved = this.resolvePaneId(pane)
    let view = this.paneView(resolved)
    const targetId = this.paneGroup(resolved).activeId
    const record = targetId && this.records.get(targetId)
    if (!record) { this.destroyView(resolved); return }
    if (!record.panes[resolved]) record.panes[resolved] = { selection: record.state.selection, top: 0, left: 0 }
    const paneMode = this.getMarkdownMode(record.meta.id, resolved)
    if(paneMode==='live' && record.state.doc.length<=1024*1024){
      const existing=this.liveViews.get(resolved)
      if(existing?.id===record.meta.id){existing.editor.sync(record.state.doc.toString());return}
      this.destroyView(resolved)
      const parent=this.hosts.get(resolved)
      if(!parent||this.disposed)return
      const load={};this.liveLoads.set(resolved,load)
      void loadLiveEditor().then(({MarkdownEditorController})=>{
        if(this.disposed||this.liveLoads.get(resolved)!==load||this.paneGroup(resolved).activeId!==record.meta.id||this.getMarkdownMode(record.meta.id, resolved)!=='live'||this.hosts.get(resolved)!==parent)return
        const source=record.state.doc.toString(),saved=record.panes[resolved]
        const sibling=[...this.liveViews.values()].find(live=>live.id===record.meta.id)?.editor
        const editor=new MarkdownEditorController(parent,{
          shortcutLabel:id=>this.shortcutLabels[id],
          source,anchor:saved.selection.main.anchor,head:saved.selection.main.head,resources:record.state.facet(markdownResources),typography:this.markdownTypography,clipboard:this.markdownClipboard,caretAnimation:this.caretAnimation,bracketMode:this.bracketMode,
          indentSize:this.indentSize,useTabs:this.useTabs,
          typewriterMode:this.typewriterMode,isPaneActive:()=>this.activePane===resolved,
          publish:(expected,patch,update,isolated)=>{
            if(this.records.get(record.meta.id)!==record||record.state.doc.toString()!==expected||record.state.readOnly)return false
            this.liveOrigin={pane:resolved,update}
            // Ordinary adjacent input uses CM's native grouping; commands keep
            // their existing full isolation on both sides of the history event.
            const userEvent=isolated?'input.markdown':patch.insert?'input.type.markdown':'delete.markdown'
            try{this.dispatch(record.meta.id,{changes:patch,userEvent,...(isolated?{annotations:isolateHistory.of('full')}:{})})}finally{this.liveOrigin=null}
            return true
          },
          selected:(anchor,head)=>{const selection=EditorSelection.single(Math.min(anchor,record.state.doc.length),Math.min(head,record.state.doc.length));record.panes[resolved].selection=selection;if(this.activePane===resolved)record.state=record.state.update({selection,annotations:Transaction.addToHistory.of(false)}).state;this.notify()},
          history:forward=>{this.focusPane(resolved,false);this.historyCommand(forward)},focus:()=>this.focusPane(resolved,false),
          compositionChanged:()=>{if(!this.disposed)this.notify()},
          openRelative:href=>window.dispatchEvent(new CustomEvent('markdown-open-relative',{detail:{id:record.meta.id,href,pane:resolved}})),
          readOnly:()=>record.state.readOnly||record.meta.readOnly,
        },sibling instanceof MarkdownEditorController?sibling.bridge:undefined)
        this.liveViews.set(resolved,{id:record.meta.id,editor})
        this.liveLoads.delete(resolved)
        const root=parent.querySelector('.markdown-live');if(root){root.scrollTop=saved.top;root.scrollLeft=saved.left}
        // Import/remount completes asynchronously. Restore an interrupted focus
        // only if the user has not focused a different pane or control meanwhile.
        if (restoreFocus && this.activePane === resolved && document.activeElement === document.body) editor.focus()
        this.notify()
      }).catch(error=>{if(this.liveLoads.get(resolved)===load){this.liveLoads.delete(resolved);parent.querySelector('.markdown-live')?.remove();this.setMarkdownMode(record.meta.id, 'source', resolved);this.showActive(resolved);window.dispatchEvent(new CustomEvent('editor-notice',{detail:`Markdown Live 加载失败，已切到源码：${String(error)}`}))}})
      return
    }
    if(this.liveViews.has(resolved)||this.liveLoads.has(resolved)){this.destroyView(resolved);view=null}
    if (!view) {
      const parent = this.hosts.get(resolved)
      if (!parent || this.disposed) return
      view = new EditorView({ parent, state: record.state, dispatchTransactions: trs => {
        // An async dispatch may outlive this mount. A Pane can already own a
        // replacement view; never route the old view's transactions into it.
        if(this.views.get(resolved)===view)this.applyTransactions(resolved, trs)
      } })
      this.views.set(resolved, view)
      this.viewDocuments.set(resolved,record.meta.id)
    }
    const shownView = view
    if(this.viewDocuments.get(resolved)!==record.meta.id||!shownView.state.doc.eq(record.state.doc)){
      shownView.setState(record.state.update({ selection: record.panes[resolved].selection, annotations: Transaction.addToHistory.of(false) }).state)
      this.viewDocuments.set(resolved,record.meta.id)
    }else if(!shownView.state.selection.eq(record.panes[resolved].selection))shownView.dispatch({selection:record.panes[resolved].selection,annotations:Transaction.addToHistory.of(false)})
    const shownDocument = shownView.state.doc, shownNavigation = this.navigationRevision(resolved)
    const scroll = { ...record.panes[resolved] }
    // A raw scrollTop write is overridden by CM's new height-map anchor after
    // setState. Its snapshot restores the measured line and pixel offset after
    // layout, without sharing selection/scroll state with another pane.
    if (scroll.snapshot && scroll.snapshotText === shownDocument) {
      shownView.dispatch({effects:scroll.snapshot,annotations:Transaction.addToHistory.of(false)})
      return
    }
    shownView.requestMeasure({
      read: () => scroll,
      write: saved => {
        // Initial/restored tabs have pixel coordinates but no measured snapshot.
        // Finish the height-map measure before turning those pixels into CM's
        // own scroll target; a raw write during measurement is anchored again.
        queueMicrotask(() => {
          if (this.disposed || this.paneView(resolved) !== shownView || this.paneGroup(resolved).activeId !== targetId || shownView.state.doc !== shownDocument || this.navigationRevision(resolved) !== shownNavigation || !shownView.state.selection.eq(saved.selection)) return
          shownView.scrollDOM.scrollTop = saved.top
          shownView.scrollDOM.scrollLeft = saved.left
          shownView.dispatch({effects:shownView.scrollSnapshot(),annotations:Transaction.addToHistory.of(false)})
        })
      },
    })
  }

  mount(parent: HTMLElement, pane: Pane = 'main') {
    const resolved = this.resolvePaneId(pane)
    this.mountPane(parent, resolved)
    this.paneView(resolved)?.focus()
  }

  restoreLayout(layout: SerializedLayoutNode) {
    for (const pane of this.hosts.keys()) this.destroyView(pane)
    const restored = this.layout.deserialize(layout)
    for (const pane of this.hosts.keys()) if (this.layout.getPane(pane)) this.showActive(pane)
    this.notify()
    return restored
  }

  mountSecondary(parent: HTMLElement) {
    const leaves = this.layout.getAllLeafIds()
    const otherId = leaves.find(id => id !== 'main') || 'secondary'
    this.mountPane(parent, otherId)
  }

  mountPane(parent: HTMLElement, pane: Pane) {
    const resolved = this.resolvePaneId(pane)
    if (this.disposed || this.hosts.get(resolved) === parent) return
    const retained=this.rehosting.get(resolved)
    if(retained && retained.host===this.hosts.get(resolved) && retained.id===this.paneGroup(resolved).activeId && (this.views.has(resolved)||this.liveViews.has(resolved))){
      // Split-tree shape changes remount Vue hosts within the same flush. Move
      // the pane's existing editor DOM instead of rebuilding its view/plugins.
      parent.append(...retained.host.childNodes)
      this.hosts.set(resolved,parent);this.rehosting.delete(resolved)
      const saved=retained.id?this.records.get(retained.id)?.panes[resolved]:undefined,view=this.views.get(resolved)
      if(view&&saved?.snapshot&&saved.snapshotText===view.state.doc)view.dispatch({effects:saved.snapshot,annotations:Transaction.addToHistory.of(false)})
      view?.requestMeasure()
      if(retained.focused&&this.activePane===resolved&&document.activeElement===document.body){view?.focus();this.liveViews.get(resolved)?.editor.focus()}
      return
    }
    this.captureScroll(resolved)
    this.destroyView(resolved)
    this.hosts.set(resolved, parent)
    this.showActive(resolved)
  }

  splitEditor(): boolean {
    if (this.disposed || this.isComposing) return false
    if (this.isSplit) return true
    this.splitPane('right')
    return true
  }

  splitPane(direction: SplitDirection, targetPane: Pane = this.activePane, docId?: string, sourcePane: Pane = targetPane, cloneActive = true): string {
    if (this.disposed || this.isComposing) return targetPane
    const resolvedTarget = this.resolvePaneId(targetPane)
    const targetGroup = this.paneGroup(resolvedTarget)
    // A file dropped on an edge creates a pane for that file only. Cloning the
    // source document there would leave a meaningless temporary duplicate tab.
    const openDocId = docId || (cloneActive ? targetGroup.activeId || undefined : undefined)
    this.captureScroll(resolvedTarget)
    const resolvedSource = this.resolvePaneId(sourcePane)
    if (resolvedSource !== resolvedTarget) this.captureScroll(resolvedSource)
    const newPaneId = this.layout.splitPane(resolvedTarget, direction, openDocId)
    if (openDocId && this.media.has(openDocId)) {
      this.media.copyViewState(openDocId, resolvedSource, newPaneId)
    }
    if (openDocId) {
      let record = this.records.get(openDocId)
      if (!record) {
        const seed = this.seeds.get(openDocId)
        if (seed) record = this.create(seed)
      }
      if (record) {
        const sourcePaneState = record.panes[resolvedSource]
        const sourceMode = this.getMarkdownMode(openDocId, resolvedSource)
        record.panes[newPaneId] = sourcePaneState
          ? { ...sourcePaneState, mode: sourceMode }
          : { selection: record.state.selection, top: 0, left: 0, mode: sourceMode }
      }
    }
    this.activePane = newPaneId
    this.showActive(newPaneId)
    this.notify()
    return newPaneId
  }

  closeSplit() {
    if (this.isComposing) return false
    return this.mergeAllPanes()
  }

  closePane(paneId: Pane): boolean {
    const resolved = this.resolvePaneId(paneId)
    if (this.disposed || this.isComposing) return false
    const leaves = this.layout.getAllLeafIds()
    if (leaves.length <= 1) return false

    const pane = this.layout.getPane(resolved)
    if (pane) {
      for (const tab of pane.group.tabs) {
        const isLast = !this.layout.getAllPanes().some(p => p.id !== resolved && p.group.tabs.some(t => t.documentId === tab.documentId))
        if (isLast && this.records.get(tab.documentId)?.meta.dirty) return false
      }
    }

    this.captureScroll(resolved)
    this.destroyView(resolved)
    this.hosts.delete(resolved)
    const closed = this.layout.closePane(resolved)
    if (closed) {
      for (const tab of pane?.group.tabs || []) this.release(tab.documentId)
      this.purgeRemovedPaneState(resolved)
      this.showActive(this.layout.activePaneId)
      this.notify()
    }
    return closed
  }

  mergeAllPanes(): boolean {
    if (this.isComposing) return false
    const primaryId = this.layout.getPrimaryPane().id
    const secondaryIds = this.layout.getAllLeafIds().filter(paneId => paneId !== primaryId)

    for (const paneId of secondaryIds) {
      this.captureScroll(paneId)
      const pane = this.layout.getPane(paneId)
      if (pane) {
        for (const tab of pane.group.tabs) {
          this.copyMediaViewState(tab.documentId, paneId, primaryId)
          const record = this.records.get(tab.documentId)
          if (record && !record.panes[primaryId]) {
            record.panes[primaryId] = { ...record.panes[paneId] }
          }
        }
      }
      this.destroyView(paneId)
      this.hosts.delete(paneId)
    }
    this.layout.mergeAllPanes()
    for (const paneId of secondaryIds) this.purgeRemovedPaneState(paneId)
    this.activePane = primaryId
    this.showActive(primaryId)
    this.notify()
    return true
  }

  moveTab(id: string, from: Pane, to: Pane, targetIndex?: number) {
    const resolvedFrom = this.resolvePaneId(from)
    const resolvedTo = this.resolvePaneId(to)
    if (this.disposed || this.isComposing || !this.layout.getPane(resolvedFrom)?.group.tabs.some(t => t.documentId === id) || !this.layout.getPane(resolvedTo)) return false
    // A reorder changes only tab slots. Keep this pane's mounted view, parser,
    // selection and scroll rather than resetting it twice through showActive.
    if(resolvedFrom===resolvedTo){const moved=this.layout.moveTab(id,resolvedFrom,resolvedTo,targetIndex);if(moved)this.notify();return moved}
    this.captureScroll(resolvedFrom)
    if (resolvedFrom !== resolvedTo) this.captureScroll(resolvedTo)
    this.copyMediaViewState(id, resolvedFrom, resolvedTo)
    const record = this.records.get(id)
    if (record && !record.panes[resolvedTo] && record.panes[resolvedFrom]) {
      record.panes[resolvedTo] = { ...record.panes[resolvedFrom] }
    }
    if (!this.layout.moveTab(id, resolvedFrom, resolvedTo, targetIndex)) return false
    if (this.layout.getPane(resolvedFrom)) {
      this.showActive(resolvedFrom)
    } else {
      this.destroyView(resolvedFrom)
      this.hosts.delete(resolvedFrom)
      this.purgeRemovedPaneState(resolvedFrom)
    }
    this.showActive(resolvedTo)
    this.notify()
    return true
  }

  /** Drop targets use insertion slots from the list before the dragged tab is removed. */
  transferTab(id: string, from: Pane, to: Pane, options: { copy?: boolean; direction?: SplitDirection; targetIndex?: number } = {}): boolean {
    const source = this.layout.getPane(from), target = this.layout.getPane(to)
    if (this.disposed || this.isComposing || !source || !target || !source.group.tabs.some(tab => tab.documentId === id)) return false
    if (options.direction) {
      // With a single tab, splitting opens a second view of the same document.
      const keepSource = options.copy || (from === to && source.group.tabs.length === 1)
      const created = this.splitPane(options.direction, to, id, from)
      if (created === to) return false
      this.layout.getPane(created)?.group.pin(id)
      if (!keepSource) this.close(id, false, from)
      else source.group.pin(id)
      this.focusPane(created, false)
      this.notify()
      return true
    }
    if (from === to && options.targetIndex === undefined) {
      source.group.pin(id)
      return this.select(id, to)
    }
    if (!options.copy || from === to) return this.moveTab(id, from, to, options.targetIndex)

    this.captureScroll(from)
    this.copyMediaViewState(id, from, to)
    const record = this.records.get(id)
    if (record && !record.panes[to] && record.panes[from]) record.panes[to] = { ...record.panes[from] }
    const existing = target.group.tabs.findIndex(tab => tab.documentId === id)
    let slot = options.targetIndex ?? target.group.tabs.length
    if (existing >= 0 && existing < slot) slot--
    if (!this.open(id, false, to)) return false
    this.reorderTab(to, id, slot)
    return true
  }

  reorderTab(pane: Pane, id: string, targetIndex: number) {
    const resolved = this.resolvePaneId(pane)
    const reordered = this.layout.reorderTab(resolved, id, targetIndex)
    if (reordered) this.notify()
    return reordered
  }

  private applyTransactions(pane: Pane, transactions: readonly Transaction[]) {
    const resolved = this.resolvePaneId(pane)
    const view = this.paneView(resolved), id = this.paneGroup(resolved).activeId, record = id && this.records.get(id)
    if (!view || !record) return
    if (record.meta.kind === 'javaClass' && transactions.some(tr => tr.docChanged)) return
    this.applying = true
    try {
      view.update(transactions)
      for (const tr of transactions) {
        // Transaction is also a TransactionSpec. Preserve all annotations,
        // including CodeMirror's internal undo/redo history annotation.
        const canonical = record.state.update(tr)
        record.state = canonical.state
        if (!record.panes[resolved]) record.panes[resolved] = { selection: tr.state.selection, top: 0, left: 0 }
        record.panes[resolved].selection = tr.state.selection
        for (const otherPane of this.layout.getAllLeafIds()) {
          if (otherPane === resolved) continue
          if (!record.panes[otherPane]) record.panes[otherPane] = { selection: record.state.selection, top: 0, left: 0 }
          record.panes[otherPane].selection = record.panes[otherPane].selection.map(tr.changes)
          const receiver = this.paneView(otherPane)
          if (this.paneGroup(otherPane).activeId === id && receiver && (tr.docChanged || tr.annotation(sharedConfiguration))) {
            receiver.update([receiver.state.update({ changes: tr.changes, effects: tr.effects,
              selection: receiver.state.selection.map(tr.changes), annotations: Transaction.addToHistory.of(false) })])
            record.panes[otherPane].selection = receiver.state.selection
          }
        }
        this.accept(record, record.state, tr.docChanged)
      }
    } finally { this.applying = false }
  }

  unmount(pane: Pane = 'main', expectedHost?: HTMLElement | null, allowRehost = false) {
    if (expectedHost && this.hosts.get(pane) !== expectedHost) return
    if (this.layout.getPane(pane)) this.captureScroll(pane)
    if(allowRehost&&expectedHost&&this.layout.getPane(pane)&&!this.disposed){
      const retained={host:expectedHost,id:this.paneGroup(pane).activeId,focused:expectedHost.contains(document.activeElement)}
      this.rehosting.set(pane,retained)
      queueMicrotask(()=>{if(this.rehosting.get(pane)!==retained)return;this.rehosting.delete(pane);if(this.hosts.get(pane)===expectedHost){this.destroyView(pane);this.hosts.delete(pane)}})
      return
    }
    this.destroyView(pane)
    this.hosts.delete(pane)
  }

  private destroyView(pane: Pane) {
    cancelAnimationFrame(this.restoreFrames.get(pane)||0);this.restoreFrames.delete(pane);this.viewDocuments.delete(pane)
    this.cancelPaneScroll(pane)
    // View ownership is exact, even after the layout removes a legacy pane ID.
    this.views.get(pane)?.destroy()
    this.views.delete(pane)
    this.liveViews.get(pane)?.editor.destroy();this.liveViews.delete(pane);this.liveLoads.delete(pane)
  }

  setIndent(size: number, tabs: boolean) {
    if (!Number.isInteger(size) || size < 1 || size > 8) return
    this.indentSize = size; this.useTabs = tabs
    for (const record of this.records.values()) this.effects(record, [record.indent.reconfigure([EditorState.tabSize.of(size), indentUnit.of(tabs ? '\t' : ' '.repeat(size))])])
    for (const live of this.liveViews.values()) live.editor.indent(size, tabs)
  }

  private get focusedCodeView() {
    const element = document.activeElement?.closest<HTMLElement>('.cm-editor')
    return element ? EditorView.findFromDOM(element) : null
  }
  transformSelection(upper: boolean) {
    const nested = this.focusedCodeView
    if (nested && nested !== this.activeEditorView) {
      if (!nested.state.readOnly && !this.isComposing) nested.dispatch({changes:nested.state.selection.ranges.filter(range=>!range.empty).map(range=>({from:range.from,to:range.to,insert:upper?nested.state.sliceDoc(range.from,range.to).toUpperCase():nested.state.sliceDoc(range.from,range.to).toLowerCase()})),annotations:isolateHistory.of('full'),userEvent:'input.case'})
      return
    }
    const id = this.activeId, view = this.paneView(this.activePane), record = id && this.records.get(id)
    if (!record || this.isComposing) return
    const state = view?.state || record.state
    if (state.readOnly) return
    const changes = state.selection.ranges.filter(r => !r.empty).map(r => ({ from: r.from, to: r.to, insert: upper ? state.sliceDoc(r.from, r.to).toUpperCase() : state.sliceDoc(r.from, r.to).toLowerCase() }))
    if (id && changes.length) this.dispatch(id, { changes, annotations: isolateHistory.of('full'), userEvent: 'input.case' })
  }

  formatMarkdown(format: MarkdownFormat, pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane), id = this.paneGroup(resolved).activeId, record = id && this.records.get(id), view = this.views.get(resolved)
    if (!id || !record || record.meta.readOnly || record.state.readOnly || record.meta.encoding === 'Hex' || this.isComposing || !/\.(md|markdown)$/i.test(record.meta.name)) return false
    if (resolved !== this.activePane) this.focusPane(resolved, false)
    const live=this.liveViews.get(resolved)
    if(live?.id===id)return live.editor.format(format)
    const state = this.sourcePaneState(record, resolved)
    if (state.readOnly || markdownSelectionInCodeBlock(state)) return false
    this.dispatch(id, markdownFormatTransaction(state, format))
    view?.focus()
    return true
  }

  liveReady(pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const id = this.paneGroup(resolved).activeId
    return !!id && this.liveViews.get(resolved)?.id === id
  }

  markdownToolbarState(pane: Pane = this.activePane): MarkdownToolbarState | null {
    const resolved = this.resolvePaneId(pane)
    const id = this.paneGroup(resolved).activeId
    const record = id && this.records.get(id)
    if (!record || record.meta.encoding === 'Hex' || record.meta.kind === 'javaClass' || !/\.(md|markdown)$/i.test(record.meta.name)) return null
    const live = this.liveViews.get(resolved)
    const state = live?.id === id ? live.editor.toolbarState() : this.sourceToolbarState(record, resolved)
    return {
      ...state,
      composing: state.composing || this.isComposing,
      readOnly: state.readOnly || record.state.readOnly || record.meta.readOnly,
      canUndo: undoDepth(record.state) > 0,
      canRedo: redoDepth(record.state) > 0,
    }
  }

  private sourceToolbarState(record: CachedDocument, pane: Pane): Omit<MarkdownToolbarState, 'canUndo' | 'canRedo'> {
    const source = this.sourcePaneState(record, pane)
    const inCodeBlock = markdownSelectionInCodeBlock(source)
    const line = inCodeBlock ? '' : source.doc.lineAt(source.selection.main.head).text
    const heading = /^\s{0,3}(#{1,6})\s/.exec(line)
    const task = /^\s*[-+*]\s+\[[ xX]\]\s+/.test(line)
    const bullet = /^\s*[-+*]\s+/.test(line) && !task
    const ordered = /^\s*\d+\.\s+/.test(line)
    return {
      heading: heading ? heading[1].length : 0,
      bold: false,
      italic: false,
      strike: false,
      inlineCode: false,
      link: false,
      quote: /^\s*>\s?/.test(line),
      bullet,
      ordered,
      task,
      codeBlock: inCodeBlock,
      inCodeBlock,
      hasYaml: record.state.doc.line(1).text.trim() === '---',
      live: false,
      readOnly: record.state.readOnly || record.meta.readOnly,
      composing: this.isComposing,
    }
  }

  private sourcePaneState(record: CachedDocument, pane: Pane): EditorState {
    const view = this.views.get(pane)
    if (view) return view.state
    const selection = record.panes[pane]?.selection || record.state.selection
    return record.state.update({ selection, annotations: Transaction.addToHistory.of(false) }).state
  }

  markdownFind(pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const id = this.paneGroup(resolved).activeId
    const record = id && this.records.get(id)
    if (!record || this.isComposing || !/\.(md|markdown)$/i.test(record.meta.name)) return false
    this.focusPane(resolved, false)
    this.command('find')
    return true
  }

  insertMarkdownTable(rows: number, columns: number, pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const id = this.paneGroup(resolved).activeId
    const record = id && this.records.get(id)
    if (!record || !/\.(md|markdown)$/i.test(record.meta.name) || this.isComposing || record.meta.readOnly || record.state.readOnly) return false
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || rows > 8 || columns < 1 || columns > 8) return false
    this.focusPane(resolved, false)
    const live = this.liveViews.get(resolved)
    if (live?.id === id) {
      const ok = live.editor.insertTable(rows, columns)
      this.focusPane(resolved, true)
      return ok
    }
    const view = this.views.get(resolved)
    const source = this.sourcePaneState(record, resolved)
    if (markdownSelectionInCodeBlock(source)) return false
    const at = source.doc.lineAt(source.selection.main.to).to
    const prefix = at > 0 ? (source.doc.lineAt(at).text ? '\n\n' : '\n') : ''
    const header = `| ${Array.from({ length: columns }, (_, index) => `列 ${index + 1}`).join(' | ')} |`
    const separator = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`
    const body = Array.from({ length: rows - 1 }, () => `| ${Array.from({ length: columns }, () => '内容').join(' | ')} |`)
    const insert = `${prefix}${[header, separator, ...body].join('\n')}\n\n`
    this.dispatch(id, { changes: { from: at, insert }, selection: { anchor: at + prefix.length + 2 }, annotations: isolateHistory.of('full'), userEvent: 'input.format.table' })
    view?.focus()
    return true
  }

  markdownHistory(forward: boolean, pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const id = this.paneGroup(resolved).activeId
    const record = id && this.records.get(id)
    if (!record || !/\.(md|markdown)$/i.test(record.meta.name) || this.isComposing || record.meta.readOnly || record.state.readOnly) return false
    this.focusPane(resolved, false)
    const command = forward ? redo : undo
    command({ state: record.state, dispatch: tr => this.dispatch(id, tr) })
    this.focusPane(resolved, true)
    return true
  }

  insertMarkdown(command: MarkdownToolbarCommand, pane: Pane = this.activePane) {
    const resolved = this.resolvePaneId(pane)
    const id = this.paneGroup(resolved).activeId
    const record = id && this.records.get(id)
    const live = this.liveViews.get(resolved)
    if (!record || !live || live.id !== id || this.isComposing || record.meta.readOnly || record.state.readOnly || !/\.(md|markdown)$/i.test(record.meta.name)) return false
    this.focusPane(resolved, false)
    const ok = live.editor.insertToolbar(command)
    this.focusPane(resolved, true)
    return ok
  }

  switchPane() {
    if (this.isSplit && !this.isComposing) this.layout.focusNextPane()
  }

  private activeViewFor(id: string) {
    const activeLeaf = this.layout.activePaneId
    const activeView = this.views.get(activeLeaf)
    if (activeView && this.paneGroup(activeLeaf).activeId === id) return activeView
    // Live panes have no CM view; keep looking for a source view of this document.
    for (const pane of this.layout.getAllLeafIds()) {
      const view = this.views.get(pane)
      if (view && this.paneGroup(pane).activeId === id) return view
    }
    return null
  }

  private historyCommand(forward: boolean, selection = false) {
    const id = this.activeId, record = id && this.records.get(id)
    const command = selection ? (forward ? redoSelection : undoSelection) : forward ? redo : undo
    if (record && id) command({ state: record.state, dispatch: tr => this.dispatch(id, tr) })
  }

  gotoLine(id: string, line: number, column = 1) {
    this.revealPosition(id, line, column)
  }

  replaceAll(
    id: string,
    searchText: string,
    replaceText: string,
    options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {}
  ): number {
    const record = this.records.get(id)
    if (!record || !searchText || this.isComposing || record.state.readOnly) return 0
    const query = createSearchQuery({ search: searchText, replace: replaceText, regexp: !!options.regex, caseSensitive: !!options.caseSensitive, wholeWord: !!options.wholeWord })
    if (!query.valid) return 0
    const cursor = query.getCursor(record.state)
    const changes: { from: number; to: number; insert: string }[] = []
    for (let item = cursor.next(); !item.done; item = cursor.next()) {
      const value = item.value
      let insert = replaceText
      if (options.regex && 'match' in value && Array.isArray(value.match)) {
        insert = expandReplacement(value.match as RegExpExecArray, replaceText)
      }
      changes.push({ from: value.from, to: value.to, insert })
    }

    if (changes.length > 0) {
      this.dispatch(id, { changes, annotations: isolateHistory.of('full'), userEvent: 'input.replace' })
    }
    return changes.length
  }

  /** One isolated history entry against the exact previewed CodeMirror Text.
   * Text identity also detects edit/undo cycles while native preview is running. */
  applyWorkspaceReplacement(id: string, expected: import('@codemirror/state').Text, changes: { from: number; to: number; insert: string }[]): boolean {
    const record = this.records.get(id)
    if (!record || record.state.doc !== expected || this.isComposing || record.state.readOnly || record.meta.readOnly || record.meta.encoding === 'Hex') return false
    let end = 0
    for (const change of changes) {
      if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < end || change.to < change.from || change.to > expected.length) return false
      end = change.to
    }
    if (!changes.length) return false
    if (changes.every(change => expected.sliceString(change.from, change.to) === change.insert)) return true
    this.dispatch(id, { changes, annotations: isolateHistory.of('full'), userEvent: 'input.replace.workspace' })
    return true
  }
  private accept(record: CachedDocument, state: EditorState, docChanged: boolean) {
    record.state = state
    if (docChanged) {
      record.meta.dirty = !state.doc.eq(record.baseline) || !record.endings.equal(state, record.baselineEndings)
      record.meta.charCount = state.doc.length
      // Drop stale scroll snapshotText references to superseded document versions
      for (const paneState of Object.values(record.panes)) {
        if (paneState.snapshotText && paneState.snapshotText !== state.doc) {
          paneState.snapshot = undefined
          paneState.snapshotText = undefined
        }
      }
      this.pin(record.meta.id)
    }
    const position = state.selection.main.head
    const line = state.doc.lineAt(position)
    record.meta.line = line.number
    record.meta.column = position - line.from + 1
    let liveSource:string|undefined
    for(const [pane,live]of this.liveViews)if(live.id===record.meta.id){
      if(docChanged&&pane!==this.liveOrigin?.pane)live.editor.sync(liveSource??=state.doc.toString(),this.liveOrigin?.update)
      live.editor.refreshResources()
    }
    this.notify()
  }
  dispatch(id: string, spec: TransactionSpec) {
    const record = this.records.get(id)
    if (!record) return
    if (record.meta.kind === 'javaClass' && spec.changes) return
    const view = this.activeViewFor(id)
    if (view) view.dispatch(view.state.update(spec))
    else {
      const transaction = record.state.update(spec)
      for (const pane of this.layout.getAllLeafIds()) {
        if (!record.panes[pane]) record.panes[pane] = { selection: record.state.selection, top: 0, left: 0 }
        record.panes[pane].selection = record.panes[pane].selection.map(transaction.changes)
      }
      if (!record.panes[this.activePane]) record.panes[this.activePane] = { selection: transaction.state.selection, top: 0, left: 0 }
      else record.panes[this.activePane].selection = transaction.state.selection
      this.accept(record, transaction.state, transaction.docChanged)
    }
  }
  private effects(record: CachedDocument, effects: StateEffect<unknown>[]) {
    if (this.activeId === record.meta.id && this.isComposing) {
      this.deferred.set(record.meta.id, [...(this.deferred.get(record.meta.id) || []), ...effects])
      this.scheduleDeferred()
      return false
    }
    this.dispatch(record.meta.id, { effects, annotations: [Transaction.addToHistory.of(false), sharedConfiguration.of(true)] })
    return true
  }
  private scheduleDeferred() {
    if (this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.isComposing) { this.scheduleDeferred(); return }
      const deferred = [...this.deferred]
      this.deferred.clear()
      for (const [id, effects] of deferred) {
        const record = this.records.get(id)
        if (record) {
          this.effects(record, effects)
          if (record.readyLanguageGeneration === record.languageGeneration) record.meta.languageStatus = 'ready'
        }
      }
      this.notify()
    }, 50)
  }

  async setLanguage(id: string, language: LanguageName) {
    const record = this.records.get(id)
    if (!record || record.meta.kind === 'javaClass' || (record.meta.encoding === 'Hex' && language !== 'Plain Text') || this.disposed) return
    const generation = ++record.languageGeneration
    record.readyLanguageGeneration = null
    record.meta.language = language
    record.meta.languageStatus = 'loading'
    record.meta.languageError = undefined
    this.effects(record, [record.language.reconfigure([])])
    this.notify()
    try {
      const extension: Extension = await this.languageLoader(language)
      if (this.disposed || this.records.get(id) !== record || generation !== record.languageGeneration) return
      record.readyLanguageGeneration = generation
      record.meta.languageStatus = this.effects(record, [record.language.reconfigure(extension)]) ? 'ready' : 'loading'
    } catch (error) {
      if (this.disposed || this.records.get(id) !== record || generation !== record.languageGeneration) return
      if (import.meta.env.DEV) console.warn(`Markumo: failed to load ${language} language support`, error)
      record.meta.languageStatus = 'error'
      record.meta.languageError = '语言包加载失败；当前仍可作为纯文本编辑，请重新选择语言以重试。'
    }
    this.notify()
  }
  getMarkdownMode(id?: string | null, pane: Pane = this.activePane): MarkdownMode | undefined {
    if (!id) return undefined
    const record = this.records.get(id)
    if (!record || record.meta.kind === 'javaClass' || record.meta.encoding === 'Hex' || !/\.(md|markdown)$/i.test(record.meta.name)) {
      return undefined
    }
    const resolved = this.resolvePaneId(pane)
    return record.panes[resolved]?.mode || record.meta.mode || this.defaultMarkdownMode || 'live'
  }
  setMarkdownMode(id: string, mode: MarkdownMode, pane?: Pane): boolean {
    const record = this.records.get(id)
    if (!record || record.meta.kind === 'javaClass' || record.meta.encoding === 'Hex' || !/\.(md|markdown)$/i.test(record.meta.name) || !['live', 'source', 'split'].includes(mode) || this.disposed || this.isComposing) return false
    if(mode==='live'&&record.state.doc.length>1024*1024){window.dispatchEvent(new CustomEvent('editor-notice',{detail:'Markdown 超过 1 Mi 字符安全预算，请使用源码或双栏模式。'}));return false}

    const resolved = this.resolvePaneId(pane || this.activePane)
    if (!record.panes[resolved]) {
      record.panes[resolved] = { selection: record.state.selection, top: 0, left: 0 }
    }
    this.captureScroll(resolved)
    record.panes[resolved].mode = mode

    // 只有当修改的是当前活动 Pane 或未传 pane 时，才同步更新 meta.mode 保持向下兼容
    if (!pane || resolved === this.resolvePaneId(this.activePane)) {
      record.meta.mode = mode
    }

    this.effects(record, [record.markdownMode.reconfigure([])])
    if (this.paneGroup(resolved).activeId === id) {
      this.destroyView(resolved)
      this.showActive(resolved)
    }
    this.notify()
    return true
  }
  setDefaultMarkdownMode(mode: MarkdownMode) { this.defaultMarkdownMode = mode }
  setFileModes(modes: Record<string, MarkdownMode>) { this.fileModes = { ...modes } }
  private updateMarkdownType(record: CachedDocument, previousName: string) {
    if (record.meta.kind === 'javaClass' || record.meta.encoding === 'Hex') return
    const wasMarkdown = /\.(md|markdown)$/i.test(previousName)
    const isMarkdown = /\.(md|markdown)$/i.test(record.meta.name)
    if (wasMarkdown === isMarkdown) return
    record.meta.mode = isMarkdown ? this.defaultMarkdownMode : undefined
    this.effects(record, [record.markdownMode.reconfigure([])])
    for(const pane of this.layout.getAllLeafIds())if(this.paneGroup(pane).activeId===record.meta.id){this.destroyView(pane);this.showActive(pane)}
  }
  setWrap(wrap: boolean) {
    this.wordWrap = wrap
    for (const record of this.records.values()) this.effects(record, [record.wrap.reconfigure(wrap ? EditorView.lineWrapping : [])])
    for (const view of this.views.values()) view.dispatch({ effects: [] })
  }
  setTheme(theme: Theme) {
    this.theme = theme
    for (const record of this.records.values()) this.effects(record, [record.theme.reconfigure(editorTheme(theme))])
  }
  refreshTypography() { this.setTheme(this.theme) }
  setBracketMode(mode: BracketMode) {
    this.bracketMode = mode
    for (const record of this.records.values()) this.effects(record, [record.brackets.reconfigure(bracketHighlight(record.meta.kind === 'javaClass' || record.meta.encoding === 'Hex' ? 'off' : mode))])
    for (const live of this.liveViews.values()) live.editor.bracketMode(mode)
  }
  setCaretAnimation(mode: CaretAnimation) {
    this.caretAnimation = mode
    for (const record of this.records.values()) this.effects(record, [record.caret.reconfigure(smoothCaret(mode))])
    for (const live of this.liveViews.values()) live.editor.caretAnimation(mode)
  }
  setTypewriterMode(enabled: boolean) {
    this.typewriterMode = enabled
    for (const record of this.records.values()) {
      this.effects(record, [
        record.typewriter.reconfigure(typewriterExtension({
          enabled,
          isPaneActive: (view: EditorView) => this.paneView(this.activePane) === view,
        }))
      ])
    }
    for (const live of this.liveViews.values()) {
      live.editor.typewriterMode(enabled)
    }
    this.notify()
  }
  getTypewriterMode() {
    return this.typewriterMode
  }
  setMarkdownTypography(settings:MarkdownTypography){this.markdownTypography={...settings};for(const live of this.liveViews.values())live.editor.typography(settings);this.notify()}
  getMarkdownTypography(){return this.markdownTypography}
  setMarkdownClipboard(settings:MarkdownClipboardSettings){this.markdownClipboard={...settings};for(const live of this.liveViews.values())live.editor.clipboardSettings(settings)}
  command(command: 'undo' | 'redo' | 'find' | 'replace' | 'find-next' | 'find-previous' | 'delete-line' | 'copy-line-down' | 'move-line-up' | 'move-line-down' | 'comment-line' | 'fold-code' | 'unfold-code') {
    if (!this.activeId || this.isComposing) return
    if (isMedia(this.activeDocument)) {
      if (this.activeDocument?.kind === 'pdf' && ['find','find-next','find-previous'].includes(command))
        window.dispatchEvent(new CustomEvent('pdf-command', { detail: { pane: this.activePane, command } }))
      return
    }
    if (command === 'undo') { this.historyCommand(false); return }
    if (command === 'redo') { this.historyCommand(true); return }
    const nested = this.focusedCodeView
    const live = this.activeLiveEditor
    if (live && (!nested || ['find','replace','find-next','find-previous'].includes(command))) {
      if (command === 'find') live.find(false)
      else if (command === 'replace') live.find(true)
      else if (command === 'find-next') live.findNext()
      else if (command === 'find-previous') live.findPrevious()
      return
    }
    const view = nested || this.paneView(this.activePane)
    if (!view) return
    view.focus()
    if (command === 'find-next') findNext(view)
    else if (command === 'find-previous') findPrevious(view)
    else if (command === 'delete-line') deleteLine(view)
    else if (command === 'copy-line-down') copyLineDown(view)
    else if (command === 'move-line-up') moveLineUp(view)
    else if (command === 'move-line-down') moveLineDown(view)
    else if (command === 'comment-line') toggleComment(view)
    else if (command === 'fold-code') foldCode(view)
    else if (command === 'unfold-code') unfoldCode(view)
    else showEditorSearch(view, command === 'replace')
  }
  dispose() {
    if(this.disposed)return
    this.disposed = true
    this.stopLayout()
    if (this.timer) clearTimeout(this.timer)
    for(const pane of new Set([...this.views.keys(),...this.liveViews.keys(),...this.restoreFrames.keys()]))this.destroyView(pane)
    this.liveViews.clear();this.liveLoads.clear()
    this.views.clear()
    this.hosts.clear();this.rehosting.clear()
    this.viewDocuments.clear();this.paneNavigation.clear();this.fileModes={}
    this.records.clear(); this.media.clear(); this.seeds.clear(); this.deferred.clear(); this.listeners.clear(); this.releaseListeners.clear()
  }
}
