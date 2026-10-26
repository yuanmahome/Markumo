import { parseFenceInfo } from '../../languages'
import { getLanguageSuggestions, createLanguageIconSvg, type LanguageOption } from '../../languages/suggestions'

let identity = 0

export class LanguageSelector {
  readonly row = document.createElement('div')
  readonly dock = document.createElement('div')
  readonly button = document.createElement('button')
  readonly input = document.createElement('input')
  private panel = document.createElement('div')
  private list = document.createElement('div')
  private options: LanguageOption[] = []
  private active = -1
  private info = ''
  private originalLabel = ''
  private interacting = false
  private listenersAttached = false

  private onOutside = (event: MouseEvent) => {
    const target = event.target as Node
    if (!this.dock.contains(target) && !this.panel.contains(target)) {
      this.close()
      this.stopEditing()
    }
  }

  private onViewportChange = (event: Event) => {
    if (!this.panel.hidden && (!(event.target instanceof Node) || !this.panel.contains(event.target))) {
      this.position()
    }
  }

  private attachGlobalListeners() {
    if (this.listenersAttached) return
    this.listenersAttached = true
    document.addEventListener('mousedown', this.onOutside)
    document.addEventListener('scroll', this.onViewportChange, true)
    window.addEventListener('resize', this.onViewportChange)
  }

  private detachGlobalListeners() {
    if (!this.listenersAttached) return
    this.listenersAttached = false
    document.removeEventListener('mousedown', this.onOutside)
    document.removeEventListener('scroll', this.onViewportChange, true)
    window.removeEventListener('resize', this.onViewportChange)
  }

  constructor(info: string, private change: (label: string) => void, private onCloseInteraction?: () => void) {
    this.row.className = 'md-code-language-row'
    this.dock.className = 'md-code-language-dock md-code-lang'

    // 静止状态按钮：宽 138px，高 18px，居中
    this.button.type = 'button'
    this.button.className = 'md-code-lang-btn'
    this.button.setAttribute('aria-label', '选择代码语言')
    this.button.onclick = (e) => {
      e.stopPropagation()
      this.startEditing()
    }

    // 编辑状态输入框：同样宽 138px，高 18px，居中，文字居中
    this.input.type = 'text'
    this.input.className = 'md-code-language-input'
    this.input.setAttribute('role', 'combobox')
    this.input.setAttribute('aria-label', '搜索代码语言')
    this.input.setAttribute('aria-autocomplete', 'list')
    this.input.setAttribute('spellcheck', 'false')
    this.input.setAttribute('autocomplete', 'off')
    this.input.hidden = true

    // 候选列表浮层
    this.panel.className = 'md-language-menu'
    this.panel.hidden = true
    this.list.id = `md-language-options-${++identity}`
    this.list.className = 'md-language-list'
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', '代码语言选项')
    this.input.setAttribute('aria-controls', this.list.id)

    this.panel.append(this.list)
    this.dock.append(this.button, this.input)
    this.row.append(this.dock, this.panel)

    this.dock.onclick = (e) => {
      if (this.button && !this.button.hidden && e.target === this.dock) {
        e.stopPropagation()
        this.startEditing()
      }
    }

    this.input.oninput = () => {
      this.active = -1
      this.filter()
      if (this.panel.hidden) {
        this.open()
      }
    }

    this.input.onkeydown = event => {
      if (event.isComposing) return
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          this.stopEditing()
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          event.stopPropagation()
          if (this.panel.hidden) {
            this.open()
          } else if (this.options.length) {
            this.active = (this.active + 1) % this.options.length
            this.paint()
          }
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          if (this.panel.hidden) {
            this.open()
          } else if (this.options.length) {
            this.active = (this.active - 1 + this.options.length) % this.options.length
            this.paint()
          }
        } else if (event.key === 'Tab') {
          if (!this.panel.hidden && this.options.length) {
            event.preventDefault()
            event.stopPropagation()
            const target = this.active >= 0 ? this.options[this.active] : this.options[0]
            if (target) {
              this.choose(target.id)
            }
          }
        } else if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          if (!this.panel.hidden && this.active >= 0 && this.options[this.active]) {
            this.choose(this.options[this.active].id)
          } else {
            const raw = this.input.value.trim()
            if (raw) {
              this.choose(raw)
            } else {
              this.stopEditing()
            }
          }
        }
      }
    }

    this.input.onblur = () => {
      queueMicrotask(() => {
        const activeEl = document.activeElement
        if (!this.dock.contains(activeEl) && !this.panel.contains(activeEl)) {
          this.interacting = false
          this.stopEditing()
        }
      })
    }

    this.update(info)
  }

  get dom() {
    return this.dock
  }

  get isInteracting() {
    return this.interacting || !this.input.hidden || !this.panel.hidden
  }

  update(info: string) {
    this.info = info
    const { label, language, parameters } = parseFenceInfo(info)
    const baseName = language?.name || label || ''
    const displayName = baseName ? (parameters ? `${baseName} ${parameters.trim()}` : baseName) : ''
    this.originalLabel = displayName
    this.button.textContent = displayName || '代码语言'
    this.input.value = displayName
    this.button.setAttribute('aria-label', `代码语言：${displayName || '未指定'}`)
    this.input.setAttribute('aria-label', `搜索代码语言（当前：${displayName || '未指定'}）`)
    this.button.title = label && !language ? `${label} 未注册，当前使用纯文本高亮` : '选择代码语言'
    this.dock.dataset.language = language?.id || 'text'
  }

  startEditing() {
    this.interacting = true
    this.attachGlobalListeners()
    this.button.hidden = true
    this.input.hidden = false
    this.input.value = this.originalLabel
    this.input.focus()
    this.input.select()
    this.open()
  }

  stopEditing() {
    const wasActive = this.isInteracting
    this.interacting = false
    this.input.hidden = true
    this.button.hidden = false
    this.input.value = this.originalLabel
    this.close()
    this.detachGlobalListeners()
    if (wasActive) this.onCloseInteraction?.()
  }

  private open() {
    this.attachGlobalListeners()
    this.panel.hidden = false
    this.input.setAttribute('aria-expanded', 'true')
    this.active = -1
    this.filter()
    this.position()
  }

  private position() {
    const anchor = this.dock.getBoundingClientRect()
    const width = 180
    this.panel.style.width = `${width}px`
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))
    this.panel.style.left = `${left}px`

    const below = window.innerHeight - anchor.bottom - 6
    const above = anchor.top - 6
    const height = Math.min(220, Math.max(below, above))
    this.panel.style.maxHeight = `${height}px`
    this.panel.style.top = `${below >= Math.min(200, above) ? anchor.bottom + 2 : Math.max(8, anchor.top - Math.min(this.panel.scrollHeight, height) - 2)}px`
  }

  private close() {
    this.panel.hidden = true
    this.input.setAttribute('aria-expanded', 'false')
    this.active = -1
  }

  private filter() {
    const query = this.input.value.trim()
    this.options = getLanguageSuggestions(query, true)
    this.paint()
  }

  private paint() {
    this.list.replaceChildren()
    this.options.forEach((option, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'md-language-option'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-label', option.label)
      row.id = `${this.list.id}-${index}`
      row.setAttribute('aria-selected', String(index === this.active))
      if (index === this.active) {
        row.classList.add('is-active')
      }

      const icon = createLanguageIconSvg(option.id)
      const name = document.createElement('span')
      name.className = 'md-language-name'
      name.textContent = option.label

      row.append(icon, name)
      row.onmousedown = event => {
        event.preventDefault()
        event.stopPropagation()
      }
      row.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.choose(option.id)
      }
      this.list.append(row)
    })

    if (this.options.length && this.active >= 0) {
      this.input.setAttribute('aria-activedescendant', `${this.list.id}-${this.active}`)
    } else {
      this.input.removeAttribute('aria-activedescendant')
    }

    const row = this.list.children[this.active] as HTMLElement | undefined
    if (row) {
      if (row.offsetTop < this.list.scrollTop) {
        this.list.scrollTop = row.offsetTop
      } else if (row.offsetTop + row.offsetHeight > this.list.scrollTop + this.list.clientHeight) {
        this.list.scrollTop = row.offsetTop + row.offsetHeight - this.list.clientHeight
      }
    }
  }

  private choose(label?: string) {
    if (!label) return
    this.stopEditing()
    const suffix = parseFenceInfo(this.info).parameters
    this.change(label + suffix)
    this.button.focus()
  }

  destroy() {
    this.detachGlobalListeners()
    this.row.remove()
  }
}
