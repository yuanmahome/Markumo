/**
 * Conservative Front Matter reader and value-preserving field updater.
 *
 * This is not a YAML implementation and must never pretend to be one. It reads
 * only the flat `key: scalar` / `key:` + `- item` shapes it can round-trip
 * exactly, and reports anything else as *not visually editable* so the card
 * falls back to the source editor instead of silently rewriting the YAML.
 */

export interface FrontMatterValueSpan {
  /** Offset of the value inside the whole front matter block. */
  from: number
  to: number
  /** Quote style used in the source, so an update can keep it. */
  quote: '"' | "'" | ''
  /** Trailing comment on the same line, preserved verbatim. */
  comment: string
  multiline: boolean
}

export interface ParsedFrontMatter {
  valid: boolean
  error?: string
  raw: string
  title?: string
  tags: string[]
  created?: string
  updated?: string
  status?: string
  otherCount: number
  fields: Record<string, string | string[]>
  /** False when the block uses YAML this module cannot rewrite safely. */
  editable: boolean
  /** Why visual editing is unavailable, in user-facing words. */
  unsafeReason?: string
  /** Exact byte spans for the fields the card can edit. */
  spans: Record<string, FrontMatterValueSpan>
  /** The front matter body line ending, so updates keep CRLF files intact. */
  newline: string
}

const BLOCK_PATTERN = /^---(\r?\n)([\s\S]*?)(\r?\n)(?:---|\.\.\.)(\r?\n|$)/

/** Scan quotes before interpreting YAML punctuation or comments. */
function scan(value: string): { code: string; parts: string[]; safe: boolean } {
  let quote = '', start = 0, end = value.length
  const parts: string[] = []
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue }
      if (ch === quote) {
        if (quote === "'" && value[i + 1] === "'") { i++; continue }
        quote = ''
      }
      continue
    }
    const previous = value.slice(0, i).trimEnd().at(-1)
    if ((ch === '"' || ch === "'") && (!previous || previous === '[' || previous === ',')) { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) { end = i; break }
    if (ch === ',') { parts.push(value.slice(start, i).trim()); start = i + 1 }
  }
  parts.push(value.slice(start, end).trim())
  return { code: value.slice(0, end).trimEnd(), parts, safe: !quote }
}

function scalar(value: string, flow = false): string | null {
  if (!value) return ''
  if (value.startsWith('"')) {
    // JSON escapes form a safe subset of YAML double-quoted escapes.
    try { const decoded: unknown = JSON.parse(value); return typeof decoded === 'string' ? decoded : null } catch { return null }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) return null
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[\[\]{}&*!|>%@`?-]|:\s|\s#/.test(value) || (flow && /[\[\]{},]|:$/.test(value))) return null
  return value
}

function emptyResult(rawSource: string, error: string): ParsedFrontMatter {
  return {
    valid: false,
    error,
    raw: rawSource,
    tags: [],
    otherCount: 0,
    fields: {},
    editable: false,
    unsafeReason: error,
    spans: {},
    newline: '\n',
  }
}

/**
 * Reads a front matter block, exposing value spans for the fields the card edits.
 * Never throws and never evaluates anything.
 */
export function parseFrontMatter(rawSource: string): ParsedFrontMatter {
  const block = BLOCK_PATTERN.exec(rawSource)
  if (!block) return emptyResult(rawSource, '缺少合法的 --- 分隔块')

  const newline = block[1] === '\r\n' ? '\r\n' : '\n'
  const body = block[2]
  const bodyStart = block[0].indexOf(block[1]) + block[1].length

  const fields: Record<string, string | string[]> = {}
  const spans: Record<string, FrontMatterValueSpan> = {}
  const seen = new Set<string>()
  // Any YAML construct this module cannot reproduce byte-exactly disables
  // visual editing; the raw block is never re-serialised by guesswork.
  let editable = true
  let unsafeReason: string | undefined

  const lines = body.split(/\r?\n/)
  let offset = bodyStart
  let currentKey: string | null = null
  let currentList: string[] | null = null

  for (const line of lines) {
    const lineStart = offset
    offset += line.length + newline.length
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const item = /^(\s*)-\s+(.*)$/.exec(line)
    if (item && currentKey) {
      if (currentList) {
        const itemSource = scan(item[2])
        const decoded = itemSource.safe ? scalar(itemSource.code) : null
        if (decoded === null) { editable = false; unsafeReason ??= '包含复杂的列表项' }
        else currentList.push(decoded)
        if (spans[currentKey]) spans[currentKey].multiline = true
      } else { editable = false; unsafeReason ??= '包含复杂的嵌套列表' }
      continue
    }

    const pair = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/.exec(line)
    if (!pair) {
      // Anything that is not a flat key line makes the block unsafe to rewrite.
      editable = false
      unsafeReason ??= `无法安全解析的行：${trimmed.slice(0, 40)}`
      continue
    }

    const key = pair[1]
    if (seen.has(key)) {
      editable = false
      unsafeReason ??= `包含重复字段：${key}`
    }
    seen.add(key)
    currentKey = key
    currentList = null

    // The value span is measured on the raw line: `pair[2]` has already eaten the
    // separating spaces, which would shift the offset into the previous token.
    const colon = line.indexOf(':')
    const afterColon = line.slice(colon + 1)
    const leading = /^[ \t]*/.exec(afterColon)?.[0].length ?? 0
    const rawValue = afterColon.slice(leading)
    const scanned = scan(rawValue)
    const value = scanned.code
    const comment = rawValue.slice(value.length)
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ''
    const valueStart = lineStart + colon + 1 + leading

    if (!value) {
      // An empty value may start a block list on the following lines.
      currentList = []
      fields[key] = currentList
      spans[key] = {
        from: valueStart,
        to: lineStart + line.length,
        quote: '',
        comment,
        multiline: false,
      }
      continue
    }

    const span: FrontMatterValueSpan = {
      from: valueStart,
      to: valueStart + value.length,
      quote,
      comment,
      multiline: false,
    }
    spans[key] = span

    if (value.startsWith('[')) {
      const list = value.endsWith(']') ? scan(value.slice(1, -1)) : null
      const items = list?.parts.filter((part, index, all) => part || index < all.length - 1).map(part => scalar(part, true))
      if (!scanned.safe || !list?.safe || !items || items.some(item => item === null)) {
        editable = false
        unsafeReason ??= value.endsWith(']') ? '包含复杂的流式集合' : '包含跨行或未闭合的流式集合'
      } else fields[key] = items as string[]
    } else {
      const decoded = scanned.safe ? scalar(value) : null
      if (decoded === null) {
        editable = false
        unsafeReason ??= /^[&*]/.test(value) ? '包含 YAML 锚点或别名引用' : '包含复杂或不支持的 YAML 值'
      } else fields[key] = decoded
    }
  }

  const title = typeof fields.title === 'string' ? fields.title : undefined
  const created = typeof fields.created === 'string' ? fields.created : typeof fields.date === 'string' ? fields.date : undefined
  const status = typeof fields.status === 'string' ? fields.status : undefined
  const updated = typeof fields.updated === 'string' ? fields.updated : undefined
  let tags: string[] = []
  if (Array.isArray(fields.tags)) tags = fields.tags
  else if (typeof fields.tags === 'string') tags = fields.tags.split(/[\s,]+/).filter(Boolean)

  const known = new Set(['title', 'tags', 'created', 'date', 'updated', 'status'])
  return {
    valid: true,
    raw: rawSource,
    title,
    tags,
    created,
    updated,
    status,
    otherCount: Object.keys(fields).filter(key => !known.has(key)).length,
    fields,
    editable,
    unsafeReason,
    spans,
    newline,
  }
}

/** Escapes a value for the quote style that was already used in the source. */
function quoteValue(value: string, quote: '"' | "'" | ''): string {
  if (quote === '"') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  if (quote === "'") return `'${value.replace(/'/g, "''")}'`
  if (!value) return '""'
  // A plain scalar cannot contain a colon+space or start with a YAML indicator.
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|[\r\n]/.test(value)) return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return value
}

/**
 * Replaces exactly one scalar value, keeping the rest of the block byte-identical
 * (comments, order, quoting, CRLF). Returns `null` when the block cannot be
 * edited safely — the caller must then offer the source editor instead.
 */
export function updateFrontMatterField(rawSource: string, key: string, value: string): string | null {
  if (/[\r\n]/.test(value)) return null
  const parsed = parseFrontMatter(rawSource)
  if (!parsed.valid || !parsed.editable) return null
  const span = parsed.spans[key]
  if (!span || span.multiline || Array.isArray(parsed.fields[key])) return null
  // Guard against a stale span after an external edit.
  if (rawSource.slice(span.from, span.to).length !== span.to - span.from) return null
  if (parsed.fields[key] === value) return rawSource
  const replacement = quoteValue(value, span.quote)
  return rawSource.slice(0, span.from) + replacement + rawSource.slice(span.to)
}
