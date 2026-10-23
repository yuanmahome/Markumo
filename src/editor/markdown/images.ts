import { Facet, StateEffect } from '@codemirror/state'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { safeMarkdownURL } from './links'

export interface MarkdownResources {
  loadLocal(path: string, options?: { full?: boolean }): Promise<Uint8Array<ArrayBuffer>>
  authorizeLocal?(path: string): Promise<boolean>
  chooseLocal?(): Promise<string | null>
  allowedRemote: Set<string>
  identity(): string
}
export const refreshMarkdownResources = StateEffect.define<null>()
export const markdownResources = Facet.define<MarkdownResources, MarkdownResources>({
  combine: values => values[values.length - 1] || createMarkdownResources(() => undefined),
})

export function detectMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x52 && bytes[11] === 0x50) return 'image/webp'
  // SVG detection: check for '<svg' or '<?xml'
  if (bytes.length >= 4) {
    const slice = bytes.subarray(0, Math.min(bytes.length, 1024))
    const s = new TextDecoder('utf-8', { fatal: false }).decode(slice).trimStart().toLowerCase()
    if (s.startsWith('<svg') || s.startsWith('<?xml') || s.startsWith('<!--') || s.startsWith('<!doctype') || s.includes('<svg')) {
      return 'image/svg+xml'
    }
  }
  return 'image/png'
}

interface BlobRecord {
  url: string
  mime: string
  size: number
  refCount: number
  lastAccessed: number
}
const sharedBlobCache = new Map<string, BlobRecord>()
let totalActiveBlobBytes = 0
const MAX_ACTIVE_BLOB_POOL_BYTES = 64 * 1024 * 1024 // 64 MiB active Blob pool

export function acquireBlobUrl(key: string, bytes: Uint8Array, mime: string): string {
  const existing = sharedBlobCache.get(key)
  if (existing && existing.size === bytes.length && existing.mime === mime) {
    existing.refCount++
    existing.lastAccessed = Date.now()
    return existing.url
  }
  if (existing) {
    URL.revokeObjectURL(existing.url)
    totalActiveBlobBytes -= existing.size
    sharedBlobCache.delete(key)
  }
  if (totalActiveBlobBytes + bytes.length > MAX_ACTIVE_BLOB_POOL_BYTES) {
    evictUnreferencedBlobs(bytes.length)
  }
  const blob = new Blob([bytes as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  sharedBlobCache.set(key, {
    url,
    mime,
    size: bytes.length,
    refCount: 1,
    lastAccessed: Date.now(),
  })
  totalActiveBlobBytes += bytes.length
  return url
}

export function releaseBlobUrl(key: string) {
  const existing = sharedBlobCache.get(key)
  if (!existing) return
  existing.refCount = Math.max(0, existing.refCount - 1)
  existing.lastAccessed = Date.now()
  if (existing.refCount === 0 && totalActiveBlobBytes > MAX_ACTIVE_BLOB_POOL_BYTES) {
    URL.revokeObjectURL(existing.url)
    totalActiveBlobBytes -= existing.size
    sharedBlobCache.delete(key)
  }
}

function evictUnreferencedBlobs(neededBytes = 0) {
  const unreferenced = [...sharedBlobCache.entries()]
    .filter(([_, r]) => r.refCount <= 0)
    .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
  for (const [k, r] of unreferenced) {
    URL.revokeObjectURL(r.url)
    totalActiveBlobBytes -= r.size
    sharedBlobCache.delete(k)
    if (totalActiveBlobBytes + neededBytes <= MAX_ACTIVE_BLOB_POOL_BYTES) break
  }
}

export function clearImageBlobCache() {
  for (const [_, r] of sharedBlobCache) {
    URL.revokeObjectURL(r.url)
  }
  sharedBlobCache.clear()
  totalActiveBlobBytes = 0
}

export function createMarkdownResources(token: () => string | undefined, identity: () => string = () => token() || ''): MarkdownResources {
  const pending = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
  let previousIdentity = identity()
  return {
    allowedRemote: new Set(),
    identity,
    async chooseLocal() {
      const grant = token()
      if (!isTauri() || !grant) throw new Error('请先保存 Markdown 文档，再选择本地图片。')
      const expected = identity()
      const inputs = await invoke<{ token: string; name: string }[]>('choose_markdown_images')
      try {
        if (!inputs.length || identity() !== expected) return null
        const result = await invoke<{ path: string }>('import_markdown_image', { input: {
          token: grant, sourceToken: inputs[0].token, name: inputs[0].name, directory: null,
        } })
        return identity() === expected ? result.path.replace(/\\/g, '/').split('/').map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join('/') : null
      } finally { await invoke('release_image_inputs', { tokens: inputs.map(input => input.token) }) }
    },
    async authorizeLocal(path) {
      const grant = token()
      if (!isTauri() || !grant) return false
      return invoke<boolean>('authorize_markdown_image_read', { token: grant, relative: path })
    },
    async loadLocal(path, options?: { full?: boolean }) {
      const grant = token()
      if (!isTauri() || !grant) throw new Error('请先保存 Markdown 文档。')
      const current = identity()
      if (current !== previousIdentity) {
        pending.clear()
        previousIdentity = current
      }
      const cacheKey = options?.full ? `${path}::full` : path
      const existing = pending.get(cacheKey)
      if (existing) return existing

      const request = invoke<ArrayBuffer>('read_markdown_image', {
        token: grant,
        relative: path,
        full: !!options?.full,
      }).then(buffer => {
        return new Uint8Array(buffer)
      }).catch(error => {
        pending.delete(cacheKey)
        throw error
      })
      pending.set(cacheKey, request)
      return request
    },
  }
}

export type ImageDestination = { kind: 'remote'; path: string } | { kind: 'local'; path: string } | { kind: 'blocked'; path: string }

/** Rust IPC errors are plain {code,message} objects, not JavaScript Errors. */
export function markdownImageError(error: unknown): { message: string; authorize: boolean } {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
  const code = typeof record?.code === 'string' ? record.code : ''
  const detail = (typeof record?.message === 'string' ? record.message : typeof error === 'string' ? error : '')
    .replace(/\[object Object\]/g, '').trim()
  if (code === 'image_scope') return { message: '文件未授权：请授权访问或重新选择图片。', authorize: true }
  if (code === 'image_size') return { message: '图片尺寸或文件大小超出安全预算。', authorize: false }
  if (code === 'image_format') return { message: '图片格式不支持或文件已损坏。支持 PNG、JPEG、GIF、WebP、SVG。', authorize: false }
  if (/not.?found|不存在|找不到|os error 2|os error 3|cannot find/i.test(detail)) return { message: '文件不存在：请修改路径或重新选择图片。', authorize: false }
  return { message: detail ? `图片加载失败：${detail}` : '图片加载失败，请重试或重新选择图片。', authorize: false }
}

export function imageDestination(source: string): ImageDestination {
  const raw = source.replace(/^<|>$/g, '').replace(/\\([\\()<> ])/g, '$1')
  const network = safeMarkdownURL(raw)
  if (network?.startsWith('https:')) return { kind: 'remote', path: network }
  try {
    const path = decodeURIComponent(raw)
    const localDrive = /^[a-z]:[\/\\]/i.test(path)
    if (!path || /^[/\\]{2}/.test(path) || /[\0\r\n]/.test(path) || (!localDrive && path.includes(':')) || (localDrive && path.slice(2).includes(':'))) return { kind: 'blocked', path }
    return { kind: 'local', path }
  } catch { return { kind: 'blocked', path: raw } }
}

/** Safe DOM only. No src is assigned to a remote image until explicit consent. */
export function mountMarkdownImage(
  host: HTMLElement,
  source: string,
  alt: string,
  resources: MarkdownResources,
  edit: () => void,
  measure: () => void = () => {},
  options: { live?: boolean; immediate?: boolean } = {}
) {
  const destination = imageDestination(source)
  host.replaceChildren()
  let disposed = false
  let objectURL: string | undefined
  let cacheKey: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let needsAuthorization = false
  let observer: IntersectionObserver | null = null

  const release = () => {
    if (objectURL && cacheKey) {
      releaseBlobUrl(cacheKey)
      objectURL = undefined
      cacheKey = undefined
    }
  }

  host.className = options.live ? 'md-image-media' : 'md-image-preview'
  host.title = `${alt}\n${source}`
  const status = document.createElement('span')
  status.className = 'md-image-status'
  const path = document.createElement('button')
  path.type = 'button'
  path.className = 'md-image-path'
  path.textContent = source || '选择或填写图片路径'
  path.title = '编辑图片路径'
  path.onclick = event => { event.stopPropagation(); edit() }
  const action = document.createElement('button')
  action.type = 'button'
  action.className = 'md-image-action'
  host.append(status, path, action)

  const failure = (reason: string) => {
    host.classList.add('is-broken-image')
    host.title = `${alt ? alt + ' · ' : ''}${source}\n（${reason}）`
    const tag = document.createElement('button')
    tag.type = 'button'
    tag.className = 'broken-image-tag'
    tag.textContent = options.live ? '▧' : alt ? `${alt} · ${reason}` : reason
    tag.title = reason
    tag.onclick = event => { event.stopPropagation(); edit() }
    status.replaceChildren(tag)
    path.hidden = options.live === true
    action.hidden = destination.kind === 'blocked'
    if (options.live) action.hidden = true
    action.textContent = '重试'
    action.className = 'md-image-action broken-retry-btn'
    measure()
  }

  async function load() {
    const current = ++generation
    if (timer) clearTimeout(timer)
    host.querySelector('img')?.remove()
    host.classList.remove('is-broken-image')
    host.classList.remove('is-pending-image')
    needsAuthorization = false
    path.hidden = !!options.live
    action.className = 'md-image-action'
    release()
    status.textContent = options.live ? '▧' : '图片加载中…'
    status.title = '图片加载中…'
    action.hidden = true
    try {
      let src: string
      if (destination.kind === 'blocked') {
        failure(source.trim() ? '路径无效：只允许本地路径或经确认的 HTTPS 图片。' : '路径为空：点击填写或选择图片。')
        return
      }
      if (destination.kind === 'remote') {
        src = destination.path
      } else {
        const bytes = await resources.loadLocal(destination.path)
        if (disposed || current !== generation) return
        const mime = detectMimeType(bytes)
        cacheKey = destination.path
        objectURL = acquireBlobUrl(cacheKey, bytes, mime)
        src = objectURL
      }
      if (disposed || current !== generation) return
      const image = document.createElement('img')
      image.alt = alt
      image.referrerPolicy = 'no-referrer'
      image.decoding = 'async'
      if (destination.kind === 'remote') image.crossOrigin = 'anonymous'
      if (!options.live) image.onclick = edit
      image.onload = () => {
        if (disposed || current !== generation) return
        if (timer) clearTimeout(timer)
        const pixels = image.naturalWidth * image.naturalHeight
        // Decompression bomb check on decoded natural size
        if (image.naturalWidth > 65535 || image.naturalHeight > 65535 || pixels > 200_000_000) {
          image.remove()
          release()
          failure('图片尺寸超出安全渲染范围或可能为解压炸弹')
          return
        }
        status.textContent = ''
        path.hidden = !!options.live
        action.hidden = true
        measure()
      }
      image.onerror = () => {
        if (!disposed && current === generation) {
          if (timer) clearTimeout(timer)
          image.remove()
          release()
          failure('加载失败或远程服务器未允许匿名跨域访问')
        }
      }
      timer = setTimeout(() => {
        if (!disposed && current === generation) {
          generation++
          image.remove()
          release()
          failure('加载超时')
        }
      }, 15000)
      host.prepend(image)
      image.src = src
      if (image.complete && image.naturalWidth > 0) {
        image.onload(new Event('load'))
      }
      measure()
    } catch (error) {
      if (!disposed && current === generation) {
        const failureInfo = markdownImageError(error)
        release()
        failure(failureInfo.message)
        needsAuthorization = destination.kind === 'local' && !!resources.authorizeLocal && failureInfo.authorize
        if (needsAuthorization) action.textContent = '授权此本地图片…'
      }
    }
  }

  action.onclick = async event => {
    event.stopPropagation()
    if (needsAuthorization) {
      action.disabled = true
      try {
        if (!await resources.authorizeLocal?.(destination.path)) return
        needsAuthorization = false
      } catch (error) {
        if (!disposed) failure(markdownImageError(error).message)
        return
      } finally {
        action.disabled = false
      }
      if (disposed) return
    }
    if (destination.kind === 'remote') resources.allowedRemote.add(destination.path)
    void load()
  }

  if (destination.kind === 'remote' && !resources.allowedRemote.has(destination.path)) {
    host.classList.add('is-pending-image')
    host.title = `${alt}\n${source}\n网络图片尚未授权加载，可通过右键菜单加载。`
    status.textContent = options.live ? '▧' : '网络图片默认关闭'
    action.textContent = `加载网络图片（${new URL(destination.path).hostname}）`
    action.hidden = !!options.live
    path.hidden = !!options.live
    measure()
  } else {
    void load()
  }

  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting && totalActiveBlobBytes > MAX_ACTIVE_BLOB_POOL_BYTES) {
          release()
        } else if (entry.isIntersecting && !host.querySelector('img') && !host.classList.contains('is-broken-image') &&
          (destination.kind !== 'remote' || resources.allowedRemote.has(destination.path))) {
          void load()
        }
      }
    }, { rootMargin: '400px 0px' })
    observer.observe(host)
  }

  return {
    retry() { action.click() },
    destroy() {
      disposed = true
      generation++
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      observer = null
      const image = host.querySelector('img')
      if (image) {
        image.onload = image.onerror = null
        image.removeAttribute('src')
      }
      release()
    },
  }
}
