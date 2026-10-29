import { createRenderTaskQueue, type RenderTaskQueueStats } from '../renderTaskQueue'
import { sanitizeMarkup } from '../html/sanitize'

// Load heavy engines (Mermaid / KaTeX) lazily only for documents containing diagrams or formulas.
let identity = 0

// Vite's CSS preload links keep their load/error callbacks on document.head.
// Keep the import closures outside render tasks so those callbacks cannot retain
// a closed editor through host/current/signal's shared lexical context.
const loadDiagramModules = () => Promise.all([import('mermaid'), import('dompurify')])
const loadMathModules = () => Promise.all([import('katex'), import('katex/dist/katex.min.css')])

// Dual-bounded LRU caches (entry count cap + UTF-16 byte budget cap; never increased above 300 / 30)
export const MATH_CACHE_LIMIT = 300
export const MATH_CACHE_MAX_BYTES = 2 * 1024 * 1024 // 2 MiB

export const DIAGRAM_CACHE_LIMIT = 30
export const DIAGRAM_CACHE_MAX_BYTES = 4 * 1024 * 1024 // 4 MiB

class BoundedStringLruCache {
  private readonly map = new Map<string, { value: string; bytes: number }>()
  private currentBytes = 0

  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number
  ) {}

  get size(): number {
    return this.map.size
  }

  get bytes(): number {
    return this.currentBytes
  }

  get(key: string): string | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: string): void {
    const existing = this.map.get(key)
    if (existing) {
      this.currentBytes = Math.max(0, this.currentBytes - existing.bytes)
      this.map.delete(key)
    }
    const entryBytes = (key.length + value.length) * 2
    // Do not cache a single entry larger than the entire cache budget
    if (entryBytes > this.maxBytes) return

    while (
      this.map.size > 0 &&
      (this.map.size >= this.maxEntries || this.currentBytes + entryBytes > this.maxBytes)
    ) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      const oldest = this.map.get(oldestKey)
      this.map.delete(oldestKey)
      if (oldest) this.currentBytes = Math.max(0, this.currentBytes - oldest.bytes)
    }

    this.map.set(key, { value, bytes: entryBytes })
    this.currentBytes += entryBytes
  }

  clear(): void {
    this.map.clear()
    this.currentBytes = 0
  }
}

const mathHtmlCache = new BoundedStringLruCache(MATH_CACHE_LIMIT, MATH_CACHE_MAX_BYTES)
const diagramSvgCache = new BoundedStringLruCache(DIAGRAM_CACHE_LIMIT, DIAGRAM_CACHE_MAX_BYTES)

// Serialized Mermaid queue (concurrency = 1, bounded queue = 48) with AbortSignal cancellation
const diagramQueue = createRenderTaskQueue(1, 48)
// Bounded KaTeX compile queue (concurrency = 2, bounded queue = 256) with main-thread frame yielding
const mathQueue = createRenderTaskQueue(2, 256)
let mathSliceStart = 0

export interface RenderCacheStats {
  mathEntries: number
  mathBytes: number
  mathMaxEntries: number
  mathMaxBytes: number
  diagramEntries: number
  diagramBytes: number
  diagramMaxEntries: number
  diagramMaxBytes: number
  diagramQueue: RenderTaskQueueStats
  mathQueue: RenderTaskQueueStats
}

export function getRenderCacheStats(): RenderCacheStats {
  return {
    mathEntries: mathHtmlCache.size,
    mathBytes: mathHtmlCache.bytes,
    mathMaxEntries: mathHtmlCache.maxEntries,
    mathMaxBytes: mathHtmlCache.maxBytes,
    diagramEntries: diagramSvgCache.size,
    diagramBytes: diagramSvgCache.bytes,
    diagramMaxEntries: diagramSvgCache.maxEntries,
    diagramMaxBytes: diagramSvgCache.maxBytes,
    diagramQueue: diagramQueue.stats(),
    mathQueue: mathQueue.stats(),
  }
}

/** Namespace a sanitized DOM fragment on every mount, including cache hits.
 * Rewrite CSS through CSSOM so selectors and declarations remain separate. */
function mountDiagram(host: HTMLElement, sanitized: string) {
  const template = document.createElement('template')
  template.innerHTML = sanitized
  const ids = new Map<string, string>()
  const prefix = `markumo-mount-${++identity}-`
  for (const element of template.content.querySelectorAll('[id]')) {
    const old = element.id
    const next = prefix + ids.size
    ids.set(old, next)
    element.id = next
  }
  const urls = (value: string) =>
    value.replace(/url\(\s*(["']?)#([^\s)'"]+)\1\s*\)/g, (original, _quote, id: string) =>
      ids.has(id) ? `url(#${ids.get(id)})` : original
    )
  const decodeIdentifier = (value: string) =>
    value.replace(/\\([\da-f]{1,6}\s?|.)/gi, (_all, escaped: string) =>
      /^[\da-f]/i.test(escaped) ? String.fromCodePoint(parseInt(escaped.trim(), 16)) : escaped
    )
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name === 'id') continue
      let value = urls(attribute.value)
      if (['aria-labelledby', 'aria-describedby'].includes(attribute.name)) {
        value = value
          .split(/\s+/)
          .map(id => ids.get(id) ?? id)
          .join(' ')
      }
      if (['href', 'xlink:href'].includes(attribute.name) && value.startsWith('#')) {
        value = '#' + (ids.get(value.slice(1)) ?? value.slice(1))
      }
      element.setAttribute(attribute.name, value)
    }
    if (element.localName === 'style') {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(element.textContent ?? '')
      const rewrite = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            rule.selectorText = rule.selectorText.replace(
              /#((?:\\[\da-f]{1,6}\s?|\\.|[\w\u0080-\uFFFF-])+)/gi,
              (original, token: string) => {
                const id = ids.get(decodeIdentifier(token))
                return id ? '#' + CSS.escape(id) : original
              }
            )
            for (const property of rule.style) {
              rule.style.setProperty(
                property,
                urls(rule.style.getPropertyValue(property)),
                rule.style.getPropertyPriority(property)
              )
            }
          } else if ('cssRules' in rule) {
            rewrite((rule as CSSGroupingRule).cssRules)
          }
        }
      }
      rewrite(sheet.cssRules)
      element.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n')
    }
  }
  host.replaceChildren(template.content)
}

export function clearRenderCaches() {
  mathHtmlCache.clear()
  diagramSvgCache.clear()
}

export async function renderDiagram(
  host: HTMLElement,
  source: string,
  current: () => boolean = () => true,
  signal?: AbortSignal
) {
  if (source.length > 8000 || source.split('\n').length > 200) {
    throw new Error('图表超过 8000 字符 / 200 行安全预算，请编辑源码。')
  }
  if (/%%\{|^\s*---|@\{|<|https?:|url\s*\(|\b(?:click|href|callback|linkStyle|classDef|style)\b/im.test(source)) {
    throw new Error('图表中的配置、资源、样式、外链和回调未启用。')
  }
  if (signal?.aborted || !host.isConnected || !current()) return

  const isLight = typeof document !== 'undefined' && document.body.classList.contains('light')
  const cacheKey = `${isLight ? 'L:' : 'D:'}${source}`
  const cachedSvg = diagramSvgCache.get(cacheKey)

  if (cachedSvg !== undefined) {
    if (!host.isConnected || !current() || signal?.aborted) return
    mountDiagram(host, cachedSvg)
    return
  }

  try {
    await diagramQueue(
      async () => {
        if (signal?.aborted || !host.isConnected || !current()) return
        if (typeof document !== 'undefined' && document.hidden) return

        // Another pane or earlier queued item may have populated the cache while we waited
        const queuedCache = diagramSvgCache.get(cacheKey)
        if (queuedCache !== undefined) {
          mountDiagram(host, queuedCache)
          return
        }

        const [{ default: mermaid }, { default: purify }] = await loadDiagramModules()
        if (signal?.aborted || !host.isConnected || !current()) return

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          maxTextSize: 8000,
          maxEdges: 200,
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: isLight ? 'default' : 'dark',
        })

        const id = `markumo-diagram-${++identity}`
        try {
          const { svg } = await mermaid.render(id, source)
          const cleaned = sanitizeMarkup(purify, svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject', 'a', 'image', 'script', 'iframe'],
            FORBID_ATTR: ['href', 'xlink:href', 'onclick', 'onload'],
          })
          // Store sanitized result in shared cache even if this specific caller navigated away,
          // so another pane displaying the same diagram can still reuse it safely!
          diagramSvgCache.set(cacheKey, cleaned)

          if (!signal?.aborted && host.isConnected && current()) {
            mountDiagram(host, cleaned)
          }
        } finally {
          document.getElementById('d' + id)?.remove()
        }
      },
      { signal, priority: 'normal' }
    )
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return
    }
    throw err
  }
}

export async function renderMath(
  host: HTMLElement,
  source: string,
  displayMode = false,
  current: () => boolean = () => true,
  signal?: AbortSignal
) {
  if (source.length > 4096) throw new Error('公式超过 4096 字符预算，请编辑源码。')
  if (signal?.aborted || !host.isConnected || !current()) return

  const cacheKey = `${displayMode ? 'D:' : 'I:'}${source}`
  const cachedHtml = mathHtmlCache.get(cacheKey)
  if (cachedHtml !== undefined) {
    if (!host.isConnected || !current() || signal?.aborted) return
    host.innerHTML = cachedHtml
    return
  }

  try {
    await mathQueue(
      async () => {
        if (signal?.aborted || !host.isConnected || !current()) return
        if (typeof document !== 'undefined' && document.hidden) return

        const hit = mathHtmlCache.get(cacheKey)
        if (hit !== undefined) {
          host.innerHTML = hit
          return
        }

        // Yield to browser frame if continuous formula compilation slice exceeds 10ms
        const now = typeof performance !== 'undefined' ? performance.now() : 0
        if (mathSliceStart > 0 && now - mathSliceStart > 10) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          mathSliceStart = typeof performance !== 'undefined' ? performance.now() : 0
          if (signal?.aborted || !host.isConnected || !current()) return
        } else if (mathSliceStart === 0 || now - mathSliceStart > 50) {
          mathSliceStart = now
        }

        const [{ default: katex }] = await loadMathModules()
        if (signal?.aborted || !host.isConnected || !current()) return

        const html = katex.renderToString(source, {
          displayMode,
          trust: false,
          strict: 'error',
          throwOnError: false,
          maxExpand: 200,
          maxSize: 20,
        })

        mathHtmlCache.set(cacheKey, html)

        if (!signal?.aborted && host.isConnected && current()) {
          host.innerHTML = html
        }
      },
      { signal, priority: 'normal' }
    )
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return
    }
    throw err
  }
}
