export type TableToolbarCommand = 'addRowBefore' | 'addRowAfter' | 'deleteRow' | 'addColumnBefore' | 'addColumnAfter' | 'deleteColumn' | 'deleteTable'
export type TableAlignment = 'left' | 'center' | 'right'

interface ToolbarActions {
  selectTable(position: number | undefined, toolbar: HTMLElement): void
  run(command: TableToolbarCommand): void
  align(value: TableAlignment): void
}
interface Toolbar {
  element: HTMLElement
  closeMenu(): void
}

/** Owns table toolbar DOM only. Selection, commands, transactions and history
 * belong to the controller; this module has no editor state or source content. */
export class LiveTableToolbar {
  private readonly primary: Toolbar
  private position: number | undefined
  private surface: HTMLElement | null = null
  private readonly observer = new ResizeObserver(() => this.reposition())
  private disposed = false
  private readonly outside = (event: MouseEvent) => {
    const target = event.target as Node
    if (!this.primary.element.contains(target)) this.primary.closeMenu()
  }

  constructor(private readonly host: HTMLElement, private readonly actions: ToolbarActions) {
    this.primary = this.create()
    this.primary.element.hidden = true
    host.append(this.primary.element)
    this.observer.observe(host)
    // One listener per Live view, rather than one closure for every decoration
    // position ever visited while text is inserted before a table.
    host.addEventListener('mousedown', this.outside)
  }

  /** One toolbar for the active table, independent of document/table count. */
  update(activePosition: number | null, alignment: string | null, surface?: HTMLElement | null) {
    if (this.disposed) return
    const element = this.primary.element
    if (this.position !== (activePosition ?? undefined)) this.primary.closeMenu()
    this.position = activePosition ?? undefined
    element.hidden = activePosition === null
    element.classList.toggle('is-active', activePosition !== null)
    const nextSurface = activePosition === null ? null : surface ?? null
    if (this.surface !== nextSurface) {
      if (this.surface) this.observer.unobserve(this.surface)
      this.surface = nextSurface
      if (nextSurface) {
        this.observer.observe(nextSurface)
        const document = nextSurface.closest('.md-document')
        if (document) this.observer.observe(document)
      }
    }
    this.reposition()
    element.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(button => {
      button.setAttribute('aria-pressed', String(activePosition !== null && button.dataset.align === alignment))
    })
  }

  private reposition() {
    if (this.disposed || !this.surface?.isConnected || this.position === undefined) return
    const bounds = this.surface.getBoundingClientRect(), origin = this.host.getBoundingClientRect()
    const element = this.primary.element
    element.style.top = `${bounds.top - origin.top + this.host.scrollTop - 28}px`
    element.style.left = `${bounds.left - origin.left + this.host.scrollLeft}px`
    element.style.width = `${this.surface.clientWidth}px`
  }

  private create(): Toolbar {
    const element = document.createElement('div')
    element.className = 'md-table-tools md-table-floating-bar'
    element.setAttribute('role', 'toolbar')
    element.setAttribute('aria-label', '表格工具')
    element.hidden = false

    const iconButton = (label: string, path: string, action: () => void) => {
      const button = document.createElement('button')
      button.type = 'button'; button.title = label; button.setAttribute('aria-label', label)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('aria-hidden', 'true')
      const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.append(shape); button.append(svg)
      button.onmousedown = event => event.preventDefault()
      button.onclick = () => { if (!this.disposed) action() }
      return button
    }
    const menu = document.createElement('div')
    menu.className = 'md-table-menu'
    menu.hidden = true
    menu.setAttribute('aria-label', '表格行列操作菜单')
    const closeMenu = () => {
      menu.hidden = true
      element.querySelectorAll('[aria-expanded]').forEach(button => button.setAttribute('aria-expanded', 'false'))
    }
    const toggleMenu = () => {
      menu.hidden = !menu.hidden
      element.querySelectorAll('[aria-expanded]').forEach(button => button.setAttribute('aria-expanded', String(!menu.hidden)))
    }
    const selectTable = () => this.actions.selectTable(this.position, element)
    const grid = iconButton('表格行列操作', 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', () => {
      selectTable(); toggleMenu()
    })
    grid.setAttribute('aria-expanded', 'false')
    element.append(grid)
    const alignments: [string, TableAlignment, string][] = [
      ['左对齐', 'left', 'M3 5h18 M3 10h12 M3 15h18 M3 20h12'],
      ['居中对齐', 'center', 'M3 5h18 M6 10h12 M3 15h18 M6 20h12'],
      ['右对齐', 'right', 'M3 5h18 M9 10h12 M3 15h18 M9 20h12'],
    ]
    for (const [label, value, path] of alignments) {
      const button = iconButton(label, path, () => { selectTable(); this.actions.align(value) })
      button.dataset.align = value
      element.append(button)
    }
    const spacer = document.createElement('span')
    spacer.className = 'md-table-tools-spacer'
    element.append(spacer)
    const more = iconButton('更多操作', 'M12 4h.01 M12 12h.01 M12 20h.01', () => { selectTable(); toggleMenu() })
    more.setAttribute('aria-expanded', 'false')
    element.append(more, iconButton('删除表格', 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7', () => { selectTable(); this.actions.run('deleteTable') }))
    const commands: [string, TableToolbarCommand][] = [
      ['前插行', 'addRowBefore'], ['后插行', 'addRowAfter'], ['删除行', 'deleteRow'],
      ['前插列', 'addColumnBefore'], ['后插列', 'addColumnAfter'], ['删除列', 'deleteColumn'],
    ]
    for (const [label, command] of commands) {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = label
      button.onmousedown = event => event.preventDefault()
      button.onclick = () => {
        if (this.disposed) return
        closeMenu(); selectTable(); this.actions.run(command)
      }
      menu.append(button)
    }
    element.append(menu)
    element.onkeydown = event => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault(); event.stopPropagation(); closeMenu(); more.focus()
      }
    }
    return { element, closeMenu }
  }

  private remove(toolbar: Toolbar) {
    toolbar.closeMenu()
    toolbar.element.onkeydown = null
    toolbar.element.querySelectorAll('button').forEach(button => { button.onmousedown = null; button.onclick = null })
    toolbar.element.remove()
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.surface = null
    this.host.removeEventListener('mousedown', this.outside)
    this.remove(this.primary)
  }
}
