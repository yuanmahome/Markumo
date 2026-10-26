export interface RenderVisibilityOptions {
  root?: Element | null
  rootMargin?: string
}

export interface RenderVisibilityState {
  readonly visible: boolean
  readonly nearViewport: boolean
  readonly documentHidden: boolean
}

/**
 * Observe both viewport intersection (against the real pane scroll container)
 * and document visibility (`document.hidden`).
 * Falls back to visible when `IntersectionObserver` is unavailable (e.g. static export).
 */
export function observeRenderVisibility(
  element: HTMLElement,
  options: RenderVisibilityOptions,
  onChange: (state: RenderVisibilityState) => void
): () => void {
  const doc = element.ownerDocument
  let nearViewport = typeof IntersectionObserver !== 'function'
  let disposed = false

  const notify = () => {
    if (disposed) return
    const documentHidden = !!doc.hidden
    onChange({
      visible: nearViewport && !documentHidden,
      nearViewport,
      documentHidden,
    })
  }

  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          entries => {
            if (disposed) return
            for (const entry of entries) {
              if (entry.target === element) {
                nearViewport = entry.isIntersecting
                notify()
              }
            }
          },
          {
            root: options.root ?? null,
            rootMargin: options.rootMargin ?? '400px 0px 400px 0px',
          }
        )
      : null

  observer?.observe(element)
  doc.addEventListener('visibilitychange', notify)
  if (typeof IntersectionObserver !== 'function') {
    notify()
  }

  return () => {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    doc.removeEventListener('visibilitychange', notify)
  }
}
