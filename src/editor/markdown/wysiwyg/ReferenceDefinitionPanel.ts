import { referenceDefinition } from './MarkdownParser'

/** Outside the ProseMirror content DOM: editing never adds a body placeholder
 * or scrolls the reading surface to an invisible source atom. */
export function referenceDefinitionPanel(raw: string, anchor: HTMLElement, options: {
  change(source: string): boolean
  remove(): void
  history(redo: boolean): void
  closed(): void
  focus(): void
}) {
  const panel = document.createElement('div')
  panel.className = 'md-reference-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '编辑引用定义')
  const url = document.createElement('input')
  url.setAttribute('aria-label', '引用目标 URL')
  const source = document.createElement('textarea')
  source.setAttribute('aria-label', '引用定义源码')
  source.spellcheck = false
  source.rows = Math.min(6, Math.max(2, raw.split('\n').length))
  source.value = raw
  let current = raw, closed = false, blurTimer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    const parts = referenceDefinition(current)
    url.value = parts ? current.slice(parts.from, parts.to) : ''
  }
  refresh()
  const close = (focus = false) => {
    if (closed) return
    closed = true
    clearTimeout(blurTimer)
    panel.remove()
    options.closed()
    if (focus) options.focus()
  }
  const apply = (next: string) => {
    if (!referenceDefinition(next)) { source.setCustomValidity('请保留一条合法引用定义；删除请使用“删除定义”。'); return }
    source.setCustomValidity('')
    if (next === current) return
    if (!options.change(next)) { close(); return }
    current = next
  }
  url.oninput = () => {
    const parts = referenceDefinition(current)
    if (!parts) return
    const next = current.slice(0, parts.from) + url.value + current.slice(parts.to)
    apply(next)
    if (current === next) source.value = next
  }
  source.oninput = () => { apply(source.value); refresh() }
  panel.addEventListener('focusout', () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => { if (!panel.contains(document.activeElement)) close() }, 0)
  })
  panel.onkeydown = event => {
    if (event.isComposing) return
    if (event.key === 'Escape' || event.key === 'Enter' && event.target === url) {
      event.preventDefault(); event.stopPropagation(); close(true)
    } else if ((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); close(true); options.history(event.key.toLowerCase() === 'y' || event.shiftKey)
    }
  }
  const done = document.createElement('button')
  done.type = 'button'; done.textContent = '完成'; done.onclick = () => close(true)
  const remove = document.createElement('button')
  remove.type = 'button'; remove.textContent = '删除定义'
  remove.onclick = () => { close(); options.remove(); options.focus() }
  panel.append(url, source, done, remove)
  document.body.append(panel)
  const rect = anchor.getBoundingClientRect()
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`
  panel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - panel.offsetHeight - 8))}px`
  url.focus({preventScroll: true})
  url.select()
  return close
}
