import { exportMarkdownToNativeDocx, type DocxImage } from './nativeDocxExport'

const scope = self as unknown as { postMessage(message: unknown, transfers?: Transferable[]): void; onmessage: ((event: MessageEvent) => void) | null }
let sequence = 0
const images = new Map<number, (image: DocxImage | null) => void>()
scope.onmessage = async event => {
  const message = event.data
  if (message.kind === 'image-result') {
    const resolve = images.get(message.id)
    images.delete(message.id)
    resolve?.(message.image ? { data: new Uint8Array(message.image.data), alt: message.image.alt, width: message.image.width, height: message.image.height } : null)
  } else if (message.kind === 'start') {
    try {
      const result = await exportMarkdownToNativeDocx(message.markdown, {
        title: message.title, mediaBudgetBytes: message.mediaBudgetBytes, linkTargets: message.linkTargets,
        renderMath: (source, display) => new Promise(resolve => {
          const id = ++sequence; images.set(id, resolve); scope.postMessage({ kind: 'math', id, source, display })
        }),
        renderDiagram: source => new Promise(resolve => {
          const id = ++sequence; images.set(id, resolve); scope.postMessage({ kind: 'diagram', id, source })
        }),
        resolveImage: source => new Promise(resolve => {
          const id = ++sequence; images.set(id, resolve); scope.postMessage({ kind: 'image', id, source })
        }),
      })
      const bytes = result.bytes.slice().buffer
      scope.postMessage({ kind: 'result', bytes, warnings: result.warnings, stats: result.stats }, [bytes])
    } catch (error) { scope.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) }) }
  }
}
