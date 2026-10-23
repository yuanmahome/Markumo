/**
 * The single allow-listed bridge between an image node and the one HTML form we
 * write for sized/aligned images.
 *
 * Only the attributes this editor itself emits are accepted. Anything else —
 * event handlers, arbitrary CSS, srcset, unknown attributes — makes the element fall
 * back to the inert "protected source" block so hostile document content can
 * never become executable markup or an editable node with smuggled state.
 */

export interface ControlledImage {
  src: string
  alt: string
  title: string | null
  width: string | null
  align: 'left' | 'center' | 'right' | null
  zoom?: number | null
}

const ALLOWED_ATTRIBUTES = new Set(['src', 'alt', 'title', 'width', 'align', 'style'])
const ALIGNMENTS = new Set(['left', 'center', 'right'])
/** `auto`, a percentage, or an explicit pixel width. Nothing else is persisted. */
const WIDTH_PATTERN = /^(?:auto|\d{1,4}%|\d{1,5}(?:px)?)$/
/** Only a single, self-contained `<img … />` element may be recognised. */
const IMAGE_PATTERN = /^<img((?:\s+[a-zA-Z][\w-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*\/?>$/i
const ATTRIBUTE_PATTERN = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** Percentage of the natural (or explicitly sized) image, as used by Typora. */
export function normalizeImageZoom(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1000) return null
  return Math.round(value * 100) / 100
}

export function normalizeImageWidth(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  return WIDTH_PATTERN.test(text) ? text : null
}

export function normalizeImageAlign(value: unknown): ControlledImage['align'] {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ALIGNMENTS.has(text) ? (text as ControlledImage['align']) : null
}

/** Strict HTML/XML attribute escaping for the controlled `<img>` writer. */
export function escapeHtmlAttribute(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Recognises exactly the `<img>` spelling this editor writes and returns the
 * image attributes. Returns `null` for anything else, including any extra
 * attribute, so the caller keeps such markup inert.
 */
export function parseControlledImageHtml(source: string): ControlledImage | null {
  const text = source.trim().replace(/\r\n/g, '\n')
  const element = IMAGE_PATTERN.exec(text)
  if (!element) return null

  const values = new Map<string, string>()
  for (const match of element[1].matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase()
    if (!ALLOWED_ATTRIBUTES.has(name) || values.has(name)) return null
    const raw = match[2] ?? match[3] ?? ''
    // Entities are not decoded: a destination must stay exactly what was written.
    if (raw.includes('&')) {
      const decoded = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      values.set(name, decoded)
    } else {
      values.set(name, raw)
    }
  }

  const src = values.get('src')
  if (src === undefined) return null
  // A destination must never carry markup-significant characters after unquoting.
  if (/[\0\r\n]/.test(src)) return null

  const width = normalizeImageWidth(values.get('width'))
  const align = normalizeImageAlign(values.get('align'))
  if (values.has('width') && width === null) return null
  if (values.has('align') && align === null) return null
  let zoom: number | null = null
  if (values.has('style')) {
    const match = /^\s*zoom\s*:\s*(\d+(?:\.\d{1,2})?)%\s*;?\s*$/i.exec(values.get('style')!)
    zoom = match ? normalizeImageZoom(Number(match[1])) : null
    if (zoom === null) return null
  }
  return { src, alt: values.get('alt') ?? '', title: values.get('title') ?? null, width, align, ...(zoom === null ? {} : { zoom }) }
}

/** Writes the controlled `<img>` spelling, escaped and validated. */
export function controlledImageHtml(image: ControlledImage, forceHtml = false): string | null {
  const width = normalizeImageWidth(image.width)
  const align = normalizeImageAlign(image.align)
  const zoom = normalizeImageZoom(image.zoom)
  if (!width && !align && zoom === null && !forceHtml) return null
  const attributes = [`src="${escapeHtmlAttribute(image.src)}"`]
  if (image.alt) attributes.push(`alt="${escapeHtmlAttribute(image.alt)}"`)
  if (image.title) attributes.push(`title="${escapeHtmlAttribute(image.title)}"`)
  if (width) attributes.push(`width="${escapeHtmlAttribute(width)}"`)
  if (align) attributes.push(`align="${escapeHtmlAttribute(align)}"`)
  if (zoom !== null) attributes.push(`style="zoom:${zoom}%;"`)
  return `<img ${attributes.join(' ')} />`
}
