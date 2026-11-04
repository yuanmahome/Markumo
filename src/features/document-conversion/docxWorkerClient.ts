import type { DocxOptions, DocxResult } from './nativeDocxExport'

/** Each export owns one worker. Terminating it cancels even synchronous parse,
 * XML generation and ZIP/CRC work; no polling or main-thread fallback. */
export function generateDocx(markdown: string, options: DocxOptions = {}): Promise<DocxResult> {
  const aborted = () => new DOMException('Word 导出已取消', 'AbortError')
  if (options.signal?.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./nativeDocxWorker.ts', import.meta.url), { type: 'module' })
    let finished = false
    const cleanup = () => {
      finished = true
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      options.signal?.removeEventListener('abort', cancel)
      worker.terminate()
    }
    const fail = (error: unknown) => { if (!finished) { cleanup(); reject(error) } }
    const cancel = () => fail(aborted())
    options.signal?.addEventListener('abort', cancel, { once: true })
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Word 导出 Worker 失败')) }
    worker.onmessageerror = () => fail(new Error('Word 导出 Worker 消息无效'))
    worker.onmessage = async event => {
      if (finished) return
      const message = event.data
      if (message.kind === 'image' || message.kind === 'diagram' || message.kind === 'math') {
        let image = null
        try { image = await (message.kind === 'math' ? options.renderMath?.(message.source, message.display) : message.kind === 'diagram' ? options.renderDiagram?.(message.source) : options.resolveImage?.(message.source)) ?? null } catch { /* Writer reports an explicit image fallback. */ }
        if (finished) return
        const data = image?.data.slice().buffer
        worker.postMessage({ kind: 'image-result', id: message.id, image: data ? { data, alt: image!.alt, width: image!.width, height: image!.height } : null }, data ? [data] : [])
      } else if (message.kind === 'result') {
        cleanup(); resolve({ bytes: new Uint8Array(message.bytes), warnings: message.warnings, stats: message.stats })
      } else if (message.kind === 'error') fail(new Error(message.message))
    }
    if (options.signal?.aborted) { cancel(); return }
    worker.postMessage({ kind: 'start', markdown, title: options.title, mediaBudgetBytes: options.mediaBudgetBytes, linkTargets: options.linkTargets })
  })
}
