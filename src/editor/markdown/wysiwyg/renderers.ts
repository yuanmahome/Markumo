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
const DIAGRAM_SINGLE_CACHE_MAX_BYTES = 768 * 1024 // Prevent a single giant diagram from evicting the whole cache

// Tiered Mermaid safety budgets:
// - Normal tier: fast path + shared LRU cache
// - Extended tier: supports large real-world architecture/sequence/ER diagrams safely on the serialized queue
// - Hard ceiling: rejects pathological inputs cleanly without affecting Markdown source persistence
export const DIAGRAM_NORMAL_MAX_CHARS = 16_000
export const DIAGRAM_NORMAL_MAX_LINES = 400
export const DIAGRAM_HARD_MAX_CHARS = 50_000
export const DIAGRAM_HARD_MAX_LINES = 1_200
export const DIAGRAM_MAX_EDGES = 500

const MERMAID_SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'htmlLabels',
  'dompurifyConfig',
  'arrowMarkerAbsolute',
  'themeCSS',
]

const FORBIDDEN_CONFIG_KEY_RE =
  /^(?:secure|startOnLoad|maxTextSize|maxEdges|suppressErrorRendering|dompurifyConfig|arrowMarkerAbsolute|themeCSS|__proto__|constructor|prototype)$/i

const SAFE_INTERNAL_HREF_TAGS = new Set([
  'use',
  'textpath',
  'lineargradient',
  'radialgradient',
  'pattern',
  'filter',
  'mpath',
])

const FORBIDDEN_SVG_TAGS = [
  'foreignObject',
  'a',
  'image',
  'feImage',
  'script',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'link',
  'meta',
  'base',
]

const FORBIDDEN_SVG_ATTRS = [
  'onclick',
  'ondblclick',
  'onmousedown',
  'onmouseup',
  'onmouseover',
  'onmousemove',
  'onmouseout',
  'onmouseenter',
  'onmouseleave',
  'onfocus',
  'onblur',
  'onload',
  'onerror',
  'onanimationstart',
  'onanimationend',
  'ontransitionend',
]

const BETA_HINT_KEYWORDS: Record<string, string> = {
  venn: 'venn-beta',
  architecture: 'architecture-beta',
  radar: 'radar-beta',
  treemap: 'treemap-beta',
  wardley: 'wardley-beta',
  treeview: 'treeView-beta',
}

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

// Serialized Mermaid queue (concurrency = 1, bounded queue = 64) with AbortSignal cancellation
const diagramQueue = createRenderTaskQueue(1, 64)
// Bounded KaTeX compile queue (concurrency = 2, bounded queue = 256) with main-thread frame yielding
const mathQueue = createRenderTaskQueue(2, 256)
let mathSliceStart = 0
let diagramRenderCount = 0
let diagramCacheHitCount = 0

export interface RenderCacheStats {
  mathEntries: number
  mathBytes: number
  mathMaxEntries: number
  mathMaxBytes: number
  diagramEntries: number
  diagramBytes: number
  diagramMaxEntries: number
  diagramMaxBytes: number
  diagramRenders: number
  diagramCacheHits: number
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
    diagramRenders: diagramRenderCount,
    diagramCacheHits: diagramCacheHitCount,
    diagramQueue: diagramQueue.stats(),
    mathQueue: mathQueue.stats(),
  }
}

function unquoteScalar(raw: string): string {
  const trimmed = raw.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function hasUnsafeConfigScalarValue(value: string): boolean {
  const decoded = value.replace(/\\u([\da-f]{4})/gi, (_m, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16))
  )
  return (
    /url\s*\(/i.test(decoded) ||
    /@import\b/i.test(decoded) ||
    /expression\s*\(/i.test(decoded) ||
    /(?:javascript|vbscript|data|file)\s*:/i.test(decoded) ||
    /<\s*\/?\s*(?:script|iframe|img|svg|object|embed|style|link|meta)\b/i.test(decoded) ||
    /-moz-binding\s*:/i.test(decoded) ||
    /behavior\s*:/i.test(decoded)
  )
}

function inspectJsonLikeConfigPayload(payload: string, contextLabel: string): void {
  const normalized = payload.replace(/\\u([\da-f]{4})/gi, (_m, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16))
  )
  const keyRegex = /(?:["']([A-Za-z0-9_$.-]+)["']|([A-Za-z0-9_$.-]+))\s*:\s*([^{[,\n}]*)/g
  let match: RegExpExecArray | null
  while ((match = keyRegex.exec(normalized)) !== null) {
    const key = (match[1] ?? match[2] ?? '').trim()
    const rawVal = (match[3] ?? '').trim()
    if (!key) continue
    if (FORBIDDEN_CONFIG_KEY_RE.test(key)) {
      throw new Error(`图表${contextLabel}越权：禁止通过文档配置覆盖安全项 "${key}"。`)
    }
    if (/^securityLevel$/i.test(key)) {
      const val = unquoteScalar(rawVal).toLowerCase()
      if (val !== 'strict') {
        throw new Error(`图表${contextLabel}越权：禁止将 securityLevel 修改为 "${val || '非 strict'}"。`)
      }
    }
    if (/^htmlLabels$/i.test(key)) {
      const val = unquoteScalar(rawVal).toLowerCase()
      if (val === 'true' || val === '1' || val === 'yes' || val === 'on') {
        throw new Error(`图表${contextLabel}受限：严格安全模式下禁止启用 htmlLabels。`)
      }
    }
    if (key.toLowerCase() !== 'title' && hasUnsafeConfigScalarValue(rawVal)) {
      throw new Error(`图表${contextLabel}包含不安全的外部资源或脚本引用。`)
    }
  }
  if (hasUnsafeConfigScalarValue(normalized)) {
    throw new Error(`图表${contextLabel}包含不安全的外部资源或脚本引用。`)
  }
}

function inspectYamlFrontmatter(frontmatterBody: string): void {
  if (/(^|[\s:[{,-])[&*][A-Za-z0-9_]/.test(frontmatterBody) || /(^|\s)!!?[A-Za-z]/.test(frontmatterBody)) {
    throw new Error('图表 Frontmatter 禁止使用 YAML 锚点、别名或自定义类型标签。')
  }
  for (const rawLine of frontmatterBody.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const pair = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*:\s*(.*)$/.exec(trimmed)
    if (!pair) {
      if (hasUnsafeConfigScalarValue(trimmed)) {
        throw new Error('图表 Frontmatter 包含不安全的外部资源或脚本引用。')
      }
      continue
    }
    const key = unquoteScalar(pair[1])
    const rawVal = pair[2].trim()
    if (FORBIDDEN_CONFIG_KEY_RE.test(key)) {
      throw new Error(`图表 Frontmatter 配置越权：禁止修改受保护安全项 "${key}"。`)
    }
    if (/^securityLevel$/i.test(key)) {
      const cleanVal = unquoteScalar(rawVal.replace(/\s+#.*$/, '')).toLowerCase()
      if (cleanVal !== 'strict') {
        throw new Error(`图表 Frontmatter 配置越权：禁止将 securityLevel 修改为 "${cleanVal || '非 strict'}"。`)
      }
    }
    if (/^htmlLabels$/i.test(key)) {
      const cleanVal = unquoteScalar(rawVal.replace(/\s+#.*$/, '')).toLowerCase()
      if (cleanVal === 'true' || cleanVal === '1' || cleanVal === 'yes' || cleanVal === 'on') {
        throw new Error('图表 Frontmatter 配置受限：严格安全模式下禁止启用 htmlLabels。')
      }
    }
    if (key.toLowerCase() !== 'title') {
      if (rawVal.startsWith('{') || rawVal.startsWith('[')) {
        inspectJsonLikeConfigPayload(rawVal, 'Frontmatter 配置')
      } else if (hasUnsafeConfigScalarValue(rawVal)) {
        throw new Error('图表 Frontmatter 配置包含不安全的外部资源或脚本引用。')
      }
    }
  }
}

export interface ValidatedMermaidSource {
  readonly normalized: string
  readonly tier: 'normal' | 'extended'
  readonly lineCount: number
}

/**
 * Validate and normalize Mermaid source text before rendering:
 * - Preserves legitimate arrows (`<|--`, `<..`, `<-->`), generics, Chinese/special labels,
 *   Mermaid v11 `@{ shape: ... }`, `classDef` / `style` / `linkStyle`, YAML frontmatter, and `%%{init:...}%%`.
 * - Blocks security escalations, JS callbacks, dangerous URI protocols, and external resource fetches.
 */
export function validateAndNormalizeMermaidSource(rawSource: string): ValidatedMermaidSource {
  const normalized = rawSource.replace(/\r\n?/g, '\n')
  const charCount = normalized.length
  if (charCount > DIAGRAM_HARD_MAX_CHARS) {
    throw new Error(
      `图表源码超过 ${DIAGRAM_HARD_MAX_CHARS.toLocaleString()} 字符安全预算（当前 ${charCount.toLocaleString()} 字符），已跳过渲染；Markdown 源码仍完整保留。`
    )
  }
  const lineCount = normalized.split('\n').length
  if (lineCount > DIAGRAM_HARD_MAX_LINES) {
    throw new Error(
      `图表源码超过 ${DIAGRAM_HARD_MAX_LINES.toLocaleString()} 行安全预算（当前 ${lineCount.toLocaleString()} 行），已跳过渲染；Markdown 源码仍完整保留。`
    )
  }
  if (!normalized.trim()) {
    throw new Error('Mermaid 图表内容为空，请输入有效的图表定义。')
  }

  let body = normalized
  const fmMatch = /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  if (fmMatch) {
    inspectYamlFrontmatter(fmMatch[1])
    body = normalized.slice(fmMatch[0].length)
  }

  // Inspect %%{ ... }%% directives (legacy init / config)
  const directiveRegex = /%%\{([\s\S]*?)\}%%/g
  let dirMatch: RegExpExecArray | null
  while ((dirMatch = directiveRegex.exec(body)) !== null) {
    inspectJsonLikeConfigPayload(dirMatch[1], 'init 指令')
  }

  // Strip %%{...}%% directives and %% comment lines when checking statement-level security rules
  const bodyWithoutDirectives = body.replace(/%%\{[\s\S]*?\}%%/g, '')

  // Inspect v11 @{ ... } shape blocks: allow vector shapes/labels, forbid external image/icon URLs
  const shapeMetaRegex = /@\{([\s\S]*?)\}/g
  let shapeMatch: RegExpExecArray | null
  while ((shapeMatch = shapeMetaRegex.exec(bodyWithoutDirectives)) !== null) {
    const shapeBody = shapeMatch[1]
    if (/\bimg\s*:/i.test(shapeBody) || /\bicon\s*:\s*["']?(?:https?:|\/\/|data:|file:)/i.test(shapeBody)) {
      throw new Error('图表安全策略：禁止在节点配置中加载外部图片或远程图标资源。')
    }
  }

  for (const rawLine of bodyWithoutDirectives.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('%%')) continue

    // Block JS callbacks on click statements (`click nodeId call fn()` or `click nodeId callback "arg"`)
    if (/^click\s+\S+\s+(?:call|callback)\b/i.test(trimmed)) {
      throw new Error('图表安全策略：严格安全模式下禁止执行 click 脚本回调。')
    }

    // Block dangerous URI protocols in click / link / links directives
    if (
      /^(?:click|links?)\b/i.test(trimmed) &&
      /(?:javascript|vbscript|data|file)\s*:/i.test(trimmed)
    ) {
      throw new Error('图表安全策略：禁止使用危险链接协议（javascript / data / file / vbscript）。')
    }

    // Inspect classDef / style / linkStyle declarations for external url() or CSS script expressions
    if (/^(?:classDef|style|linkStyle)\b/i.test(trimmed)) {
      if (
        /url\s*\(\s*["']?(?!#)/i.test(trimmed) ||
        /@import\b/i.test(trimmed) ||
        /expression\s*\(/i.test(trimmed) ||
        /(?:javascript|vbscript)\s*:/i.test(trimmed) ||
        /-moz-binding\s*:/i.test(trimmed) ||
        /behavior\s*:/i.test(trimmed)
      ) {
        throw new Error('图表安全策略：样式定义中禁止引用外部资源或可执行表达式。')
      }
    }
  }

  const tier =
    charCount <= DIAGRAM_NORMAL_MAX_CHARS && lineCount <= DIAGRAM_NORMAL_MAX_LINES
      ? 'normal'
      : 'extended'

  return { normalized, tier, lineCount }
}

function extractLeadingDiagramKeyword(source: string): string {
  let rest = source.replace(/\r\n?/g, '\n')
  const fmMatch = /^\s*---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(rest)
  if (fmMatch) rest = rest.slice(fmMatch[0].length)
  rest = rest.replace(/%%\{[\s\S]*?\}%%/g, '')
  for (const line of rest.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%')) continue
    const token = /^([A-Za-z0-9_-]+)/.exec(trimmed)?.[1]
    return token || trimmed.slice(0, 32)
  }
  return ''
}

export function formatMermaidError(error: unknown, source: string): string {
  const rawMessage = (error instanceof Error ? error.message : String(error ?? ''))
    .replace(/^Error:\s*/i, '')
    .trim()

  if (!rawMessage) {
    return '图表语法无效或暂不支持该图表类型；Markdown 源码仍完整保留。'
  }

  // Already a user-facing Chinese budget or security message
  if (/^图表(?:源码超过|安全策略|配置|Frontmatter|init 指令|连线)/.test(rawMessage)) {
    return rawMessage
  }

  if (/maxEdges|Too many edges|Maximum number of edges/i.test(rawMessage)) {
    return `图表连线数超过 ${DIAGRAM_MAX_EDGES} 条安全预算，已跳过渲染；Markdown 源码仍完整保留。`
  }

  if (/Maximum text size in diagram exceeded/i.test(rawMessage)) {
    return `图表源码超过 ${DIAGRAM_HARD_MAX_CHARS.toLocaleString()} 字符安全预算，已跳过渲染；Markdown 源码仍完整保留。`
  }

  if (/UnknownDiagramError|No diagram type detected/i.test(rawMessage)) {
    const keyword = extractLeadingDiagramKeyword(source)
    const betaHint = keyword ? BETA_HINT_KEYWORDS[keyword.toLowerCase()] : undefined
    if (betaHint) {
      return `暂不支持图表关键字 "${keyword}"（当前 Mermaid 11.16.1 请使用 "${betaHint}"）；Markdown 源码仍完整保留。`
    }
    return keyword
      ? `暂不支持 Mermaid 图表类型 "${keyword}"（当前版本未内置该语法）；Markdown 源码仍完整保留。`
      : '未能识别 Mermaid 图表类型，请检查首行图表声明；Markdown 源码仍完整保留。'
  }

  const compact = rawMessage.split('\n').slice(0, 4).join('\n')
  return `Mermaid 语法错误：${compact}`
}

/**
 * Pre-normalize Mermaid SVG in an inert DOMParser document BEFORE DOMPurify runs:
 * 1. Convert `<foreignObject>` labels (e.g. `journey` tasks/sections) into plain-text SVG `<text>`
 *    so labels remain visible while `<foreignObject>` stays strictly forbidden in DOMPurify.
 * 2. Convert `<a>` wrappers into inert `<g>` elements preserving `transform`/`class` geometry
 *    while completely stripping clickable `href` / `xlink:href` navigation.
 */
function preNormalizeMermaidSvg(rawSvg: string): string {
  if (typeof DOMParser === 'undefined') return rawSvg
  const doc = new DOMParser().parseFromString(rawSvg, 'text/html')
  const svg = doc.querySelector('svg')
  if (!svg) return rawSvg

  const svgNs = 'http://www.w3.org/2000/svg'

  for (const fo of [...svg.querySelectorAll('foreignObject')]) {
    const labelText = (fo.textContent || '').replace(/\s+/g, ' ').trim()
    if (!labelText) {
      fo.remove()
      continue
    }
    const x = Number.parseFloat(fo.getAttribute('x') || '0') || 0
    const y = Number.parseFloat(fo.getAttribute('y') || '0') || 0
    const w = Number.parseFloat(fo.getAttribute('width') || '0') || 0
    const h = Number.parseFloat(fo.getAttribute('height') || '0') || 0
    const textEl = doc.createElementNS(svgNs, 'text')
    textEl.setAttribute('x', String(x + w / 2))
    textEl.setAttribute('y', String(y + h / 2))
    textEl.setAttribute('text-anchor', 'middle')
    textEl.setAttribute('dominant-baseline', 'central')
    const innerDiv = fo.querySelector('[class]')
    const safeClass = innerDiv?.getAttribute('class')?.replace(/[^A-Za-z0-9_\s-]/g, '').trim()
    textEl.setAttribute('class', safeClass ? `markumo-fo-text ${safeClass}` : 'markumo-fo-text label')
    textEl.textContent = labelText
    fo.replaceWith(textEl)
  }

  for (const anchor of [...svg.querySelectorAll('a')]) {
    const group = doc.createElementNS(svgNs, 'g')
    const transform = anchor.getAttribute('transform')
    if (transform) group.setAttribute('transform', transform)
    const cls = anchor.getAttribute('class')?.replace(/\bclickable\b/g, '').trim()
    if (cls) group.setAttribute('class', cls)
    const id = anchor.getAttribute('id')
    if (id) group.setAttribute('id', id)
    while (anchor.firstChild) {
      group.appendChild(anchor.firstChild)
    }
    anchor.replaceWith(group)
  }

  for (const clickable of svg.querySelectorAll('.clickable')) {
    clickable.classList.remove('clickable')
  }

  return svg.outerHTML
}

function sanitizeInlineStyleValue(
  rawStyle: string,
  rewriteLocalUrls: (val: string) => string
): string {
  if (!rawStyle) return ''
  const kept: string[] = []
  for (const decl of rawStyle.split(';')) {
    const colon = decl.indexOf(':')
    if (colon < 0) continue
    const prop = decl.slice(0, colon).trim()
    const rawVal = decl.slice(colon + 1).trim()
    if (!prop || !rawVal) continue
    if (/^(?:position|behavior|-moz-binding)$/i.test(prop)) continue
    const rewritten = rewriteLocalUrls(rawVal)
    if (
      /url\s*\(\s*["']?(?!#markumo-)/i.test(rewritten) ||
      /@import\b/i.test(rewritten) ||
      /expression\s*\(/i.test(rewritten) ||
      /(?:javascript|vbscript|data)\s*:/i.test(rewritten)
    ) {
      continue
    }
    kept.push(`${prop}: ${rewritten}`)
  }
  return kept.join('; ')
}

/**
 * Namespace all `[id]`, `url(#id)`, internal `#id` hrefs, and `<style>` selector/declaration
 * references inside an inert container so multiple mounted diagrams and modal previews
 * never collide on markers, clipPaths, filters, gradients, or scoped CSS rules.
 */
function namespaceSvgContainer(root: ParentNode, prefix = `markumo-mount-${++identity}-`): void {
  const ids = new Map<string, string>()
  for (const element of root.querySelectorAll('[id]')) {
    const old = element.id
    if (!old) continue
    const next = prefix + ids.size
    ids.set(old, next)
    element.id = next
  }

  // Rewrite `url(#knownId)` -> `url(#namespacedId)`; strip ANY unknown or external `url(...)`!
  const rewriteUrls = (value: string) =>
    value.replace(/url\(\s*(["']?)([^)'"]+)\1\s*\)/gi, (_original, _quote, rawTarget: string) => {
      const trimmed = rawTarget.trim()
      if (trimmed.startsWith('#')) {
        const mapped = ids.get(trimmed.slice(1))
        return mapped ? `url(#${mapped})` : 'none'
      }
      return 'none'
    })

  const decodeIdentifier = (value: string) =>
    value.replace(/\\([\da-f]{1,6}\s?|.)/gi, (_all, escaped: string) =>
      /^[\da-f]/i.test(escaped) ? String.fromCodePoint(parseInt(escaped.trim(), 16)) : escaped
    )

  for (const element of root.querySelectorAll('*')) {
    const tagLower = element.localName.toLowerCase()
    for (const attribute of [...element.attributes]) {
      const attrName = attribute.name
      const attrLower = attrName.toLowerCase()
      if (attrLower === 'id') continue

      if (attrLower.startsWith('on')) {
        element.removeAttribute(attrName)
        continue
      }

      if (attrLower === 'href' || attrLower === 'xlink:href') {
        const trimmed = attribute.value.trim()
        if (SAFE_INTERNAL_HREF_TAGS.has(tagLower) && trimmed.startsWith('#')) {
          const mapped = ids.get(trimmed.slice(1))
          if (mapped) {
            element.setAttribute(attrName, `#${mapped}`)
            continue
          }
        }
        element.removeAttribute(attrName)
        continue
      }

      if (attrLower === 'style') {
        const cleanStyle = sanitizeInlineStyleValue(attribute.value, rewriteUrls)
        if (cleanStyle) element.setAttribute(attrName, cleanStyle)
        else element.removeAttribute(attrName)
        continue
      }

      let value = rewriteUrls(attribute.value)
      if (attrLower === 'aria-labelledby' || attrLower === 'aria-describedby') {
        value = value
          .split(/\s+/)
          .map(id => ids.get(id) ?? id)
          .join(' ')
      }
      element.setAttribute(attrName, value)
    }

    if (tagLower === 'style') {
      try {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(element.textContent ?? '')
        const serializeRules = (rules: CSSRuleList): string[] => {
          const out: string[] = []
          for (const rule of rules) {
            if (rule instanceof CSSStyleRule) {
              rule.selectorText = rule.selectorText.replace(
                /#((?:\\[\da-f]{1,6}\s?|\\.|[\w\u0080-\uFFFF-])+)/gi,
                (original, token: string) => {
                  const mapped = ids.get(decodeIdentifier(token))
                  return mapped ? '#' + CSS.escape(mapped) : original
                }
              )
              for (const property of [...rule.style]) {
                if (/^(?:position|behavior|-moz-binding)$/i.test(property)) {
                  rule.style.removeProperty(property)
                  continue
                }
                const rawVal = rule.style.getPropertyValue(property)
                const rewritten = rewriteUrls(rawVal)
                if (
                  /url\s*\(\s*["']?(?!#markumo-)/i.test(rewritten) ||
                  /@import\b/i.test(rewritten) ||
                  /expression\s*\(/i.test(rewritten) ||
                  /(?:javascript|vbscript|data)\s*:/i.test(rewritten)
                ) {
                  rule.style.removeProperty(property)
                  continue
                }
                rule.style.setProperty(property, rewritten, rule.style.getPropertyPriority(property))
              }
              out.push(rule.cssText)
            } else if (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule) {
              out.push(rule.cssText)
            } else if (typeof CSSMediaRule !== 'undefined' && rule instanceof CSSMediaRule) {
              const nested = serializeRules(rule.cssRules)
              if (nested.length > 0) {
                out.push(`@media ${rule.conditionText} {\n${nested.join('\n')}\n}`)
              }
            }
          }
          return out
        }
        element.textContent = serializeRules(sheet.cssRules).join('\n')
      } catch {
        element.textContent = ''
      }
    }
  }
}

function mountDiagram(host: HTMLElement, sanitized: string) {
  const template = document.createElement('template')
  template.innerHTML = sanitized
  namespaceSvgContainer(template.content, `markumo-mount-${++identity}-`)
  host.classList.remove('md-render-error')
  host.replaceChildren(template.content)
}

/**
 * Clone an already-rendered, sanitized Mermaid `<svg>` element and rewrite all internal IDs,
 * `url(#id)` marker/clipPath/filter/gradient references, `#id` hrefs, and scoped `<style>` rules.
 * Used by MediaPreview so opening the modal never re-invokes `mermaid.render()` and never
 * collides with the underlying document SVG's markers or clipPaths.
 */
export function cloneAndNamespaceSvg(sourceSvg: SVGSVGElement): SVGSVGElement {
  const template = document.createElement('template')
  template.content.append(sourceSvg.cloneNode(true))
  namespaceSvgContainer(template.content, `markumo-preview-${++identity}-`)
  const cloned = template.content.querySelector('svg')
  if (!cloned) {
    throw new Error('无法克隆 SVG 节点')
  }
  return cloned
}

export function clearRenderCaches() {
  mathHtmlCache.clear()
  diagramSvgCache.clear()
  diagramRenderCount = 0
  diagramCacheHitCount = 0
}

/**
 * Shared safe Mermaid SVG compiler (used by Live editor, Split preview, and HTML/PDF Export).
 * Ensures `mermaid.initialize` always enforces `securityLevel: 'strict'`, `suppressErrorRendering: true`,
 * and locked `secure` keys across the entire application.
 */
export async function compileSafeMermaidSvg(
  rawSource: string,
  options: { theme?: 'default' | 'dark'; useCache?: boolean } = {}
): Promise<string> {
  const validated = validateAndNormalizeMermaidSource(rawSource)
  const theme =
    options.theme ??
    (typeof document !== 'undefined' && document.body.classList.contains('light') ? 'default' : 'dark')
  const useCache = options.useCache !== false
  const cacheKey = `v2:${theme === 'default' ? 'L' : 'D'}:${validated.normalized}`

  if (useCache) {
    const hit = diagramSvgCache.get(cacheKey)
    if (hit !== undefined) {
      diagramCacheHitCount++
      return hit
    }
  }

  const [{ default: mermaid }, { default: purify }] = await loadDiagramModules()

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: DIAGRAM_HARD_MAX_CHARS,
    maxEdges: DIAGRAM_MAX_EDGES,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    secure: MERMAID_SECURE_KEYS,
    theme,
  })

  const id = `markumo-diagram-${++identity}`
  try {
    await mermaid.parse(validated.normalized)
    // Verify active config was not escalated
    const activeCfg = mermaid.mermaidAPI.getConfig()
    if (activeCfg.securityLevel !== 'strict') {
      mermaid.mermaidAPI.reset()
      throw new Error('图表安全策略：检测到非法 securityLevel 变更，已中止渲染。')
    }

    const { svg } = await mermaid.render(id, validated.normalized)
    diagramRenderCount++

    const preNormalized = preNormalizeMermaidSvg(svg)
    const cleaned = sanitizeMarkup(purify, preNormalized, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: FORBIDDEN_SVG_TAGS,
      FORBID_ATTR: FORBIDDEN_SVG_ATTRS,
    })

    if (!cleaned || !cleaned.includes('<svg')) {
      throw new Error('图表渲染结果为空或包含不受支持的内容。')
    }

    const approxBytes = (cacheKey.length + cleaned.length) * 2
    if (useCache && approxBytes <= DIAGRAM_SINGLE_CACHE_MAX_BYTES) {
      diagramSvgCache.set(cacheKey, cleaned)
    }

    return cleaned
  } catch (err) {
    throw new Error(formatMermaidError(err, validated.normalized))
  } finally {
    try {
      mermaid.mermaidAPI.reset()
    } catch {
      // Ignore reset errors on failed initialization
    }
    if (typeof document !== 'undefined') {
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
    }
  }
}

export async function renderDiagram(
  host: HTMLElement,
  source: string,
  current: () => boolean = () => true,
  signal?: AbortSignal
) {
  let validated: ValidatedMermaidSource
  try {
    validated = validateAndNormalizeMermaidSource(source)
  } catch (err) {
    throw new Error(formatMermaidError(err, source))
  }

  if (signal?.aborted || !host.isConnected || !current()) return

  const isLight = typeof document !== 'undefined' && document.body.classList.contains('light')
  const theme: 'default' | 'dark' = isLight ? 'default' : 'dark'
  const cacheKey = `v2:${isLight ? 'L' : 'D'}:${validated.normalized}`
  const cachedSvg = diagramSvgCache.get(cacheKey)

  if (cachedSvg !== undefined) {
    if (!host.isConnected || !current() || signal?.aborted) return
    diagramCacheHitCount++
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
          diagramCacheHitCount++
          mountDiagram(host, queuedCache)
          return
        }

        const cleaned = await compileSafeMermaidSvg(validated.normalized, { theme, useCache: true })
        if (!signal?.aborted && host.isConnected && current()) {
          mountDiagram(host, cleaned)
        }
      },
      { signal, priority: 'normal' }
    )
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return
    }
    throw err instanceof Error ? err : new Error(formatMermaidError(err, validated.normalized))
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
