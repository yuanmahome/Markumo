import { TextSelection, Selection } from 'prosemirror-state'
import { isInTable } from 'prosemirror-tables'
import { findWrapping } from 'prosemirror-transform'
import { markdownSchema as s } from '../wysiwyg/MarkdownSchema'
import { parseMarkdown } from '../wysiwyg/MarkdownParser'
import type { MarkdownEditorController } from '../wysiwyg/MarkdownEditorController'
import {
  type SlashCommand,
  type SlashCommandContext,
  SLASH_COMMANDS,
  filterSlashCommands,
} from './SlashCommandRegistry'
import { SlashCommandMenu } from './SlashCommandMenu'

export class LiveSlashController {
  readonly menu: SlashCommandMenu

  constructor(
    private editor: MarkdownEditorController,
    private container: HTMLElement
  ) {
    this.menu = new SlashCommandMenu(this.container)
  }

  destroy() {
    this.menu.destroy()
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    const handled = this.menu.handleKeyDown(event)
    return handled
  }

  close() {
    this.menu.close()
  }

  update() {
    const view = this.editor.view
    if (this.editor.composing || this.editor['disposed'] || this.editor['options'].readOnly?.()) {
      this.close()
      return
    }

    const { state } = view
    const { selection } = state
    if (!selection.empty) {
      this.close()
      return
    }

    const { $from } = selection
    // Slash commands only trigger in textblock (paragraph) and not in code_block
    if (!$from.parent.isTextblock || $from.parent.type === s.nodes.code_block) {
      this.close()
      return
    }

    // Do not trigger inside inline-code or link
    const marks = $from.marks()
    if (marks.some(m => m.type === s.marks.code || m.type === s.marks.link)) {
      this.close()
      return
    }

    const textBefore = $from.parent.textBetween(0, $from.parentOffset)
    const slashIndex = textBefore.lastIndexOf('/')
    if (slashIndex === -1) {
      this.close()
      return
    }

    // Check boundary before slash
    if (slashIndex > 0) {
      const charBefore = textBefore[slashIndex - 1]
      // Must be whitespace and not escaped slash
      if (!/\s/.test(charBefore) || charBefore === '\\') {
        this.close()
        return
      }
    }

    const query = textBefore.slice(slashIndex + 1)
    // If query contains whitespace or another slash, do not trigger
    if (/\s|\//.test(query)) {
      this.close()
      return
    }

    // Calculate document positions of the trigger
    const from = $from.pos - query.length - 1
    const to = $from.pos

    try {
      const coords = view.coordsAtPos(from)
      const inTable = isInTable(state)
      const hasYaml = this.editor.bridge.blocks[0]?.node.attrs.label === 'YAML Front Matter'

      const context: SlashCommandContext = {
        mode: 'live',
        inTable,
        inCodeBlock: false,
        readOnly: false,
        hasYaml,
        from,
        to,
        query,
        liveEditor: this.editor,
      }

      const filtered = filterSlashCommands(SLASH_COMMANDS, query, context)

      this.menu.show(coords, filtered, {
        onSelect: (cmd, tableDim) => {
          this.execute(cmd, context, tableDim)
        },
        onClose: () => {},
      })
    } catch {
      this.close()
    }
  }

  execute(
    command: SlashCommand,
    context: SlashCommandContext,
    tableDim?: { rows: number; columns: number }
  ) {
    const view = this.editor.view
    const { from, to } = context

    switch (command.id) {
      case 'heading-0':
      case 'heading-1':
      case 'heading-2':
      case 'heading-3':
      case 'heading-4':
      case 'heading-5':
      case 'heading-6': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const level = command.id === 'heading-0' ? 0 : Number(command.id.slice(-1))
        const nodeType = level === 0 ? s.nodes.paragraph : s.nodes.heading
        const attrs = level === 0 ? null : { level }
        tr = tr.setNodeMarkup($pos.before($pos.depth), nodeType, attrs)
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'bullet':
      case 'ordered':
      case 'task': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const range = $pos.blockRange()
        if (range) {
          const listType = command.id === 'ordered' ? s.nodes.ordered_list : s.nodes.bullet_list
          const wrapping = findWrapping(range, listType)
          if (wrapping) {
            tr = tr.wrap(range, wrapping)
            if (command.id === 'task') {
              const $item = tr.doc.resolve(tr.mapping.map(mapped))
              for (let d = $item.depth; d > 0; d--) {
                if ($item.node(d).type === s.nodes.list_item) {
                  tr = tr.setNodeMarkup($item.before(d), undefined, { ...$item.node(d).attrs, checked: false })
                  break
                }
              }
            }
          }
        }
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'quote': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const range = $pos.blockRange()
        if (range) {
          const wrapping = findWrapping(range, s.nodes.blockquote)
          if (wrapping) tr = tr.wrap(range, wrapping)
        }
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'callout-note':
      case 'callout-tip':
      case 'callout-important':
      case 'callout-warning':
      case 'callout-caution': {
        const type = command.id.replace('callout-', '').toUpperCase()
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const parent = $pos.parent
        const para = s.nodes.paragraph.create()
        const calloutNode = s.nodes.callout.create({ calloutType: type, title: '' }, [para])
        let targetPos: number
        if (parent.content.size === 0) {
          targetPos = $pos.before($pos.depth)
          tr = tr.replaceWith(targetPos, $pos.after($pos.depth), calloutNode)
        } else {
          targetPos = $pos.after($pos.depth)
          tr = tr.insert(targetPos, calloutNode)
        }
        tr = tr.setSelection(TextSelection.create(tr.doc, targetPos + 2))
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'code-block': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const parent = $pos.parent
        const codeNode = s.nodes.code_block.create({ fence: '```', params: '' })
        let targetPos: number
        if (parent.content.size === 0) {
          targetPos = $pos.before($pos.depth)
          tr = tr.replaceWith(targetPos, $pos.after($pos.depth), codeNode)
        } else {
          targetPos = $pos.after($pos.depth)
          tr = tr.insert(targetPos, codeNode)
        }
        tr = tr.setSelection(TextSelection.create(tr.doc, targetPos + 1))
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        queueMicrotask(() => {
          const codeView = [...(this.editor['codeViews'] as Set<any>)].find(v => v.getPos() === targetPos)
          if (codeView && typeof codeView.ensureEditor === 'function') {
            codeView.ensureEditor().focus()
            codeView.setSelection(0, 0)
          }
        })
        return
      }

      case 'mermaid': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const parent = $pos.parent
        const textNode = s.text('graph TD\n    A[开始] --> B[结束]')
        const mermaidNode = s.nodes.code_block.create({ fence: '```', params: 'mermaid' }, textNode)
        let targetPos: number
        if (parent.content.size === 0) {
          targetPos = $pos.before($pos.depth)
          tr = tr.replaceWith(targetPos, $pos.after($pos.depth), mermaidNode)
        } else {
          targetPos = $pos.after($pos.depth)
          tr = tr.insert(targetPos, mermaidNode)
        }
        tr = tr.setSelection(TextSelection.create(tr.doc, targetPos + 1))
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        // Activate mermaid editing on the newly inserted CodeBlockView
        queueMicrotask(() => {
          const codeView = [...(this.editor['codeViews'] as Set<any>)].find(v => v.getPos() === targetPos)
          if (codeView && typeof codeView.setMermaidEditing === 'function') {
            codeView.setMermaidEditing(true)
          }
        })
        return
      }

      case 'table': {
        const rows = Math.max(1, Math.min(8, tableDim?.rows ?? 3))
        const cols = Math.max(1, Math.min(8, tableDim?.columns ?? 3))
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const parent = $pos.parent

        const cell = (header: boolean) => (header ? s.nodes.table_header : s.nodes.table_cell).createAndFill()!
        const header = s.nodes.table_row.create(null, Array.from({ length: cols }, () => cell(true)))
        const body = Array.from({ length: rows - 1 }, () => s.nodes.table_row.create(null, Array.from({ length: cols }, () => cell(false))))
        const table = s.nodes.table.create(null, [header, ...body])

        let insertPos: number
        if (parent.content.size === 0) {
          insertPos = $pos.before($pos.depth)
          tr = tr.replaceWith(insertPos, $pos.after($pos.depth), table)
        } else {
          insertPos = $pos.after($pos.depth)
          tr = tr.insert(insertPos, table)
        }

        const sel = Selection.findFrom(tr.doc.resolve(insertPos), 1)
        if (sel) tr = tr.setSelection(sel)
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'image': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const imgNode = s.nodes.image.create({ src: 'image.png', alt: '图片描述' })
        tr = tr.insert(mapped, imgNode)
        tr.setMeta('isolated', true)
        view.dispatch(tr)
        this.editor['queueInlineEdit']?.(mapped, 'image')
        view.focus()
        return
      }

      case 'link': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const mark = s.marks.link.create({ href: 'https://example.com' })
        tr = tr.insert(mapped, s.text('链接', [mark]))
        tr.setMeta('isolated', true)
        view.dispatch(tr)
        this.editor['queueInlineEdit']?.(mapped, 'link')
        view.focus()
        return
      }

      case 'rule': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const parent = $pos.parent
        const hr = s.nodes.horizontal_rule.create()
        const p = s.nodes.paragraph.create()
        if (parent.content.size === 0) {
          tr = tr.replaceWith($pos.before($pos.depth), $pos.after($pos.depth), [hr, p])
          tr = tr.setSelection(TextSelection.create(tr.doc, $pos.before($pos.depth) + hr.nodeSize + 1))
        } else {
          tr = tr.insert($pos.after($pos.depth), [hr, p])
          tr = tr.setSelection(TextSelection.create(tr.doc, $pos.after($pos.depth) + hr.nodeSize + 1))
        }
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'math': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const parent = $pos.parent
        const mathContent = parseMarkdown('$$\nx^2\n$$').doc.content
        let targetPos: number
        if (parent.content.size === 0) {
          targetPos = $pos.before($pos.depth)
          tr = tr.replaceWith(targetPos, $pos.after($pos.depth), mathContent)
        } else {
          targetPos = $pos.after($pos.depth)
          tr = tr.insert(targetPos, mathContent)
        }
        const sel = Selection.findFrom(tr.doc.resolve(targetPos), 1)
        if (sel) tr = tr.setSelection(sel)
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'toc': {
        let tr = view.state.tr.delete(from, to)
        const mapped = tr.mapping.map(from)
        const $pos = tr.doc.resolve(mapped)
        const parent = $pos.parent
        const tocContent = parseMarkdown('[TOC]').doc.content
        if (parent.content.size === 0) {
          tr = tr.replaceWith($pos.before($pos.depth), $pos.after($pos.depth), tocContent)
        } else {
          tr = tr.insert($pos.after($pos.depth), tocContent)
        }
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'yaml': {
        if (this.editor.bridge.blocks[0]?.node.attrs.label === 'YAML Front Matter') return
        let tr = view.state.tr.delete(from, to)
        const yamlContent = parseMarkdown('---\ntitle: ""\n---').doc.content
        tr = tr.insert(0, yamlContent)
        tr.setMeta('isolated', true).scrollIntoView()
        view.dispatch(tr)
        view.focus()
        return
      }

      case 'footnote':
      case 'link-reference': {
        let tr = view.state.tr.delete(from, to)
        tr.setMeta('isolated', true)
        view.dispatch(tr)
        this.editor['insertReference']?.(command.id === 'footnote')
        view.focus()
        return
      }
    }
  }
}
