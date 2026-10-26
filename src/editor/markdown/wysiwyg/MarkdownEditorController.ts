import { EditorState, Plugin, TextSelection, Selection, NodeSelection, AllSelection, type Transaction, type Command } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { Slice, type Node } from 'prosemirror-model'
import { baseKeymap, chainCommands, exitCode, lift, liftEmptyBlock, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { inputRules, textblockTypeInputRule, wrappingInputRule, InputRule } from 'prosemirror-inputrules'
import { wrapInList, splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list'
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable, selectedRect } from 'prosemirror-tables'
import { tableEditingWithDragGuard } from './tableTextSelection'
import { TableView } from 'prosemirror-tables'
import { gapCursor } from 'prosemirror-gapcursor'
import { LiveTableToolbar, type TableToolbarCommand } from './LiveTableToolbar'
import { markdownSchema as s } from './MarkdownSchema'
import { MarkdownSourceBridge, textPatch, type SourcePatch } from './MarkdownSourceBridge'
import { mathBlockParts, mapMathSelection, mergeMathComposition, type MathSelection } from './MathSource'
import { markdownTypographyStyle } from '../typography'
import { InlineSourceView, inlineSourceRange } from './InlineSourceView'
import { ModifiedLinkGesture } from './ModifiedLinkGesture'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { CodeBlockView } from './CodeBlockView'
import { CalloutNodeView } from './CalloutNodeView'
import { TocNodeView } from './TocNodeView'
import { FootnoteDefNodeView } from './FootnoteDefNodeView'
import { renderFrontMatterCard } from './FrontMatterCard'
import { LiveImageView } from './LiveImageView'
import { ImagePreview } from './ImagePreview'
import { positionImageOverlay } from './imageOverlay'
import { controlledImageHtml, normalizeImageWidth, normalizeImageAlign } from './imageHtml'
import { markdownImageError } from '../images'
import { FenceAutocomplete } from './FenceAutocomplete'
import { LiveSlashController } from '../slash/LiveSlashController'
import { HtmlBlockView } from './HtmlBlockView'
import { HtmlInlineView } from './HtmlInlineView'
import { HtmlSourceView, isHtmlSourceNode } from './HtmlSourceView'
import { inlineHtmlRanges } from './HtmlSourceRanges'
import { markdownParser, parseMarkdown } from './MarkdownParser'
import { reuseSourceBlocks } from './reuseSourceBlocks'
import { serializeBlock } from './MarkdownSerializer'
import { createAutoLinkPlugin } from './AutoLinkSync'
import { createLiveSearchPlugin } from './plugins/LiveSearch'
import { LiveSearchController } from './LiveSearchController'
import { createNodeTargetPlugin, nodeTargetKey, type NodeTarget } from './plugins/NodeTarget'
import { safeMarkdownURL, openMarkdownLink } from '../links'
import { LiveClipboard, type LiveClipboardOperation } from './LiveClipboard'
import { LiveContextMenu, type LiveMenuEntry, type LiveMenuItem } from './LiveContextMenu'
import { defaultMarkdownClipboard, type MarkdownClipboardSettings } from './contracts'
import { shortcutLabel } from '../../../features/shell/editorSettings'
import { textClipboard } from '../../../features/shell/clipboard'
import { cancelSmoothScroll, smoothScrollTo, isSmoothScrolling } from '../../core/smoothScroll'
import { calculateTypewriterScroll, type CaretCoords } from '../../core/typewriterScroll'
import { EditorView as CMEditorView } from '@codemirror/view'
import { createSmoothCaretPlugin } from './plugins/SmoothCaret'
import { trailingParagraphPlugin, withTrailingParagraph } from './TrailingParagraph'
import type { BracketMode } from '../../core/brackets'
import type { CaretAnimation } from '../../core/caretMotion'
import type { MarkdownFormat } from '../formatCommands'
import type { LiveEditor, LiveOptions, LiveToolbarState, MarkdownToolbarCommand, MarkdownTypography } from './contracts'
import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-tables/style/tables.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './MarkdownTheme.css'

interface LiveUpdate { bridge: MarkdownSourceBridge; transactions: readonly Transaction[] }
let nodeIdentity = 0

function notice(error: unknown) {
  window.dispatchEvent(new CustomEvent('editor-notice', { detail: String(error) }))
}

export class MarkdownEditorController implements LiveEditor {
  readonly view: EditorView
  bridge: MarkdownSourceBridge
  readonly dom = document.createElement('div')
  private outlineHeadingDoc?: Node
  private outlineHeadingPositions: number[] = []
  private tableToolbar: LiveTableToolbar
  private imagePreview: ImagePreview
  private properties = document.createElement('div')
  private propertyObserver?: ResizeObserver
  private repositionProperties = () => {
    if (!this.properties.hidden && this.currentAnchorEl?.isConnected) this.positionAnchoredElement(this.properties, this.currentAnchorEl)
  }
  private searchController: LiveSearchController
  private fenceAutocomplete: FenceAutocomplete
  private slashController: LiveSlashController
  private codeViews = new Set<CodeBlockView>()
  private indentSize: number
  private useTabs: boolean
  private liveImages = new Set<LiveImageView>()
  private htmlViews = new Set<HtmlSourceView>()
  private extensionViews = new Set<() => void>()
  private compositionActive = false
  private onCompositionStart = () => {
    this.compositionActive = true
    cancelSmoothScroll(this.dom)
    this.fenceAutocomplete?.hide()
    this.slashController?.close()
    queueMicrotask(() => { if (!this.disposed) this.options.compositionChanged?.() })
  }
  private settings: MarkdownTypography
  private caretMode: CaretAnimation
  private brackets: BracketMode
  private disposed = false
  private typewriterEnabled = false
  private typewriterFollowing = true
  private typewriterKeyboardAlign = false
  private typewriterAlignScheduled = false
  private typewriterAlignFrame = 0
  private typewriterResizeObserver?: ResizeObserver
  private typewriterCleanup?: () => void
  // A newly focused surface invalidates deferred focus restoration by the old one.
  private focusEpoch = 0
  private onFocusOwnerChanged = () => { this.focusEpoch++ }
  private copySettings = defaultMarkdownClipboard()
  private liveClipboard!: LiveClipboard
  private contextMenu = new LiveContextMenu(notice, () => this.view.focus())
  private pendingSource: string | null = null
  private wasReadOnly = false
  private currentAnchorEl: HTMLElement | null = null
  private propertyTargetToken: object | null = null
  private inlineSource: InlineSourceView | null = null
  private pendingInline: { pos:number; kind:string } | null = null
  private dismissedInline: { from:number; to:number } | null = null
  private linkGesture?: ModifiedLinkGesture
  private inlineEntryEpoch = 0
  private onCanvasPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || this.options.readOnly?.() || this.composing) return
    const target = event.target
    const last = this.view.state.doc.lastChild
    if (last?.type !== s.nodes.paragraph || last.content.size) return
    const node = this.view.nodeDOM(this.view.state.doc.content.size - last.nodeSize)
    if (!(node instanceof HTMLElement)) return
    const inside = target instanceof Element && node.contains(target)
    const canvas = target === this.dom || target === this.view.dom || target === this.view.dom.parentElement
    if (!inside && (!canvas || event.clientY < node.getBoundingClientRect().top)) return
    // Synchronize before the next key event: the browser's selectionchange
    // observer can otherwise leave Enter targeting the previous code block.
    event.preventDefault()
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, this.view.state.doc.content.size - 1)))
    this.view.focus()
  }

  private onCompositionEnd = () => {
    this.compositionActive = false
    this.typewriterFollowing = true
    this.typewriterKeyboardAlign = true
    this.scheduleTypewriterAlign()
    setTimeout(() => {
      if (!this.disposed) this.options.compositionChanged?.()
      if (!this.disposed && this.pendingSource !== null) {
        const source = this.pendingSource
        this.pendingSource = null
        this.sync(source)
      }
      if (!this.disposed) this.slashController?.update()
    }, 0)
  }

  constructor(parent: HTMLElement, private options: LiveOptions, sharedBridge?: MarkdownSourceBridge) {
    this.settings = options.typography
    this.indentSize = options.indentSize ?? 2
    this.useTabs = options.useTabs ?? false
    this.caretMode = options.caretAnimation ?? 'smooth'
    this.brackets = options.bracketMode ?? 'matching'
    this.copySettings = { ...defaultMarkdownClipboard(), ...options.clipboard }
    // Panes must start from the same immutable PM document and source IDs.
    // Independent parses look equal on screen but force full-document syncs,
    // which destroy mapped property targets and selection/search continuity.
    this.bridge = sharedBridge?.source === options.source
      ? Object.assign(new MarkdownSourceBridge(''), sharedBridge)
      : new MarkdownSourceBridge(options.source)
    this.wasReadOnly = options.readOnly?.() ?? false

    this.typewriterEnabled = options.typewriterMode ?? false
    this.dom.className = 'markdown-live' + (this.typewriterEnabled ? ' typewriter-mode' : '')
    this.dom.setAttribute('aria-label', 'Markdown 所见即所得编辑器')

    // Table Toolbar (always anchored directly above table)
    this.tableToolbar = new LiveTableToolbar(this.dom, {
      selectTable: (position, toolbar) => this.focusToolbarTable(position, toolbar),
      run: command => {
        const commands: Record<TableToolbarCommand, Command> = { addRowBefore, addRowAfter, deleteRow, addColumnBefore, addColumnAfter, deleteColumn, deleteTable }
        this.run(commands[command], true)
      },
      align: value => { this.run(this.align(value), true) },
    })

    // Floating Property Popover (anchored to link/image/math)
    this.properties.className = 'md-properties md-anchored-popover'
    this.properties.hidden = true
    this.properties.onkeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        this.properties.hidden = true; this.currentAnchorEl = null; this.view.focus()
      }
    }

    const mount = document.createElement('div')
    mount.className = 'md-document'

    this.dom.append(this.properties, mount)
    parent.append(this.dom)
    this.imagePreview = new ImagePreview(this.dom)
    this.fenceAutocomplete = new FenceAutocomplete(this.dom)
    this.slashController = new LiveSlashController(this, this.dom)

    // Input Rules
    const rules = inputRules({
      rules: [
        new InputRule(/!\[[^\n]*\]\([^\n]*\)$/, (state, match, start, end) => {
          const parsed = markdownParser.parse(match[0], this.bridge.environment).firstChild
          if (parsed?.childCount !== 1 || parsed.firstChild?.type !== s.nodes.image) return null
          return state.tr.replaceWith(start, end, parsed.firstChild).setMeta('isolated', true)
        }),
        textblockTypeInputRule(/^(#{1,6})\s$/, s.nodes.heading, match => ({ level: match[1].length })),
        textblockTypeInputRule(/^```([^`\s]*)\s$/, s.nodes.code_block, match => ({ params: match[1] })),
        wrappingInputRule(/^\s*>\s$/, s.nodes.blockquote),
        wrappingInputRule(/^\s*([-+*])\s$/, s.nodes.bullet_list),
        wrappingInputRule(/^(\d+)\.\s$/, s.nodes.ordered_list, match => ({ order: +match[1] })),
        new InputRule(/^\[([ xX])\] $/, (state, match, start, end) => {
          const $from = state.doc.resolve(start)
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type === s.nodes.list_item) {
              return state.tr
                .delete(start, end)
                .setNodeMarkup($from.before(depth), undefined, {
                  ...$from.node(depth).attrs,
                  checked: match[1] !== ' ',
                })
            }
          }
          return null
        }),
      ],
    })

    // Create ProseMirror EditorView
    this.view = new EditorView(mount, {
      state: EditorState.create({
        schema: s,
        doc: withTrailingParagraph(this.bridge.doc),
        plugins: [
          createSmoothCaretPlugin(this.dom, () => this.caretMode),
          trailingParagraphPlugin(),
          new Plugin({
            appendTransaction: (_transactions, _before, state) => {
              const seen = new Set<string>()
              const tr = state.tr
              state.doc.forEach((node, pos) => {
                const id = node.attrs.sourceId as string
                if (!id || seen.has(id)) {
                  tr.setNodeMarkup(pos, undefined, { ...node.attrs, sourceId: `live-${++nodeIdentity}` })
                } else {
                  seen.add(id)
                }
              })
              return tr.steps.length ? tr : null
            },
          }),
          rules,
          createLiveSearchPlugin(),
          createNodeTargetPlugin(),
          createAutoLinkPlugin(() => this.composing),
          new Plugin({ props: { decorations: state => {
            const decorations = this.inlineSource?.decorations(state.doc).find() || []
            const { $from } = state.selection
            const tablePositions = new Set<number>()
            state.doc.descendants((node, pos) => {
              if (node.type === s.nodes.table) {
                tablePositions.add(pos)
                decorations.push(Decoration.widget(pos, this.tableToolbar.forTable(pos), {
                  key: `table-tools-${pos}`,
                  side: -1,
                  stopEvent: () => true,
                  ignoreSelection: true
                }))
                return false
              }
            })
            this.tableToolbar.retain(tablePositions)
            if ($from.parent.type === s.nodes.heading) {
              const pos = $from.before()
              decorations.push(Decoration.node(pos, pos + $from.parent.nodeSize, { class: 'md-heading-focused', 'data-heading-level': `h${$from.parent.attrs.level}` }))
            }
            return DecorationSet.create(state.doc, decorations)
          } } }),
          new Plugin({
            props: {
              handleKeyDown: (_view, event) => {
                if (this.shortcut(event)) return true
                if (this.slashController?.handleKeyDown(event)) {
                  return true
                }
                if (this.fenceAutocomplete?.handleKeyDown(event)) {
                  return true
                }
                return false
              },
            },
          }),
          keymap({
            'Mod-z': () => { options.history(false); return true },
            'Mod-y': () => { options.history(true); return true },
            'Mod-Shift-z': () => { options.history(true); return true },
            'Mod-f': () => { this.find(false); return true },
            'Mod-r': () => { this.find(true); return true },
            'F3': () => { this.findNext(); return true },
            'Shift-F3': () => { this.findPrevious(); return true },
            'Mod-b': toggleMark(s.marks.strong),
            'Mod-i': toggleMark(s.marks.em),
            'Mod-Shift-x': toggleMark(s.marks.strike),
            'Mod-`': toggleMark(s.marks.code),
            'Backspace': (state, dispatch) => {
              const {empty,$from}=state.selection
              if (empty && $from.parent.type === s.nodes.paragraph && $from.parent.content.size === 0) {
                if ($from.pos === 1 && state.doc.childCount > 1) {
                  const tr = state.tr.delete($from.before(), $from.after())
                  const sel = Selection.near(tr.doc.resolve(1))
                  tr.setSelection(sel)
                  dispatch?.(tr.setMeta('isolated', true).scrollIntoView())
                  return true
                }
              }
              if(empty&&$from.parentOffset===0&&$from.depth>0){
                const before=$from.before(),previous=state.doc.resolve(before).nodeBefore
                const html=previous&&[...this.htmlViews].find(html=>html.getPos()===before-previous.nodeSize)
                if(html){html.startEditing();return true}
              }
              if(!empty || $from.parent.type!==s.nodes.heading || $from.parentOffset!==0)return false
              dispatch?.(state.tr.setNodeMarkup($from.before(),s.nodes.paragraph,{sourceId:$from.parent.attrs.sourceId}).setMeta('isolated',true).scrollIntoView())
              return true
            },
            'Delete': (state, dispatch) => {
              const {empty,$from}=state.selection
              if (empty && $from.parent.type === s.nodes.paragraph && $from.parent.content.size === 0) {
                if ($from.after() === state.doc.content.size && state.doc.childCount > 1) {
                  const tr = state.tr.delete($from.before(), $from.after())
                  const sel = Selection.near(tr.doc.resolve(tr.doc.content.size), -1)
                  tr.setSelection(sel)
                  dispatch?.(tr.setMeta('isolated', true).scrollIntoView())
                  return true
                }
              }
              return false
            },
            'Enter': chainCommands(this.enterHtml,this.enterFence,splitListItem(s.nodes.list_item, { checked: null }), liftEmptyBlock, baseKeymap.Enter),
            'F2': this.enterHtml,
            'Tab': chainCommands(this.nextCell(1), sinkListItem(s.nodes.list_item)),
            'Shift-Tab': chainCommands(this.nextCell(-1), liftListItem(s.nodes.list_item)),
            'Shift-Enter': (state, dispatch) => {
              dispatch?.(state.tr.replaceSelectionWith(s.nodes.hard_break.create()).scrollIntoView())
              return true
            },
            'Mod-Enter': exitCode,
            'Escape': () => {
              const openMenu = this.dom.querySelector<HTMLElement>('.md-table-menu:not([hidden])')
              if (openMenu) {
                openMenu.hidden = true
                this.dom.querySelectorAll('.md-table-tools [aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'))
                return true
              }
              if (!this.properties.hidden) {
                this.properties.hidden = true
                return true
              }
              if (this.searchController.isOpen) {
                this.searchController.close()
                return true
              }
              if (this.view.state.selection instanceof NodeSelection && this.view.state.selection.node.type === s.nodes.image) {
                const { to } = this.view.state.selection
                this.view.dispatch(this.view.state.tr.setSelection(Selection.near(this.view.state.doc.resolve(to), 1)))
                return true
              }
              return false
            },
            ...Object.fromEntries(
              [1, 2, 3, 4, 5, 6].map(level => [`Mod-Alt-${level}`, setBlockType(s.nodes.heading, { level })])
            ),
          }),
          keymap(baseKeymap),
          gapCursor(),
          new Plugin({
            props: {
              handleTextInput: (view,from,to,text) => {
                if(view.composing||this.compositionActive||!text.includes('>'))return false
                const $from=view.state.doc.resolve(from)
                if(!$from.parent.isTextblock||$from.parent.type===s.nodes.code_block)return false
                const tr=view.state.tr.insertText(text,from,to),$at=tr.doc.resolve(from+text.length)
                const raw=serializeBlock($at.parent)
                if(!/<\/[a-z][\w-]*\s*>$/i.test(raw)&&!/<(?:img|br|hr)\b[^>]*>$/i.test(raw))return false
                if(!raw.includes('<')||/^\s*</.test(raw)&&/^\s*<(?:h[1-6]|div|table|details|svg|p)(?:\s|>)/i.test(raw))return false
                const parsed=markdownParser.parse(raw,this.bridge.environment).firstChild
                if(!parsed?.isTextblock||!parsed.content.content.some(node=>node.type===s.nodes.html_inline))return false
                // Only this changed textblock is reparsed; canonical source is
                // validated by the bridge before the derived node is accepted.
                tr.replaceWith($at.start(),$at.end(),parsed.content)
                view.dispatch(tr);return true
              },
              handleDOMEvents: {
                focus: () => { options.focus(); return false },
                mousedown: (_view, event) => {
                  if (event.button !== 2 || !(event.target as Element).closest('a[data-href]')) return false
                  // The contextmenu handler positions its own selection. A
                  // preliminary PM mousedown must not turn the link into source.
                  event.preventDefault()
                  return true
                },
                copy: (_view, event) => this.liveClipboard.event(event, false),
                cut: (_view, event) => this.liveClipboard.event(event, true),
                beforeinput: (_view, event) => {
                  const e = event as InputEvent
                  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
                    e.preventDefault()
                    options.history(e.inputType === 'historyRedo')
                    return true
                  }
                  return false
                },
                contextmenu: (view, event) => {
                  if ((event.target as Element).closest('input,textarea,.cm-editor')) return false
                  const keyboard = event.clientX === 0 && event.clientY === 0
                  const pos = keyboard ? null : view.posAtCoords({ left: event.clientX, top: event.clientY })
                  if (pos && (pos.pos < view.state.selection.from || pos.pos > view.state.selection.to)) {
                    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos.pos))))
                  }
                  event.preventDefault()
                  this.properties.hidden = true
                  this.fenceAutocomplete.hide()
                  this.slashController?.close()
                  const caret = keyboard ? view.coordsAtPos(view.state.selection.from) : null
                  this.contextMenu.open(caret?.left ?? event.clientX, caret?.bottom ?? event.clientY, this.contextEntries(event.target as Element), keyboard)
                  this.inlineEntryEpoch++
                  return true
                },
              },
              handleClick: (view, _pos, event) => {
                const a = (event.target as Element).closest('a')
                if (!a) {
                  // Click outside popover closes it
                  if (!this.properties.hidden && !(event.target as Element).closest('.md-properties')) {
                    this.properties.hidden = true
                  }
                  this.slashController?.close()
                  return this.activateMark(view,event)
                }
                return this.activateLink(view,event)
              },
              handleDoubleClick: (view,_pos,event) => this.activateLink(view,event) || this.activateMark(view,event),
              handleTripleClick: (view,_pos,event) => this.activateLink(view,event) || this.activateMark(view,event),
              transformPastedHTML: html => {
                const doc = new DOMParser().parseFromString(html, 'text/html')
                doc.querySelectorAll('script,style,iframe,object,embed,svg,math').forEach(el => el.remove())
                for (const el of doc.body.querySelectorAll('*')) {
                  for (const attr of [...el.attributes]) {
                    if (
                      attr.name.startsWith('on') ||
                      ['style', 'src', 'srcset'].includes(attr.name) ||
                      (attr.name === 'href' && !safeMarkdownURL(attr.value) && !attr.value.startsWith('#'))
                    ) {
                      el.removeAttribute(attr.name)
                    }
                  }
                }
                return doc.body.innerHTML
              },
            },
          }),
          tableEditingWithDragGuard(),
        ],
      }),
      nodeViews: {
        table: node => new TableView(node, 60),
        callout: (node, view, getPos) => new CalloutNodeView(node, view, getPos, () => !!this.options.readOnly?.()),
        toc: (node, view, getPos) => {
          const tocView = new TocNodeView(node, view, getPos, () => !!this.options.readOnly?.())
          const refresh = () => tocView.refreshHeadings()
          this.extensionViews.add(refresh)
          const origDestroy = tocView.destroy.bind(tocView)
          tocView.destroy = () => {
            this.extensionViews.delete(refresh)
            origDestroy()
          }
          return tocView
        },
        footnote_definition: (node, view, getPos) => new FootnoteDefNodeView(node, view, getPos, () => !!this.options.readOnly?.()),
        code_block: (node, view, getPos) => {
          const code = new CodeBlockView(
            node,
            view,
            getPos,
            this.settings,
            options.history,
            replace => this.find(replace),
            forward => forward ? this.findNext() : this.findPrevious(),
            this.caretMode,
            this.brackets
          )
          code.indent(this.indentSize, this.useTabs)
          this.codeViews.add(code)
          const destroy = code.destroy.bind(code)
          code.destroy = () => {
            this.codeViews.delete(code)
            destroy()
          }
          return code
        },
        html_block: (node, view, getPos) => this.htmlView(node,view,getPos),
        html_inline: (node, view, getPos) => this.htmlView(node,view,getPos,true),
        protected_source: (node, view, getPos) => {
          const source = String(node.attrs.source || '').trim()
          if (/^\$\$[\s\S]*\$\$$/.test(source)) {
            return this.mathView(node, view, getPos, true)
          }
          if (isHtmlSourceNode(node)) {
            return this.htmlView(node,view,getPos)
          }
          return this.protectedView(node, view, getPos)
        },
        image: (node, view, getPos) => {
          const imgView = new LiveImageView(
            node,
            view,
            getPos,
            this.options.resources,
            (pos, selectAll) => this.openInlineAt(pos, 'image', selectAll),
            commit => this.pickImageFile(commit),
            (pos, attrs) => this.updateImageAt(pos, attrs),
            pos => inlineSourceRange(this.bridge, view.state.doc, pos, pos + 1, 'image')?.raw ?? '',
          )
          this.liveImages.add(imgView)
          const destroy = imgView.destroy.bind(imgView)
          imgView.destroy = () => {
            this.liveImages.delete(imgView)
            destroy()
          }
          return imgView
        },
        image_source: (node, _view, getPos) => {
          const dom = document.createElement('span')
          dom.className = 'md-image-draft'
          dom.contentEditable = 'false'
          dom.textContent = node.attrs.source
          dom.onclick = () => { const pos = getPos(); if (pos !== undefined) this.openInlineAt(pos, 'image') }
          return { dom, update: next => {
            if (next.type !== s.nodes.image_source) return false
            dom.textContent = next.attrs.source; return true
          }, ignoreMutation: () => true }
        },
        math_inline: (node, view, getPos) => this.mathView(node, view, getPos),
        footnote_reference: (node, view) => {
          const dom = document.createElement('sup')
          dom.className = 'md-footnote'
          dom.contentEditable = 'false'
          dom.textContent = node.attrs.label
          dom.title = '查看脚注定义'
          dom.setAttribute('role', 'button')
          dom.setAttribute('data-footnote-ref', String(node.attrs.label))
          dom.onclick = () => {
            const target = this.footnoteDefinitionPosition(view.state.doc, String(node.attrs.label))
            if (target === null) {
              window.dispatchEvent(new CustomEvent('editor-notice', { detail: `没有找到脚注定义 [^${node.attrs.label}]` }))
              return
            }
            // Navigation only: the document and its undo history stay untouched.
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, target)).scrollIntoView())
            view.focus()
          }
          return { dom, stopEvent: () => true }
        },
        list_item: (node, view, getPos) => this.listView(node, view, getPos),
      },
      attributes: { class: 'md-prose', spellcheck: 'false', 'aria-label': 'Markdown 正文' },
      editable: () => !options.readOnly?.(),
      dispatchTransaction: tr => this.dispatch(tr),
    })

    this.linkGesture = new ModifiedLinkGesture(this.dom, event => {
      const element = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-href]') : null
      if (!element || !this.view.dom.contains(element) || this.disposed || this.composing) return null
      const doc = this.view.state.doc, href = element.getAttribute('data-href') || ''
      return { element, href, valid: () => !this.disposed && !this.composing && this.view.state.doc === doc && element.getAttribute('data-href') === href }
    }, () => { this.inlineEntryEpoch++ }, href => this.openLink(href))

    this.liveClipboard = new LiveClipboard(this.view, () => this.copySettings, () => this.bridge,
      () => !this.options.readOnly?.() && !this.composing, () => !this.disposed)

    // Live Search Controller
    this.searchController = new LiveSearchController(this.view, this.dom, () => this.codeViews)

    // Listeners
    // Trusted native events may run a microtask checkpoint between listeners.
    // Clear the guard before a child editor queues its final composition commit.
    this.dom.addEventListener('compositionend', this.onCompositionEnd, true)
    this.dom.addEventListener('focusin', this.onFocusOwnerChanged, true)
    this.dom.addEventListener('compositionstart', this.onCompositionStart, true)
    this.dom.addEventListener('pointerdown', this.onCanvasPointerDown)
    this.dom.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key.toLowerCase() === 'f') {
          event.preventDefault()
          this.find(false)
        } else if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          this.find(true)
        }
      }
    })
    this.dom.addEventListener('scroll', () => {
      if (this.currentAnchorEl && !this.properties.hidden) {
        this.positionAnchoredElement(this.properties, this.currentAnchorEl)
      }
    })
    this.propertyObserver = new ResizeObserver(this.repositionProperties)
    this.propertyObserver.observe(this.dom); this.propertyObserver.observe(this.properties)
    window.addEventListener('resize', this.repositionProperties)

    if (this.typewriterEnabled) this.installTypewriterListeners(mount)

    this.typography(options.typography)
    this.reveal(options.head)
    this.updateTools()
    if (this.typewriterEnabled) this.scheduleTypewriterAlign()
  }

  private installTypewriterListeners(mount: HTMLElement) {
    if (this.typewriterCleanup) return
    const onTypewriterWheel = () => {
      cancelSmoothScroll(this.dom)
      this.typewriterFollowing = false
      this.typewriterKeyboardAlign = false
    }
    const onTypewriterScroll = () => {
      if (isSmoothScrolling(this.dom)) return
      // ProseMirror may reveal an offscreen caret as part of native input.
      // Keep that scroll from cancelling the alignment requested by the key.
      if (this.typewriterKeyboardAlign) { this.scheduleTypewriterAlign(); return }
      this.typewriterFollowing = false
    }
    const onTypewriterKeydown = (event: KeyboardEvent) => {
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        cancelSmoothScroll(this.dom)
        this.typewriterFollowing = false
        this.typewriterKeyboardAlign = false
        return
      }
      if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        this.typewriterFollowing = true
        this.typewriterKeyboardAlign = true
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        this.typewriterFollowing = true
        this.typewriterKeyboardAlign = true
      }
    }
    const onTypewriterPointerDown = (event: PointerEvent) => {
      if ((event.target instanceof HTMLElement && this.view.dom.contains(event.target)) || (event.target as HTMLElement)?.closest?.('.cm-editor')) {
        this.typewriterFollowing = true
        queueMicrotask(() => this.scheduleTypewriterAlign())
      } else {
        cancelSmoothScroll(this.dom)
        this.typewriterFollowing = false
        this.typewriterKeyboardAlign = false
      }
    }

    this.dom.addEventListener('wheel', onTypewriterWheel, { passive: true })
    this.dom.addEventListener('scroll', onTypewriterScroll, { passive: true })
    this.dom.addEventListener('keydown', onTypewriterKeydown, { capture: true })
    this.dom.addEventListener('pointerdown', onTypewriterPointerDown)

    if (typeof ResizeObserver !== 'undefined') {
      this.typewriterResizeObserver = new ResizeObserver(() => {
        if (!this.disposed && this.typewriterEnabled && this.typewriterFollowing && !this.compositionActive && this.isPaneActive() && this.dom.contains(document.activeElement)) {
          this.scheduleTypewriterAlign()
        }
      })
      this.typewriterResizeObserver.observe(mount)
    }

    this.typewriterCleanup = () => {
      this.dom.removeEventListener('wheel', onTypewriterWheel)
      this.dom.removeEventListener('scroll', onTypewriterScroll)
      this.dom.removeEventListener('keydown', onTypewriterKeydown, true)
      this.dom.removeEventListener('pointerdown', onTypewriterPointerDown)
      this.typewriterResizeObserver?.disconnect()
      this.typewriterResizeObserver = undefined
      this.typewriterCleanup = undefined
    }
  }

  private isPaneActive(): boolean {
    return this.options.isPaneActive ? this.options.isPaneActive() : true
  }

  private getActiveCaretCoords(): CaretCoords | null {
    const activeEl = document.activeElement
    if (activeEl && this.dom.contains(activeEl)) {
      const cmEl = activeEl.closest<HTMLElement>('.cm-editor')
      if (cmEl) {
        const embeddedView = (cmEl as any).cmView?.view || CMEditorView.findFromDOM(cmEl)
        if (embeddedView) {
          try {
            const head = embeddedView.state.selection.main.head
            const c = embeddedView.coordsAtPos(head)
            if (c) return { top: c.top, bottom: c.bottom }
          } catch {}
        }
      }
    }
    try {
      const head = this.view.state.selection.head
      const c = this.view.coordsAtPos(head)
      if (c) return { top: c.top, bottom: c.bottom }
    } catch {}
    return null
  }

  private scheduleTypewriterAlign() {
    if (!this.typewriterEnabled || !this.typewriterFollowing || this.compositionActive || !this.isPaneActive() || this.disposed) return
    if (this.typewriterAlignScheduled) return
    this.typewriterAlignScheduled = true
    this.typewriterAlignFrame = requestAnimationFrame(() => {
      this.typewriterAlignFrame = 0
      this.typewriterAlignScheduled = false
      this.performTypewriterAlign()
    })
  }

  private performTypewriterAlign() {
    if (!this.typewriterEnabled || !this.typewriterFollowing || this.compositionActive || !this.isPaneActive() || this.disposed) return
    const coords = this.getActiveCaretCoords()
    if (!coords) return
    const calc = calculateTypewriterScroll(this.dom, coords)
    this.typewriterKeyboardAlign = false
    if (!calc.needed) return
    smoothScrollTo(
      this.dom,
      () => {
        const currentCoords = this.getActiveCaretCoords()
        if (!currentCoords) return this.dom.scrollTop
        return calculateTypewriterScroll(this.dom, currentCoords).destination
      },
      () => !this.disposed && this.typewriterEnabled && this.typewriterFollowing && !this.compositionActive && this.isPaneActive()
    )
  }

  typewriterMode(enabled: boolean) {
    this.typewriterEnabled = enabled
    this.dom.classList.toggle('typewriter-mode', enabled)
    if (enabled) {
      this.installTypewriterListeners(this.dom.parentElement!)
      this.typewriterFollowing = true
      this.scheduleTypewriterAlign()
    } else {
      cancelSmoothScroll(this.dom)
      cancelAnimationFrame(this.typewriterAlignFrame)
      this.typewriterAlignFrame = 0
      this.typewriterAlignScheduled = false
      this.typewriterKeyboardAlign = false
      this.typewriterCleanup?.()
    }
  }

  private enterFence: Command = (state, dispatch) => {
    const { empty, $from } = state.selection
    if (!empty || $from.parent.type !== s.nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false
    const fence = /^(`{3,}|~{3,})([^`~\s]*)[ \t]*$/.exec($from.parent.textContent)
    if (!fence) return false
    this.fenceAutocomplete?.hide()
    const pos = $from.before()
    const tr = state.tr
      .delete($from.start(), $from.end())
      .setNodeMarkup(pos, s.nodes.code_block, {
        sourceId: $from.parent.attrs.sourceId,
        params: fence[2] || '',
        fence: fence[1] || '```',
      })
    dispatch?.(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).setMeta('isolated', true).scrollIntoView())
    queueMicrotask(() => {
      if (!this.disposed) {
        const code = [...this.codeViews].find(c => c.getPos() === pos)
        if (code) {
          code.ensureEditor().focus()
          code.setSelection(0, 0)
        }
      }
    })
    return true
  }

  private commitFence(language: string, fenceMarks: string) {
    const { state } = this.view
    const { selection } = state
    const { $from } = selection
    if ($from.parent.type !== s.nodes.paragraph) return
    this.fenceAutocomplete?.hide()
    const pos = $from.before()
    const tr = state.tr
      .delete($from.start(), $from.end())
      .setNodeMarkup(pos, s.nodes.code_block, {
        sourceId: $from.parent.attrs.sourceId,
        params: language || '',
        fence: fenceMarks || '```',
      })
      .setSelection(TextSelection.create(state.doc, pos + 1))
      .setMeta('isolated', true)
      .scrollIntoView()

    this.view.dispatch(tr)
    queueMicrotask(() => {
      if (!this.disposed) {
        const code = [...this.codeViews].find(c => c.getPos() === pos)
        if (code) {
          code.ensureEditor().focus()
          code.setSelection(0, 0)
        }
      }
    })
  }

  private tabCompleteFence(language: string, fenceMarks: string) {
    const { state } = this.view
    const { selection } = state
    const { $from } = selection
    if ($from.parent.type !== s.nodes.paragraph) return
    const newText = fenceMarks + language
    const tr = state.tr
      .replaceWith($from.start(), $from.end(), state.schema.text(newText))
      .scrollIntoView()
    this.view.dispatch(tr)
  }

  private updateFenceAutocomplete() {
    if (this.disposed || !this.fenceAutocomplete || this.compositionActive || this.view.composing) {
      this.fenceAutocomplete?.hide()
      return
    }

    const { state } = this.view
    const { selection } = state
    if (!selection.empty) {
      this.fenceAutocomplete.hide()
      return
    }

    const { $from } = selection
    if ($from.parent.type !== s.nodes.paragraph || $from.parentOffset !== $from.parent.content.size) {
      this.fenceAutocomplete.hide()
      return
    }

    const text = $from.parent.textContent
    const match = /^(`{3,}|~{3,})([a-zA-Z0-9_+#.-]*)$/.exec(text)
    if (!match) {
      this.fenceAutocomplete.hide()
      return
    }

    const fence = match[1]
    const query = match[2]
    const pos = $from.pos
    try {
      const coords = this.view.coordsAtPos(pos)
      this.fenceAutocomplete.show(coords, query, fence, {
        onCommit: (lang, f) => this.commitFence(lang, f),
        onTabComplete: (lang, f) => this.tabCompleteFence(lang, f),
      })
    } catch {
      this.fenceAutocomplete.hide()
    }
  }

  get composing() {
    return this.compositionActive || this.view.composing || !!this.inlineSource?.composing || !!this.inlineSource?.pending || [...this.codeViews].some(code => code.isComposing) || [...this.htmlViews].some(html=>html.composing)
  }

  get selection() {
    for(const html of this.htmlViews){const selection=html.sourceSelection;if(selection)return selection}
    if(this.inlineSource){const selection=this.inlineSource.selection();if(selection)return {anchor:this.inlineSource.sourceFrom+selection.anchor,head:this.inlineSource.sourceFrom+selection.head}}
    const sel = this.view.state.selection
    return { anchor: this.bridge.sourcePosition(sel.anchor), head: this.bridge.sourcePosition(sel.head) }
  }

  private dispatch(tr: Transaction) {
    if (this.disposed) return
    if (tr.docChanged) cancelSmoothScroll(this.dom)
    try {
      const applied = this.view.state.applyTransaction(tr)
      const before = this.bridge.source
      if (applied.state.doc.eq(this.view.state.doc) && !tr.getMeta('inlineSourcePatch')) {
        this.view.updateState(applied.state)
        this.updateTools()
        const sel = this.selection
        this.options.selected(sel.anchor, sel.head)
        this.scheduleInlineEntry()
        this.updateFenceAutocomplete()
        this.slashController?.update()
        if (tr.selectionSet || tr.docChanged) this.scheduleTypewriterAlign()
        return
      }
      const prepared = this.bridge.prepare(applied.state.doc, tr.getMeta('inlineSourcePatch') as SourcePatch | undefined)
      const previous = { source: this.bridge.source, doc: this.bridge.doc, blocks: this.bridge.blocks, tail:this.bridge.tail, environment:this.bridge.environment }
      prepared.commit()
      let nextState = applied.state
      if (prepared.definitionsChanged) {
        // Definitions affect preceding and following links. Reparse semantics
        // against a fresh environment, but publish only the one source patch.
        const fresh = parseMarkdown(prepared.source)
        const byFrom = new Map(fresh.blocks.map(block => [block.from, block]))
        // Keep the source-editing atom alive while its definition is temporarily
        // incomplete (Ctrl+A, typing a new URL). Reparse referring blocks only.
        this.bridge.blocks = this.bridge.blocks.map(block => {
          const parsed = byFrom.get(block.from)
          if (block.node.attrs.kind === 'reference' || !parsed || parsed.raw !== block.raw) return block
          const node = parsed.node.type.create({ ...parsed.node.attrs, sourceId: block.id }, parsed.node.content, parsed.node.marks)
          return { ...block, node }
        })
        this.bridge.environment = fresh.environment
        this.bridge.doc = s.nodes.doc.create(null, this.bridge.blocks.length ? this.bridge.blocks.map(block => block.node) : s.nodes.paragraph.create())
        const doc = withTrailingParagraph(this.bridge.doc)
        const start = nextState.doc.content.findDiffStart(doc.content), end = nextState.doc.content.findDiffEnd(doc.content)
        if (start !== null && end) {
          const overlap = Math.max(0, start - Math.min(end.a, end.b))
          nextState = nextState.apply(nextState.tr.replace(start, end.a + overlap, doc.slice(start, end.b + overlap)))
        }
      }
      const update: LiveUpdate = { bridge: this.bridge, transactions: prepared.definitionsChanged ? [] : applied.transactions }
      if (prepared.patch && !this.options.publish(before, prepared.patch, update, !!tr.getMeta('isolated'))) {
        Object.assign(this.bridge, previous)
        this.view.updateState(this.view.state)
        notice('文档版本已变化或为只读；已拒绝 Markdown 修改。')
        return
      }
      for (const transaction of applied.transactions) this.inlineSource?.map(transaction)
      this.inlineSource?.mapSource(prepared.patch, tr.getMeta('inlineSourceEditor') === this.inlineSource)
      this.view.updateState(nextState)
      this.updateTools()
      const sel = this.selection
      this.options.selected(sel.anchor, sel.head)
      this.updateFenceAutocomplete()
      this.slashController?.update()
      this.scheduleTypewriterAlign()
    } catch (error) {
      notice(`Markdown 修改未应用：${String(error)}`)
    }
  }

  sync(source: string, update?: unknown) {
    if (this.disposed || source === this.bridge.source) return
    cancelSmoothScroll(this.dom)
    this.contextMenu.close()
    this.slashController?.close()
    if (this.composing) {
      this.pendingSource = source
      return
    }
    const remote = update as LiveUpdate | undefined
    this.inlineSource?.mapSource(textPatch(this.bridge.source, source))
    if (remote && remote.transactions[0]?.before.eq(this.view.state.doc)) {
      const tr = this.view.state.tr.setMeta('trailingParagraphSync', true)
      for (const transaction of remote.transactions) {
        for (const step of transaction.steps) tr.step(step)
      }
      // Apply the complete change once. Running appendTransaction between
      // remote steps would normalize an intermediate, incomplete document.
      this.inlineSource?.map(tr)
      const state = this.view.state.apply(tr)
      this.bridge = new MarkdownSourceBridge('')
      Object.assign(this.bridge, { source, doc: remote.bridge.doc, blocks: remote.bridge.blocks, tail: remote.bridge.tail, environment:remote.bridge.environment })
      this.view.updateState(state)
    } else {
      const sel = this.selection
      const bridge = new MarkdownSourceBridge(source, this.bridge)
      reuseSourceBlocks(bridge, this.bridge)
      const doc = withTrailingParagraph(bridge.doc)
      const state = this.view.state
      const start = state.doc.content.findDiffStart(doc.content)
      const end = state.doc.content.findDiffEnd(doc.content)
      let tr = state.tr
      if (start !== null && end) {
        const overlap = start - Math.min(end.a, end.b)
        tr = tr.replace(start, end.a + Math.max(0, overlap), doc.slice(start, end.b + Math.max(0, overlap)))
      }
      this.bridge = bridge
      if (!tr.doc.eq(doc)) tr = state.tr.replaceWith(0, state.doc.content.size, doc.content)
      const head = Math.min(tr.doc.content.size, bridge.documentPosition(sel.head))
      tr.setSelection(Selection.near(tr.doc.resolve(head)))
      this.inlineSource?.map(tr)
      this.view.updateState(state.apply(tr))
    }
    this.updateTools()
  }

  focus() {
    this.view.focus()
  }

  /** Reading anchor shared with outline navigation, without changing selection. */
  viewportSourcePosition(): number | null {
    const bounds = this.dom.getBoundingClientRect()
    const content = this.view.dom.getBoundingClientRect()
    if (bounds.height <= 0 || bounds.width <= 0) return null
    // Heading line boxes can begin above their glyphs (especially H4–H6).
    // Hit-testing text alone can select the preceding paragraph at the anchor.
    if (this.outlineHeadingDoc !== this.view.state.doc) {
      this.outlineHeadingDoc = this.view.state.doc
      this.outlineHeadingPositions = []
      this.view.state.doc.descendants((node, position) => {
        if (node.type === s.nodes.heading && this.outlineHeadingPositions.length < 1000) this.outlineHeadingPositions.push(position)
        return !node.isTextblock && this.outlineHeadingPositions.length < 1000
      })
    }
    let low = 0, high = this.outlineHeadingPositions.length - 1, index = -1
    while (low <= high) {
      const middle = (low + high) >>> 1, element = this.view.nodeDOM(this.outlineHeadingPositions[middle])
      if (element instanceof HTMLElement && element.getBoundingClientRect().top <= bounds.top + 24) { index = middle; low = middle + 1 }
      else high = middle - 1
    }
    if (index >= 0) return this.bridge.sourcePosition(this.outlineHeadingPositions[index] + 1)
    const found = this.view.posAtCoords({
      left: Math.max(bounds.left + 1, Math.min(bounds.right - 1, content.left + 8)),
      top: Math.min(bounds.bottom - 1, bounds.top + 24),
    })
    return found ? this.bridge.sourcePosition(found.pos) : null
  }

  reveal(position: number, align: 'nearest' | 'start' = 'nearest') {
    cancelSmoothScroll(this.dom)
    const before = this.dom.scrollTop
    const at = Math.min(this.view.state.doc.content.size, this.bridge.documentPosition(position))
    let tr = this.view.state.tr.setSelection(Selection.near(this.view.state.doc.resolve(at)))
    if (align === 'nearest') tr = tr.scrollIntoView()
    this.view.dispatch(tr)
    if (align === 'start') {
      this.view.focus()
      this.dom.scrollTop = before
      smoothScrollTo(this.dom, () => {
        const found = this.view.domAtPos(this.view.state.selection.from).node
        const element = found instanceof Element ? found : found.parentElement
        const heading = element?.closest('h1,h2,h3,h4,h5,h6')
        const top = heading && this.view.dom.contains(heading)
          ? heading.getBoundingClientRect().top : this.view.coordsAtPos(this.view.state.selection.from).top
        return this.dom.scrollTop + top - this.dom.getBoundingClientRect().top - 24
      }, () => !this.disposed)
    }
  }

  indent(size: number, tabs: boolean) {
    this.indentSize = size
    this.useTabs = tabs
    for (const code of this.codeViews) code.indent(size, tabs)
    for (const html of this.htmlViews) html.indent(size, tabs)
  }

  bracketMode(mode: BracketMode) {
    this.brackets = mode
    for (const code of this.codeViews) code.bracketMode(mode)
    for (const html of this.htmlViews) html.bracketMode(mode)
  }

  caretAnimation(mode: CaretAnimation) {
    this.caretMode = mode
    this.view.updateState(this.view.state)
    for (const code of this.codeViews) code.caretAnimation(mode)
  }

  typography(settings: MarkdownTypography) {
    this.settings = settings
    this.dom.dataset.imageBorder = String(settings.imageBorder !== false)
    const style = this.dom.style
    for (const [property, value] of Object.entries(markdownTypographyStyle(settings))) style.setProperty(property, value)
    for (const code of this.codeViews) code.typography(settings)
  }

  private htmlRange(node:Node,pos:number){
    let base=0
    for(const block of this.bridge.blocks){
      if(pos>=base+block.node.nodeSize){base+=block.node.nodeSize;continue}
      if(node.type!==s.nodes.html_inline)return {from:block.from,to:block.to}
      let ordinal=0,consumed=0,result:{from:number;to:number;htmlOrdinal:number}|null=null
      const syntaxRanges=inlineHtmlRanges(block.raw)
      block.node.descendants((child,offset)=>{
        if(child.type!==s.nodes.html_inline)return
        const range=syntaxRanges.find(range=>range.from>=consumed)
        if(!range)return
        const end=range.from+String(child.attrs.source).length
        if(block.raw.slice(range.from,end)!==child.attrs.source)return
        consumed=end
        if(base+offset+1===pos)result={from:block.from+range.from,to:block.from+end,htmlOrdinal:ordinal}
        ordinal++
      })
      return result
    }
    return null
  }

  /**
   * The one place that maps a footnote label to its definition node.
   *
   * Both directions of footnote navigation go through this map, so a reference
   * can find its definition (and a definition its reference) without ever
   * scanning raw source text or relying on DOM order.
   */
  footnoteDefinitionPosition(doc: Node, label: string): number | null {
    let found: number | null = null
    doc.descendants((node, pos) => {
      if (found !== null) return false
      if (node.type === s.nodes.footnote_definition && String(node.attrs.label) === label) {
        found = pos
        return false
      }
      return true
    })
    return found
  }

  /** Every reference that uses `label`, in document order. */
  footnoteReferencePositions(doc: Node, label: string): number[] {
    const positions: number[] = []
    doc.descendants((node, pos) => {
      if (node.type === s.nodes.footnote_reference && String(node.attrs.label) === label) positions.push(pos)
      return true
    })
    return positions
  }

  private htmlView(node:Node,view:EditorView,getPos:()=>number|undefined,inline=false){
    const html=new (inline?HtmlInlineView:HtmlBlockView)(node,view,getPos,this.options.resources,{
      range:(node,pos)=>this.htmlRange(node,pos),
      publish:(node,pos,raw)=>{
        if(this.disposed||this.options.readOnly?.()||view.state.doc.nodeAt(pos)!==node)return false
        const range=this.htmlRange(node,pos)
        if(!range)return false
        let tr=view.state.tr.setNodeMarkup(pos,undefined,{...node.attrs,source:raw})
        if(inline)tr=tr.setMeta('inlineSourcePatch',{...range,from:range.from,to:range.to,insert:raw})
        view.dispatch(tr)
        const next=view.state.doc.nodeAt(pos)
        return next?.attrs.source===raw&&this.bridge.source.slice(range.from,range.from+raw.length)===raw
      },
      selected:(anchor,head)=>this.options.selected(anchor,head),
      history:forward=>this.options.history(forward),readOnly:()=>!!this.options.readOnly?.(),
      settled:()=>{if(!this.disposed&&this.pendingSource!==null&&!this.composing){const source=this.pendingSource;this.pendingSource=null;this.sync(source)}},
    })
    html.bracketMode(this.brackets)
    html.indent(this.indentSize, this.useTabs)
    this.htmlViews.add(html)
    const destroy=html.destroy.bind(html)
    html.destroy=()=>{this.htmlViews.delete(html);destroy()}
    return html
  }

  private enterHtml:Command=(state,dispatch)=>{
    if(state.selection instanceof NodeSelection){
      const html=[...this.htmlViews].find(html=>html.getPos()===state.selection.from)
      if(html){html.startEditing();return true}
    }
    const {$from,empty}=state.selection
    if(!empty||$from.parent.type!==s.nodes.paragraph||!$from.parent.textContent.trimStart().startsWith('<'))return false
    if(!$from.parent.content.content.every(node=>node.isText&&!node.marks.length))return false
    const raw=$from.parent.textContent,parsed=parseMarkdown(raw).doc
    if(parsed.childCount!==1||parsed.firstChild?.type!==s.nodes.protected_source)return false
    if(parsed.firstChild.attrs.label!=='HTML（安全源码）')return false
    const block=parsed.firstChild.type.create({...parsed.firstChild.attrs,sourceId:$from.parent.attrs.sourceId})
    let tr=state.tr.replaceWith($from.before(),$from.after(),[block,s.nodes.paragraph.create()])
    tr=tr.setSelection(TextSelection.near(tr.doc.resolve($from.before()+block.nodeSize+1)))
    dispatch?.(tr.setMeta('isolated',true).scrollIntoView());return true
  }

  private run(command: Command, isolated = false) {
    const result = command(
      this.view.state,
      tr => this.view.dispatch(isolated ? tr.setMeta('isolated', true) : tr),
      this.view
    )
    this.view.focus()
    return result
  }

  toolbarState(): LiveToolbarState {
    return { ...this.formatState(), readOnly: !!this.options.readOnly?.(), composing: this.composing }
  }

  insertToolbar(command: MarkdownToolbarCommand): boolean {
    if (this.options.readOnly?.() || this.composing) return false
    if (command === 'footnote') { this.insertReference(true); return true }
    if (command === 'link-reference') { this.insertReference(false); return true }
    if (command === 'math') { this.insertBlock('$$\nx^2\n$$'); return true }
    if (command === 'toc') { this.insertBlock('[TOC]'); return true }
    if (command === 'callout') return this.insertCallout('NOTE')
    if (command === 'yaml') {
      if (this.bridge.blocks[0]?.node.attrs.label === 'YAML Front Matter') return false
      this.insertBlock('---\ntitle: ""\n---', 'start')
      return true
    }
    return false
  }

  insertTable(rows: number, columns: number): boolean {
    if (this.options.readOnly?.() || this.composing) return false
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || rows > 8 || columns < 1 || columns > 8) return false
    const cell = (header: boolean) => (header ? s.nodes.table_header : s.nodes.table_cell).createAndFill()!
    const header = s.nodes.table_row.create(null, Array.from({ length: columns }, () => cell(true)))
    const body = Array.from({ length: rows - 1 }, () => s.nodes.table_row.create(null, Array.from({ length: columns }, () => cell(false))))
    const table = s.nodes.table.create(null, [header, ...body])
    this.view.dispatch(this.view.state.tr.replaceSelectionWith(table).setMeta('isolated', true).scrollIntoView())
    return true
  }

  insertCallout(calloutType: 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION' = 'NOTE', title = ''): boolean {
    if (this.options.readOnly?.() || this.composing) return false
    const para = s.nodes.paragraph.create()
    const callout = s.nodes.callout.create({ calloutType, title }, [para])
    const tr = this.view.state.tr.replaceSelectionWith(callout).setMeta('isolated', true).scrollIntoView()
    this.view.dispatch(tr)
    this.focus()
    return true
  }

  format(format: MarkdownFormat): boolean {
    if (this.options.readOnly?.() || this.composing) return false
    const marks = { bold: 'strong', italic: 'em', strike: 'strike', 'inline-code': 'code' } as const
    if (format in marks) return this.run(toggleMark(s.marks[marks[format as keyof typeof marks]]), true)
    if (format === 'heading-0') return this.run(setBlockType(s.nodes.paragraph), true)
    if (format.startsWith('heading-')) return this.run(setBlockType(s.nodes.heading, { level: +format.slice(-1) }), true)
    if (format === 'quote') return this.run(wrapIn(s.nodes.blockquote), true)
    if (format === 'bullet' || format === 'task' || format === 'ordered') {
      const result = this.run(wrapInList(format === 'ordered' ? s.nodes.ordered_list : s.nodes.bullet_list), true)
      if (format === 'task') {
        this.view.state.doc.nodesBetween(this.view.state.selection.from, this.view.state.selection.to, (node, pos) => {
          if (node.type === s.nodes.list_item) {
            this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false }))
          }
        })
      }
      return result
    }
    if (format === 'code-block') return this.run(setBlockType(s.nodes.code_block), true)
    if (format === 'table') {
      const cell = (header: boolean) => (header ? s.nodes.table_header : s.nodes.table_cell).createAndFill()!
      const table = s.nodes.table.create(null, [
        s.nodes.table_row.create(null, [cell(true), cell(true)]),
        s.nodes.table_row.create(null, [cell(false), cell(false)]),
      ])
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(table).setMeta('isolated', true))
      return true
    }
    if (format === 'rule') {
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(s.nodes.horizontal_rule.create()).setMeta('isolated', true))
      return true
    }
    if (format === 'link') {
      const sel = this.view.state.selection
      const mark = s.marks.link.create({ href: 'https://example.com' })
      if (!sel.empty) {
        this.view.dispatch(this.view.state.tr.addMark(sel.from, sel.to, mark).setMeta('isolated', true))
        this.queueInlineEdit(sel.from, 'link')
      } else {
        // With inheritMarks enabled, an empty selection picks up the surrounding
        // mark set and drops the link mark we just created, leaving plain text.
        this.view.dispatch(this.view.state.tr.replaceSelectionWith(s.text('链接', [mark]), false).setMeta('isolated', true))
        this.queueInlineEdit(sel.from, 'link')
      }
      return true
    }
    if (format === 'image') {
      const at = this.view.state.selection.from
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(s.nodes.image.create({ src: '', alt: '' })).setMeta('isolated', true))
      // The toolbar restores editor focus after format(). Open the form after
      // that handoff so the first keystroke belongs to the path input.
      setTimeout(() => {
        if (this.disposed) return
        const pos = this.view.state.doc.nodeAt(at)?.type === s.nodes.image ? at : this.view.state.selection.from - 1
        if (this.view.state.doc.nodeAt(pos)?.type === s.nodes.image) this.openInlineAt(pos, 'image')
      }, 60)
      return true
    }
    return false
  }

  // Live Search actions
  find(replace = false) {
    this.searchController.open(replace)
  }

  findNext() {
    this.searchController.findNext()
  }

  findPrevious() {
    this.searchController.findPrevious()
  }

  closeSearch() {
    this.searchController.close()
  }

  private nextCell(direction: 1 | -1): Command {
    return (state, dispatch, view) => {
      if (!isInTable(state)) return false
      if (goToNextCell(direction)(state, dispatch, view)) return true
      if (direction > 0) {
        return addRowAfter(state, tr => {
          dispatch?.(tr)
          goToNextCell(1)(this.view.state, dispatch, view)
        })
      }
      return false
    }
  }

  private align(value: string): Command {
    return (state, dispatch) => {
      if (!isInTable(state)) return false
      const rect = selectedRect(state)
      const tr = state.tr
      for (let row = 0; row < rect.map.height; row++) {
        const pos = rect.tableStart + rect.map.positionAt(row, rect.left, rect.table)
        tr.setNodeMarkup(pos, undefined, { ...tr.doc.nodeAt(pos)!.attrs, align: value })
      }
      dispatch?.(tr)
      return true
    }
  }

  private positionAnchoredElement(el: HTMLElement, anchor: HTMLElement, placeAbove = false) {
    if (el.classList.contains('md-image-properties')) {
      positionImageOverlay(el, anchor.querySelector('img') ?? anchor, this.dom)
      return
    }
    const containerRect = this.dom.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()

    let top = placeAbove
      ? anchorRect.top - containerRect.top + this.dom.scrollTop - (elRect.height || 36) - 8
      : anchorRect.bottom - containerRect.top + this.dom.scrollTop + 8

    if (top < this.dom.scrollTop + 8) {
      top = anchorRect.bottom - containerRect.top + this.dom.scrollTop + 8
    }

    let left = anchorRect.left - containerRect.left + this.dom.scrollLeft
    const maxLeft = this.dom.clientWidth - (elRect.width || 320) - 16
    left = Math.max(16, Math.min(maxLeft, left))

    el.style.position = 'absolute'
    el.style.top = `${top}px`
    el.style.left = `${left}px`
    el.style.zIndex = '25'
  }

  private focusToolbarTable(position: number | undefined, toolbar: HTMLElement) {
    let currentPos = position
    if (currentPos === undefined && this.view?.dom) {
      const sibling = toolbar.nextElementSibling
      const next = sibling?.tagName === 'TABLE' ? sibling : sibling?.querySelector('table')
      if (next && next.tagName === 'TABLE') {
        try {
          currentPos = this.view.posAtDOM(next, 0) - 1
        } catch { /* ignored */ }
      }
    }
    if (currentPos !== undefined && this.view?.state) {
      const { $from } = this.view.state.selection
      let inCurrentTable = false
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.before(depth) === currentPos) { inCurrentTable = true; break }
      }
      if (!inCurrentTable) {
        const tableNode = this.view.state.doc.nodeAt(currentPos)
        if (tableNode) {
          let firstCellPos: number | undefined
          this.view.state.doc.nodesBetween(currentPos, currentPos + tableNode.nodeSize, (n, p) => {
            if ((n.type.name === 'table_cell' || n.type.name === 'table_header') && firstCellPos === undefined) {
              firstCellPos = p
            }
          })
          if (firstCellPos !== undefined) {
            this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(firstCellPos + 1))))
            this.view.focus()
          }
        }
      }
    }
  }

  private updateTools() {
    this.imagePreview?.refresh()
    for(const image of this.liveImages)image.refreshLayout()
    if (this.propertyTargetToken && nodeTargetKey.getState(this.view.state)?.token !== this.propertyTargetToken) {
      this.properties.hidden = true
      this.propertyTargetToken = null
    }
    if (this.propertyTargetToken && !this.properties.hidden && this.currentAnchorEl?.isConnected) {
      this.positionAnchoredElement(this.properties, this.currentAnchorEl)
    }
    this.searchController?.updateCount()
    const inTable = isInTable(this.view.state)
    const { $from } = this.view.state.selection
    let activeTablePos: number | null = null
    let alignment: string | null = null
    if (inTable) {
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth)
        if (node.type === s.nodes.table) {
          activeTablePos = $from.before(depth)
        }
        if (['table_cell', 'table_header'].includes(node.type.name) && alignment === null) {
          alignment = node.attrs.align || 'left'
        }
      }
    }
    this.tableToolbar.update(inTable ? activeTablePos : null, alignment)
    for (const refresh of this.extensionViews) refresh()
  }

  private closeInline(focus = false, position?: number) {
    const editor = this.inlineSource
    if (!editor) return
    this.dismissedInline = { from: editor.from, to: editor.to }
    this.inlineSource = null
    const hadFocus = focus || document.activeElement === editor.input || editor.dom.contains(document.activeElement) || this.view.hasFocus()
    const epoch = this.focusEpoch
    // Let the current input handler finish before removing its editing DOM.
    queueMicrotask(() => {
      if (this.disposed) { editor.destroy(); return }
      if(this.inlineSource && this.inlineSource!==editor){editor.destroy();return}
      const active = document.activeElement
      const ownsFocus = epoch === this.focusEpoch && (active === document.body || active === this.view.dom || editor.dom.contains(active))
      // A blur may run before PM receives the browser's selectionchange. Keep
      // the new DOM caret instead of restoring the old image/link selection.
      let nextSelection: Selection | undefined
      const native = document.getSelection()
      if (ownsFocus && native?.anchorNode && native.focusNode && this.view.dom.contains(native.anchorNode) && this.view.dom.contains(native.focusNode) && !editor.dom.contains(native.anchorNode)) {
        try {
          nextSelection=TextSelection.create(this.view.state.doc,this.view.posAtDOM(native.anchorNode,native.anchorOffset),this.view.posAtDOM(native.focusNode,native.focusOffset))
        } catch { /* Detached DOM selection: keep PM's current selection. */ }
      }
      editor.destroy()
      if (!this.disposed) {
        if (this.pendingSource !== null) { const source=this.pendingSource; this.pendingSource=null; this.sync(source) }
        if (ownsFocus && hadFocus && !nextSelection) {
          const targetPos = Math.min(position ?? editor.from, this.view.state.doc.content.size)
          nextSelection = Selection.near(this.view.state.doc.resolve(targetPos))
        }
        if(nextSelection && nextSelection.$from.doc===this.view.state.doc)this.view.dispatch(this.view.state.tr.setSelection(nextSelection))
        else this.view.updateState(this.view.state)
        if (ownsFocus && hadFocus) this.view.focus()
      }
    })
  }

  private activateLink(view:EditorView,event:MouseEvent) {
    const a=(event.target as Element).closest('a')
    if(!a)return false
    event.preventDefault()
    // Modified clicks belong exclusively to the capture-phase gesture owner.
    // PM click handlers must never provide a second navigation path.
    if(!event.ctrlKey&&!event.metaKey){
      const start=view.posAtDOM(a,0)
      const at=view.posAtCoords({left:event.clientX,top:event.clientY})?.pos ?? start
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,at)))
      this.properties.hidden = true
      this.openInlineAt(at,'link')
    }
    return true
  }

  private activateMark(view:EditorView,event:MouseEvent) {
    const el=(event.target as Element).closest('strong,em,s,code')
    const kind=el && ({STRONG:'strong',EM:'em',S:'strike',CODE:'code'} as Record<string,string>)[el.tagName]
    const pos=kind ? view.posAtCoords({left:event.clientX,top:event.clientY})?.pos : undefined
    if (!kind || pos === undefined || this.options.readOnly?.()) return false
    event.preventDefault(); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,pos)))
    this.openInlineAt(pos,kind); return true
  }

  private scheduleInlineEntry() {
    const epoch = this.inlineEntryEpoch
    queueMicrotask(() => {
      if (epoch !== this.inlineEntryEpoch || this.linkGesture?.active || this.disposed || this.inlineSource || this.composing || !this.view.hasFocus() || !this.view.state.selection.empty) return
      const pos = this.view.state.selection.from
      if (this.dismissedInline && pos >= this.dismissedInline.from && pos <= this.dismissedInline.to) return
      this.dismissedInline = null
      const marks = this.view.state.storedMarks ?? this.view.state.selection.$from.marks()
      const kind = ['link','code','strong','em','strike'].find(kind => marks.some(mark => mark.type.name === kind))
      if (kind) this.openInlineAt(pos, kind)
    })
  }

  private queueInlineEdit(pos: number, kind: string) {
    this.pendingInline = { pos, kind }
    // The toolbar focuses the editor after running the command; wait for that
    // focus so the inline source editor is not immediately blurred and closed.
    queueMicrotask(() => {
      const pending = this.pendingInline
      if (!pending || this.disposed || !this.view.hasFocus()) return
      this.pendingInline = null
      this.openInlineAt(pending.pos, pending.kind)
    })
  }

  private openInlineAt(pos: number, kind: string, selectAll = false) {
    if (this.linkGesture?.active) return
    this.pendingInline = null
    if (kind === 'image' && this.inlineSource?.kind === kind && this.inlineSource.from === pos) {
      this.inlineSource.focus(undefined, selectAll)
      return
    }
    if (this.options.readOnly?.() || this.composing) return
    if (this.inlineSource) { if (this.inlineSource.pending) return; this.closeInline() }
    const doc = this.view.state.doc, $pos = doc.resolve(pos)
    let from = pos, to = pos + 1
    if (kind !== 'image') {
      const mark = $pos.nodeAfter?.marks.find(mark => mark.type.name === kind) || $pos.marks().find(mark => mark.type.name === kind)
      if (!mark) return
      const start = $pos.start()
      const runs: {from:number;to:number}[] = []
      $pos.parent.forEach((node, offset) => { if (mark.isInSet(node.marks)) runs.push({ from:start+offset, to:start+offset+node.nodeSize }) })
      const at = runs.findIndex(run => pos >= run.from && pos <= run.to)
      if (at < 0) return
      from = runs[at].from; to = runs[at].to
      for (let i=at-1;i>=0 && runs[i].to===from;i--) from=runs[i].from
      for (let i=at+1;i<runs.length && runs[i].from===to;i++) to=runs[i].to
    }
    let range = inlineSourceRange(this.bridge, doc, from, to, kind)
    if (kind === 'image' && doc.nodeAt(from)?.type === s.nodes.image_source) {
      let base = 0
      for (const block of this.bridge.blocks) {
        if (from < base + block.node.nodeSize) {
          const sourceFrom = this.bridge.sourcePosition(from)
          range = { raw: doc.nodeAt(from)!.attrs.source, sourceFrom, sourceTo: sourceFrom + doc.nodeAt(from)!.attrs.source.length, inherited: doc.nodeAt(from)!.marks, blockId: block.id }
          break
        }
        base += block.node.nodeSize
      }
    }
    if (!range) return
    const editor = new InlineSourceView(from,to,range.sourceFrom,range.sourceTo,kind,range.raw,range.inherited,doc.slice(from,to).content,()=>this.bridge.environment,range.blockId,
      (editor, raw, content) => {
        if (this.disposed || this.inlineSource !== editor || this.options.readOnly?.()) return false
        const patch: SourcePatch = { from:editor.sourceFrom, to:editor.sourceTo, insert:raw,blockId:editor.blockId }
        if (kind === 'image' && content.firstChild?.type === s.nodes.image_source) {
          let base = 0
          for (const block of this.bridge.blocks) {
            if (block.id === editor.blockId) { patch.imageDraft = { from: editor.from - base - 1, to: editor.to - base - 1 }; break }
            base += block.node.nodeSize
          }
        }
        this.properties.hidden = true
        const tr = this.view.state.tr.replaceWith(editor.from,editor.to,content)
          .setMeta('inlineSourcePatch',patch).setMeta('inlineSourceEditor',editor)
        const oldTo=editor.to,oldSourceTo=editor.sourceTo
        const oldExpected = this.view.state.doc.slice(editor.from, editor.to).content
        editor.acceptRange(editor.from+content.size,editor.sourceFrom+raw.length,content)
        this.view.dispatch(tr)
        const accepted=this.bridge.source.slice(patch.from,patch.from+raw.length)===raw
        if(!accepted)editor.acceptRange(oldTo,oldSourceTo,oldExpected)
        return accepted
      }, (focus, position) => { if (this.inlineSource === editor) this.closeInline(focus, position) }, forward => {
        const focused = !!editor.selection()
        this.options.history(forward)
        queueMicrotask(() => {
          const active = document.activeElement
          if (!focused || this.disposed || active !== document.body && active !== editor.input && !this.view.dom.contains(active)) return
          if (this.inlineSource) this.inlineSource.input.focus({ preventScroll: true })
          else if (editor.kind === 'image' && ['image', 'image_source'].includes(this.view.state.doc.nodeAt(editor.from)?.type.name ?? '')) this.openInlineAt(editor.from, 'image')
          else this.view.focus()
        })
      }, (command, selection) => {
        if (this.disposed) return
        if (command === 'select-all') { this.view.dispatch(this.view.state.tr.setSelection(new AllSelection(this.view.state.doc))); this.view.focus() }
        else if (command === 'find' || command === 'replace') this.find(command === 'replace')
        else {
          const nearest = (offset: number) => {
            let result=editor.from, distance=Infinity
            for(let pos=editor.from;pos<=editor.to;pos++) {
              const delta=Math.abs(this.bridge.sourcePosition(pos)-editor.sourceFrom-offset)
              if(delta<distance){distance=delta;result=pos}
            }
            return Math.min(result,this.view.state.doc.content.size)
          }
          if(selection)this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc,nearest(selection.anchor),nearest(selection.head))))
          if(command === 'enter') this.run(chainCommands(splitListItem(s.nodes.list_item,{checked:null}),liftEmptyBlock,baseKeymap.Enter),true)
          else if(command === 'hard-break') { this.view.dispatch(this.view.state.tr.replaceSelectionWith(s.nodes.hard_break.create()).setMeta('isolated',true));this.view.focus() }
          else this.format(command)
        }
      })
    this.inlineSource = editor; this.dismissedInline = null
    this.focusEpoch++
    this.view.updateState(this.view.state)
    editor.focus(kind === 'image' ? undefined : Math.max(0, Math.min(range.raw.length, this.bridge.sourcePosition(pos) - range.sourceFrom)), selectAll)
    if (kind === 'image') this.options.selected(range.sourceTo, range.sourceTo)
  }

  private field(label: string, value: string): HTMLInputElement {
    const wrapper = document.createElement('label')
    wrapper.textContent = label
    const input = document.createElement('input')
    input.setAttribute('aria-label', label)
    input.value = value
    wrapper.append(input)
    this.properties.append(wrapper)
    return input
  }

  private propertyButton(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.onclick = action
    this.properties.append(button)
    return button
  }

  private linkProperties(anchorEl: HTMLElement, href: string) {
    this.properties.classList.remove('md-image-properties')
    this.propertyTargetToken = null
    this.properties.replaceChildren()
    this.properties.hidden = false
    this.currentAnchorEl = anchorEl

    const selection = this.view.state.selection
    let from = selection.from
    let to = selection.to
    const $pos = this.view.state.doc.resolve(from)
    const link = s.marks.link.isInSet($pos.marks()) || s.marks.link.isInSet($pos.nodeAfter?.marks || [])
    if (link) {
      const parent = $pos.parent
      const start = $pos.start()
      parent.forEach((node, offset) => {
        if (s.marks.link.isInSet(node.marks)?.eq(link) && start + offset <= from && start + offset + node.nodeSize >= from) {
          from = start + offset
          to = from + node.nodeSize
        }
      })
    }

    const textInput = this.field('链接文字', this.view.state.doc.textBetween(from, to))
    const urlInput = this.field('链接 URL', href)

    const expected = this.view.state.doc.slice(from, to).content
    const current = () => to <= this.view.state.doc.content.size && this.view.state.doc.slice(from, to).content.eq(expected)

    this.propertyButton('应用链接', () => {
      if (!current()) {
        notice('链接内容已变化，请重新选择链接。')
        this.properties.hidden = true
        return
      }
      const mark = s.marks.link.create({ href: urlInput.value })
      const tr = this.view.state.tr
      if (textInput.value) {
        tr.replaceWith(from, to, s.text(textInput.value, [mark]))
      } else {
        tr.addMark(from, to, mark)
      }
      this.view.dispatch(tr.setMeta('isolated', true))
      this.properties.hidden = true
      this.focus()
    })

    this.propertyButton('打开链接', () => this.openLink(urlInput.value))
    this.propertyButton('复制链接', () => {
      void textClipboard.writeText(urlInput.value).then(() => {
        notice('链接已复制到剪贴板')
      })
    })
    this.propertyButton('移除链接', () => {
      if (current()) {
        this.view.dispatch(this.view.state.tr.removeMark(from, to, s.marks.link).setMeta('isolated', true))
      }
      this.properties.hidden = true
      this.focus()
    })

    this.positionAnchoredElement(this.properties, anchorEl)
    urlInput.focus()
  }

  private pickImageFile(commit: (src: string | null) => void) {
    const choose = this.options.resources.chooseLocal
    if (!choose) {
      notice('当前环境请直接填写图片路径。')
      return
    }
    void choose()
      .then(path => { if (!this.disposed) commit(path) })
      .catch(error => { if (!this.disposed) notice(markdownImageError(error).message) })
  }

  /** Sets one image attribute at `pos` as a single undoable edit. */
  private updateImageAt(pos: number, attrs: Record<string, unknown>) {
    if (this.options.readOnly?.() || this.composing) return
    const node = this.view.state.doc.nodeAt(pos)
    if (node?.type !== s.nodes.image) return
    this.closeInline(false)
    const next = { ...node.attrs, ...attrs }
    // Percentage sizing uses HTML, including 100%, while keeping the picture
    // editable through the same complete source surface.
    if (attrs.htmlSource !== null && ('zoom' in attrs || next.htmlSource || next.width || next.align)) {
      next.htmlSource = controlledImageHtml({ src: String(next.src ?? ''), alt: String(next.alt ?? ''), title: next.title ?? null, width: next.width ?? null, align: normalizeImageAlign(next.align), zoom: next.zoom }, true)
    }
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, next)
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)).setMeta('isolated', true))
    queueMicrotask(() => { if (!this.disposed && this.view.state.doc.nodeAt(pos)?.type === s.nodes.image) this.openInlineAt(pos, 'image') })
  }

  private deleteImageAt(pos: number) {
    if (this.options.readOnly?.()) return
    const doc = this.view.state.doc, $pos = doc.resolve(pos), node = doc.nodeAt(pos)
    if (!node || node.type !== s.nodes.image) return
    const standalone = $pos.parent.type.name === 'paragraph' && $pos.parent.childCount === 1
    const tr = standalone && (doc.childCount > 1 || $pos.depth > 1)
      ? this.view.state.tr.delete($pos.before(), $pos.after())
      : this.view.state.tr.delete(pos, pos + node.nodeSize)
    this.view.dispatch(tr.setMeta('isolated', true))
    this.view.focus()
  }

  private previewImageAt(pos: number) {
    const dom = this.view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return
    const image = dom.querySelector('img')
    if (!image?.naturalWidth) { notice('请先填写有效图片路径并等待加载。'); return }
    this.imagePreview.open(image, () => this.view.state.doc.nodeAt(pos) !== undefined, () => this.view.focus())
  }

  private imageProperties(anchorEl: HTMLElement, node: Node, pos: number) {
    if (this.options.readOnly?.()) return
    const token = this.trackPropertyNode(node, pos)
    this.properties.replaceChildren()
    this.properties.hidden = false
    this.properties.classList.add('md-image-properties')
    this.currentAnchorEl = anchorEl

    const srcInput = this.field('图片路径', node.attrs.src)
    const altInput = this.field('图片替代文字', node.attrs.alt || '')
    const titleInput = this.field('图片标题', node.attrs.title || '')
    const widthInput = this.field('图片宽度', node.attrs.width || '')
    widthInput.placeholder = '原始大小 / 50% / 320px'
    const alignment = document.createElement('select')
    alignment.setAttribute('aria-label', '图片对齐')
    for (const [value, label] of [['', '默认'], ['left', '左对齐'], ['center', '居中'], ['right', '右对齐']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; alignment.append(option)
    }
    alignment.value = node.attrs.align || ''
    const alignLabel = document.createElement('label'); alignLabel.textContent = '图片对齐'; alignLabel.append(alignment); this.properties.append(alignLabel)
    const feedback = document.createElement('div'); feedback.className = 'md-image-property-feedback'; feedback.setAttribute('role', 'status'); this.properties.append(feedback)
    this.propertyButton('重新选择本地图片', () => {
      const choose = this.options.resources.chooseLocal
      if (!choose) { feedback.textContent = '当前环境请直接填写图片路径。'; return }
      void choose().then(path => {
        if (this.disposed || this.propertyTargetToken !== token || this.properties.hidden) return
        if (path !== null) srcInput.value = path
      }).catch(error => { if (!this.disposed && this.propertyTargetToken === token) feedback.textContent = markdownImageError(error).message })
    })
    this.propertyButton('放大预览', () => {
      const image = anchorEl.querySelector('img')
      if (image?.naturalWidth) this.imagePreview.open(image, () => !!this.currentPropertyNode(token), () => srcInput.focus({ preventScroll: true }))
      else feedback.textContent = '请先应用有效路径并等待图片加载。'
    })

    this.propertyButton('应用图片', () => {
      const width = normalizeImageWidth(widthInput.value)
      if (widthInput.value.trim() && !width) { feedback.textContent = '宽度请输入数字、px、百分比或 auto。'; widthInput.focus(); return }
      const target = this.currentPropertyNode(token)
      if (target) {
        this.view.dispatch(
          this.view.state.tr
            .setNodeMarkup(target.pos, undefined, {
              ...target.node.attrs,
              src: srcInput.value,
              alt: altInput.value,
              title: titleInput.value || null,
              width,
              align: normalizeImageAlign(alignment.value),
            })
            .setMeta('isolated', true)
        )
      }
      this.properties.hidden = true
      this.currentAnchorEl = null
      this.view.focus()
    })

    this.propertyButton('删除图片', () => {
      const target = this.currentPropertyNode(token)
      this.closeInline(false)
      this.properties.hidden = true
      this.currentAnchorEl = null
      if (target) {
        const doc = this.view.state.doc
        const $pos = doc.resolve(target.pos)
        const parent = $pos.parent
        const isStandalone =
          parent.type === s.nodes.paragraph &&
          parent.childCount === 1 &&
          parent.firstChild === target.node
        const canDeleteParagraph = isStandalone && (doc.childCount > 1 || $pos.depth > 1)

        let tr = this.view.state.tr
        if (canDeleteParagraph) {
          const from = $pos.before()
          const to = $pos.after()
          tr = tr.delete(from, to)
          const targetPos = Math.min(from, tr.doc.content.size)
          tr = tr.setSelection(Selection.near(tr.doc.resolve(targetPos)))
        } else {
          tr = tr.delete(target.pos, target.pos + target.node.nodeSize)
          const targetPos = Math.min(target.pos, tr.doc.content.size)
          tr = tr.setSelection(Selection.near(tr.doc.resolve(targetPos)))
        }
        tr = tr.setMeta('isolated', true)
        this.view.dispatch(tr)
        this.view.focus()
      }
    })

    this.propertyButton('关闭', () => {
      this.properties.hidden = true
      this.currentAnchorEl = null
      this.view.focus()
    })

    this.positionAnchoredElement(this.properties, anchorEl)
    srcInput.focus({ preventScroll: true })
  }

  private trackPropertyNode(node: Node, pos: number) {
    const token = {}
    this.view.dispatch(this.view.state.tr.setMeta(nodeTargetKey, { target: { token, pos, node } }))
    this.propertyTargetToken = token
    return token
  }

  private currentPropertyNode(token: object): NodeTarget | null {
    const target = nodeTargetKey.getState(this.view.state)
    if (this.disposed || this.properties.hidden || this.propertyTargetToken !== token || target?.token !== token || this.view.state.doc.nodeAt(target.pos) !== target.node) {
      notice('目标内容已变化，请重新选择。')
      return null
    }
    return target
  }

  private openLink(href: string) {
    if (href.startsWith('#')) {
      let slug: string
      try {
        slug = decodeURIComponent(href.slice(1))
      } catch {
        return
      }
      let target: number | undefined
      this.view.state.doc.descendants((node, pos) => {
        if (node.type === s.nodes.heading && node.textContent.toLowerCase().replace(/\s+/g, '-') === slug) {
          target = pos + 1
        }
      })
      if (target !== undefined) {
        this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, target)).scrollIntoView())
        this.focus()
      }
      return
    }
    if (safeMarkdownURL(href)) {
      void openMarkdownLink(href)
      return
    }
    const destination = href.split(/[?#]/, 1)[0]
    if (!/^[/\\]|:/.test(destination) && !/[\0\r\n]/.test(href)) {
      this.options.openRelative?.(href)
      return
    }
    notice('链接协议或路径未获允许。')
  }

  private protectedView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
    const reference = node.attrs.kind === 'reference'
    const dom = document.createElement('div')
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    const input = document.createElement('textarea')
    const preview = document.createElement('div')

    details.className = reference ? 'md-protected md-reference-source' : 'md-protected'
    dom.className = reference ? 'md-extension md-reference-definition' : 'md-extension'
    dom.contentEditable = 'false'
    const referenceLabel = String(node.attrs.source).match(/^\s*\[((?:\\.|[^\]])+)\]:/)?.[1].replace(/\s+/g, ' ').slice(0, 60)
    summary.textContent = reference ? `链接引用定义${referenceLabel ? ` [${referenceLabel}]` : ''} · 展开源码` : node.attrs.label
    input.value = node.attrs.source
    input.setAttribute('aria-label', node.attrs.label)
    input.spellcheck = false
    input.readOnly = !!this.options.readOnly?.()
    const sizeSource = () => { input.rows = Math.min(10, Math.max(2, input.value.split('\n').length)) }
    sizeSource()
    details.append(summary)
    if (!reference) details.append(input)
    details.ontoggle = () => { if (details.open && !input.parentElement) { details.append(input); sizeSource() } }
    dom.append(preview, details)

    let previous = ''
    let knownPreview = false
    const finishSource = () => {
      if (!knownPreview) return
      details.hidden = true; details.open = false; preview.hidden = false
    }
    const editSource = () => {
      if (!knownPreview || this.options.readOnly?.()) return
      details.hidden = false; details.open = true; preview.hidden = true; input.focus()
    }
    const refresh = () => {
      const source = String(node.attrs.source)
      const toc = /^\[toc\]$/i.test(source.trim())
      const key = toc ? view.state.doc.textContent : source
      if (key === previous) return
      previous = key
      preview.replaceChildren()
      knownPreview = toc || /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(source) || /^\s*\[\^/.test(source) || /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)/.test(source)
      if (!details.open) details.hidden = knownPreview
      dom.classList.toggle('md-extension-preview',knownPreview)

      if (toc) {
        summary.textContent = '目录源码'
        preview.className = 'md-toc'
        view.state.doc.descendants((heading, pos) => {
          if (heading.type !== s.nodes.heading) return
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = heading.textContent
          button.style.paddingLeft = `${(heading.attrs.level - 1) * 28}px`
          if (heading.attrs.level === 1) button.style.fontWeight = '700'
          button.onclick = () => {
            view.dispatch(this.view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)).scrollIntoView())
            view.focus()
          }
          preview.append(button)
        })
      } else if (/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(source)) {
        summary.textContent = 'Callout 源码'
        preview.className = 'md-callout'
        const lines = source.split('\n')
        const title = document.createElement('strong')
        title.textContent = lines[0].replace(/^>\s*\[!|\]$/g, '')
        const body = document.createElement('p')
        body.textContent = lines
          .slice(1)
          .map(line => line.replace(/^>\s?/, ''))
          .join('\n')
        preview.append(title, body)
      } else if (/^\s*\[\^/.test(source)) {
        summary.textContent = '脚注定义源码'
        preview.className = 'md-footnote-definition'
        preview.textContent = source
      } else if (/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)/.test(source)) {
        summary.textContent = '元数据 (YAML Front Matter)'
        renderFrontMatterCard(
          preview,
          source,
          newYaml => {
            const pos = getPos()
            if (pos !== undefined && !this.options.readOnly?.() && view.state.doc.nodeAt(pos) === node) {
              view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: newYaml }))
            }
          },
          () => editSource(),
          !!this.options.readOnly?.()
        )
      }
    }

    refresh()
    this.extensionViews.add(refresh)

    input.oninput = () => {
      sizeSource()
      const pos = getPos()
      if (pos !== undefined && !this.options.readOnly?.() && view.state.doc.nodeAt(pos) === node) {
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: input.value }))
      }
    }
    preview.onclick = event => { if (!(event.target as Element).closest('button')) editSource() }
    preview.oncontextmenu = event => { if (knownPreview) { event.preventDefault(); editSource() } }
    input.onblur = finishSource
    input.onkeydown = event => {
      if (event.isComposing) return
      if ((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) { event.preventDefault(); this.options.history(event.key.toLowerCase() === 'y' || event.shiftKey) }
      else if(event.key === 'Escape') { event.preventDefault(); finishSource(); view.focus() }
    }

    return {
      dom,
      stopEvent: () => true,
      ignoreMutation: () => true,
      update: next => {
        if (next.type !== node.type) return false
        if ((next.attrs.kind === 'reference') !== reference) return false
        if (/^\$\$[\s\S]*\$\$$/.test(String(next.attrs.source).trim())) return false
        if (isHtmlSourceNode(next)) return false
        node = next
        if (input.value !== next.attrs.source) input.value = next.attrs.source
        input.readOnly = !!this.options.readOnly?.()
        refresh()
        return true
      },
      destroy: () => {
        input.oninput = null
        details.ontoggle = null
        this.extensionViews.delete(refresh)
      },
    }
  }

  private mathView(node: Node, view: EditorView, getPos: () => number | undefined, display = false): NodeView {
    const dom = document.createElement(display ? 'div' : 'span')
    dom.className = display ? 'md-math-output' : 'md-inline-math'
    dom.contentEditable = 'false'
    dom.title = '点击编辑公式'
    const preview = document.createElement(display ? 'div' : 'span')
    const input = document.createElement('textarea')
    input.className = 'md-math-source'
    input.setAttribute('aria-label', '公式源码')
    input.spellcheck = false
    input.rows = display ? 3 : 1
    input.hidden = true
    dom.append(input, preview)
    let generation = 0
    let dead = false
    let isEditing = false
    let selfDispatch = false
    let composing = false
    let endingComposition = false
    let compositionBase = ''
    let settlingComposition = false

    const latex = () => {
      if (!display) return node.attrs.latex || ''
      const src = String(node.attrs.source || '')
      return mathBlockParts(src)?.value ?? src
    }

    const render = () => {
      const request = ++generation
      void import('./renderers').then(renderer => renderer.renderMath(preview, latex(), display, () => !dead && request === generation))
        .catch(error => { if (!dead && request === generation) preview.textContent = `公式无法渲染：${String(error)}` })
    }
    render()

    const finish = () => {
      if (dead) return
      isEditing = false
      input.hidden = true
      dom.classList.remove('md-math-editing')
      dom.title = '点击编辑公式'
    }

    const startEdit = () => {
      const pos = getPos()
      if (dead || this.options.readOnly?.() || pos === undefined || view.state.doc.nodeAt(pos) !== node) return
      this.closeInline()
      this.focusEpoch++
      this.properties.hidden = true
      isEditing = true
      input.value = latex()
      input.hidden = false
      dom.classList.add('md-math-editing')
      dom.removeAttribute('title')
      input.focus()
      const len = input.value.length
      input.setSelectionRange(len, len)
    }

    const selection = (): MathSelection => ({ start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection })
    const restore = (value: string, range: MathSelection) => {
      if (input.value !== value) input.value = value
      input.setSelectionRange(Math.min(range.start, value.length), Math.min(range.end, value.length), range.direction)
    }
    const commit = () => {
      const pos = getPos()
      if (dead || !isEditing || this.options.readOnly?.() || pos === undefined || view.state.doc.nodeAt(pos) !== node || composing || endingComposition || this.compositionActive) return
      const val = input.value
      if (val === latex()) return
      const parts = display ? mathBlockParts(String(node.attrs.source)) : null
      const attrs = display ? { ...node.attrs, source: `${parts!.opening}${val}${parts!.closing}` } : { ...node.attrs, latex: val }
      selfDispatch = true
      try {
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, attrs))
      } finally {
        selfDispatch = false
      }
    }
    input.oninput = event => { if (!(event as InputEvent).isComposing) commit() }
    const onCompositionStart = () => { composing = true; compositionBase = latex() }
    const onCompositionEnd = () => {
      composing = false
      endingComposition = true
      // The root's compositionend must clear its flag first. The final native
      // input may arrive on either side of this microtask; commit is idempotent.
      queueMicrotask(() => {
        if (dead) return
        const draft = input.value, range = selection()
        endingComposition = false
        if (this.pendingSource !== null) {
          const source = this.pendingSource
          this.pendingSource = null
          settlingComposition = true
          try { this.sync(source) } finally { settlingComposition = false }
          if (dead) return
          const merged = mergeMathComposition(compositionBase, draft, latex(), range)
          restore(merged.value, merged.selection)
          if (merged.conflict) notice('公式同时被其他 Pane 修改；已保留本次完成的输入法内容，请核对公式。')
        }
        commit()
        if (!dom.contains(document.activeElement)) finish()
      })
    }
    input.addEventListener('compositionstart', onCompositionStart)
    input.addEventListener('compositionend', onCompositionEnd)
    input.onbeforeinput = event => {
      if (composing || endingComposition || event.isComposing) return
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault()
        if (!this.options.readOnly?.()) this.options.history(event.inputType === 'historyRedo')
      }
    }

    input.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229 || composing || endingComposition || this.compositionActive) return
      if ((event.ctrlKey || event.metaKey) && ['f','r'].includes(event.key.toLowerCase())) {
        event.preventDefault(); finish(); this.find(event.key.toLowerCase() === 'r'); return
      }
      if ((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); if (!this.options.readOnly?.()) this.options.history(event.key.toLowerCase() === 'y' || event.shiftKey); return
      }
      if (event.key === 'Escape' || (event.key === 'Enter' && (!display || event.ctrlKey || event.metaKey))) {
        event.preventDefault(); finish()
        const pos = getPos()
        if (pos !== undefined) { view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos + node.nodeSize)))); view.focus() }
      }
    }

    input.onblur = (event: FocusEvent) => {
      if (composing || endingComposition || this.compositionActive) return
      const related = event.relatedTarget instanceof globalThis.Node ? event.relatedTarget : null
      if (related && dom.contains(related)) return
      queueMicrotask(() => {
        if (!dead && isEditing && !composing && !endingComposition && !dom.contains(document.activeElement)) {
          finish()
        }
      })
    }

    preview.onmousedown = event => {
      if (isEditing) {
        event.preventDefault()
      }
    }

    dom.onclick = () => {
      if (dead || this.options.readOnly?.()) return
      if (input.hidden) {
        startEdit()
      }
    }

    const refreshReadOnly = () => { input.readOnly = this.options.readOnly?.() ?? false }
    refreshReadOnly()
    this.extensionViews.add(refreshReadOnly)

    return {
      dom,
      stopEvent: () => true,
      ignoreMutation: () => true,
      update: next => {
        if (next.type !== node.type) return false
        if (display && !mathBlockParts(String(next.attrs.source))) return false
        const previous = latex()
        node = next
        if (isEditing) {
          if (selfDispatch || composing || endingComposition || settlingComposition) {
            if (latex() !== previous) render()
            return true
          }
          const newLatex = latex()
          if (newLatex !== input.value) {
            restore(newLatex, mapMathSelection(selection(), textPatch(input.value, newLatex)))
            render()
          }
          return true
        }
        if (latex() !== previous) render()
        return true
      },
      destroy: () => {
        if (!this.disposed && isEditing && (composing || settlingComposition) && input.value !== latex()) notice(`正在输入的公式已被删除或替换，未提交的源码：${input.value}`)
        const interrupted = composing
        dead = true
        isEditing = composing = endingComposition = false
        generation++
        dom.onclick = null
        preview.onmousedown = null
        input.oninput = input.onbeforeinput = input.onkeydown = input.onblur = null
        input.removeEventListener('compositionstart', onCompositionStart)
        input.removeEventListener('compositionend', onCompositionEnd)
        this.extensionViews.delete(refreshReadOnly)
        // Removing an IME target need not deliver compositionend. Release only
        // this target's guard, and wait until PM finishes destroying the view.
        if (interrupted && !this.disposed) {
          this.compositionActive = false
          queueMicrotask(() => {
            if (this.disposed || this.composing) return
            this.options.compositionChanged?.()
            if (this.pendingSource !== null) {
              const source = this.pendingSource
              this.pendingSource = null
              this.sync(source)
            }
          })
        }
      },
    }
  }

  private listView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
    const dom = document.createElement('li')
    const contentDOM = document.createElement('div')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.contentEditable = 'false'
    box.setAttribute('aria-label', '任务完成状态')
    box.checked = !!node.attrs.checked
    box.hidden = node.attrs.checked === null
    dom.className = node.attrs.checked === null ? '' : 'md-task'
    dom.append(box, contentDOM)

    box.onchange = () => {
      const pos = getPos()
      if (pos !== undefined) {
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: box.checked }).setMeta('isolated', true))
      }
      box.checked = !!node.attrs.checked
    }

    return {
      dom,
      contentDOM,
      stopEvent: event => event.target === box,
      update: next => {
        if (next.type !== node.type) return false
        node = next
        box.checked = !!node.attrs.checked
        box.hidden = node.attrs.checked === null
        dom.className = node.attrs.checked === null ? '' : 'md-task'
        return true
      },
      destroy: () => {
        box.onchange = null
      },
    }
  }

  refreshResources() {
    for (const img of this.liveImages) img.refreshResource()
    const readOnly = this.options.readOnly?.() ?? false
    if (readOnly !== this.wasReadOnly) {
      this.wasReadOnly = readOnly
      this.view.setProps({ editable: () => !this.options.readOnly?.() })
      for (const code of this.codeViews) code.refreshReadOnly()
      for (const refresh of this.extensionViews) refresh()
    }
  }

  clipboard(operation: LiveClipboardOperation) {
    return this.inlineSource?.selection() ? this.inlineSource.clipboard(operation) : this.liveClipboard.run(operation)
  }
  clipboardSettings(settings: MarkdownClipboardSettings) { this.copySettings = { ...settings } }

  /** Also called by the shell's capture handler before global shortcuts (Mod+0
   * otherwise resets font size). Never handles source editors or search inputs. */
  shortcut(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing || this.composing || !(event.ctrlKey || event.metaKey) || event.altKey) return false
    if (!(event.target instanceof Element) || event.target.closest('input,textarea,.cm-editor,.md-inline-source-input')) return false
    const inMenu = this.contextMenu.owns(event.target)
    if (!inMenu && !this.view.dom.contains(event.target)) return false
    const key = event.key.toLowerCase()
    let action: (() => void) | undefined
    if (event.shiftKey && key === 'c') action = () => { void this.clipboard('markdown').catch(notice) }
    else if (event.shiftKey && key === 'v') action = () => { void this.clipboard('paste-plain').catch(notice) }
    else if (!event.shiftKey && /^[0-6]$/.test(key)) action = () => this.heading(+key)
    else if (!event.shiftKey && key === 't') action = () => { this.format('table') }
    else if (event.shiftKey && key === 'k') action = () => { this.format('code-block') }
    else if (event.shiftKey && key === 'i') action = () => { this.format('image') }
    else if (event.shiftKey && key === 'm') action = () => this.insertBlock('$$\nx^2\n$$')
    else if (inMenu && !event.shiftKey && ['c','x','v','a'].includes(key)) action = () => {
      const operation = {c:'copy',x:'cut',v:'paste',a:'select-all'}[key] as LiveClipboardOperation
      void this.clipboard(operation).catch(notice)
    }
    if (!action) return false
    event.preventDefault(); event.stopPropagation(); this.contextMenu.close(); this.view.focus(); action(); return true
  }

  private heading(level: number) {
    if (this.options.readOnly?.() || this.composing) return
    this.run(level ? setBlockType(s.nodes.heading, { level }) : setBlockType(s.nodes.paragraph), true)
  }

  private insertBlock(markdown: string, where: 'selection' | 'start' | 'end' = 'selection') {
    if (this.options.readOnly?.() || this.composing) return
    const state = this.view.state, content = parseMarkdown(markdown).doc.content
    const tr = where === 'selection' ? state.tr.replaceSelection(new Slice(content, 0, 0)) : state.tr.insert(where === 'start' ? 0 : state.doc.content.size, content)
    this.view.dispatch(tr.setMeta('isolated', true).scrollIntoView())
  }

  private formatState() {
    const { $from, $to } = this.view.state.selection
    const ancestors = Array.from({ length: $from.depth }, (_, index) => $from.node(index + 1))
    const marked = (name: string) => this.view.state.selection.empty
      ? !!s.marks[name].isInSet(this.view.state.storedMarks || $from.marks())
      : this.view.state.doc.rangeHasMark($from.pos, $to.pos, s.marks[name])
    const heading = $from.parent
    const hasYaml = this.bridge.blocks[0]?.node.attrs.label === 'YAML Front Matter'
    return {
      heading: heading.type === s.nodes.heading ? heading.attrs.level as number : 0,
      bold: marked('strong'), italic: marked('em'), strike: marked('strike'), inlineCode: marked('code'), link: marked('link'),
      quote: ancestors.some(node => node.type === s.nodes.blockquote),
      ordered: ancestors.some(node => node.type === s.nodes.ordered_list),
      bullet: ancestors.some(node => node.type === s.nodes.bullet_list) && !ancestors.some(node => node.type === s.nodes.list_item && node.attrs.checked !== null),
      task: ancestors.some(node => node.type === s.nodes.list_item && node.attrs.checked !== null),
      codeBlock: heading.type === s.nodes.code_block,
      inCodeBlock: ancestors.some(node => node.type === s.nodes.code_block),
      hasYaml,
      live: true,
    }
  }

  private contextEntries(target: Element): LiveMenuEntry[] {
    const editable = !this.options.readOnly?.() && !this.composing
    const selected = !this.view.state.selection.empty
    const canCopy = selected || this.copySettings.copyWholeLine
    const label = (key: string, id?:string) => id ? this.options.shortcutLabel?.(id) ?? shortcutLabel(key) : shortcutLabel(key)
    const clip = (name: string, operation: LiveClipboardOperation, icon?: string, key?: string): LiveMenuItem => ({
      label: name, icon, shortcut: key && label(key), disabled: operation === 'paste' || operation === 'paste-plain' ? !editable : !canCopy || operation === 'cut' && !editable,
      run: () => this.clipboard(operation),
    })
    const formats = this.formatState()
    const active: Partial<Record<MarkdownFormat, boolean>> = {
      bold: formats.bold, italic: formats.italic, strike: formats.strike, 'inline-code': formats.inlineCode, link: formats.link,
      quote: formats.quote, ordered: formats.ordered, bullet: formats.bullet, task: formats.task,
    }
    const format = (name: string, command: MarkdownFormat, icon?: string, key?: string): LiveMenuItem => ({ label: name, icon, pressed: icon ? active[command] : undefined, shortcut: key && label(key,command), disabled: !editable, run: () => { this.contextFormat(command, !!active[command]) } })
    const insert = (name: string, source: string, where: 'selection' | 'start' | 'end' = 'selection', key?: string): LiveMenuItem => ({ label: name, shortcut: key && label(key), disabled: !editable, run: () => this.insertBlock(source, where) })
    const level = formats.heading
    const headingNames = ['段落', '一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题']
    const entries: LiveMenuEntry[] = [
      { label: '使用 Google 搜索', disabled: !selected, run: () => {
        const text = this.view.state.doc.textBetween(this.view.state.selection.from, this.view.state.selection.to, ' ').slice(0, 2000)
        return openMarkdownLink(`https://www.google.com/search?q=${encodeURIComponent(text)}`)
      } },
      'separator',
      { icons: [clip('剪切', 'cut', 'cut', 'Mod+X'), clip('复制', 'copy', 'copy', 'Mod+C'), clip('粘贴', 'paste', 'paste', 'Mod+V'),
        { label: '删除', icon: 'delete', disabled: !editable || !selected, run: () => { this.view.dispatch(this.view.state.tr.deleteSelection().setMeta('isolated', true)) } }] },
      { label: '复制 / 粘贴为…', children: [clip('复制为 Markdown', 'markdown', undefined, 'Mod+Shift+C'), clip('复制为 HTML 代码', 'html'), clip('复制内容并简化格式', 'simplified'), 'separator', clip('粘贴为纯文本', 'paste-plain', undefined, 'Mod+Shift+V')] },
      'separator',
      { icons: [format('加粗', 'bold', 'bold', 'Mod+B'), format('斜体', 'italic', 'italic', 'Mod+I'), format('行内代码', 'inline-code', 'code', 'Mod+Shift+`'), format('链接', 'link', 'link', 'Mod+K')] },
      { icons: [format('引用', 'quote', 'quote'), format('有序列表', 'ordered', 'ordered'), format('无序列表', 'bullet', 'bullet'), format('任务列表', 'task', 'task')] },
      'separator',
      { label: headingNames[level] || '段落', children: [...[1, 2, 3, 4, 5, 6].map(number => ({ label: headingNames[number], checked: level === number, disabled: !editable, shortcut: label(`Mod+${number}`,'heading-'+number), run: () => this.heading(number) })), 'separator', { label: '段落', checked: level === 0, disabled: !editable, shortcut: label('Mod+0','heading-0'), run: () => this.heading(0) }] },
      { label: '插入', disabled: !editable, children: [
        format('图像', 'image', undefined, 'Mod+Shift+I'),
        { label: '脚注', run: () => this.insertReference(true) }, { label: '链接引用', run: () => this.insertReference(false) },
        format('水平分割线', 'rule'), format('表格', 'table', undefined, 'Mod+T'), format('代码块', 'code-block', undefined, 'Mod+Shift+K'),
        insert('公式块', '$$\nx^2\n$$', 'selection', 'Mod+Shift+M'), insert('内容目录', '[TOC]'),
        { ...insert('YAML Front Matter', '---\ntitle: ""\n---', 'start'), disabled: !editable || this.bridge.blocks[0]?.node.attrs.label === 'YAML Front Matter' },
        'separator', { label: '段落（上方）', run: () => this.insertParagraph(false) }, { label: '段落（下方）', run: () => this.insertParagraph(true) },
      ] },
    ]
    const sourceImage = target.closest('.md-source-image') && this.inlineSource?.kind === 'image' ? this.view.nodeDOM(this.inlineSource.from) : null
    const image = target.closest('.md-live-image') ?? (sourceImage instanceof Element ? sourceImage : null), link = target.closest('a')
    if (image) {
      const pos = this.view.posAtDOM(image, 0), node = this.view.state.doc.nodeAt(pos)
      if (node?.type === s.nodes.image) {
        // Secondary image actions live here so nothing but the picture itself is
        // visible in the document until the user asks for it.
        entries.unshift(
          { label: image.classList.contains('is-broken-image') ? '重新加载 / 授权图片' : '加载图片', disabled: !node.attrs.src, run: () => {
            for (const live of this.liveImages) if (live.getPos() === pos) live.retry()
          } },
          // Typora keeps resizing here instead of a floating control on the image.
          { label: '缩放图片', disabled: !editable, children: [25, 33, 50, 67, 80, 100, 150, 200].flatMap(zoom => [
            ...(zoom === 100 || zoom === 150 ? ['separator' as const] : []), {
            label: `${zoom}%`,
            checked: Number(node.attrs.zoom ?? 100) === zoom,
            run: () => this.updateImageAt(pos, { zoom }),
          }]) },
          { label: '图片对齐', disabled: !editable, children: [
            ['left', '左对齐'], ['center', '居中'], ['right', '右对齐'], [null, '默认'],
          ].map(([align, label]) => ({
            label: String(label),
            checked: (node.attrs.align ?? null) === align,
            run: () => this.updateImageAt(pos, { align }),
          })) },
          { label: '转换图片语法', disabled: !editable, children: [
            { label: 'Markdown ![](src)', checked: !node.attrs.htmlSource && !node.attrs.width && !node.attrs.align && !node.attrs.zoom, run: () => this.updateImageAt(pos, { htmlSource: null, width: null, align: null, zoom: null }) },
            { label: 'HTML <img>', checked: !!node.attrs.htmlSource || !!node.attrs.width || !!node.attrs.align || !!node.attrs.zoom, run: () => this.updateImageAt(pos, { htmlSource: controlledImageHtml({ src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title, width: node.attrs.width, align: node.attrs.align, zoom: node.attrs.zoom }, true) }) },
          ] },
          { label: '放大预览', disabled: !node.attrs.src, run: () => this.previewImageAt(pos) },
          { label: '复制图片路径', disabled: !node.attrs.src, run: () => { void navigator.clipboard?.writeText(String(node.attrs.src)) } },
          { label: '跳转到图片引用定义', disabled: !/!\[[\s\S]*\]\[[^\]]*\]/.test(inlineSourceRange(this.bridge, this.view.state.doc, pos, pos + 1, 'image')?.raw ?? ''), run: () => {
            const raw = inlineSourceRange(this.bridge, this.view.state.doc, pos, pos + 1, 'image')?.raw ?? ''
            const match = /^!\[([\s\S]*)\]\[([^\]]*)\]$/.exec(raw)
            const label = (match?.[2] || match?.[1] || '').trim().replace(/\s+/g, ' ').toUpperCase()
            const definition = this.bridge.blocks.find(block => {
              const name = /^\s*\[([^\]]+)\]:/.exec(block.raw)?.[1]
              return name?.trim().replace(/\s+/g, ' ').toUpperCase() === label
            })
            if (definition) { this.closeInline(); queueMicrotask(() => this.reveal(definition.from)) }
            else notice('找不到图片引用定义。')
          } },
          { label: '删除图片', disabled: !editable, run: () => this.deleteImageAt(pos) },
          'separator',
          { label: '图像属性…', disabled: !editable, run: () => {
            this.closeInline(); this.imageProperties(image as HTMLElement, node, pos)
          } },
          'separator',
        )
        return entries
      }
    }
    if (link) entries.push({ label: '链接属性…', disabled: !editable, run: () => { this.closeInline(); this.linkProperties(link as HTMLElement, link.getAttribute('data-href') || '') } })
    return entries
  }

  private contextFormat(format: MarkdownFormat, active: boolean) {
    if (this.options.readOnly?.() || this.composing) return
    if (format === 'quote' && active) { this.run(lift, true); return }
    if ((format === 'bullet' || format === 'ordered') && active) { this.run(liftListItem(s.nodes.list_item), true); return }
    if (format === 'bullet' || format === 'ordered' || format === 'task') {
      const state = this.view.state, { $from } = state.selection
      for (let depth = $from.depth; depth > 0; depth--) {
        if (![s.nodes.bullet_list, s.nodes.ordered_list].includes($from.node(depth).type)) continue
        const type = format === 'ordered' ? s.nodes.ordered_list : s.nodes.bullet_list
        const tr = state.tr.setNodeMarkup($from.before(depth), type)
        // Keep the same selected items; clear task markers when changing kind.
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, at) => {
          if (node.type === s.nodes.list_item) tr.setNodeMarkup(at, undefined, { ...node.attrs, checked: format === 'task' && !active ? false : null })
        })
        this.view.dispatch(tr.setMeta('isolated', true)); return
      }
    }
    this.format(format)
  }

  private insertParagraph(after: boolean) {
    if (this.options.readOnly?.() || this.composing) return
    const { $from } = this.view.state.selection
    const at = $from.depth ? after ? $from.after(1) : $from.before(1) : $from.pos
    const tr = this.view.state.tr.insert(at, s.nodes.paragraph.create())
    this.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).setMeta('isolated', true).scrollIntoView())
  }

  private insertReference(footnote: boolean) {
    if (this.options.readOnly?.() || this.composing) return
    let index = 1
    while (this.bridge.source.includes(`[${footnote ? '^' : ''}${index}]`)) index++
    const id = String(index), state = this.view.state, source = this.bridge.source
    const from = this.bridge.sourcePosition(state.selection.from), to = this.bridge.sourcePosition(state.selection.to)
    const text = state.doc.textBetween(state.selection.from, state.selection.to, ' ').replace(/[\[\]\\\r\n]/g, ' ') || '链接'
    const reference = footnote ? `[^${id}]` : `[${text}][${id}]`
    const definition = footnote ? `[^${id}]: 脚注内容` : `[${id}]: https://example.com`
    // Reference spelling is meaningful source. Insert the marker and definition
    // as a single canonical edit, rather than serializing it as escaped text.
    const next = source.slice(0, from) + reference + source.slice(to) + '\n\n' + definition
    const patch = textPatch(source, next)
    if (patch && this.options.publish(source, patch, undefined, true)) {
      this.sync(next)
      this.reveal(from + reference.length)
    }
  }

  destroy() {
    this.linkGesture?.destroy()
    this.propertyObserver?.disconnect()
    window.removeEventListener('resize', this.repositionProperties)
    cancelAnimationFrame(this.typewriterAlignFrame)
    cancelSmoothScroll(this.dom)
    this.typewriterCleanup?.()
    this.contextMenu.close()
    this.imagePreview.destroy()
    this.fenceAutocomplete?.destroy()
    this.slashController?.destroy()
    this.disposed = true
    this.inlineSource?.destroy()
    this.inlineSource = null
    this.dom.removeEventListener('compositionend', this.onCompositionEnd, true)
    this.dom.removeEventListener('focusin', this.onFocusOwnerChanged, true)
    this.dom.removeEventListener('compositionstart', this.onCompositionStart, true)
    this.dom.removeEventListener('pointerdown', this.onCanvasPointerDown)
    this.searchController.destroy()
    // prosemirror-view 1.42 leaves its temporary hidden NodeSelection guard on
    // ownerDocument when a selected atom is disposed before selection changes.
    // The optional adapter is deliberately limited to destroy-time cleanup.
    const input = (this.view as unknown as { input?: { hideSelectionGuard?: EventListener } }).input
    if (input?.hideSelectionGuard) this.view.dom.ownerDocument.removeEventListener('selectionchange', input.hideSelectionGuard)
    this.view.destroy()
    this.dom.remove()
    this.codeViews.clear()
    this.liveImages.clear()
    this.extensionViews.clear()
    this.tableToolbar.destroy()
  }
}
