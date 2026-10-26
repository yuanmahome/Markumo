import DOMPurify from 'dompurify'
import { safeMarkdownURL } from '../links'
import {
  acquireBlobUrl,
  detectMimeType,
  imageDestination,
  releaseBlobUrl,
  scopedImageBlobKey,
  tryAcquireExistingBlobUrl,
  type MarkdownResources,
} from '../images'

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark',
  'small', 'sub', 'sup', 'ruby', 'rt', 'rp', 'kbd', 'code', 'pre', 'br', 'hr',
  'a', 'img', 'button', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary', 'blockquote', 'ul', 'ol', 'li',
  'figure', 'figcaption', 'section', 'article', 'q', 'cite', 'abbr', 'time', 'var', 'samp',
]

const ALLOWED_ATTR = [
  'id', 'class', 'style', 'title', 'dir', 'lang',
  'href', 'target', 'rel',
  'src', 'alt', 'width', 'height', 'loading',
  'colspan', 'rowspan', 'headers', 'scope', 'align', 'valign',
  'open', 'data-source-line', 'data-md-copy', 'data-md-render', 'data-line', 'viewbox', 'viewBox', 'fill', 'stroke', 'stroke-width', 'd',
  'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'transform', 'xmlns',
]

const SAFE_CSS_PROPERTIES = new Set([
  'color', 'background-color',
  'font-size', 'font-weight', 'font-style', 'font-family',
  'text-align', 'text-decoration', 'text-indent', 'line-height',
  'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'border', 'border-radius', 'border-color', 'border-style', 'border-width',
  'vertical-align', 'letter-spacing', 'word-spacing', 'opacity', 'display',
])

export function sanitizeCssStyle(rawStyle: string): string {
  if (!rawStyle || typeof rawStyle !== 'string') return ''
  const declarations = rawStyle.split(';')
  const valid: string[] = []

  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':')
    if (colonIdx === -1) continue
    const prop = decl.slice(0, colonIdx).trim().toLowerCase()
    const val = decl.slice(colonIdx + 1).trim()

    if (!SAFE_CSS_PROPERTIES.has(prop) && prop !== 'zoom') continue
    if (prop === 'zoom' && (!/^\d+(?:\.\d{1,2})?%$/.test(val) || Number(val.slice(0, -1)) < 1 || Number(val.slice(0, -1)) > 1000)) continue

    const lowerVal = val.toLowerCase()
    if (
      /[\\\u0000-\u001f]/.test(val) ||
      lowerVal.includes('url(') ||
      lowerVal.includes('@import') ||
      lowerVal.includes('expression') ||
      lowerVal.includes('javascript:') ||
      lowerVal.includes('behavior') ||
      lowerVal.includes('position') ||
      lowerVal.includes('fixed')
    ) {
      continue
    }

    valid.push(`${prop}: ${val}`)
  }

  return valid.join('; ')
}

/** Keep image URLs inert until resource permissions have been checked. The
 * template is never attached; remote URLs cannot fetch before consent. */
export function htmlForPreview(raw:string):string {
  const clean=sanitizeHtml(raw)
  if(typeof document==='undefined')return clean
  const template=document.createElement('template')
  template.innerHTML=clean
  for(const img of template.content.querySelectorAll('img')){
    img.setAttribute('data-md-safe-src',img.getAttribute('src')||'')
    img.removeAttribute('src')
  }
  return template.innerHTML
}
export function renderSafeHtml(container:HTMLElement,raw:string){container.innerHTML=htmlForPreview(raw)}
export function hasUnsupportedHtml(raw:string){
  const template=document.createElement('template');template.innerHTML=raw
  return [...template.content.querySelectorAll('*')].some(node=>!ALLOWED_TAGS.includes(node.localName.toLowerCase()))
}

// 安全初始化 DOMPurify 实例（兼容浏览器与 Node 测试环境）
let purifyInstance: any = null

function getPurifier(): any {
  if (purifyInstance) return purifyInstance
  if (typeof window !== 'undefined') {
    const raw = DOMPurify as any
    purifyInstance = typeof raw === 'function' ? raw(window) : raw.default ? (typeof raw.default === 'function' ? raw.default(window) : raw.default) : raw
    if (purifyInstance && purifyInstance.addHook && !purifyInstance.__hookAdded) {
      purifyInstance.__hookAdded = true
      purifyInstance.addHook('afterSanitizeAttributes', (node: Element) => {
        if(node.namespaceURI==='http://www.w3.org/2000/svg'){
          node.removeAttribute('href');node.removeAttribute('xlink:href')
        }
        if (node.tagName === 'A') {
          const href = node.getAttribute('href')
          if (href) {
            const safe = safeMarkdownURL(href)
            if (!safe) {
              node.removeAttribute('href')
            } else {
              node.setAttribute('href', safe)
              if (safe.startsWith('http:') || safe.startsWith('https:')) {
                node.setAttribute('target', '_blank')
                node.setAttribute('rel', 'noopener noreferrer')
              }
            }
          }
        }

        if (node.hasAttribute('style')) {
          const original = node.getAttribute('style') || ''
          const clean = sanitizeCssStyle(original)
          if (clean) {
            node.setAttribute('style', clean)
          } else {
            node.removeAttribute('style')
          }
        }

        if (node.tagName === 'IMG') {
          if (node.getAttribute('width') === '') node.removeAttribute('width')
          if (node.getAttribute('height') === '') node.removeAttribute('height')
        }
      })
    }
  }
  return purifyInstance
}

/**
 * 净化不可信的用户 HTML 源码，返回安全可直接渲染的 HTML 字符串
 */
export function sanitizeHtml(rawHtml: string): string {
  if (!rawHtml || typeof rawHtml !== 'string') return ''

  const purifier = getPurifier()
  if (purifier && typeof purifier.sanitize === 'function') {
    return purifier.sanitize(rawHtml, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      RETURN_DOM_FRAGMENT: false,
      RETURN_DOM: false,
      WHOLE_DOCUMENT: false,
      CUSTOM_ELEMENT_HANDLING: {
        tagNameCheck: () => false,
        attributeNameCheck: () => false,
      },
    })
  }

  // No DOM sanitizer is available in non-browser consumers. Fail closed;
  // regex blacklists cannot safely recognize HTML parser edge cases.
  return rawHtml.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}

export interface MountedImageHandle {
  destroy: () => void
}

/**
 * 扫描指定容器中的所有 <img>，接入本地授权资源或远程确认加载服务
 */
export function mountHtmlImages(
  container: HTMLElement,
  resources?: MarkdownResources,
  onImageClick?: (img: HTMLImageElement) => void
): MountedImageHandle {
  const acquiredKeys: string[] = []
  let disposed = false
  const imgElements = Array.from(container.querySelectorAll<HTMLImageElement>('img'))

  for (const img of imgElements) {
    const zoom = Number.parseFloat(img.style.getPropertyValue('zoom'))
    if (Number.isFinite(zoom)) {
      const width = img.getAttribute('width') || img.style.width
      img.style.removeProperty('zoom')
      img.addEventListener('load', () => {
        if (disposed) return
        const base = width && /^\d+(?:\.\d+)?(?:px|%)?$/.test(width) ? parseFloat(width) : img.naturalWidth
        img.style.width = `${base * zoom / 100}${width?.endsWith('%') ? '%' : 'px'}`
        img.style.maxWidth = '100%'
      }, { once: true })
    }
    const rawSrc = img.getAttribute('data-md-safe-src') ?? img.getAttribute('src') ?? ''
    img.removeAttribute('data-md-safe-src')
    img.removeAttribute('src')
    if (!rawSrc) continue

    const dest = imageDestination(rawSrc)

    if (onImageClick) {
      img.style.cursor = 'pointer'
      img.onclick = e => {
        e.stopPropagation()
        onImageClick(img)
      }
    }

    if (dest.kind === 'blocked') {
      replaceWithImageError(img, rawSrc, '只允许授权本地路径或合法的 HTTPS 图片')
      continue
    }

    if (dest.kind === 'remote') {
      if (!resources || !resources.allowedRemote.has(dest.path)) {
        const placeholder = document.createElement('span')
        placeholder.className = 'md-html-remote-image-btn'
        placeholder.textContent = `点击加载网络图片 (${dest.path})`
        placeholder.onclick = (e) => {
          e.stopPropagation()
          if (disposed || !placeholder.isConnected || !resources) return
          resources.allowedRemote.add(dest.path)
          img.src = dest.path
          placeholder.replaceWith(img)
        }
        img.replaceWith(placeholder)
      } else {
        img.src = dest.path
      }
      continue
    }

    // 本地图片资源：复用共享引用计数 Blob 池
    if (dest.kind === 'local' && resources) {
      const key = scopedImageBlobKey(resources, dest.path)
      const cachedUrl = tryAcquireExistingBlobUrl(key)
      if (cachedUrl) {
        acquiredKeys.push(key)
        img.src = cachedUrl
        img.classList.add('md-html-img-ready')
        continue
      }
      img.classList.add('md-html-img-loading')
      resources
        .loadLocal(dest.path)
        .then(bytes => {
          if (disposed || !img.isConnected) return
          const url = acquireBlobUrl(key, bytes, detectMimeType(bytes))
          acquiredKeys.push(key)
          img.src = url
          img.classList.remove('md-html-img-loading')
          img.classList.add('md-html-img-ready')
        })
        .catch(err => {
          if (disposed || !img.isConnected) return
          img.classList.remove('md-html-img-loading')
          const msg = err instanceof Error ? err.message : String(err)
          replaceWithImageError(img, rawSrc, msg.includes('系统找不到') ? '目标路径图片不存在' : msg)
        })
    } else if (dest.kind === 'local') {
      replaceWithImageError(img, rawSrc, '本地图片需要文档授权')
    }
  }

  return {
    destroy: () => {
      disposed = true
      for (const img of imgElements) {
        img.onload = img.onerror = img.onclick = null
        img.removeAttribute('src')
        img.remove()
      }
      for (const key of acquiredKeys) {
        releaseBlobUrl(key)
      }
      acquiredKeys.length = 0
    },
  }
}

function replaceWithImageError(img: HTMLImageElement, src: string, reason: string) {
  const errWrap = document.createElement('span')
  errWrap.className = 'md-html-image-error'
  errWrap.title = `${reason}\n${src}`
  for(const [className,text] of [['md-image-error-icon','🖼️'],['md-image-error-path',src],['md-image-error-tip',`(${reason})`]]){
    const span=document.createElement('span');span.className=className;span.textContent=text;errWrap.append(span)
  }
  img.replaceWith(errWrap)
}
