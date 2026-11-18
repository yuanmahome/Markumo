import { type EditorView, type Panel, type ViewUpdate, runScopeHandlers } from '@codemirror/view'
import { getSearchQuery, setSearchQuery, findNext, findPrevious, selectMatches, openSearchPanel, closeSearchPanel } from '@codemirror/search'
import { createSearchBar } from './SearchBar'
import { createSearchQuery, regexError, replaceEditorMatches } from './searchQuery'

const panels = new WeakMap<EditorView, ReturnType<typeof createSearchBar>>()
export function showEditorSearch(view: EditorView, replacement: boolean) {
  if (view.compositionStarted) return true
  if (!panels.has(view)) {
    // CodeMirror seeds an opened panel from the editor selection. Preserve an
    // existing query when reopening; toggling Find/Replace must never replace
    // a capture expression with the currently selected match.
    const previous = getSearchQuery(view.state)
    openSearchPanel(view)
    const query = previous.search ? previous : getSearchQuery(view.state)
    view.dispatch({ effects: setSearchQuery.of(createSearchQuery(query)) })
  }
  const bar = panels.get(view)
  bar?.expand()
  bar?.setReplaceVisible(replacement)
  const field = replacement ? bar?.replace : bar?.search
  field?.focus(); field?.select()
  view.requestMeasure()
  return true
}
export function createEditorSearchPanel(view: EditorView): Panel {
  const bar = createSearchBar({ change: commit, selectAll: true, toggle: () => view.requestMeasure(), run: action => {
    if (action === 'close') { closeSearchPanel(view); view.focus() }
    else if (action === 'previous') findPrevious(view)
    else if (action === 'next') findNext(view)
    else if (action === 'select') selectMatches(view)
    else replaceEditorMatches(view, action === 'replaceAll')
  } })
  const { dom, search, replace, caseSensitive, wholeWord, regexp } = bar
  dom.classList.add('cm-search'); panels.set(view, bar)
  let timer: ReturnType<typeof setTimeout> | undefined, composing = false
  function commit() {
    if (composing) return
    view.dispatch({ effects: setSearchQuery.of(createSearchQuery({ search: search.value, replace: replace.value,
      caseSensitive: caseSensitive.checked, wholeWord: wholeWord.checked, regexp: regexp.checked })) })
  }
  dom.addEventListener('compositionstart', () => { composing = true })
  dom.addEventListener('compositionend', () => { composing = false; commit() })
  function sync() {
    const query = getSearchQuery(view.state)
    if (!composing) {
      if (search.value !== query.search) search.value = query.search
      if (replace.value !== query.replace) replace.value = query.replace
    }
    caseSensitive.checked = query.caseSensitive; wholeWord.checked = query.wholeWord; regexp.checked = query.regexp
    const error = regexError(query)
    bar.setStatus(error ? '无效正则' : '', error, false, view.state.readOnly)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!query.search || error) return
      const cursor = query.getCursor(view.state); let total = 0, current = 0
      for (let item = cursor.next(); !item.done; item = cursor.next()) {
        total++; if (item.value.from === view.state.selection.main.from && item.value.to === view.state.selection.main.to) current = total
        if (total > 1500) break
      }
      bar.setStatus(total > 1500 ? '1500+ 处' : current ? `${current} / ${total}` : `0 / ${total}`, '', total > 0, view.state.readOnly)
    }, 60)
  }
  dom.onkeydown = event => {
    if (event.isComposing || composing || event.keyCode === 229) return
    if (event.key === 'Escape') { closeSearchPanel(view); view.focus(); event.preventDefault(); event.stopPropagation() }
    else if (event.key === 'F3' || (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox')) {
      event.shiftKey ? findPrevious(view) : findNext(view); event.preventDefault(); event.stopPropagation()
    } else if (runScopeHandlers(view, event, 'search-panel')) { event.preventDefault(); event.stopPropagation() }
  }
  sync()
  return { dom, top: true, mount() { bar.mount(view.dom); bar.expand(); search.focus(); search.select() }, update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.transactions.some(tr => tr.effects.some(effect => effect.is(setSearchQuery)))) sync()
  }, destroy() { if (timer) clearTimeout(timer); bar.destroy(); panels.delete(view) } }
}
