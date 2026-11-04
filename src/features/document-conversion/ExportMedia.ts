import { detectMimeType, imageDestination, type MarkdownResources } from '../../editor/markdown/images'
import { cloneAndNamespaceSvg, compileSafeMermaidSvg } from '../../editor/markdown/wysiwyg/renderers'
import type { DocxImage } from './nativeDocxExport'

/** Both static HTML/PDF and Word use exactly the preview's strict compiler. */
export async function compileExportDiagram(source: string) {
  const svg = await compileSafeMermaidSvg(source, { theme: 'default', useCache: true })
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  return new XMLSerializer().serializeToString(cloneAndNamespaceSvg(doc.documentElement as unknown as SVGSVGElement))
}

export async function rasterExportImage(data: Uint8Array, alt: string, signal?: AbortSignal): Promise<DocxImage> {
  signal?.throwIfAborted()
  const mime = detectMimeType(data)
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
  const image = new Image()
  try {
    image.src = url
    await image.decode()
    signal?.throwIfAborted()
    const width = image.naturalWidth, height = image.naturalHeight
    if (!width || !height || width * height > 16_000_000) throw new Error('图片超过像素预算')
    if (['image/png', 'image/jpeg', 'image/gif'].includes(mime)) return { data, alt, width, height }
    // Rasterize only the incompatible asset, never a page. At least 2x for SVG.
    const scale = mime === 'image/svg+xml' ? 2 : 1
    if (width * height * scale * scale > 16_000_000) throw new Error('图表超过 2x 栅格化预算')
    const canvas = document.createElement('canvas')
    try {
      canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale)
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('图表转换失败')
      return { data: new Uint8Array(await blob.arrayBuffer()), alt, width, height }
    } finally { canvas.width = canvas.height = 0 }
  } finally { image.src = ''; URL.revokeObjectURL(url) }
}

export async function renderExportDiagram(source: string, signal?: AbortSignal) {
  const svg = await compileExportDiagram(source)
  return rasterExportSvg(svg, 'Mermaid', signal)
}

export async function rasterExportSvg(svg: string, alt: string, signal?: AbortSignal) {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement, box = root.getAttribute('viewBox')?.split(/[ ,]+/).map(Number)
  if (box?.length === 4 && box[2] > 0 && box[3] > 0) {
    const scale = Math.min(1, 601 / box[2], 780 / box[3])
    root.setAttribute('width', String(box[2] * scale)); root.setAttribute('height', String(box[3] * scale))
    root.removeAttribute('style')
  }
  return rasterExportImage(new TextEncoder().encode(new XMLSerializer().serializeToString(root)), alt, signal)
}

export async function resolveExportImage(source: string, resources?: MarkdownResources, signal?: AbortSignal): Promise<DocxImage | null> {
  const destination = imageDestination(source)
  if (source.startsWith('data:image/') && source.length < 24 * 1024 * 1024) {
    const response = await fetch(source, { signal })
    return rasterExportImage(new Uint8Array(await response.arrayBuffer()), source.slice(0, 80), signal)
  }
  if (destination.kind !== 'local' || !resources) return null
  return rasterExportImage(await resources.loadLocal(destination.path, { full: true }), source, signal)
}
