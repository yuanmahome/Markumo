import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import {
  liveSearchPluginKey, replacementText, replaceMatch,
  type LiveSearchOptions,
  type LiveSearchState,
} from './plugins/LiveSearch'
import type { CodeBlockView } from './CodeBlockView'
import { createSearchBar } from '../../core/SearchBar'
import { regexError } from '../../core/searchQuery'

export class LiveSearchController {
  readonly dom: HTMLElement
  private searchInput: HTMLInputElement
  private replaceInput: HTMLInputElement
  private countLabel: HTMLElement
  private caseCheckbox: HTMLInputElement
  private wordCheckbox: HTMLInputElement
  private regexCheckbox: HTMLInputElement
  private bar: ReturnType<typeof createSearchBar>
  private codeQueryWasActive = false
  private composing = false
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private codeViewsGetter: () => Set<CodeBlockView>

  constructor(
    private view: EditorView,
    parent: HTMLElement,
    codeViewsGetter: () => Set<CodeBlockView>
  ) {
    this.codeViewsGetter = codeViewsGetter

    this.bar = createSearchBar({ change: () => this.handleInput(), toggle: () => {
      if (!this.bar.second.hidden) this.replaceInput.focus()
      else this.searchInput.focus()
    }, run: action => {
      if (action === 'previous') this.findPrevious()
      else if (action === 'next') this.findNext()
      else if (action === 'close') this.close()
      else if (action === 'replace') this.replaceCurrent()
      else if (action === 'replaceAll') this.replaceAll()
    } })
    this.dom = this.bar.dom
    this.dom.classList.add('md-live-search')
    this.dom.hidden = true
    this.searchInput = this.bar.search; this.replaceInput = this.bar.replace
    this.countLabel = this.bar.count; this.caseCheckbox = this.bar.caseSensitive
    this.wordCheckbox = this.bar.wholeWord; this.regexCheckbox = this.bar.regexp
    this.dom.addEventListener('compositionstart', () => { this.composing = true })
    this.dom.addEventListener('compositionend', () => { this.composing = false; this.handleInput() })
    parent.append(this.dom)

    this.dom.onkeydown = event => {
      if (event.isComposing || this.composing || event.keyCode === 229) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        this.close()
      } else if (event.key === 'F3' || (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox')) {
        event.preventDefault(); event.stopPropagation()
        event.shiftKey ? this.findPrevious() : this.findNext()
      } else if (event.key === 'f' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        event.stopPropagation()
        this.open(false)
      } else if (event.key === 'r' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        event.stopPropagation()
        this.open(true)
      }
    }
  }

  get isOpen(): boolean {
    return !this.dom.hidden
  }

  private get pluginState(): LiveSearchState | undefined {
    return liveSearchPluginKey.getState(this.view.state)
  }

  setReplaceVisible(visible: boolean) {
    this.bar.setReplaceVisible(visible)
  }

  open(replace = false) {
    this.dom.hidden = false
    this.setReplaceVisible(replace)

    const sel = this.view.state.selection
    if (!sel.empty && !this.searchInput.value) {
      const selectedText = this.view.state.doc.textBetween(sel.from, sel.to)
      if (selectedText && selectedText.length <= 100 && !selectedText.includes('\n')) {
        this.searchInput.value = selectedText
      }
    }

    const tr = this.view.state.tr.setMeta(liveSearchPluginKey, {
      type: 'open',
      replace,
    })
    this.view.dispatch(tr)

    this.handleInput()

    if (replace) {
      this.replaceInput.focus()
      this.replaceInput.select()
    } else {
      this.searchInput.focus()
      this.searchInput.select()
    }

    this.updateCount()
    this.revealCurrentMatch()
  }

  close() {
    this.dom.hidden = true
    const tr = this.view.state.tr.setMeta(liveSearchPluginKey, { type: 'close' })
    this.view.dispatch(tr)
    this.syncQueryToCodeBlocks()
    this.view.focus()
  }

  private handleInput() {
    if (this.composing) return
    const options: Partial<LiveSearchOptions> = {
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: this.caseCheckbox.checked,
      wholeWord: this.wordCheckbox.checked,
      regexp: this.regexCheckbox.checked,
    }

    const tr = this.view.state.tr.setMeta(liveSearchPluginKey, {
      type: 'setOptions',
      options,
    })
    this.view.dispatch(tr)

    this.syncQueryToCodeBlocks()

    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      this.updateCount()
      this.revealCurrentMatch()
    }, 60)
  }

  private syncQueryToCodeBlocks() {
    const state = this.pluginState
    const active = this.isOpen && !!state?.valid && !!state.options.search
    if (!active && !this.codeQueryWasActive) return
    this.codeQueryWasActive = active
    for (const codeView of this.codeViewsGetter()) {
      const pos = active ? codeView.getPos() : undefined
      const ranges = !active || !state || pos === undefined ? [] : state.matches.flatMap((match, index) =>
        match.codeBlockPos === pos ? [{ from: match.from - pos - 1, to: match.to - pos - 1, current: index === state.currentIndex }] : [])
      codeView.setSearchHighlights(ranges)
    }
  }

  updateCount() {
    this.syncQueryToCodeBlocks()
    const state = this.pluginState
    if (!state || !state.active || !this.searchInput.value) {
      this.bar.setStatus('', '', false, !this.view.editable)
      return
    }

    if (!state.valid) {
      this.bar.setStatus('无效正则', regexError(state.options), false, !this.view.editable)
      return
    }

    this.searchInput.setAttribute('aria-invalid', 'false')
    const total = state.matches.length
    if (total === 0) {
      this.countLabel.textContent = '0 / 0'
    } else {
      const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 1
      this.countLabel.textContent = total >= 1500 ? '1500+ 处' : `${current} / ${total}`
    }
    this.bar.setStatus(this.countLabel.textContent || '', '', total > 0, !this.view.editable)
  }

  findNext() {
    if (!this.isOpen) { this.open(false); return }
    const state = this.pluginState
    if (!state || !state.matches.length) return
    const nextIndex = (state.currentIndex + 1) % state.matches.length
    this.setCurrentIndex(nextIndex)
  }

  findPrevious() {
    if (!this.isOpen) { this.open(false); return }
    const state = this.pluginState
    if (!state || !state.matches.length) return
    const prevIndex = (state.currentIndex - 1 + state.matches.length) % state.matches.length
    this.setCurrentIndex(prevIndex)
  }

  private setCurrentIndex(index: number) {
    const tr = this.view.state.tr.setMeta(liveSearchPluginKey, {
      type: 'setCurrentIndex',
      index,
    })
    this.view.dispatch(tr)
    this.updateCount()
    this.revealCurrentMatch()
  }

  private revealCurrentMatch() {
    const state = this.pluginState
    if (!state || state.currentIndex < 0 || state.currentIndex >= state.matches.length) return
    const match = state.matches[state.currentIndex]

    if (match.codeBlockPos !== undefined) {
      // Inside an embedded code block
      for (const codeView of this.codeViewsGetter()) {
        const pos = codeView.getPos?.()
        if (pos === match.codeBlockPos) {
          const from = match.from - pos - 1
          const to = match.to - pos - 1
          codeView.revealSearchMatch(from, to, this.view.hasFocus())
          return
        }
      }
    }

    // Regular prose or heading
    if (match.from >= 0 && match.to <= this.view.state.doc.content.size) {
      const sel = TextSelection.create(this.view.state.doc, match.from, match.to)
      const tr = this.view.state.tr.setSelection(sel).scrollIntoView()
      this.view.dispatch(tr)
    }
  }

  replaceCurrent() {
    const state = this.pluginState
    if (!this.view.editable || this.view.composing || [...this.codeViewsGetter()].some(code => code.isComposing) || !state || !state.valid || state.currentIndex < 0 || state.currentIndex >= state.matches.length) return
    const match = state.matches[state.currentIndex]

    const tr = replaceMatch(this.view.state.tr, match, replacementText(match, this.replaceInput.value, state.options.regexp))
    tr.setMeta('isolated', true)
    this.view.dispatch(tr)

    // After replace, plugin apply recomputes matches
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.updateCount()
      this.syncQueryToCodeBlocks()
      this.revealCurrentMatch()
    }, 20)
  }

  replaceAll() {
    const state = this.pluginState
    if (!this.view.editable || this.view.composing || [...this.codeViewsGetter()].some(code => code.isComposing) || !state || !state.valid || !state.matches.length) return

    // The UI deliberately caps highlights; never silently call a partial batch "all".
    if (state.matches.length >= 1500) {
      window.dispatchEvent(new CustomEvent('editor-notice', { detail: '匹配达到 1500 处显示上限，请缩小查找范围后全部替换。' }))
      return
    }
    const tr = this.view.state.tr
    for (const match of [...state.matches].reverse()) {
      replaceMatch(tr, match, replacementText(match, this.replaceInput.value, state.options.regexp))
    }

    tr.setMeta('isolated', true)
    this.view.dispatch(tr)

    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.updateCount()
      this.syncQueryToCodeBlocks()
    }, 20)
  }

  destroy() {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.dom.remove()
  }
}
