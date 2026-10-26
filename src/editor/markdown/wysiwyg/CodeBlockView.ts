import { EditorState as CMState, EditorSelection, Compartment, Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView as CMView, drawSelection, keymap, lineNumbers, Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { smoothCaret } from '../../core/smoothCaret'
import type { CaretAnimation } from '../../core/caretMotion'
import { defaultKeymap, indentWithTab, indentLess } from '@codemirror/commands'
import { bracketHighlight, type BracketMode } from '../../core/brackets'
import { markumoSyntax } from '../../core/syntaxTheme'
import { LanguageSelector } from './LanguageSelector'
import { copyStatusIcon } from '../../../components/common/iconPaths'
import type { Node } from 'prosemirror-model'
import { TextSelection, Selection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'
import { parseFenceInfo, loadLanguage } from '../../languages'
import { textClipboard } from '../../../features/shell/clipboard'
import type { MarkdownTypography } from './contracts'
import { LanguageSupport, indentUnit } from '@codemirror/language'
import { syntaxSpans, type SyntaxSpan } from '../../core/syntaxSpans'
import { staticCodeLines } from '../staticCode'
import { createRenderTaskQueue, type RenderTaskQueueStats } from '../renderTaskQueue'
import { observeRenderVisibility } from '../renderVisibility'

const escapeCode = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

export const DISPLAY_HIGHLIGHT_MAX_CHARS = 50_000
export const DEFAULT_CODE_ROOT_MARGIN = '400px 0px 400px 0px'
const MAX_OFFSCREEN_HIGHLIGHTED = 12

const codeHighlightQueue = createRenderTaskQueue(2, 128)
const offscreenHighlightedViews = new Set<CodeBlockView>()
let pointerClickingOutsideCodeBlock = false
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    event => {
      const target = event.target instanceof Element ? event.target : null
      if (target && target.closest('.markdown-live') && !target.closest('.md-code-block')) {
        pointerClickingOutsideCodeBlock = true
        queueMicrotask(() => {
          setTimeout(() => {
            pointerClickingOutsideCodeBlock = false
          }, 0)
        })
      } else {
        pointerClickingOutsideCodeBlock = false
      }
    },
    { capture: true, passive: true }
  )
}

export function getCodeHighlightQueueStats(): RenderTaskQueueStats {
  return codeHighlightQueue.stats()
}

function resolveCodeRootMargin(): string {
  const custom = (globalThis as { __MARKUMO_CODE_ROOT_MARGIN?: unknown }).__MARKUMO_CODE_ROOT_MARGIN
  return typeof custom === 'string' && custom.trim() ? custom.trim() : DEFAULT_CODE_ROOT_MARGIN
}

interface CodeSearchRange {
  from: number
  to: number
  current: boolean
}
const setCodeSearch = StateEffect.define<CodeSearchRange[]>()

class ZeroSearchMatch extends WidgetType {
  constructor(private current: boolean) {
    super()
  }
  eq(other: ZeroSearchMatch) {
    return this.current === other.current
  }
  toDOM() {
    const marker = document.createElement('span')
    marker.className = `cm-searchMatch md-search-zero md-search-match${this.current ? ' cm-searchMatch-selected md-search-match-current' : ''}`
    marker.setAttribute('aria-hidden', 'true')
    return marker
  }
}

const codeSearchDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setCodeSearch)) {
        value = Decoration.set(
          effect.value
            .filter(r => r.from <= r.to && r.to <= tr.newDoc.length)
            .map(r =>
              r.from === r.to
                ? Decoration.widget({ widget: new ZeroSearchMatch(r.current), side: 1 }).range(r.from)
                : Decoration.mark({
                    class: `cm-searchMatch md-search-match${r.current ? ' cm-searchMatch-selected md-search-match-current' : ''}`,
                  }).range(r.from, r.to)
            ),
          true
        )
      }
    }
    return value
  },
  provide: field => CMView.decorations.from(field),
})

/**
 * CodeBlockView with strict Display / Edit separation:
 * - Display mode renders lightweight static DOM + viewport-bounded queued syntax highlighting (0 CMViews when idle/scrolling).
 * - Edit mode lazily mounts a full CodeMirror EditorView only on explicit user interaction or selection entry,
 *   and safely detaches it once focus/IME/drag/selection leave the block.
 */
export class CodeBlockView implements NodeView {
  readonly dom = document.createElement('div')
  readonly surface = document.createElement('div')
  private cmInstance: CMView | null = null

  private language = new Compartment()
  private numbers = new Compartment()
  private wrap = new Compartment()
  private caret = new Compartment()
  private brackets = new Compartment()
  private editable = new Compartment()
  private indentation = new Compartment()
  private indentSize = 2
  private useTabs = false
  private updating = false
  private dead = false
  private generation = 0
  private highlightKey = ''
  private highlightDoc?: CMState['doc']
  private pendingHighlights: CodeSearchRange[] = []
  private highlightScheduled = false

  private selector: LanguageSelector
  private languageStatus = document.createElement('span')
  private copyTimer: ReturnType<typeof setTimeout> | undefined
  private detachCheckTimer: ReturnType<typeof setTimeout> | undefined
  private diagram = document.createElement('div')
  private diagramToolbar = document.createElement('div')
  private renderButton = document.createElement('button')
  private editSourceButton = document.createElement('button')
  private copyButton = document.createElement('button')
  private cmContainer = document.createElement('div')
  private placeholder: HTMLElement | null = null
  private cachedSpans: { source: string; params: string; spans: readonly SyntaxSpan[] } | null = null
  private displayHighlighted = false
  private displayHighlightDirty = true
  private highlightAbort: AbortController | null = null
  private placeholderGeneration = 0

  private isMermaid = false
  private isEditingMermaid = false
  private diagramDirty = true
  private diagramAbort: AbortController | null = null
  private renderGeneration = 0
  private themeObserver?: MutationObserver
  private renderTimer?: ReturnType<typeof setTimeout>
  private stopVisibility: () => void = () => {}
  private renderVisible = false
  private inViewport = false
  private isFocused = false
  private pointerActive = false
  private coldDragAnchor: number | null = null
  private savedSelection = EditorSelection.single(0)
  private savedScrollLeft = 0

  private dragPlaceholder = (event: PointerEvent) => {
    const editor = this.cmInstance
    if (!editor || this.coldDragAnchor === null) return
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null
    const head =
      range && editor.contentDOM.contains(range.startContainer)
        ? editor.posAtDOM(range.startContainer, range.startOffset)
        : editor.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    if (head !== null) editor.dispatch({ selection: { anchor: this.coldDragAnchor, head } })
  }

  private releasePointer = () => {
    this.pointerActive = false
    this.coldDragAnchor = null
    window.removeEventListener('pointermove', this.dragPlaceholder)
    window.removeEventListener('pointerup', this.releasePointer)
    window.removeEventListener('pointercancel', this.releasePointer)
    this.scheduleDetachCheck()
  }

  constructor(
    private node: Node,
    private outer: EditorView,
    readonly getPos: () => number | undefined,
    private settings: MarkdownTypography,
    private history: (forward: boolean) => void,
    private onSearchRequest?: (replace: boolean) => void,
    private onSearchNavigate?: (forward: boolean) => void,
    private caretAnim: CaretAnimation = 'smooth',
    private bracketMod: BracketMode = 'matching'
  ) {
    this.isMermaid = /^mermaid(?:\s|$)/i.test(node.attrs.params)
    this.dom.className = 'md-code-block md-code-block-container'
    this.updateLayout()
    this.dom.contentEditable = 'false'
    this.surface.className = 'md-code-surface'

    // Copy button (top-right of surface, hover display)
    this.copyButton.type = 'button'
    this.copyButton.className = 'md-code-copy'
    this.copyButton.setAttribute('aria-label', '复制代码')
    this.copyButton.title = '复制代码'
    this.copyButton.append(copyStatusIcon())
    this.copyButton.onclick = () => {
      const codeText = this.cmInstance ? this.cmInstance.state.doc.toString() : this.node.textContent
      void textClipboard
        .writeText(codeText)
        .then(() => {
          if (this.dead) return
          this.copyButton.replaceChildren(copyStatusIcon(true))
          this.copyButton.title = '已复制'
          if (this.copyTimer) clearTimeout(this.copyTimer)
          this.copyTimer = setTimeout(() => {
            if (!this.dead) {
              this.copyButton.replaceChildren(copyStatusIcon())
              this.copyButton.title = '复制代码'
            }
          }, 1500)
        })
        .catch(error => window.dispatchEvent(new CustomEvent('editor-notice', { detail: String(error) })))
    }

    this.selector = new LanguageSelector(
      node.attrs.params,
      params => {
        const pos = this.getPos()
        if (this.dead || pos === undefined || this.outer.state.doc.nodeAt(pos) !== this.node || this.cmInstance?.compositionStarted) {
          return
        }
        const unchanged = params === this.node.attrs.params
        this.outer.dispatch(this.outer.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, params }).setMeta('isolated', true))
        if (!this.dead && unchanged) {
          if (this.cmInstance) this.setLanguage()
          else this.renderPlaceholder(true)
        }
      },
      () => this.scheduleDetachCheck()
    )
    this.languageStatus.className = 'md-code-language-status'
    this.languageStatus.setAttribute('role', 'status')
    this.selector.dock.prepend(this.languageStatus)

    // Mermaid specific controls
    this.diagram.className = 'md-diagram'
    this.diagramToolbar.className = 'md-diagram-toolbar'

    this.renderButton.type = 'button'
    this.renderButton.className = 'md-diagram-btn'
    this.renderButton.textContent = '渲染 Mermaid'
    this.renderButton.onclick = () => this.setMermaidEditing(false)

    this.editSourceButton.type = 'button'
    this.editSourceButton.className = 'md-diagram-btn'
    this.editSourceButton.textContent = '编辑图表源码'
    this.editSourceButton.onclick = () => {
      this.setMermaidEditing(!this.isEditingMermaid)
    }

    this.diagramToolbar.append(this.editSourceButton, this.renderButton)
    this.diagramToolbar.hidden = !this.isMermaid
    this.diagram.hidden = !this.isMermaid

    // Code container (hosts static placeholder in display mode, CMView in edit mode)
    this.cmContainer.className = 'md-code-editor-wrap'

    this.surface.append(this.diagramToolbar, this.cmContainer, this.diagram, this.copyButton)
    this.dom.append(this.surface, this.selector.row)

    this.dom.addEventListener('focusin', () => {
      this.isFocused = true
      this.updateFocusState()
    })
    this.dom.addEventListener('focusout', () => {
      queueMicrotask(() => {
        if (this.dead) return
        this.isFocused = !!this.dom.contains(document.activeElement)
        this.updateFocusState()
        if (this.isEditingMermaid && !this.cmInstance?.compositionStarted && !this.isFocused) {
          this.setMermaidEditing(false)
        }
        this.maybeDetachEditor()
        this.scheduleDetachCheck()
      })
    })

    // Activate edit mode only on direct pointer interaction inside the code area
    this.dom.addEventListener(
      'pointerdown',
      event => {
        this.pointerActive = true
        window.addEventListener('pointerup', this.releasePointer)
        window.addEventListener('pointercancel', this.releasePointer)
        if (this.cmContainer.hidden || !this.cmContainer.contains(event.target as globalThis.Node)) return
        if (event.button !== 0) return

        const wasStatic = !this.cmInstance
        const sourceOffset = wasStatic ? this.resolveStaticOffset(event.clientX, event.clientY) : null
        const editor = this.ensureEditor()
        if (wasStatic) {
          const pos = sourceOffset ?? editor.posAtCoords({ x: event.clientX, y: event.clientY })
          const anchor = event.shiftKey ? editor.state.selection.main.anchor : pos
          if (pos !== null && anchor !== null) {
            editor.dispatch({ selection: { anchor, head: pos } })
          }
          editor.focus()
          // Original static target was detached on mount; keep gesture ownership on CM
          event.preventDefault()
          this.coldDragAnchor = anchor
          window.addEventListener('pointermove', this.dragPlaceholder)
        }
      },
      { capture: true }
    )

    this.dom.addEventListener('compositionend', () =>
      queueMicrotask(() => {
        if (!this.dead) this.scheduleDetachCheck()
      })
    )

    // Bind IntersectionObserver + visibilitychange after ProseMirror inserts NodeView DOM into the real Pane
    queueMicrotask(() => {
      if (this.dead) return
      const paneRoot = this.outer.dom.closest('.markdown-live')
      this.stopVisibility = observeRenderVisibility(
        this.dom,
        {
          root: paneRoot,
          rootMargin: resolveCodeRootMargin(),
        },
        state => {
          if (this.dead) return
          this.inViewport = state.nearViewport
          this.renderVisible = state.visible

          if (state.visible) {
            offscreenHighlightedViews.delete(this)
            if (this.isMermaid) {
              if (this.diagramDirty) void this.renderMermaidDiagram()
            } else if (!this.cmInstance && this.displayHighlightDirty) {
              this.scheduleStaticHighlight()
            }
          } else {
            this.highlightAbort?.abort()
            this.highlightAbort = null
            if (!this.isEditingMermaid) {
              this.diagramAbort?.abort()
              this.diagramAbort = null
            }
            if (!this.isMermaid && !this.cmInstance && this.displayHighlighted) {
              this.trackOffscreenHighlight()
            }
            this.maybeDetachEditor()
          }
        }
      )
    })

    this.updateLanguageBadge()
    if (this.isMermaid) {
      this.setMermaidEditing(false)
    } else {
      this.renderPlaceholder(false)
    }
  }

  /** State queries must never allocate an embedded CodeMirror editor. */
  get existingEditor(): CMView | null {
    return this.cmInstance
  }
  get isComposing(): boolean {
    return !!this.cmInstance?.compositionStarted
  }
  get hasFocus(): boolean {
    return !!this.cmInstance?.hasFocus
  }
  get isNearViewport(): boolean {
    return this.inViewport
  }

  private resolveStaticOffset(clientX: number, clientY: number): number | null {
    if (!this.placeholder) return null
    const sourceLen = this.node.textContent.length
    if (sourceLen === 0) return 0

    const docWithCaret = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: globalThis.Node; offset: number } | null
    }
    let container: globalThis.Node | null = null
    let domOffset = 0
    const caretPos = docWithCaret.caretPositionFromPoint?.(clientX, clientY)
    if (caretPos) {
      container = caretPos.offsetNode
      domOffset = caretPos.offset
    } else {
      const range = document.caretRangeFromPoint?.(clientX, clientY)
      if (range) {
        container = range.startContainer
        domOffset = range.startOffset
      }
    }
    if (!container || !this.placeholder.contains(container)) return null

    const flatCode = this.placeholder.querySelector('.md-code-flat-text')
    if (flatCode && flatCode.contains(container)) {
      const prefix = document.createRange()
      prefix.selectNodeContents(flatCode)
      prefix.setEnd(container, domOffset)
      return Math.max(0, Math.min(sourceLen, prefix.toString().length))
    }

    let offset = 0
    for (const line of this.placeholder.querySelectorAll('.md-code-line')) {
      const text = line.querySelector('.md-code-text')!
      if (text.contains(container)) {
        const prefix = document.createRange()
        prefix.selectNodeContents(text)
        prefix.setEnd(container, domOffset)
        return Math.max(0, Math.min(sourceLen, offset + prefix.toString().length))
      }
      offset += (text.textContent?.length ?? 0) + 1
    }
    return null
  }

  ensureEditor(): CMView {
    if (this.dead) throw new Error('Cannot activate a destroyed code block')
    if (this.cmInstance) {
      return this.cmInstance
    }
    this.highlightAbort?.abort()
    this.highlightAbort = null
    offscreenHighlightedViews.delete(this)
    if (this.placeholder) {
      // Hold the measured display height only during synchronous replacement.
      // This prevents scroll anchoring from observing an empty code container.
      this.cmContainer.style.minHeight = getComputedStyle(this.placeholder).height
      this.savedScrollLeft = this.placeholder.scrollLeft
      this.placeholder.remove()
      this.placeholder = null
    }
    this.displayHighlighted = false

    this.cmInstance = new CMView({
      parent: this.cmContainer,
      state: CMState.create({
        doc: this.node.textContent,
        selection: EditorSelection.create(
          this.savedSelection.ranges.map(range =>
            EditorSelection.range(
              Math.min(range.anchor, this.node.textContent.length),
              Math.min(range.head, this.node.textContent.length)
            )
          )
        ),
        extensions: [
          this.editable.of([CMState.readOnly.of(!this.outer.editable), CMView.editable.of(this.outer.editable)]),
          this.caret.of([smoothCaret(this.caretAnim), this.caretAnim === 'off' ? [] : drawSelection()]),
          this.language.of([]),
          this.indentation.of([CMState.tabSize.of(this.indentSize), indentUnit.of(this.useTabs ? '\t' : ' '.repeat(this.indentSize))]),
          this.numbers.of(this.settings.codeLineNumbers ? lineNumbers() : []),
          this.wrap.of(this.settings.codeWrap ? CMView.lineWrapping : []),
          markumoSyntax,
          this.brackets.of(bracketHighlight(this.bracketMod)),
          codeSearchDecorations,
          CMView.contentAttributes.of({ 'aria-label': '代码块编辑器' }),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-z',
                run: () => {
                  this.history(false)
                  return true
                },
              },
              {
                key: 'Mod-y',
                run: () => {
                  this.history(true)
                  return true
                },
              },
              {
                key: 'Mod-Shift-z',
                run: () => {
                  this.history(true)
                  return true
                },
              },
              {
                key: 'Mod-f',
                run: () => {
                  this.onSearchRequest?.(false)
                  return true
                },
              },
              {
                key: 'Mod-r',
                run: () => {
                  this.onSearchRequest?.(true)
                  return true
                },
              },
              {
                key: 'F3',
                run: () => {
                  this.onSearchNavigate?.(true)
                  return true
                },
              },
              {
                key: 'Shift-F3',
                run: () => {
                  this.onSearchNavigate?.(false)
                  return true
                },
              },
              indentWithTab,
              { key: 'Shift-Tab', run: indentLess },
              { key: 'ArrowUp', run: () => this.escape(-1) },
              { key: 'ArrowDown', run: () => this.escape(1) },
              { key: 'ArrowLeft', run: () => this.escape(-1, true) },
              { key: 'ArrowRight', run: () => this.escape(1, true) },
              { key: 'Mod-Enter', run: () => this.insertParagraph(1) },
              { key: 'Mod-Shift-Enter', run: () => this.insertParagraph(-1) },
              {
                key: 'Backspace',
                run: () => {
                  if (this.cmInstance && this.cmInstance.state.doc.length) return false
                  const pos = this.getPos()
                  if (pos === undefined) return false
                  this.outer.dispatch(this.outer.state.tr.setNodeMarkup(pos, this.outer.state.schema.nodes.paragraph))
                  this.outer.focus()
                  return true
                },
              },
            ])
          ),
          keymap.of(defaultKeymap),
          CMView.updateListener.of(update => {
            if (this.updating) return
            const pos = this.getPos()
            if (pos === undefined) return
            if (update.docChanged) {
              const tr = this.outer.state.tr
              let delta = 0
              update.changes.iterChanges((from, to, _a, _b, insert) => {
                tr.replaceWith(
                  pos + 1 + from + delta,
                  pos + 1 + to + delta,
                  insert.length ? this.outer.state.schema.text(insert.toString()) : []
                )
                delta += insert.length - (to - from)
              })
              const sel = update.state.selection.main
              tr.setSelection(TextSelection.create(tr.doc, pos + 1 + sel.anchor, pos + 1 + sel.head))
              this.outer.dispatch(tr)
            } else if (update.selectionSet || (update.focusChanged && update.view.hasFocus)) {
              if (update.focusChanged) {
                this.updateFocusState()
              }
              const sel = update.state.selection.main
              this.outer.dispatch(
                this.outer.state.tr.setSelection(
                  TextSelection.create(this.outer.state.doc, pos + 1 + sel.anchor, pos + 1 + sel.head)
                )
              )
            } else if (update.focusChanged) {
              this.updateFocusState()
            }
          }),
        ],
      }),
    })

    // CM normally measures gutters on the next animation frame. Force its public
    // geometry read before painting (also for empty blocks with no caret lookup).
    this.cmInstance.coordsAtPos(this.cmInstance.state.selection.main.head)
    this.cmContainer.style.minHeight = ''
    if (this.savedScrollLeft > 0) {
      this.cmInstance.scrollDOM.scrollLeft = this.savedScrollLeft
    }

    this.setLanguage()
    if (this.pendingHighlights.length) {
      this.highlightKey = JSON.stringify(this.pendingHighlights)
      this.highlightDoc = this.cmInstance.state.doc
      this.cmInstance.dispatch({ effects: setCodeSearch.of(this.pendingHighlights) })
    }
    return this.cmInstance
  }

  private scheduleDetachCheck() {
    if (this.detachCheckTimer) clearTimeout(this.detachCheckTimer)
    if (!this.cmInstance || this.dead) return
    this.detachCheckTimer = setTimeout(() => {
      this.detachCheckTimer = undefined
      if (!this.dead) this.maybeDetachEditor()
    }, 0)
  }

  /** Called by controller or focus/pointer/IME handlers to release idle CMView safely. */
  maybeDetachEditor() {
    if (!this.cmInstance || this.dead) return
    const pos = this.getPos()
    const selection = this.outer.state.selection
    const hasOuterRangeSelection =
      pos !== undefined && !selection.empty && selection.to > pos && selection.from < pos + this.node.nodeSize
    const nativeSelection = window.getSelection()
    const hasNativeRangeSelection =
      !!nativeSelection && !nativeSelection.isCollapsed && nativeSelection.containsNode(this.dom, true)

    if (
      this.isFocused ||
      this.hasFocus ||
      this.isComposing ||
      this.updating ||
      this.pointerActive ||
      this.selector.isInteracting ||
      this.isEditingMermaid ||
      hasOuterRangeSelection ||
      hasNativeRangeSelection ||
      this.cmInstance.state.doc.toString() !== this.node.textContent ||
      this.dom.contains(document.activeElement)
    ) {
      return
    }

    this.savedSelection = this.cmInstance.state.selection
    this.savedScrollLeft = this.cmInstance.scrollDOM.scrollLeft
    this.generation++
    this.highlightDoc = undefined
    this.cmInstance.destroy()
    this.cmInstance = null
    if (!this.isMermaid) {
      this.renderPlaceholder(this.renderVisible)
    }
  }

  private trackOffscreenHighlight() {
    if (this.pendingHighlights.length > 0) return
    offscreenHighlightedViews.delete(this)
    offscreenHighlightedViews.add(this)
    while (offscreenHighlightedViews.size > MAX_OFFSCREEN_HIGHLIGHTED) {
      const oldest = offscreenHighlightedViews.values().next().value
      if (!oldest) break
      offscreenHighlightedViews.delete(oldest)
      if (!oldest.dead && !oldest.cmInstance && !oldest.renderVisible && oldest.pendingHighlights.length === 0) {
        oldest.downgradeToCompactPlaceholder()
      }
    }
  }

  private downgradeToCompactPlaceholder() {
    this.displayHighlighted = false
    this.displayHighlightDirty = true
    this.renderPlaceholderDOM(null)
  }

  private updateLanguageBadge() {
    const { label, language } = parseFenceInfo(this.node.attrs.params)
    this.languageStatus.textContent = label && !language && !this.isMermaid ? '未注册语言 · 纯文本' : ''
    if (!language) {
      this.dom.dataset.languageStatus = 'plain'
    } else if (!this.dom.dataset.languageStatus || this.dom.dataset.languageStatus === 'plain') {
      this.dom.dataset.languageStatus = 'loading'
    }
  }

  private ensurePlaceholderElement(): HTMLElement {
    if (!this.placeholder) {
      const pre = document.createElement('pre')
      pre.className = 'md-code-placeholder'
      pre.addEventListener(
        'scroll',
        () => {
          this.savedScrollLeft = pre.scrollLeft
        },
        { passive: true }
      )
      this.placeholder = pre
      this.cmContainer.append(pre)
    }
    return this.placeholder
  }

  private renderPlaceholderDOM(spans: readonly SyntaxSpan[] | null) {
    const pre = this.ensurePlaceholderElement()
    const source = this.node.textContent
    const lineCount = source.split('\n').length
    const code = document.createElement('code')
    const hasSearch = this.pendingHighlights.length > 0

    if ((spans && spans.length > 0) || this.settings.codeWrap || hasSearch) {
      code.innerHTML = staticCodeLines(source, spans ?? [], escapeCode, true, this.pendingHighlights)
      this.displayHighlighted = !!spans
    } else {
      code.className = 'md-code-flat'
      const numbers = document.createElement('span')
      numbers.className = 'md-code-number'
      numbers.setAttribute('aria-hidden', 'true')
      numbers.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n')
      const text = document.createElement('span')
      text.className = 'md-code-flat-text md-code-text'
      text.textContent = source
      code.append(numbers, text)
      this.displayHighlighted = false
    }

    this.updateLayout(lineCount)
    pre.replaceChildren(code)
    pre.classList.toggle('is-wrapped', this.settings.codeWrap)
    pre.classList.toggle('has-numbers', this.settings.codeLineNumbers)
    if (this.savedScrollLeft > 0) {
      pre.scrollLeft = this.savedScrollLeft
    }
  }

  private updateLayout(lineCount = this.node.textContent.split('\n').length) {
    this.dom.style.setProperty('--code-digits', String(String(lineCount).length))
    this.dom.classList.toggle('has-code-numbers', this.settings.codeLineNumbers)
    this.dom.classList.toggle('has-code-wrap', this.settings.codeWrap)
  }

  private renderPlaceholder(scheduleHighlight = this.renderVisible) {
    if (this.isMermaid || this.cmInstance || this.dead) return
    const source = this.node.textContent
    const params = this.node.attrs.params
    const { language } = parseFenceInfo(params)

    // Reuse cached spans synchronously when source and language have not changed
    if (
      this.cachedSpans &&
      this.cachedSpans.source === source &&
      this.cachedSpans.params === params &&
      (scheduleHighlight || this.pendingHighlights.length > 0)
    ) {
      this.renderPlaceholderDOM(this.cachedSpans.spans)
      this.displayHighlightDirty = false
      this.dom.dataset.languageStatus = 'ready'
      if (!this.renderVisible) this.trackOffscreenHighlight()
      return
    }

    this.renderPlaceholderDOM(null)
    if (!language || source.length > DISPLAY_HIGHLIGHT_MAX_CHARS) {
      this.displayHighlightDirty = false
      if (language && source.length > DISPLAY_HIGHLIGHT_MAX_CHARS) {
        this.dom.dataset.languageStatus = 'plain'
      }
      return
    }

    this.displayHighlightDirty = true
    if (scheduleHighlight && this.renderVisible) {
      this.scheduleStaticHighlight()
    }
  }

  private scheduleStaticHighlight() {
    if (this.dead || this.isMermaid || this.cmInstance || !this.renderVisible || !this.displayHighlightDirty) return
    const source = this.node.textContent
    const params = this.node.attrs.params
    const { language } = parseFenceInfo(params)
    if (!language || source.length > DISPLAY_HIGHLIGHT_MAX_CHARS) {
      this.displayHighlightDirty = false
      return
    }

    this.highlightAbort?.abort()
    const controller = new AbortController()
    this.highlightAbort = controller
    const generation = ++this.placeholderGeneration
    this.dom.dataset.languageStatus = 'loading'

    void codeHighlightQueue(
      async () => {
        const support = await loadLanguage(language.name, 'fence')
        if (
          this.dead ||
          this.cmInstance ||
          controller.signal.aborted ||
          generation !== this.placeholderGeneration ||
          this.node.textContent !== source ||
          this.node.attrs.params !== params
        ) {
          return null
        }
        if (!(support instanceof LanguageSupport)) return []
        return syntaxSpans(source, support)
      },
      { signal: controller.signal, priority: 'normal' }
    )
      .then(spans => {
        if (
          spans === null ||
          this.dead ||
          this.cmInstance ||
          controller.signal.aborted ||
          generation !== this.placeholderGeneration
        ) {
          return
        }
        this.cachedSpans = { source, params, spans }
        this.displayHighlightDirty = false
        this.dom.dataset.languageStatus = 'ready'
        if (this.renderVisible || this.pendingHighlights.length > 0) {
          this.renderPlaceholderDOM(spans)
          if (!this.renderVisible) this.trackOffscreenHighlight()
        } else {
          this.displayHighlightDirty = true
        }
      })
      .catch(err => {
        if (this.dead || controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return
        }
        if (generation === this.placeholderGeneration) {
          this.languageStatus.textContent = '语言加载失败 · 纯文本（重新选择可重试）'
          this.dom.dataset.languageStatus = 'error'
          this.displayHighlightDirty = false
        }
      })
      .finally(() => {
        if (this.highlightAbort === controller) {
          this.highlightAbort = null
        }
      })
  }

  refreshReadOnly() {
    this.cmInstance?.dispatch({
      effects: this.editable.reconfigure([CMState.readOnly.of(!this.outer.editable), CMView.editable.of(this.outer.editable)]),
    })
  }

  private updateFocusState() {
    if (this.dead) return
    const isFocused =
      (this.cmInstance && this.cmInstance.hasFocus) || this.selector.isInteracting || this.dom.contains(document.activeElement)
    this.dom.classList.toggle('is-focused', isFocused)
  }

  setMermaidEditing(editing: boolean, focus = true) {
    if (this.isMermaid && !this.themeObserver) {
      let light = document.body.classList.contains('light')
      this.themeObserver = new MutationObserver(() => {
        const next = document.body.classList.contains('light')
        if (light === next) return
        light = next
        this.diagramDirty = true
        if (this.renderVisible) void this.renderMermaidDiagram()
      })
      this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    } else if (!this.isMermaid) {
      this.themeObserver?.disconnect()
      this.themeObserver = undefined
    }
    this.isEditingMermaid = editing
    this.copyButton.hidden = this.isMermaid && !editing
    this.cmContainer.hidden = this.isMermaid && !editing
    this.diagram.hidden = !this.isMermaid
    this.renderButton.hidden = !editing
    this.editSourceButton.textContent = editing ? '完成编辑' : '编辑图表源码'

    if (editing) {
      const editor = this.ensureEditor()
      if (focus) editor.focus()
    } else {
      this.maybeDetachEditor()
    }
    if (this.isMermaid) {
      this.diagramDirty = true
      if (this.renderVisible || editing) {
        void this.renderMermaidDiagram()
      } else if (!this.diagram.querySelector('svg')) {
        this.diagram.textContent = '图表加载中…'
      }
    }
  }

  private async renderMermaidDiagram() {
    if (this.dead || !this.isMermaid) return
    if (!this.renderVisible && !this.isEditingMermaid) {
      this.diagramDirty = true
      return
    }
    this.diagramAbort?.abort()
    const controller = new AbortController()
    this.diagramAbort = controller
    const generation = ++this.renderGeneration
    this.renderButton.disabled = true
    if (!this.diagram.querySelector('svg')) this.diagram.textContent = '图表加载中…'
    try {
      const { renderDiagram } = await import('./renderers')
      await renderDiagram(
        this.diagram,
        this.node.textContent,
        () =>
          !this.dead &&
          !controller.signal.aborted &&
          generation === this.renderGeneration &&
          this.isMermaid &&
          (this.renderVisible || this.isEditingMermaid),
        controller.signal
      )
      if (
        !this.dead &&
        !controller.signal.aborted &&
        generation === this.renderGeneration &&
        (this.renderVisible || this.isEditingMermaid) &&
        !!this.diagram.querySelector('svg')
      ) {
        this.diagramDirty = false
      }
    } catch (error) {
      if (!this.dead && !controller.signal.aborted && generation === this.renderGeneration) {
        this.diagram.textContent = `图表无法渲染：${String(error)}`
        this.diagramDirty = false
      }
    } finally {
      if (this.diagramAbort === controller) this.diagramAbort = null
      if (!this.dead && generation === this.renderGeneration) {
        this.renderButton.disabled = false
        this.cmInstance?.requestMeasure()
      }
    }
  }

  setSearchHighlights(ranges: CodeSearchRange[]) {
    const nextKey = JSON.stringify(ranges)
    if (nextKey === this.highlightKey && (!this.cmInstance || this.highlightDoc === this.cmInstance.state.doc)) {
      return
    }
    this.pendingHighlights = ranges
    this.highlightKey = nextKey
    if (this.highlightScheduled) return
    this.highlightScheduled = true
    queueMicrotask(() => {
      this.highlightScheduled = false
      if (this.dead) return
      if (this.cmInstance) {
        this.highlightDoc = this.cmInstance.state.doc
        this.cmInstance.dispatch({ effects: setCodeSearch.of(this.pendingHighlights) })
        this.maybeDetachEditor()
        return
      }
      if (!this.isMermaid) {
        // Update static display search highlights without creating a CMView
        const spans =
          this.cachedSpans &&
          this.cachedSpans.source === this.node.textContent &&
          this.cachedSpans.params === this.node.attrs.params
            ? this.cachedSpans.spans
            : null
        this.renderPlaceholderDOM(spans)
        if (!spans && this.renderVisible && this.displayHighlightDirty) {
          this.scheduleStaticHighlight()
        }
      }
    })
  }

  private setLanguage() {
    if (!this.cmInstance) return
    const generation = ++this.generation
    const { label, language } = parseFenceInfo(this.node.attrs.params)
    this.cmInstance.dispatch({ effects: this.language.reconfigure([]) })
    this.languageStatus.textContent = label && !language && !this.isMermaid ? '未注册语言 · 纯文本' : ''
    this.dom.dataset.languageStatus = language ? 'loading' : 'plain'
    if (!language) return
    void loadLanguage(language.name, 'fence')
      .then(extension => {
        if (!this.dead && generation === this.generation && this.cmInstance) {
          this.cmInstance.dispatch({ effects: this.language.reconfigure(extension) })
          this.dom.dataset.languageStatus = 'ready'
        }
      })
      .catch(() => {
        if (!this.dead && generation === this.generation) {
          this.languageStatus.textContent = '语言加载失败 · 纯文本（重新选择可重试）'
          this.dom.dataset.languageStatus = 'error'
        }
      })
  }

  private escape(direction: number, horizontal = false) {
    if (!this.cmInstance) return false
    const { state } = this.cmInstance
    const sel = state.selection.main
    if (!sel.empty) return false
    if (
      direction < 0
        ? horizontal
          ? sel.head !== 0
          : state.doc.lineAt(sel.head).number !== 1
        : horizontal
          ? sel.head !== state.doc.length
          : state.doc.lineAt(sel.head).number !== state.doc.lines
    ) {
      return false
    }
    const pos = this.getPos()
    if (pos === undefined) return false
    const target = direction < 0 ? pos : pos + this.node.nodeSize
    this.outer.dispatch(
      this.outer.state.tr.setSelection(Selection.near(this.outer.state.doc.resolve(target), direction)).scrollIntoView()
    )
    this.outer.focus()
    this.scheduleDetachCheck()
    return true
  }

  private insertParagraph(direction: number) {
    const pos = this.getPos()
    if (pos === undefined) return false
    const at = direction < 0 ? pos : pos + this.node.nodeSize
    const tr = this.outer.state.tr.insert(at, this.outer.state.schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, at + 1))
    this.outer.dispatch(tr.scrollIntoView())
    this.outer.focus()
    this.scheduleDetachCheck()
    return true
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false
    const changed = node.textContent !== this.node.textContent
    const languageChanged = node.attrs.params !== this.node.attrs.params
    this.node = node
    if (changed) this.updateLayout()
    this.selector.update(node.attrs.params)
    if (languageChanged) this.updateLanguageBadge()
    if (changed || languageChanged) this.cachedSpans = null

    const wasMermaid = this.isMermaid
    this.isMermaid = /^mermaid(?:\s|$)/i.test(node.attrs.params)
    this.diagramToolbar.hidden = !this.isMermaid
    if (wasMermaid !== this.isMermaid) this.setMermaidEditing(false)

    if (this.cmInstance) {
      const current = this.cmInstance.state.doc.toString()
      const next = node.textContent

      if (changed && wasMermaid === this.isMermaid && this.isMermaid) {
        this.renderGeneration++
        this.diagramDirty = true
        if (this.renderTimer) clearTimeout(this.renderTimer)
        this.renderTimer = setTimeout(() => {
          if (!this.dead) void this.renderMermaidDiagram()
        }, 120)
      }

      if (current !== next) {
        let from = 0
        let end = current.length
        let to = next.length
        while (from < end && from < to && current[from] === next[from]) from++
        while (end > from && to > from && current[end - 1] === next[to - 1]) {
          end--
          to--
        }
        this.updating = true
        try {
          this.cmInstance.dispatch({ changes: { from, to: end, insert: next.slice(from, to) } })
        } finally {
          this.updating = false
        }
      }

      if (languageChanged) this.setLanguage()
    } else {
      if (!this.isMermaid && (changed || languageChanged || wasMermaid)) {
        this.placeholderGeneration++
        this.renderPlaceholder(this.renderVisible)
      }
      if (this.isMermaid && changed) {
        this.diagramDirty = true
        if (this.renderVisible) void this.renderMermaidDiagram()
      }
    }
    return true
  }

  setSelection(anchor: number, head: number) {
    const safeAnchor = Math.max(0, Math.min(anchor, this.node.textContent.length))
    const safeHead = Math.max(0, Math.min(head, this.node.textContent.length))
    this.savedSelection = EditorSelection.single(safeAnchor, safeHead)

    if (this.cmContainer.hidden) {
      this.dom.scrollIntoView({ block: 'nearest' })
      return
    }
    // Ignore transient ProseMirror selectionToDOM replay when user is clicking outside all code blocks
    if (pointerClickingOutsideCodeBlock) {
      return
    }
    // Do not allocate a CMView for background state syncs when outer editor is unfocused
    if (!this.outer.hasFocus() && !this.isFocused && !this.cmInstance) {
      return
    }
    const editor = this.ensureEditor()
    this.updating = true
    try {
      editor.dispatch({ selection: { anchor: safeAnchor, head: safeHead } })
      editor.focus()
    } finally {
      this.updating = false
    }
  }

  revealSearchMatch(from: number, to: number, focus: boolean) {
    this.savedSelection = EditorSelection.single(
      Math.max(0, Math.min(from, this.node.textContent.length)),
      Math.max(0, Math.min(to, this.node.textContent.length))
    )
    if (this.isMermaid && !this.isEditingMermaid) {
      this.setMermaidEditing(true, focus)
    }
    if (focus || this.cmInstance) {
      const editor = this.ensureEditor()
      if (focus) this.setSelection(from, to)
      editor.dispatch({ effects: CMView.scrollIntoView(from, { y: 'nearest' }) })
      this.dom.scrollIntoView({ block: 'nearest' })
      return
    }
    // Display-mode search navigation: scroll directly to the static search marker without allocating CMView
    this.dom.scrollIntoView({ block: 'nearest' })
    queueMicrotask(() => {
      if (this.dead || this.cmInstance) return
      const currentMarker = this.placeholder?.querySelector<HTMLElement>('.md-search-match-current')
      currentMarker?.scrollIntoView({ block: 'nearest' })
    })
  }

  typography(settings: MarkdownTypography) {
    this.settings = settings
    this.updateLayout()
    if (this.cmInstance) {
      this.cmInstance.dispatch({
        effects: [
          this.numbers.reconfigure(settings.codeLineNumbers ? lineNumbers() : []),
          this.wrap.reconfigure(settings.codeWrap ? CMView.lineWrapping : []),
        ],
      })
    }
    if (this.placeholder) {
      this.renderPlaceholder(this.renderVisible)
    }
  }

  indent(size: number, tabs: boolean) {
    this.indentSize = size
    this.useTabs = tabs
    this.dom.style.tabSize = String(size)
    this.cmInstance?.dispatch({
      effects: this.indentation.reconfigure([CMState.tabSize.of(size), indentUnit.of(tabs ? '\t' : ' '.repeat(size))]),
    })
  }

  bracketMode(mode: BracketMode) {
    this.bracketMod = mode
    if (this.cmInstance) {
      this.cmInstance.dispatch({ effects: this.brackets.reconfigure(bracketHighlight(mode)) })
    }
  }

  caretAnimation(mode: CaretAnimation) {
    this.caretAnim = mode
    if (this.cmInstance) {
      this.cmInstance.dispatch({ effects: this.caret.reconfigure([smoothCaret(mode), mode === 'off' ? [] : drawSelection()]) })
    }
  }

  stopEvent() {
    return true
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    if (this.detachCheckTimer) clearTimeout(this.detachCheckTimer)
    if (this.copyTimer) clearTimeout(this.copyTimer)
    this.dead = true
    this.stopVisibility()
    this.highlightAbort?.abort()
    this.highlightAbort = null
    this.diagramAbort?.abort()
    this.diagramAbort = null
    offscreenHighlightedViews.delete(this)
    window.removeEventListener('pointerup', this.releasePointer)
    window.removeEventListener('pointercancel', this.releasePointer)
    window.removeEventListener('pointermove', this.dragPlaceholder)
    this.themeObserver?.disconnect()
    this.themeObserver = undefined
    this.generation++
    this.placeholderGeneration++
    this.cmInstance?.destroy()
    this.cmInstance = null
    this.cachedSpans = null
    this.selector.destroy()
  }
}
