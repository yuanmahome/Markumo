import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'

export const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex')

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/**
 * Deterministically generate a valid RGB PNG.
 * Uses fast zlib level 1 compression and deterministic pseudo-noise so large
 * images stay well above the 100 KiB decompression-bomb threshold while taking
 * < 1 second to generate in Node.js.
 */
export function createDeterministicPng(width, height, seed = 1) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rowStride = 1 + width * 3
  const raw = Buffer.allocUnsafe(rowStride * height)
  let state = (seed >>> 0) || 0x12345678

  // Prepare 16 varied scanline patterns and mix row index to avoid huge memory/CPU time
  // while keeping compressed output > 500 KiB for 6000x4000 (preventing bomb false-positive).
  const patternCount = 32
  const patterns = Array.from({ length: patternCount }, () => {
    const line = Buffer.allocUnsafe(width * 3)
    for (let x = 0; x < width * 3; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      line[x] = (state >>> 16) & 0xff
    }
    return line
  })

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowStride
    raw[rowStart] = 0 // filter: None
    const base = patterns[y % patternCount]
    base.copy(raw, rowStart + 1)
    // Perturb every 64th pixel per row so LZ77 cannot collapse identical rows into <100KiB
    const yMix = ((y * 2654435761) >>> 16) & 0xff
    for (let offset = (y % 17) * 3; offset < width * 3; offset += 192) {
      raw[rowStart + 1 + offset] ^= yMix
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 1 })
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Deterministically build a valid multi-page PDF 1.4 document with text streams
 * and vector graphics so PDF.js renders real canvases and text layers.
 */
export function createDeterministicPdf(pageCount = 6) {
  const objects = []
  const addObject = body => {
    objects.push(body)
    return objects.length
  }

  const catalogId = addObject('') // placeholder 1
  const pagesId = addObject('') // placeholder 2
  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  const pageIds = []
  for (let i = 1; i <= pageCount; i++) {
    const lines = [
      'BT',
      '/F1 18 Tf',
      `56 740 Td (Markumo Phase 04.2 PDF Memory Benchmark - Page ${i} of ${pageCount}) Tj`,
      '/F1 11 Tf',
      '0 -28 Td (This page exercises PDF.js Worker, Canvas rasterization, and TextLayer lifecycle.) Tj',
    ]
    for (let row = 1; row <= 18; row++) {
      lines.push(`0 -22 Td (Section ${i}.${row}: Deterministic benchmark paragraph for search and viewport scrolling.) Tj`)
    }
    lines.push('ET')
    lines.push('0.2 0.45 0.85 rg 56 80 480 18 re f')
    const stream = lines.join('\n')
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`)
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    )
    pageIds.push(pageId)
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`

  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, 'ascii'))
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(out, 'ascii')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(out, 'ascii')
}

const CODE_SAMPLES = [
  {
    lang: 'typescript',
    body: i => `export interface RenderTaskMetric_${i} {\n  readonly id: string;\n  readonly queuedAt: number;\n  readonly visible: boolean;\n}\n\nexport function computeBudget_${i}(items: readonly RenderTaskMetric_${i}[], limit = 64): number {\n  let active = 0;\n  for (const item of items) {\n    if (item.visible && active < limit) active += 1;\n  }\n  return active;\n}`,
  },
  {
    lang: 'javascript',
    body: i => `function scheduleFrame_${i}(queue, maxConcurrency = 2) {\n  const running = new Set();\n  while (running.size < maxConcurrency && queue.length > 0) {\n    const next = queue.shift();\n    running.add(next.id);\n  }\n  return running.size;\n}`,
  },
  {
    lang: 'python',
    body: i => `def summarize_samples_${i}(samples: list[float]) -> dict[str, float]:\n    ordered = sorted(samples)\n    mid = len(ordered) // 2\n    median = ordered[mid] if len(ordered) % 2 == 1 else (ordered[mid - 1] + ordered[mid]) / 2.0\n    return {"count": len(ordered), "median": round(median, 3), "peak": max(ordered)}`,
  },
  {
    lang: 'rust',
    body: i => `pub fn preview_scale_${i}(width: u32, height: u32, max_edge: u32) -> (u32, u32) {\n    if width <= max_edge && height <= max_edge {\n        return (width, height);\n    }\n    let ratio = (max_edge as f64 / width.max(height) as f64).clamp(0.01, 1.0);\n    (((width as f64 * ratio).round() as u32).max(1), ((height as f64 * ratio).round() as u32).max(1))\n}`,
  },
]

export function buildCodeBlocksMarkdown(count, withImages = false) {
  const parts = [`# 代码块生命周期基准测试（${count} 个代码块）\n\n本测试文档用于测量 WebView2 在不同代码块规模下的实例创建、语法高亮与内存曲线。\n`]
  if (withImages) {
    parts.push('![本地示例图一](img-small-1.png)\n\n![本地示例图二](img-small-2.png)\n')
  }
  for (let i = 1; i <= count; i++) {
    const sample = CODE_SAMPLES[(i - 1) % CODE_SAMPLES.length]
    parts.push(`## 章节 ${i}：模块样例 (${sample.lang})\n\n普通说明段落 ${i}，包含 **加粗强调**、*斜体样式* 与 \`inline_token_${i}\`。\n\n\`\`\`${sample.lang}\n${sample.body(i)}\n\`\`\`\n`)
  }
  return parts.join('\n')
}

export function build5KbMarkdownWithTwoImages() {
  const intro = [
    '# Phase 04.2 图文混排基准文档（约 5 KB）',
    '',
    '本文档模拟日常工程笔记：包含约 5 KB 的 Markdown 文本与两张本地图片引用，用于观察常规文档在 Live / Source / Split 下的基础开销。',
    '',
    '![本地架构示意图](img-small-1.png)',
    '',
  ].join('\n')

  const section = idx => [
    `## ${idx}. 资源生命周期记录小节`,
    '',
    `在第 ${idx} 小节中，编辑器需要保持完整的双向源码映射、平滑光标以及撤销重做栈。日常笔记包含无序列表与简短公式，如 $E = mc^2$ 与 $\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$。`,
    '',
    '- 保持 DocumentManager 单一权威文档状态，避免多份全文冗余拷贝。',
    '- 本地图片经由受控授权读取并通过引用计数共享 Blob URL。',
    '',
  ].join('\n')

  let body = intro
  let idx = 1
  while (Buffer.byteLength(body, 'utf8') < 4700) {
    body += section(idx++) + '\n'
    if (idx === 4) {
      body += '![本地性能趋势图](img-small-2.png)\n\n'
    }
  }
  return body
}

export function buildOrdinaryMarkdown() {
  const parts = ['# 普通 Markdown 文档性能测试\n']
  for (let i = 1; i <= 80; i++) {
    parts.push(
      `## 小节标题 ${i}\n\n这是第 ${i} 段常规 Markdown 正文内容，包含 **粗体文字**、*斜体描述*、\`行内代码\` 以及 [内部跳转链接](#小节标题-1)。用于测量纯段落文档在 Live、Source 与 Split 切换时的内存表现。\n\n- 列表条目 A-${i}\n- 列表条目 B-${i}\n`
    )
  }
  return parts.join('\n')
}

export function buildSplitMarkdown() {
  const parts = [
    '# Split 双栏综合基准文档\n',
    '![本地图片一](img-small-1.png)\n',
    '![本地图片二](img-small-2.png)\n',
  ]
  for (let i = 1; i <= 40; i++) {
    const sample = CODE_SAMPLES[(i - 1) % CODE_SAMPLES.length]
    parts.push(
      `## 双栏章节 ${i}\n\n段落包含行内公式 $f(x) = x^2 + ${i}$ 与块级公式：\n\n$$\n\\int_0^1 x^{${i}} \\, dx = \\frac{1}{${i + 1}}\n$$\n\n\`\`\`${sample.lang}\n${sample.body(i)}\n\`\`\`\n`
    )
  }
  for (let d = 1; d <= 4; d++) {
    parts.push(`\`\`\`mermaid\ngraph LR\n  A${d}[输入 ${d}] --> B${d}[队列控制]\n  B${d} --> C${d}[渲染完成]\n\`\`\`\n`)
  }
  return parts.join('\n')
}

export function buildLargeTxt(lineCount = 30000) {
  const lines = []
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`[2026-10-26T09:30:${String(i % 60).padStart(2, '0')}Z] INFO  worker=${i % 8} seq=${i} message="Plain text large file baseline measurement line with realistic ASCII/UTF-8 payload 数据记录"`)
  }
  return lines.join('\n') + '\n'
}

export function ensurePhase042Fixtures(fixtureDir) {
  fs.mkdirSync(fixtureDir, { recursive: true })
  const files = {
    'img-small-1.png': () => createDeterministicPng(800, 600, 101),
    'img-small-2.png': () => createDeterministicPng(640, 480, 202),
    'img-large-24mp.png': () => createDeterministicPng(6000, 4000, 303),
    'sample-multi.pdf': () => createDeterministicPdf(6),
    'doc-5kb-2img.md': () => Buffer.from(build5KbMarkdownWithTwoImages(), 'utf8'),
    'doc-ordinary.md': () => Buffer.from(buildOrdinaryMarkdown(), 'utf8'),
    'doc-split.md': () => Buffer.from(buildSplitMarkdown(), 'utf8'),
    'code-50.md': () => Buffer.from(buildCodeBlocksMarkdown(50, false), 'utf8'),
    'code-100.md': () => Buffer.from(buildCodeBlocksMarkdown(100, false), 'utf8'),
    'code-200.md': () => Buffer.from(buildCodeBlocksMarkdown(200, false), 'utf8'),
    'multi-pane.md': () => Buffer.from(buildCodeBlocksMarkdown(100, true), 'utf8'),
    'doc-large-image.md': () => Buffer.from(
      '# 大图片自适应降采样与原图预览测试\n\n正文引用一张 6000×4000（24 MP）本地图片：\n\n![24MP 大图](img-large-24mp.png)\n\n尾部段落。\n',
      'utf8'
    ),
    'large-2mb.txt': () => Buffer.from(buildLargeTxt(22000), 'utf8'),
  }

  const manifest = {}
  for (const [name, generator] of Object.entries(files)) {
    const fullPath = path.join(fixtureDir, name)
    const buf = generator()
    fs.writeFileSync(fullPath, buf)
    manifest[name] = {
      bytes: buf.length,
      sha256: sha256Bytes(buf),
    }
  }
  return manifest
}
