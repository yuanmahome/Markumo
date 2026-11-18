import { commonIconPaths } from '../../components/common/iconPaths'
import './searchPanel.css'

export type SearchAction = 'previous' | 'next' | 'close' | 'replace' | 'replaceAll' | 'select'
let nextId = 0
export function createSearchBar(actions: { change: () => void; run: (action: SearchAction) => void; toggle?: () => void; selectAll?: boolean }) {
  const dom = document.createElement('div'); dom.className = 'fleet-search'
  dom.setAttribute('role', 'search'); dom.setAttribute('aria-label', '文档查找和替换')
  const grid = document.createElement('div'); grid.className = 'search-grid'
  const input = (name: string, label: string) => {
    const el = document.createElement('input'); el.type = 'text'; el.name = name; el.placeholder = label; el.autocomplete = 'off'; el.spellcheck = false
    el.className = 'search-input'; el.setAttribute('aria-label', label); el.oninput = actions.change; return el
  }
  const search = input('search', '查找'), replace = input('replace', '替换')
  search.setAttribute('main-field', 'true')
  const field = document.createElement('div'); field.className = 'search-field'; field.append(search)
  const controls = document.createElement('div'); controls.className = 'search-controls'
  const options = document.createElement('div'); options.className = 'search-options'
  const more = document.createElement('button'); more.type = 'button'; more.className = 'search-more'; more.textContent = '⋯'; more.title = '搜索选项'; more.setAttribute('aria-label', '更多搜索选项'); more.setAttribute('aria-expanded','false')
  const optionItems = document.createElement('div'); optionItems.className = 'search-option-items'
  more.onclick = () => { optionItems.hidden = !optionItems.hidden; more.setAttribute('aria-expanded',String(!optionItems.hidden)) }
  options.append(more, optionItems); controls.append(options)
  const navigation = document.createElement('div'); navigation.className = 'search-navigation'
  const count = document.createElement('span'); count.className = 'search-count'; count.setAttribute('aria-live', 'polite')
  const error = document.createElement('div'); error.className = 'search-error'; error.id = `search-error-${++nextId}`; error.setAttribute('role', 'status'); error.hidden = true
  const icon = (name: keyof typeof commonIconPaths) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('search-icon')
    const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', commonIconPaths[name]); svg.append(p); return svg
  }
  const button = (name: string, label: string, glyph: keyof typeof commonIconPaths, action: () => void) => {
    const el = document.createElement('button'); el.type = 'button'; el.name = name; el.title = label; el.setAttribute('aria-label', label); el.append(icon(glyph)); el.onclick = action; return el
  }
  const option = (name: string, label: string, glyph: keyof typeof commonIconPaths) => {
    const wrapper = document.createElement('label'); wrapper.className = 'search-option'; wrapper.title = label
    const el = document.createElement('input'); el.type = 'checkbox'; el.name = name; el.setAttribute('aria-label', label); el.onchange = actions.change
    const caption = document.createElement('span'); caption.append(icon(glyph)); wrapper.append(el, caption); optionItems.append(wrapper); return el
  }
  const caseSensitive = option('case', '区分大小写', 'matchCase'), wholeWord = option('word', '全词匹配', 'wholeWord'), regexp = option('re', '使用正则表达式', 'regex')
  const previous = button('prev', '上一个匹配 (Shift+Enter / Shift+F3)', 'arrowUp', () => actions.run('previous'))
  const next = button('next', '下一个匹配 (Enter / F3)', 'arrowDown', () => actions.run('next'))
  if (actions.selectAll) optionItems.append(button('select', '选择全部匹配', 'selectMatches', () => actions.run('select')))
  navigation.append(count, previous, next, button('close', '关闭查找 (Esc)', 'close', () => actions.run('close')))
  const second = document.createElement('div'); second.className = 'search-replace-row search-row'; second.hidden = true
  const spacer = document.createElement('span'); spacer.className = 'search-spacer'; spacer.setAttribute('aria-hidden', 'true')
  const replaceActions = document.createElement('div'); replaceActions.className = 'search-replace-actions'
  const replaceOne = button('replace', '替换当前匹配', 'replace', () => actions.run('replace'))
  const replaceAll = button('replaceAll', '全部替换', 'replaceAll', () => actions.run('replaceAll'))
  replaceActions.append(replaceOne, replaceAll); second.append(spacer, replace, replaceActions)
  const toggle = button('toggleReplace', '展开/收起替换', 'chevronRight', () => { setReplaceVisible(second.hidden); actions.toggle?.() })
  toggle.className = 'search-toggle'; toggle.setAttribute('aria-expanded', 'false')
  grid.append(toggle, field, controls, navigation, second); dom.append(grid, error)
  const compact = button('expandSearch', '展开/收起文档搜索', 'search', () => {
    dom.classList.toggle('search-expanded'); if (dom.classList.contains('search-expanded')) search.focus()
  })
  compact.className = 'search-compact-toggle'; dom.prepend(compact)
  let observer: ResizeObserver | undefined
  function expand() { dom.classList.add('search-expanded') }
  function mount(container: HTMLElement) {
    observer?.disconnect()
    const resize = () => {
      const width = container.getBoundingClientRect().width
      const size = width < 320 ? 'tiny' : width < 500 ? 'narrow' : width < 800 ? 'compact' : 'full'
      if (size !== dom.dataset.size) {
        const inline = size === 'full' || size === 'compact'
        optionItems.classList.toggle('search-options-menu',!inline)
        ;(inline ? options : grid).append(optionItems)
        optionItems.hidden = !inline; more.setAttribute('aria-expanded',String(inline))
      }
      dom.dataset.size = size
      dom.style.setProperty('--search-max-height',`${Math.max(32,container.clientHeight-16)}px`)
    }
    observer = new ResizeObserver(resize); observer.observe(container); resize()
  }
  function setReplaceVisible(visible: boolean) {
    second.hidden = !visible; dom.classList.toggle('search-with-replace', visible); toggle.setAttribute('aria-expanded', String(visible))
    toggle.replaceChildren(icon(visible ? 'chevronDown' : 'chevronRight'))
  }
  function setStatus(text: string, message: string, hasMatches: boolean, readOnly = false) {
    count.textContent = text; count.title = text; error.textContent = message; error.hidden = !message
    search.setAttribute('aria-invalid', String(!!message)); search.setAttribute('aria-describedby', error.id)
    previous.disabled = next.disabled = !hasMatches || !!message
    replaceOne.disabled = replaceAll.disabled = readOnly || !hasMatches || !!message
  }
  return { dom, search, replace, count, error, caseSensitive, wholeWord, regexp, second, toggle, setReplaceVisible, setStatus, expand, mount, destroy: () => observer?.disconnect() }
}
