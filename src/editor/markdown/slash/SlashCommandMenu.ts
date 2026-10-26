import {
  type SlashCommand,
  type SlashCommandCategory,
} from './SlashCommandRegistry'
import './SlashCommandMenu.css'

const ICON_PATHS: Record<string, string[]> = {
  paragraph: ['M13 4v16', 'M17 4v16', 'M19 4H9.5a4.5 4.5 0 0 0 0 9H13'],
  heading: ['M6 4v16', 'M18 4v16', 'M6 12h12'],
  'list-bullet': ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  'list-ordered': ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 16h2', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
  'list-task': ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M3 6l1.5 1.5L7 5', 'M3 12l1.5 1.5L7 11', 'M3 18l1.5 1.5L7 17'],
  quote: ['M4 5h16', 'M4 19h16', 'M8 9h8', 'M8 13h5'],
  table: ['M4 5h16v14H4z', 'M4 10h16', 'M4 15h16', 'M10 5v14', 'M16 5v14'],
  'code-block': ['M4 5h16v14H4z', 'm9 10-3 2 3 2', 'm15 10 3 2-3 2'],
  image: ['M4 5h16v14H4z', 'M8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4', 'm20 15-4.5-4.5L6 20'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  rule: ['M4 12h16'],
  sigma: ['M18 7V4H6l6 8-6 8h12v-3'],
  mermaid: ['M4 6h4v4H4z', 'M16 6h4v4H4z', 'M10 16h4v4H4z', 'M8 8h8', 'M12 8v8'],
  outline: ['M4 6h6', 'M4 12h10', 'M4 18h14', 'M18 6h2', 'M16 12h4', 'M20 18h0'],
  footnote: ['M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 10h6', 'M12 10v7'],
  yaml: ['M4 4h16v16H4z', 'M9 8l3 4 3-4', 'M12 12v4'],
}

function createIconSvg(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')

  const paths = ICON_PATHS[name] || ICON_PATHS.paragraph
  for (const p of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', p)
    svg.append(path)
  }
  return svg
}

export interface SlashMenuCallbacks {
  onSelect: (command: SlashCommand, tableDimensions?: { rows: number; columns: number }) => void
  onClose: () => void
}

export class SlashCommandMenu {
  readonly dom = document.createElement('div')
  private items: SlashCommand[] = []
  private selectedIndex = 0
  private visible = false
  private isTablePickerMode = false
  private tableRows = 3
  private tableColumns = 3
  private currentCoords: { left: number; bottom: number; top: number } | null = null
  private callbacks?: SlashMenuCallbacks
  private currentTableCommand: SlashCommand | null = null

  private onWindowScroll = (event: Event) => {
    if (!this.visible) return
    // If scrolling occurs outside the menu, reposition or close
    if (event.target instanceof Node && this.dom.contains(event.target)) return
    this.close()
  }

  constructor(private container: HTMLElement = document.body) {
    this.dom.className = 'md-slash-menu'
    this.dom.hidden = true
    this.dom.setAttribute('role', 'menu')
    this.dom.setAttribute('aria-label', '快捷插入菜单')
    this.dom.tabIndex = -1

    this.dom.onmousedown = event => {
      // Prevent focus loss from the editor
      event.preventDefault()
    }

    window.addEventListener('scroll', this.onWindowScroll, { capture: true, passive: true })
    window.addEventListener('resize', this.onWindowScroll, { passive: true })
    this.container.append(this.dom)
  }

  get isVisible(): boolean {
    return this.visible && !this.dom.hidden
  }

  show(
    coords: { left: number; bottom: number; top: number },
    items: SlashCommand[],
    callbacks: SlashMenuCallbacks
  ) {
    this.currentCoords = coords
    this.items = items
    this.callbacks = callbacks
    this.isTablePickerMode = false
    this.currentTableCommand = null

    if (this.selectedIndex >= items.length) {
      this.selectedIndex = 0
    }
    if (this.selectedIndex < 0 && items.length > 0) {
      this.selectedIndex = 0
    }

    this.render()
    this.dom.hidden = false
    this.visible = true
    this.position(coords)
  }

  updateItems(items: SlashCommand[]) {
    this.items = items
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = Math.max(0, items.length - 1)
    }
    this.render()
    if (this.currentCoords) {
      this.position(this.currentCoords)
    }
  }

  showTablePicker(command: SlashCommand, coords?: { left: number; bottom: number; top: number }) {
    if (coords) this.currentCoords = coords
    this.isTablePickerMode = true
    this.currentTableCommand = command
    this.tableRows = 3
    this.tableColumns = 3
    this.renderTablePicker()
    this.dom.hidden = false
    this.visible = true
    if (this.currentCoords) {
      this.position(this.currentCoords)
    }
  }

  close() {
    if (!this.visible) return
    this.visible = false
    this.dom.hidden = true
    this.isTablePickerMode = false
    this.currentTableCommand = null
    this.callbacks?.onClose()
  }

  destroy() {
    this.close()
    window.removeEventListener('scroll', this.onWindowScroll, { capture: true })
    window.removeEventListener('resize', this.onWindowScroll)
    this.dom.remove()
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.isVisible) return false

    // Ignore composition key events
    if (event.isComposing || event.keyCode === 229) return false

    if (this.isTablePickerMode) {
      return this.handleTablePickerKeyDown(event)
    }

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        event.stopPropagation()
        if (this.items.length === 0) return true
        this.selectedIndex = (this.selectedIndex + 1) % this.items.length
        this.updateActiveItem()
        return true
      }
      case 'ArrowUp': {
        event.preventDefault()
        event.stopPropagation()
        if (this.items.length === 0) return true
        this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length
        this.updateActiveItem()
        return true
      }
      case 'Enter':
      case 'Tab': {
        if (this.items.length === 0) {
          // If no items, do not swallow Enter/Tab
          this.close()
          return false
        }
        event.preventDefault()
        event.stopPropagation()
        this.executeCurrent()
        return true
      }
      case 'Escape': {
        event.preventDefault()
        event.stopPropagation()
        this.close()
        return true
      }
      default:
        return false
    }
  }

  private handleTablePickerKeyDown(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'ArrowRight': {
        event.preventDefault()
        event.stopPropagation()
        this.tableColumns = Math.min(6, this.tableColumns + 1)
        this.updateTableSelection()
        return true
      }
      case 'ArrowLeft': {
        event.preventDefault()
        event.stopPropagation()
        this.tableColumns = Math.max(1, this.tableColumns - 1)
        this.updateTableSelection()
        return true
      }
      case 'ArrowDown': {
        event.preventDefault()
        event.stopPropagation()
        this.tableRows = Math.min(6, this.tableRows + 1)
        this.updateTableSelection()
        return true
      }
      case 'ArrowUp': {
        event.preventDefault()
        event.stopPropagation()
        this.tableRows = Math.max(1, this.tableRows - 1)
        this.updateTableSelection()
        return true
      }
      case 'Enter': {
        event.preventDefault()
        event.stopPropagation()
        if (this.currentTableCommand) {
          const cmd = this.currentTableCommand
          const rows = this.tableRows
          const cols = this.tableColumns
          this.close()
          this.callbacks?.onSelect(cmd, { rows, columns: cols })
        }
        return true
      }
      case 'Escape': {
        event.preventDefault()
        event.stopPropagation()
        this.close()
        return true
      }
      default:
        return false
    }
  }

  private executeCurrent() {
    const cmd = this.items[this.selectedIndex]
    if (!cmd) return

    if (cmd.id === 'table') {
      this.showTablePicker(cmd)
      return
    }

    this.close()
    this.callbacks?.onSelect(cmd)
  }

  private position(coords: { left: number; bottom: number; top: number }) {
    const width = 300
    const padding = 10
    const estimatedHeight = Math.min(360, this.dom.offsetHeight || 280)

    let left = coords.left
    if (left + width > window.innerWidth - padding) {
      left = Math.max(padding, window.innerWidth - width - padding)
    }
    if (left < padding) {
      left = padding
    }

    const spaceBelow = window.innerHeight - coords.bottom - padding
    const spaceAbove = coords.top - padding

    let top: number
    if (spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove) {
      top = coords.bottom + 4
      this.dom.style.maxHeight = `${Math.min(360, Math.max(80, spaceBelow - 8))}px`
    } else {
      top = Math.max(padding, coords.top - estimatedHeight - 4)
      this.dom.style.maxHeight = `${Math.min(360, Math.max(80, spaceAbove - 8))}px`
    }

    this.dom.style.left = `${left}px`
    this.dom.style.top = `${top}px`
    this.dom.style.width = `${width}px`
  }

  private render() {
    this.dom.replaceChildren()

    if (this.items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'md-slash-empty'
      empty.textContent = '没有找到对应命令'
      this.dom.append(empty)
      return
    }

    const list = document.createElement('div')
    list.className = 'md-slash-list'

    // Group items by category if more than 3 items
    let currentCat: SlashCommandCategory | null = null

    this.items.forEach((cmd, index) => {
      if (cmd.category !== currentCat) {
        currentCat = cmd.category
        const catHeader = document.createElement('div')
        catHeader.className = 'md-slash-category'
        catHeader.textContent = currentCat
        list.append(catHeader)
      }

      const itemBtn = document.createElement('button')
      itemBtn.type = 'button'
      itemBtn.className = `md-slash-item${index === this.selectedIndex ? ' is-active' : ''}`
      itemBtn.setAttribute('role', 'menuitem')
      itemBtn.setAttribute('data-id', cmd.id)

      const iconWrap = document.createElement('span')
      iconWrap.className = 'md-slash-item-icon'
      iconWrap.append(createIconSvg(cmd.icon))

      const content = document.createElement('div')
      content.className = 'md-slash-item-content'

      const label = document.createElement('span')
      label.className = 'md-slash-item-label'
      label.textContent = cmd.label

      const desc = document.createElement('span')
      desc.className = 'md-slash-item-desc'
      desc.textContent = cmd.description

      content.append(label, desc)
      itemBtn.append(iconWrap, content)

      if (cmd.aliases.length > 0) {
        const tag = document.createElement('span')
        tag.className = 'md-slash-item-shortcut'
        tag.textContent = `/${cmd.aliases[0]}`
        itemBtn.append(tag)
      }

      itemBtn.onmouseenter = () => {
        this.selectedIndex = index
        this.updateActiveItem()
      }

      itemBtn.onclick = () => {
        this.selectedIndex = index
        this.executeCurrent()
      }

      list.append(itemBtn)
    })

    this.dom.append(list)
    this.scrollToActive()
  }

  private renderTablePicker() {
    this.dom.replaceChildren()

    const picker = document.createElement('div')
    picker.className = 'md-slash-table-picker'

    const header = document.createElement('div')
    header.className = 'md-slash-table-header'
    header.innerHTML = `<span>插入表格</span><strong>${this.tableRows} × ${this.tableColumns}</strong>`

    const grid = document.createElement('div')
    grid.className = 'md-slash-table-grid'

    for (let r = 1; r <= 6; r++) {
      for (let c = 1; c <= 6; c++) {
        const cell = document.createElement('button')
        cell.type = 'button'
        cell.className = `md-slash-table-cell${r <= this.tableRows && c <= this.tableColumns ? ' is-selected' : ''}`
        cell.setAttribute('aria-label', `${r} 行 ${c} 列`)

        cell.onmouseenter = () => {
          this.tableRows = r
          this.tableColumns = c
          this.updateTableSelection()
        }

        cell.onclick = () => {
          this.tableRows = r
          this.tableColumns = c
          if (this.currentTableCommand) {
            const cmd = this.currentTableCommand
            this.close()
            this.callbacks?.onSelect(cmd, { rows: r, columns: c })
          }
        }

        grid.append(cell)
      }
    }

    const footer = document.createElement('div')
    footer.className = 'md-slash-table-footer'
    footer.innerHTML = '<span>按 Enter 确认</span><span>按 Esc 取消</span>'

    picker.append(header, grid, footer)
    this.dom.append(picker)
  }

  private updateTableSelection() {
    const dimensions = this.dom.querySelector('.md-slash-table-header strong')
    if (dimensions) dimensions.textContent = `${this.tableRows} × ${this.tableColumns}`
    // Keep the hovered button mounted so it can receive the subsequent click.
    this.dom.querySelectorAll('.md-slash-table-cell').forEach((cell, index) => {
      const row = Math.floor(index / 6) + 1
      const column = index % 6 + 1
      cell.classList.toggle('is-selected', row <= this.tableRows && column <= this.tableColumns)
    })
  }

  private updateActiveItem() {
    const buttons = this.dom.querySelectorAll<HTMLButtonElement>('.md-slash-item')
    buttons.forEach((btn, idx) => {
      btn.classList.toggle('is-active', idx === this.selectedIndex)
    })
    this.scrollToActive()
  }

  private scrollToActive() {
    const activeBtn = this.dom.querySelector<HTMLElement>('.md-slash-item.is-active')
    if (activeBtn) {
      activeBtn.scrollIntoView({ block: 'nearest' })
    }
  }
}
