import type { ConversionWarning } from './contracts'
import MarkdownIt, { type Token } from 'markdown-it'
import { installCjkEmphasis } from '../../editor/markdown/cjkEmphasis'
import { installMarkdownMath } from '../../editor/markdown/mathSemantics'
import { installExportFootnotes, type ExportNote } from './ExportSemantics'
import { markdownSemantics } from '../../editor/markdown/semantics'
import { parseControlledImageHtml, type ControlledImage } from '../../editor/markdown/wysiwyg/imageHtml'

/**
 * Native DOCX writer.
 *
 * Produces a real Office Open XML package: Word list numbering, hyperlink
 * relationships, embedded media, tables and section-level styling. The heavy
 * module is only imported when the user actually exports Word.
 *
 * Deliberately bounded: a media budget, an image count cap, a total output cap
 * and cooperative cancellation, so a huge document cannot exhaust memory or
 * leave a half-written file behind.
 */

export interface DocxImage {
  /** Bytes of the image. Type is detected from the signature. */
  data: Uint8Array
  alt: string
  width?: number
  height?: number
}

export interface DocxWarning extends ConversionWarning {
  kind: 'image' | 'math' | 'diagram' | 'footnote' | 'toc' | 'content'
  message: string
}

export interface DocxOptions {
  title?: string
  /** Resolves a local/network image. Returning null reports a warning instead. */
  resolveImage?: (source: string) => Promise<DocxImage | null>
  renderMath?: (source: string, display: boolean) => Promise<DocxImage | null>
  renderDiagram?: (source: string) => Promise<DocxImage | null>
  linkTargets?: Record<string, string>
  resolveLink?: (href: string) => string | null
  signal?: AbortSignal
  /** Largest total media payload embedded into one document. */
  mediaBudgetBytes?: number
}

export interface DocxResult {
  bytes: Uint8Array
  warnings: DocxWarning[]
  stats: { paragraphs: number; tables: number; lists: number; hyperlinks: number; images: number; footnotes: number }
}

const MAX_MEDIA_BYTES = 64 * 1024 * 1024
const MAX_IMAGES = 120
const MAX_TEXT_BYTES = 64 * 1024 * 1024

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Minimal store-only ZIP writer: every entry is a valid, readable member. */
export function createZipArchive(files: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder()
  const entries: { name: Uint8Array; data: Uint8Array; crc: number; offset: number }[] = []
  const chunks: Uint8Array[] = []
  let offset = 0

  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? encoder.encode(content) : content
    const name = encoder.encode(path)
    const checksum = crc32(data)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, 0, true)
    view.setUint32(14, checksum, true)
    view.setUint32(18, data.length, true)
    view.setUint32(22, data.length, true)
    view.setUint16(26, name.length, true)
    header.set(name, 30)
    entries.push({ name, data, crc: checksum, offset })
    chunks.push(header, data)
    offset += header.length + data.length
  }

  const centralStart = offset
  for (const entry of entries) {
    const header = new Uint8Array(46 + entry.name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint32(16, entry.crc, true)
    view.setUint32(20, entry.data.length, true)
    view.setUint32(24, entry.data.length, true)
    view.setUint16(28, entry.name.length, true)
    view.setUint32(42, entry.offset, true)
    header.set(entry.name, 46)
    chunks.push(header)
    offset += header.length
  }

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, offset - centralStart, true)
  eocdView.setUint32(16, centralStart, true)
  chunks.push(eocd)

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) {
    result.set(chunk, position)
    position += chunk.length
  }
  return result
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Keeps control characters out of XML, which would make the part invalid. */
function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDFFF]/gu, '')
}

function imageExtension(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpeg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'gif'
  if (data[0] === 0x42 && data[1] === 0x4d) return 'bmp'
  return ''
}

/** Read intrinsic dimensions without a DOM in the worker. */
function imageDimensions(data: Uint8Array): [number, number] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (imageExtension(data) === 'png' && data.length >= 24) return [view.getUint32(16), view.getUint32(20)]
  if (imageExtension(data) === 'gif' && data.length >= 10) return [view.getUint16(6, true), view.getUint16(8, true)]
  if (imageExtension(data) === 'jpeg') {
    for (let i = 2; i + 9 < data.length;) {
      if (data[i] !== 255) break
      const marker = data[i + 1], length = view.getUint16(i + 2)
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return [view.getUint16(i + 7), view.getUint16(i + 5)]
      if (length < 2) break
      i += length + 2
    }
  }
  return null
}

interface EmitState {
  resolveLink?: DocxOptions['resolveLink']
  imageRuns: Map<Token, string>
  body: string
  rels: string[]
  media: { name: string; data: Uint8Array }[]
  numbering: string[]
  nextRel: number
  nextImage: number
  nextNumber: number
  listStack: { ordered: boolean; numId: number }[]
  warnings: DocxWarning[]
  stats: DocxResult['stats']
  mediaBytes: number
  mediaBudget: number
  footnoteRelId?: number
  footnotes: { id: number; label: string; text: string; anchors: { relId: number; target: number }[] }[]
  anchors: Map<string, number>
  bookmarkId: number
  headingOutline: { level: number; text: string; bookmark: string }[]
}

function runProps(options: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; size?: number; color?: string }): string {
  const parts: string[] = []
  if (options.code) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>')
  if (options.bold) parts.push('<w:b/>')
  if (options.italic) parts.push('<w:i/>')
  if (options.strike) parts.push('<w:strike/>')
  if (options.size) parts.push(`<w:sz w:val="${options.size}"/>`)
  if (options.color) parts.push(`<w:color w:val="${options.color}"/>`)
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : ''
}

function textRun(text: string, props = ''): string {
  return `<w:r>${props}<w:t xml:space="preserve">${sanitizeText(text).split(/\r\n|\n|\r/).map(line => escapeXml(line).split("\t").join('</w:t><w:tab/><w:t xml:space="preserve">')).join('</w:t><w:br/><w:t xml:space="preserve">')}</w:t></w:r>`
}

/** Renders one inline token stream with marks, code, links and math fallbacks. */
function inlineRuns(children: Token[] | null, state: EmitState, baseUrl?: string): string {
  if (!children?.length) return ''
  const runs: string[] = []
  const marks = { bold: false, italic: false, strike: false }
  let linkHref: string | null = null
  let linkRel: string | null = null
  const flushLink = () => {
    if (linkRel) runs.push(`</w:hyperlink>`)
    linkRel = null
    linkHref = null
  }
  for (const token of children) {
    if (token.type === 'strong_open') marks.bold = true
    else if (token.type === 'strong_close') marks.bold = false
    else if (token.type === 'em_open') marks.italic = true
    else if (token.type === 'em_close') marks.italic = false
    else if (token.type === 's_open') marks.strike = true
    else if (token.type === 's_close') marks.strike = false
    else if (token.type === 'link_open') {
      flushLink()
      const original = String(token.attrGet('href') ?? '')
      const href = state.resolveLink?.(original) ?? original
      if (href && baseUrl !== null && (/^(?:https?:|mailto:)/i.test(href) || href !== original && href.startsWith('file:///'))) {
        const relId = `rIdLink${++state.nextRel}`
        state.rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(href)}" TargetMode="External"/>`)
        linkRel = relId
        state.stats.hyperlinks++
        runs.push(`<w:hyperlink r:id="${relId}">`)
      } else if (href) {
        // A relative or unsupported target is written as text plus its target,
        // never as a broken relationship.
        linkHref = href
        state.warnings.push({ kind: 'content', message: `链接无法安全定位（需要已保存源文档及授权目录内的目标），已作为文本保留：${href}` })
      }
    } else if (token.type === 'link_close') {
      if (linkRel) flushLink()
      else if (linkHref) {
        runs.push(textRun(` (${linkHref})`))
        linkHref = null
      }
    } else if (token.type === 'code_inline') {
      runs.push(textRun(token.content, runProps({ code: true, size: 20 })))
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      runs.push('<w:r><w:br/></w:r>')
    } else if (token.type === 'text') {
      runs.push(textRun(token.content, runProps({ ...marks, color: linkRel ? '1155CC' : undefined })))
    } else if (token.type === 'math_inline') {
      const math = state.imageRuns.get(token)
      runs.push(math ?? textRun('$' + token.content + '$'))
      if (!math) state.warnings.push({ kind: 'math', message: '行内公式渲染失败，已保留源码。' })
    } else if (token.type === 'image') {
      runs.push(state.imageRuns.get(token) ?? textRun(token.content || '[图片]'))
    } else if (token.type === 'html_inline') {
      if (/^<br\s*\/?\s*>$/i.test(token.content)) { runs.push('<w:r><w:br/></w:r>'); continue }
      const stripped = token.content.replace(/<[^>]*>/g, '')
      if (stripped) runs.push(textRun(stripped))
    }
  }
  flushLink()
  return runs.join('')
}

function listParagraph(state: EmitState, level: number, prefix: string, runs: string): string {
  const numbering = state.listStack[state.listStack.length - 1]
  if (!numbering) return `<w:p><w:pPr><w:ind w:left="${360 * (level + 1)}" w:hanging="360"/></w:pPr>${textRun(prefix)}${runs}</w:p>`
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${Math.min(level, 8)}"/><w:numId w:val="${numbering.numId}"/></w:numPr><w:ind w:left="${360 * (level + 1)}"/></w:pPr>${runs}</w:p>`
}

async function prepareImages(tokens: Token[], state: EmitState, options: DocxOptions) {
  for (const image of tokens.flatMap(token => token.type === 'markumo_image_block' || token.type === 'math_block' || token.type === 'fence' && token.info.trim() === 'mermaid' ? [token] : (token.children ?? []).filter(child => child.type === 'image' || child.type === 'math_inline'))) {
    if (options.signal?.aborted) throw new Error('导出已取消')
    const source = String(image.attrGet('src') ?? '')
    if (state.nextImage >= MAX_IMAGES || state.mediaBytes >= state.mediaBudget) {
      state.warnings.push({kind:'image',message:'媒体超过导出预算，已保留文字。'}); continue
    }
    const resolved = image.type.startsWith('math_')
      ? await options.renderMath?.(image.content, image.type === 'math_block').catch(() => null)
      : image.type === 'fence'
      ? await options.renderDiagram?.(image.content).catch(() => null)
      : await options.resolveImage?.(source).catch(() => null)
    const ext = resolved && imageExtension(resolved.data)
    if (!resolved || !ext || state.mediaBytes + resolved.data.length > state.mediaBudget || state.nextImage >= MAX_IMAGES) {
      state.warnings.push({ kind: 'image', message: `图片未能嵌入（读取失败、格式不支持或超过预算），已保留替代文字：${source || '(空路径)'}` })
      continue
    }
    const dimensions = imageDimensions(resolved.data)
    let width = resolved.width || dimensions?.[0], height = resolved.height || dimensions?.[1]
    const sizing = image.meta?.controlledImage as ControlledImage | undefined
    if (width && height && sizing) {
      const naturalRatio = width / height
      const specifiedWidth = sizing.width && sizing.width !== 'auto' ? parseFloat(sizing.width) * (sizing.width.endsWith('%') ? 601 / 100 : 1) : null
      const specifiedHeight = sizing.height ? parseFloat(sizing.height) : null
      if (specifiedWidth) { width = specifiedWidth; height = specifiedHeight || width / naturalRatio }
      else if (specifiedHeight) { height = specifiedHeight; width = height * naturalRatio }
      width *= (sizing.zoom ?? 100) / 100; height *= (sizing.zoom ?? 100) / 100
    }
    if (!width || !height || !Number.isFinite(width + height)) {
      state.warnings.push({ kind: 'image', message: '无法确定图片尺寸：' + source }); continue
    }
    const scale = Math.min(1, 601 / width, 780 / height)
    const cx = Math.round(width * scale * 9525), cy = Math.round(height * scale * 9525)
    const name = `image${++state.nextImage}.${ext}`
    const relId = `rIdImg${name}`
    const id = ++state.bookmarkId
    state.media.push({ name, data: resolved.data }); state.mediaBytes += resolved.data.length
    state.rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`)
    state.imageRuns.set(image, `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${escapeXml(sanitizeText(image.content || resolved.alt || name))}" descr="${escapeXml(sanitizeText(image.content || resolved.alt || name))}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`)
    state.stats.images++
  }
}

async function buildDocumentXml(markdown: string, state: EmitState, options: DocxOptions): Promise<void> {
  const md = new MarkdownIt(markdownSemantics)
  installCjkEmphasis(md)
  installMarkdownMath(md)
  const notes: ExportNote[] = []
  installExportFootnotes(md, notes)
  const tokens = md.parse(markdown, {})
  // Accept only the editor's allow-listed image form. This also keeps imported
  // Word images (including explicit dimensions) as media during a second export.
  for (const block of tokens) for (const token of [block, ...(block.children ?? [])]) {
    if (token.type !== 'html_block' && token.type !== 'html_inline') continue
    const image = parseControlledImageHtml(token.content)
    if (!image) continue
    token.type = token.type === 'html_block' ? 'markumo_image_block' : 'image'
    token.attrSet('src', image.src); token.content = image.alt
    token.meta = { ...token.meta, controlledImage: image }
  }
  for (const note of notes) state.footnotes.push({ id: state.footnotes.length + 1, ...note, anchors: [] })
  if (notes.length) state.warnings.push({ kind: 'footnote', message: '脚注以文末列表形式导出（' + notes.length + ' 条）' })
  await prepareImages(tokens, state, options)

  if (options.title && !tokens.some((token, index) => token.type === 'heading_open' && token.tag === 'h1' && tokens[index + 1]?.content === options.title)) {
    state.body += `<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/></w:pPr>${textRun(options.title, runProps({ bold: true, size: 48 }))}</w:p>`
  }

  let index = 0
  while (index < tokens.length) {
    if (options.signal?.aborted) throw new Error('导出已取消')
    const token = tokens[index]

    if (token.type === 'math_block') {
      const math = state.imageRuns.get(token)
      state.body += '<w:p>' + (math ?? textRun(token.content)) + '</w:p>'
      if (!math) state.warnings.push({ kind: 'math', message: '公式渲染失败，已保留源公式。' })
      index++; continue
    }
    if (token.type === 'heading_open') {
      const level = Math.min(6, Math.max(1, Number(token.tag.slice(1)) || 1))
      const inline = tokens[index + 1]
      const text = inline?.content ?? ''
      state.bookmarkId++
      const bookmark = `_Toc${state.bookmarkId}`
      state.headingOutline.push({ level, text, bookmark })
      state.body += `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:bookmarkStart w:id="${state.bookmarkId}" w:name="${bookmark}"/>${inlineRuns(inline?.children ?? null, state, '')}<w:bookmarkEnd w:id="${state.bookmarkId}"/></w:p>`
      state.stats.paragraphs++
      index += 3
      continue
    }

    if (token.type === 'paragraph_open') {
      const inline = tokens[index + 1]
      const text = inline?.content ?? ''
      if (/^\s*\[toc\]\s*$/i.test(text)) {
        // Placeholder only: the full heading list exists after this pass.
        state.body += '<!--MARKUMO_TOC-->'
        index += 3
        continue
      }
      // A paragraph holding only an image becomes a real embedded picture.
      const onlyImage = inline?.children?.length === 1 && inline.children[0]?.type === 'image'
      if (onlyImage) {
        state.body += `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${inlineRuns(inline?.children ?? null,state,'')}</w:p>`
        state.stats.paragraphs++;index+=3;continue
      }
      state.body += `<w:p><w:pPr>${tokens[index + 3]?.type === 'fence' && tokens[index + 3].info.trim() === 'mermaid' ? '<w:keepNext/>' : ''}<w:spacing w:line="360" w:lineRule="auto"/>${state.listStack.length ? `<w:ind w:left="${360 * state.listStack.length}"/>` : ''}</w:pPr>${inlineRuns(inline?.children ?? null, state, '')}</w:p>`
      state.stats.paragraphs++
      index += 3
      continue
    }

    if (token.type === 'fence' || token.type === 'code_block') {
      const language = String(token.info || '').trim()
      if (language === 'mermaid') {
        const diagram = state.imageRuns.get(token)
        if (diagram) { state.body += '<w:p>' + diagram + '</w:p>'; index++; continue }
        state.warnings.push({ kind: 'diagram', message: 'Mermaid 编译失败或超过资源预算，以下保留源码。' })
      }
      state.body += `<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:shd w:val="clear" w:fill="F6F8FA"/><w:spacing w:line="240" w:lineRule="auto"/><w:ind w:left="240" w:right="240"/></w:pPr>${textRun(token.content.replace(/\n$/, ''), runProps({ code: true, size: 20 }))}</w:p>`
      state.stats.paragraphs++
      index++
      continue
    }

    if (token.type === 'hr') {
      state.body += `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="D0D7DE"/></w:pBdr></w:pPr></w:p>`
      index++
      continue
    }

    if (token.type === 'blockquote_open') {
      let cursor = index + 1
      let first = true
      const callout = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(tokens[cursor]?.type === 'inline' ? tokens[cursor].content : '')
      const accent: Record<string, string> = { NOTE: '3B82F6', TIP: '10B981', IMPORTANT: '8B5CF6', WARNING: 'F59E0B', CAUTION: 'EF4444' }
      const tone = callout ? accent[callout[1].toUpperCase()] : '64748B'
      while (cursor < tokens.length && tokens[cursor].type !== 'blockquote_close') {
        if (tokens[cursor].type === 'inline') {
          let text = tokens[cursor].content
          if (first && callout) {
            const title = callout[2]?.trim() || callout[1].toUpperCase()
            state.body += `<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${tone}"/></w:pBdr><w:shd w:val="clear" w:fill="F8FAFC"/><w:ind w:left="240"/></w:pPr>${textRun(title, runProps({ bold: true, color: tone }))}</w:p>`
            text = text.replace(/^\s*\[![A-Z]+\]\s*/, '')
            first = false
          }
          const children=tokens[cursor].children
          if(callout && children?.[0]?.type==='text')children[0].content=children[0].content.replace(/^\s*\[![A-Z]+\]\s*/,'')
          state.body += `<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${tone}"/></w:pBdr><w:shd w:val="clear" w:fill="F8FAFC"/><w:ind w:left="240"/></w:pPr>${inlineRuns(children ?? null,state,'')}</w:p>`
          state.stats.paragraphs++
        }
        cursor++
      }
      index = cursor + 1
      continue
    }

    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const ordered = token.type === 'ordered_list_open'
      const numId = ++state.nextNumber
      const start = ordered ? Math.max(0, Math.min(2147483647, Number(token.attrGet('start') || 1))) : 1
      state.listStack.push({ ordered, numId })
      state.numbering.push(
        `<w:abstractNum w:abstractNumId="${numId}"><w:multiLevelType w:val="hybridMultilevel"/>` +
        Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? `%${level + 1}.` : ['•', '◦', '▪'][level % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('') +
        `</w:abstractNum>`,
      )
      state.numbering.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${numId}"/></w:num>`)
      state.stats.lists++
      index++
      continue
    }
    if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      state.listStack.pop()
      index++
      continue
    }

    if (token.type === 'list_item_open') {
      // Only consume the immediate first paragraph. Scanning ahead to any
      // inline token used to skip code fences/tables at the start of an item.
      const inline = tokens[index+1]?.type==='paragraph_open' && tokens[index+2]?.type==='inline' ? tokens[index+2] : undefined
      const level = Math.max(0, state.listStack.length - 1)
      state.body += listParagraph(state, level, '', inlineRuns(inline?.children ?? null, state, ''))
      state.stats.paragraphs++
      index += inline ? 3 : 1
      continue
    }

    if (token.type === 'table_open') {
      const rows: string[] = []
      let cursor = index + 1
      let cells: string[] = []
      let header = false
      let columns = 0
      let alignment = ''
      while (cursor < tokens.length && tokens[cursor].type !== 'table_close') {
        const current = tokens[cursor]
        if (current.type === 'tr_open') { cells = []; header = false }
        else if (current.type === 'th_open' || current.type === 'td_open') {
          header = current.type === 'th_open'
          alignment = /text-align:\s*(left|center|right)/.exec(String(current.attrGet('style') || ''))?.[1] || ''
        }
        else if (current.type === 'th_close' || current.type === 'td_close') {
          const inline = tokens[cursor - 1]
          cells.push(`<w:tc><w:tcPr>${header ? '<w:shd w:val="clear" w:fill="F6F8FA"/>' : ''}</w:tcPr><w:p>${alignment ? `<w:pPr><w:jc w:val="${alignment}"/></w:pPr>` : ''}${inlineRuns(inline?.children ?? null, state, '')}</w:p></w:tc>`)
        } else if (current.type === 'tr_close') {
          columns = Math.max(columns, cells.length)
          rows.push(`<w:tr>${cells.join('')}</w:tr>`)
        }
        cursor++
      }
      state.body += `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblStyle w:val="TableGrid"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideH w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideV w:val="single" w:sz="4" w:color="D0D7DE"/></w:tblBorders></w:tblPr><w:tblGrid>${(`<w:gridCol w:w="${Math.floor(9026 / columns)}"/>`).repeat(columns)}</w:tblGrid>${rows.join('').split('<w:tcPr>').join( `<w:tcPr><w:tcW w:w="${Math.floor(9026 / columns)}" w:type="dxa"/>`)}</w:tbl><w:p/>`
      state.stats.tables++
      index = cursor + 1
      continue
    }

    if (token.type === 'inline') {
      state.body += `<w:p>${inlineRuns(token.children, state, '')}</w:p>`
      state.stats.paragraphs++
      index++
      continue
    }

    if (token.type === 'markumo_image_block') {
      state.body += `<w:p>${state.imageRuns.get(token) ?? textRun(token.content || '[图片]')}</w:p>`
      state.stats.paragraphs++
    } else if (token.type === 'html_block') {
      state.body += `<w:p>${textRun(token.content, runProps({code:true}))}</w:p>`
      state.warnings.push({kind:'content',message:'HTML 块以源码文字保留；未宣称支持 Word HTML 排版。'})
      state.stats.paragraphs++
    }
    index++
  }
}

/** Builds the document, returning the package bytes plus explicit warnings. */
export async function exportMarkdownToNativeDocx(markdownContent: string, options: DocxOptions = {}): Promise<DocxResult> {
  if (options.signal?.aborted) throw new Error('导出已取消')
  if (markdownContent.length > MAX_TEXT_BYTES) throw new Error('文档超过 64 MiB，无法导出 Word')
  const state: EmitState = {
    resolveLink: options.resolveLink ?? (href => options.linkTargets?.[href] ?? null),
    imageRuns: new Map(),
    body: '',
    rels: [],
    media: [],
    numbering: [],
    nextRel: 0,
    nextImage: 0,
    nextNumber: 0,
    listStack: [],
    warnings: [],
    stats: { paragraphs: 0, tables: 0, lists: 0, hyperlinks: 0, images: 0, footnotes: 0 },
    mediaBytes: 0,
    mediaBudget: options.mediaBudgetBytes ?? MAX_MEDIA_BYTES,
    footnotes: [],
    anchors: new Map(),
    bookmarkId: 0,
    headingOutline: [],
  }

  await buildDocumentXml(markdownContent, state, options)

  // A `[toc]` marker becomes a real, navigable heading list. Page numbers are
  // omitted because Word can only compute them while paginating, and that
  // limitation is reported instead of being hidden.
  if (/^\s*\[toc\]\s*$/im.test(markdownContent)) {
    state.warnings.push({ kind: 'toc', message: '目录以标题列表形式导出，页码需在 Word 中按 F9 更新' })
    const entries = state.headingOutline
      .map(heading => `<w:p><w:pPr><w:pStyle w:val="TOC${Math.min(3, heading.level)}"/><w:ind w:left="${(heading.level - 1) * 240}"/></w:pPr><w:hyperlink w:anchor="${heading.bookmark}">${textRun(heading.text)}</w:hyperlink></w:p>`)
      .join('')
    const tocBlock = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${textRun('目录', runProps({ bold: true }))}</w:p>${entries}`
    state.body = state.body.replace('<!--MARKUMO_TOC-->', tocBlock)
  } else {
    state.body = state.body.replace('<!--MARKUMO_TOC-->', '')
  }

  if (state.footnotes.length) {
    state.body += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${textRun('脚注', runProps({ bold: true }))}</w:p>`
    for (const footnote of state.footnotes) {
      state.body += `<w:p><w:pPr><w:ind w:left="240" w:hanging="240"/></w:pPr>${textRun(`[${footnote.id}] ${footnote.label}  `, runProps({ bold: true }))}${textRun(footnote.text)}</w:p>`
      state.stats.footnotes++
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${state.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

  const numberingXml = state.numbering.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${state.numbering.filter(xml => xml.startsWith('<w:abstractNum')).join('')}${state.numbering.filter(xml => xml.startsWith('<w:num ')).join('')}</w:numbering>`
    : null

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${state.rels.join('')}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${numberingXml ? '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' : ''}</Relationships>`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Default Extension="gif" ContentType="image/gif"/>
<Default Extension="bmp" ContentType="image/bmp"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
${numberingXml ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : ''}
</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${[1, 2, 3, 4, 5, 6].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.max(20, 40 - level * 3)}"/></w:rPr></w:style>`).join('')}
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
<w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/></w:style>
<w:style w:type="paragraph" w:styleId="TOC3"><w:name w:val="toc 3"/></w:style>
</w:styles>`

  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'word/document.xml': documentXml,
    'word/_rels/document.xml.rels': documentRels,
    'word/styles.xml': stylesXml,
  }
  if (numberingXml) files['word/numbering.xml'] = numberingXml
  for (const media of state.media) files[`word/media/${media.name}`] = media.data

  return { bytes: createZipArchive(files), warnings: state.warnings, stats: state.stats }
}
