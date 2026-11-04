import { detectMimeType, imageDestination, type MarkdownResources } from '../images'
import { cloneAndNamespaceSvg } from './renderers'

const MIN_ZOOM_SCALE = 0.05
const MAX_ZOOM_SCALE = 16
const ZOOM_STEP = 1.25

function parseSvgIntrinsicSize(svg: SVGSVGElement): { width: number; height: number; viewBox: string } {
  const rawViewBox = svg.getAttribute('viewBox')?.trim() || ''
  if (rawViewBox) {
    const parts = rawViewBox.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3], viewBox: rawViewBox }
    }
  }
  const rect = svg.getBoundingClientRect()
  const attrW = Number.parseFloat(svg.getAttribute('width') || '')
  const attrH = Number.parseFloat(svg.getAttribute('height') || '')
  const width = Math.max(
    1,
    rect.width > 0 ? rect.width : !svg.getAttribute('width')?.includes('%') && attrW > 0 ? attrW : 400
  )
  const height = Math.max(
    1,
    rect.height > 0 ? rect.height : !svg.getAttribute('height')?.includes('%') && attrH > 0 ? attrH : 300
  )
  return { width, height, viewBox: `0 0 ${width} ${height}` }
}

function captureScrollPositions(el: HTMLElement | null): Array<{ node: HTMLElement; top: number; left: number }> {
  const saved: Array<{ node: HTMLElement; top: number; left: number }> = []
  let cur: HTMLElement | null = el
  while (cur && cur !== document.body) {
    if (cur.scrollHeight > cur.clientHeight || cur.scrollWidth > cur.clientWidth) {
      saved.push({ node: cur, top: cur.scrollTop, left: cur.scrollLeft })
    }
    cur = cur.parentElement
  }
  return saved
}

/**
 * Singleton application-wide modal controller shared across all WYSIWYG and Split Preview panes.
 * Ensures at most ONE `<dialog>` exists in the entire WebView, lazily mounted on first open
 * and completely detached when the last editor/preview consumer is destroyed.
 */
class SharedMediaPreviewModal {
  readonly dom = document.createElement('dialog')
  private readonly surface = document.createElement('div')
  private readonly stage = document.createElement('div')
  private readonly image = document.createElement('img')
  private readonly percent = document.createElement('output')
  private readonly openOriginalBtn = document.createElement('button')
  private readonly owners = new Set<MediaPreview>()

  private activeOwner: MediaPreview | null = null
  private activeKind: 'image' | 'diagram' | null = null
  private activeElement: HTMLElement | SVGSVGElement | null = null
  private targetImage: HTMLImageElement | null = null
  private targetSvg: SVGSVGElement | null = null
  private initialTargetSrc = ''
  private baseWidth = 0
  private baseHeight = 0
  private scale = 1
  private fitMode = true
  private current = () => true
  private restoreEl: HTMLElement | null = null
  private restoreFocus: (() => void) | null = null
  private savedScrolls: Array<{ node: HTMLElement; top: number; left: number }> = []
  private fullUrl: string | null = null
  private onOpenOriginalCallback: (() => void) | null = null
  private openSeq = 0
  private pan: { pointerId: number; x: number; y: number; left: number; top: number } | null = null
  private mounted = false

  constructor() {
    this.dom.className = 'md-image-lightbox md-media-lightbox'
    this.dom.setAttribute('aria-label', '媒体放大预览')

    const bar = document.createElement('div')
    bar.className = 'md-image-lightbox-tools md-media-lightbox-tools'

    const button = (label: string, ariaLabel: string, title: string, action: () => void) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.textContent = label
      el.setAttribute('aria-label', ariaLabel)
      el.title = title
      el.onclick = action
      return el
    }

    this.percent.className = 'md-media-lightbox-scale'
    this.openOriginalBtn.type = 'button'
    this.openOriginalBtn.textContent = '打开原文件'
    this.openOriginalBtn.setAttribute('aria-label', '打开原文件')
    this.openOriginalBtn.hidden = true
    this.openOriginalBtn.onclick = () => this.onOpenOriginalCallback?.()

    bar.append(
      button('缩小', '缩小', '缩小 (-)', () => this.zoomBy(1 / ZOOM_STEP)),
      this.percent,
      button('放大', '放大', '放大 (+)', () => this.zoomBy(ZOOM_STEP)),
      button('适应窗口', '适应窗口', '适应窗口 (F)', () => this.fit()),
      button('100%', '100%', '100% 原始尺寸 (1)', () => this.zoomOneToOne()),
      button('重置', '重置', '重置视图 (0)', () => this.reset()),
      this.openOriginalBtn,
      button('关闭预览', '关闭预览', '关闭预览 (Esc)', () => this.close())
    )

    this.surface.className = 'md-image-lightbox-surface md-media-lightbox-surface'
    this.surface.tabIndex = 0
    this.surface.setAttribute('aria-label', '预览画布，滚轮缩放，左键拖动平移')
    this.stage.className = 'md-media-lightbox-stage'
    this.surface.append(this.stage)
    this.dom.append(bar, this.surface)

    this.image.draggable = false
    this.image.className = 'md-media-lightbox-img'

    this.surface.onpointerdown = event => {
      if (event.button !== 0 || !this.activeElement) return
      this.pan = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: this.surface.scrollLeft,
        top: this.surface.scrollTop,
      }
      this.surface.classList.add('is-dragging')
      try {
        this.surface.setPointerCapture(event.pointerId)
      } catch {
        // Ignore synthetic pointer events without active pointerId registration
      }
      this.surface.focus({ preventScroll: true })
      event.preventDefault()
    }

    this.surface.onpointermove = event => {
      if (!this.pan || event.pointerId !== this.pan.pointerId) return
      this.surface.scrollLeft = this.pan.left + (this.pan.x - event.clientX)
      this.surface.scrollTop = this.pan.top + (this.pan.y - event.clientY)
    }

    const endPan = (event?: PointerEvent) => {
      if (!this.pan) return
      if (event && event.pointerId !== this.pan.pointerId) return
      const pid = this.pan.pointerId
      this.pan = null
      this.surface.classList.remove('is-dragging')
      try {
        if (this.surface.hasPointerCapture(pid)) {
          this.surface.releasePointerCapture(pid)
        }
      } catch {
        // Ignore
      }
    }

    this.surface.onpointerup = endPan
    this.surface.onpointercancel = endPan
    this.surface.onlostpointercapture = () => endPan()

    // Pointer-centered wheel zoom (prevents underlying editor scroll)
    this.dom.addEventListener(
      'wheel',
      event => {
        if (!this.dom.open) return
        event.preventDefault()
        event.stopPropagation()
        if (!this.activeElement) return
        const rawDelta =
          event.deltaMode === 1
            ? event.deltaY * 32
            : event.deltaMode === 2
              ? event.deltaY * 300
              : event.deltaY
        const clampedDelta = Math.max(-240, Math.min(240, rawDelta))
        if (clampedDelta === 0) return
        const factor = Math.exp(-clampedDelta * 0.0025)
        this.setScale(this.scale * factor, { x: event.clientX, y: event.clientY })
      },
      { passive: false }
    )

    this.dom.addEventListener('keydown', event => {
      if (!this.dom.open) return
      event.stopPropagation()
      const key = event.key
      if (key === 'Escape') {
        event.preventDefault()
        this.close()
        return
      }
      if (event.altKey) return
      if (key === '+' || key === '=') {
        event.preventDefault()
        this.zoomBy(ZOOM_STEP)
      } else if (key === '-' || key === '_') {
        event.preventDefault()
        this.zoomBy(1 / ZOOM_STEP)
      } else if (key === '0') {
        event.preventDefault()
        this.reset()
      } else if (key === '1' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        this.zoomOneToOne()
      } else if ((key === 'f' || key === 'F') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        this.fit()
      } else if (!event.ctrlKey && !event.metaKey) {
        const step = 64
        if (key === 'ArrowLeft') {
          event.preventDefault()
          this.surface.scrollLeft -= step
        } else if (key === 'ArrowRight') {
          event.preventDefault()
          this.surface.scrollLeft += step
        } else if (key === 'ArrowUp') {
          event.preventDefault()
          this.surface.scrollTop -= step
        } else if (key === 'ArrowDown') {
          event.preventDefault()
          this.surface.scrollTop += step
        }
      }
    })

    this.dom.addEventListener('cancel', event => {
      event.preventDefault()
      this.close()
    })

    this.dom.onclick = event => {
      if (event.target === this.dom) {
        this.close()
      }
    }

    this.dom.onclose = () => {
      if (this.activeKind !== null || this.stage.childElementCount > 0 || this.fullUrl) {
        this.cleanupSession(true)
      }
    }
  }

  private ensureMounted() {
    if (this.mounted || typeof document === 'undefined') return
    document.body.append(this.dom)
    window.addEventListener('resize', this.onResize)
    this.mounted = true
  }

  private unmountIfUnused() {
    if (this.owners.size > 0 || !this.mounted) return
    if (this.dom.open) this.dom.close()
    this.cleanupSession(false)
    window.removeEventListener('resize', this.onResize)
    this.dom.remove()
    this.mounted = false
  }

  retain(owner: MediaPreview) {
    this.owners.add(owner)
  }

  release(owner: MediaPreview) {
    if (this.activeOwner === owner) {
      if (this.dom.open) this.dom.close()
      else this.cleanupSession(false)
    }
    this.owners.delete(owner)
    this.unmountIfUnused()
  }

  private onResize = () => {
    if (this.dom.open && this.fitMode) {
      this.fit()
    }
  }

  private revokeFullUrl() {
    if (this.fullUrl) {
      URL.revokeObjectURL(this.fullUrl)
      this.fullUrl = null
    }
  }

  private cleanupSession(restoreFocusNow: boolean) {
    this.openSeq++
    this.pan = null
    this.surface.classList.remove('is-dragging')
    this.activeOwner = null
    this.activeKind = null
    this.activeElement = null
    this.targetImage = null
    this.targetSvg = null
    this.initialTargetSrc = ''
    this.baseWidth = 0
    this.baseHeight = 0
    this.image.onload = this.image.onerror = null
    this.image.removeAttribute('src')
    this.image.remove()
    this.stage.replaceChildren()
    this.revokeFullUrl()
    this.onOpenOriginalCallback = null
    this.openOriginalBtn.hidden = true

    const restoreFn = this.restoreFocus
    const restoreEl = this.restoreEl
    const scrolls = this.savedScrolls
    this.restoreFocus = null
    this.restoreEl = null
    this.savedScrolls = []

    if (restoreFocusNow) {
      if (restoreFn) {
        restoreFn()
      } else if (restoreEl?.isConnected && restoreEl !== document.body) {
        restoreEl.focus({ preventScroll: true })
      }
      for (const item of scrolls) {
        if (item.node.isConnected) {
          item.node.scrollTop = item.top
          item.node.scrollLeft = item.left
        }
      }
    }
  }

  close() {
    if (this.dom.open) {
      this.dom.close()
      this.cleanupSession(true)
    } else {
      this.cleanupSession(false)
    }
  }

  get isOpen(): boolean {
    return this.dom.open
  }

  openImage(
    owner: MediaPreview,
    image: HTMLImageElement,
    current: () => boolean = () => true,
    restoreFocus?: () => void,
    fullLoader?: () => Promise<string | null>,
    onOpenOriginal?: () => void,
    explicitRestoreEl?: HTMLElement | null
  ) {
    if (!image.isConnected || !image.naturalWidth || !image.naturalHeight) return
    this.ensureMounted()
    const seq = ++this.openSeq
    this.revokeFullUrl()
    this.stage.replaceChildren()
    this.pan = null
    this.surface.classList.remove('is-dragging')

    const priorActive =
      explicitRestoreEl ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    if (!this.dom.open) {
      this.restoreEl = priorActive && !this.dom.contains(priorActive) ? priorActive : null
      this.savedScrolls = captureScrollPositions(image)
    }
    this.restoreFocus = restoreFocus ?? null

    this.activeOwner = owner
    this.activeKind = 'image'
    this.targetImage = image
    this.targetSvg = null
    this.initialTargetSrc = image.src
    this.current = current
    this.baseWidth = image.naturalWidth
    this.baseHeight = image.naturalHeight

    this.dom.setAttribute('aria-label', '图片放大预览')
    this.image.onload = this.image.onerror = null
    this.image.alt = image.alt || '图片预览'
    this.image.src = image.src
    this.activeElement = this.image
    this.stage.append(this.image)

    this.onOpenOriginalCallback = onOpenOriginal ?? null
    this.openOriginalBtn.hidden = !onOpenOriginal

    if (!this.dom.open) {
      this.dom.showModal()
    }
    this.fit()
    this.surface.focus({ preventScroll: true })

    if (fullLoader) {
      void fullLoader()
        .then(fullUrl => {
          if (!fullUrl) return
          if (!this.dom.open || seq !== this.openSeq || this.targetImage !== image) {
            URL.revokeObjectURL(fullUrl)
            return
          }
          this.revokeFullUrl()
          this.fullUrl = fullUrl
          const wasFit = this.fitMode
          this.image.onload = () => {
            if (this.dom.open && seq === this.openSeq && this.targetImage === image) {
              this.baseWidth = this.image.naturalWidth || image.naturalWidth
              this.baseHeight = this.image.naturalHeight || image.naturalHeight
              if (wasFit) this.fit()
              else this.applyDimensions()
            }
          }
          this.image.src = fullUrl
          if (this.image.complete && this.image.naturalWidth > 0) {
            this.baseWidth = this.image.naturalWidth
            this.baseHeight = this.image.naturalHeight
            if (wasFit) this.fit()
            else this.applyDimensions()
          }
        })
        .catch(() => {
          // Keep the downsampled preview visible if full-resolution read fails.
        })
    }
  }

  openDiagram(
    owner: MediaPreview,
    svg: SVGSVGElement,
    current: () => boolean = () => true,
    restoreFocus?: () => void,
    explicitRestoreEl?: HTMLElement | null
  ) {
    if (!svg.isConnected) return
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    this.ensureMounted()
    this.openSeq++
    this.revokeFullUrl()
    this.image.onload = this.image.onerror = null
    this.image.removeAttribute('src')
    this.stage.replaceChildren()
    this.pan = null
    this.surface.classList.remove('is-dragging')

    const priorActive =
      explicitRestoreEl ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    if (!this.dom.open) {
      this.restoreEl = priorActive && !this.dom.contains(priorActive) ? priorActive : null
      this.savedScrolls = captureScrollPositions(svg as unknown as HTMLElement)
    }
    this.restoreFocus = restoreFocus ?? null

    const { width, height, viewBox } = parseSvgIntrinsicSize(svg)
    const cloned = cloneAndNamespaceSvg(svg)
    cloned.classList.add('md-media-lightbox-svg')
    cloned.setAttribute('viewBox', viewBox)
    cloned.style.removeProperty('max-width')
    cloned.style.removeProperty('max-height')
    cloned.style.maxWidth = 'none'
    cloned.style.maxHeight = 'none'

    this.activeOwner = owner
    this.activeKind = 'diagram'
    this.targetImage = null
    this.targetSvg = svg
    this.initialTargetSrc = ''
    this.current = current
    this.baseWidth = width
    this.baseHeight = height
    this.activeElement = cloned

    this.dom.setAttribute('aria-label', 'Mermaid 图表放大预览')
    this.onOpenOriginalCallback = null
    this.openOriginalBtn.hidden = true
    this.stage.append(cloned)

    if (!this.dom.open) {
      this.dom.showModal()
    }
    this.fit()
    this.surface.focus({ preventScroll: true })
  }

  private computeFitScale(): number {
    const availW = Math.max(120, this.surface.clientWidth - 48)
    const availH = Math.max(120, this.surface.clientHeight - 48)
    const ratio = Math.min(availW / Math.max(1, this.baseWidth), availH / Math.max(1, this.baseHeight))
    const cap = this.activeKind === 'diagram' ? 1.5 : 1
    return Math.max(0.01, Math.min(cap, ratio))
  }

  fit() {
    if (!this.activeElement || this.baseWidth <= 0 || this.baseHeight <= 0) return
    this.scale = this.computeFitScale()
    this.fitMode = true
    this.applyDimensions()
    this.surface.scrollTo(0, 0)
  }

  zoomOneToOne() {
    if (!this.activeElement) return
    this.setScale(1)
  }

  reset() {
    if (!this.activeElement) return
    this.fit()
  }

  zoomBy(factor: number) {
    this.setScale(this.scale * factor)
  }

  setScale(nextScale: number, anchorClient?: { x: number; y: number }) {
    const el = this.activeElement
    if (!el || this.baseWidth <= 0 || this.baseHeight <= 0 || !Number.isFinite(nextScale)) return
    const minScale = Math.min(MIN_ZOOM_SCALE, this.computeFitScale() * 0.5)
    const clamped = Math.max(minScale, Math.min(MAX_ZOOM_SCALE, nextScale))

    const surfaceRect = this.surface.getBoundingClientRect()
    const point = anchorClient ?? {
      x: surfaceRect.left + surfaceRect.width / 2,
      y: surfaceRect.top + surfaceRect.height / 2,
    }
    const beforeRect = el.getBoundingClientRect()
    const relX = beforeRect.width > 0 ? (point.x - beforeRect.left) / beforeRect.width : 0.5
    const relY = beforeRect.height > 0 ? (point.y - beforeRect.top) / beforeRect.height : 0.5

    this.scale = clamped
    this.fitMode = false
    this.applyDimensions()

    const afterRect = el.getBoundingClientRect()
    const dx = afterRect.left + relX * afterRect.width - point.x
    const dy = afterRect.top + relY * afterRect.height - point.y
    if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
      this.surface.scrollLeft += dx
      this.surface.scrollTop += dy
    }
  }

  private applyDimensions() {
    const el = this.activeElement
    if (!el) return
    const w = Math.max(1, Math.round(this.baseWidth * this.scale * 100) / 100)
    const h = Math.max(1, Math.round(this.baseHeight * this.scale * 100) / 100)
    this.percent.value = `${Math.round(this.scale * 1000) / 10}%`
    el.style.width = `${w}px`
    el.style.height = `${h}px`
    if (el instanceof SVGSVGElement) {
      el.setAttribute('width', String(w))
      el.setAttribute('height', String(h))
    }
  }

  refreshOwner(owner: MediaPreview) {
    if (!this.dom.open || this.activeOwner !== owner) return
    if (!this.current()) {
      this.close()
      return
    }
    if (this.activeKind === 'image') {
      if (!this.targetImage?.isConnected || this.targetImage.src !== this.initialTargetSrc) {
        this.close()
      }
    } else if (this.activeKind === 'diagram') {
      if (!this.targetSvg?.isConnected) {
        this.close()
      }
    }
  }
}

let sharedModal: SharedMediaPreviewModal | null = null

function getSharedModal(): SharedMediaPreviewModal {
  if (!sharedModal) {
    sharedModal = new SharedMediaPreviewModal()
  }
  return sharedModal
}

/**
 * Per-pane handle backed by the single shared application modal.
 * Preserves full API compatibility with legacy `ImagePreview` while adding Mermaid SVG support.
 */
export class MediaPreview {
  private disposed = false
  private readonly modal = getSharedModal()

  constructor(_parent?: HTMLElement) {
    this.modal.retain(this)
  }

  get dom(): HTMLDialogElement {
    return this.modal.dom
  }

  open(
    image: HTMLImageElement,
    current: () => boolean = () => true,
    restoreFocus?: () => void,
    fullLoader?: () => Promise<string | null>,
    onOpenOriginal?: () => void,
    explicitRestoreEl?: HTMLElement | null
  ) {
    if (this.disposed) return
    this.modal.openImage(this, image, current, restoreFocus, fullLoader, onOpenOriginal, explicitRestoreEl)
  }

  openDiagram(
    svg: SVGSVGElement,
    current: () => boolean = () => true,
    restoreFocus?: () => void,
    explicitRestoreEl?: HTMLElement | null
  ) {
    if (this.disposed) return
    this.modal.openDiagram(this, svg, current, restoreFocus, explicitRestoreEl)
  }

  refresh() {
    if (!this.disposed) {
      this.modal.refreshOwner(this)
    }
  }

  close() {
    this.modal.close()
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.modal.release(this)
  }
}

export { MediaPreview as ImagePreview }

export interface MediaHoverTriggerOptions {
  readonly preview: MediaPreview
  readonly getResources?: () => MarkdownResources | undefined
  readonly isAlive?: () => boolean
}

export interface MediaHoverTriggerHandle {
  readonly button: HTMLButtonElement
  syncFocusTarget(container: Element | null): void
  reposition(): void
  hide(): void
  destroy(): void
}

type ResolvedMediaTarget =
  | { kind: 'image'; element: HTMLImageElement; anchor: HTMLElement }
  | { kind: 'diagram'; element: SVGSVGElement; anchor: HTMLElement }

function createZoomIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7')
  svg.append(path)
  return svg
}

function isValidLoadedImage(img: HTMLImageElement): boolean {
  if (!img.isConnected || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return false
  if (
    img.closest(
      '.is-broken-image, .is-pending-image, .md-html-img-loading, .md-html-image-error, .md-media-lightbox'
    )
  ) {
    return false
  }
  const rect = img.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function isValidRenderedDiagram(diagramBox: HTMLElement): SVGSVGElement | null {
  if (!diagramBox.isConnected || diagramBox.hidden || diagramBox.classList.contains('md-render-error')) {
    return null
  }
  const svg = diagramBox.querySelector<SVGSVGElement>(':scope > svg')
  if (!svg) return null
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return svg
}

function resolveMediaFromNode(paneEl: HTMLElement, node: EventTarget | null): ResolvedMediaTarget | null {
  if (!(node instanceof Element) || !paneEl.contains(node)) return null
  // Only match media inside actual Markdown content surfaces
  if (!node.closest('.md-prose, .split-preview-content')) return null

  const directImg = node instanceof HTMLImageElement ? node : node.closest('img')
  if (directImg && paneEl.contains(directImg) && isValidLoadedImage(directImg)) {
    return { kind: 'image', element: directImg, anchor: directImg }
  }

  const imageContainer = node.closest<HTMLElement>(
    '.md-live-image, .md-image-slot, .md-html-block-view, .md-html-inline-view'
  )
  if (imageContainer && paneEl.contains(imageContainer)) {
    const candidateImg = imageContainer.querySelector('img')
    if (candidateImg && isValidLoadedImage(candidateImg)) {
      // For HTML blocks that contain text + images, only activate on hover when over the img itself,
      // while allowing container match for keyboard focus!
      if (!node.closest('.md-html-block-view, .md-html-inline-view') || node === imageContainer) {
        return { kind: 'image', element: candidateImg, anchor: candidateImg }
      }
    }
  }

  const diagramBox = node.closest<HTMLElement>('.md-diagram')
  if (diagramBox && paneEl.contains(diagramBox)) {
    const svg = isValidRenderedDiagram(diagramBox)
    if (svg) return { kind: 'diagram', element: svg, anchor: diagramBox }
  }

  const codeFence = node.closest<HTMLElement>('.md-code-block, .md-preview-fence')
  if (codeFence && paneEl.contains(codeFence)) {
    const diagram = codeFence.querySelector<HTMLElement>(':scope .md-diagram')
    if (diagram) {
      const svg = isValidRenderedDiagram(diagram)
      if (svg) return { kind: 'diagram', element: svg, anchor: diagram }
    }
  }

  return null
}

/**
 * Mounts a single zero-layout-shift floating zoom button onto a Markdown pane (`.markdown-live` or `.split-preview-pane`).
 * Works identically for Markdown images, sanitized HTML `<img>`, and rendered Mermaid `<svg>`.
 */
export function attachMediaHoverTrigger(
  paneEl: HTMLElement,
  options: MediaHoverTriggerOptions
): MediaHoverTriggerHandle {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md-media-zoom-btn'
  button.setAttribute('aria-label', '放大预览')
  button.title = '放大预览'
  button.hidden = true
  button.append(createZoomIcon())
  paneEl.append(button)

  let disposed = false
  let hoveredTarget: ResolvedMediaTarget | null = null
  let focusedTarget: ResolvedMediaTarget | null = null
  let activeTarget: ResolvedMediaTarget | null = null
  let pointerOnButton = false
  let focusBeforeButtonPointer: HTMLElement | null = null

  const makeFullLoader = (img: HTMLImageElement): (() => Promise<string | null>) | undefined => {
    const rawSrc = img.dataset.mdRawSrc || ''
    const resources = options.getResources?.()
    if (!rawSrc || !resources) return undefined
    const dest = imageDestination(rawSrc)
    if (dest.kind !== 'local') return undefined
    return async () => {
      if (disposed || options.isAlive?.() === false) return null
      const bytes = await resources.loadLocal(dest.path, { full: true })
      if (disposed || options.isAlive?.() === false) return null
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: detectMimeType(bytes) }))
    }
  }

  const isTargetStillValid = (target: ResolvedMediaTarget | null): boolean => {
    if (!target || !paneEl.contains(target.anchor)) return false
    if (target.kind === 'image') return isValidLoadedImage(target.element)
    return isValidRenderedDiagram(target.anchor) === target.element
  }

  const updatePosition = () => {
    if (disposed) return
    const candidate =
      (pointerOnButton && isTargetStillValid(activeTarget) ? activeTarget : null) ??
      (isTargetStillValid(hoveredTarget) ? hoveredTarget : null) ??
      (isTargetStillValid(focusedTarget) ? focusedTarget : null) ??
      (document.activeElement === button && isTargetStillValid(activeTarget) ? activeTarget : null)

    if (!candidate) {
      activeTarget = null
      button.hidden = true
      return
    }

    activeTarget = candidate
    const paneRect = paneEl.getBoundingClientRect()
    const anchorRect = candidate.anchor.getBoundingClientRect()
    const btnSize = 26

    const minVisibleLeft = paneRect.left + 4
    const maxVisibleRight = paneRect.left + paneEl.clientWidth - 4
    const minVisibleTop = paneRect.top + 4
    const maxVisibleBottom = paneRect.top + paneEl.clientHeight - 4

    // Hide if the target has scrolled completely outside the pane viewport
    if (
      anchorRect.bottom <= minVisibleTop + 8 ||
      anchorRect.top >= maxVisibleBottom - 8 ||
      anchorRect.right <= minVisibleLeft + 8 ||
      anchorRect.left >= maxVisibleRight - 8
    ) {
      button.hidden = true
      return
    }

    // Avoid overlapping SplitPreview's `.md-code-copy` button (`top: 6px; right: 8px; width: 24px`)
    let rightInset = 6
    if (candidate.kind === 'diagram') {
      const fence = candidate.anchor.closest('.md-preview-fence')
      const copyBtn = fence?.querySelector<HTMLElement>(':scope > .md-code-copy:not([hidden])')
      if (copyBtn) {
        rightInset = 36
      } else {
        rightInset = 8
      }
    }

    const desiredViewportLeft = anchorRect.right - rightInset - btnSize
    const desiredViewportTop = anchorRect.top + 6

    const clampedViewportLeft = Math.max(
      Math.max(minVisibleLeft, anchorRect.left + 2),
      Math.min(maxVisibleRight - btnSize, desiredViewportLeft)
    )
    const clampedViewportTop = Math.max(
      minVisibleTop,
      Math.min(Math.min(maxVisibleBottom - btnSize, Math.max(anchorRect.top + 2, anchorRect.bottom - btnSize - 2)), desiredViewportTop)
    )

    button.style.left = `${Math.round(clampedViewportLeft - paneRect.left + paneEl.scrollLeft)}px`
    button.style.top = `${Math.round(clampedViewportTop - paneRect.top + paneEl.scrollTop)}px`
    button.dataset.mediaKind = candidate.kind
    button.hidden = false
  }

  const openActiveMedia = (viaKeyboard: boolean) => {
    if (disposed || !activeTarget || !isTargetStillValid(activeTarget)) return
    const target = activeTarget
    const restoreEl = viaKeyboard
      ? button
      : focusBeforeButtonPointer && focusBeforeButtonPointer !== button
        ? focusBeforeButtonPointer
        : document.activeElement instanceof HTMLElement && document.activeElement !== button
          ? document.activeElement
          : null

    if (target.kind === 'image') {
      const img = target.element
      const initialSrc = img.src
      options.preview.open(
        img,
        () => !disposed && options.isAlive?.() !== false && img.isConnected && img.src === initialSrc,
        undefined,
        makeFullLoader(img),
        undefined,
        restoreEl
      )
    } else {
      const svg = target.element
      options.preview.openDiagram(
        svg,
        () => !disposed && options.isAlive?.() !== false && svg.isConnected,
        undefined,
        restoreEl
      )
    }
  }

  button.onpointerenter = () => {
    pointerOnButton = true
  }
  button.onpointerleave = () => {
    pointerOnButton = false
    queueMicrotask(updatePosition)
  }
  button.onpointerdown = event => {
    if (event.button !== 0) return
    focusBeforeButtonPointer = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Prevent stealing editor caret/selection on mouse click
    event.preventDefault()
    event.stopPropagation()
  }
  button.onclick = event => {
    event.preventDefault()
    event.stopPropagation()
    const viaKeyboard = event.detail === 0
    openActiveMedia(viaKeyboard)
    focusBeforeButtonPointer = null
  }

  const onPointerMove = (event: PointerEvent) => {
    if (disposed) return
    const target = event.target
    if (target instanceof Node && button.contains(target)) {
      pointerOnButton = true
      return
    }
    pointerOnButton = false

    // Strictly hover-match actual media boxes (`img` or `.md-diagram`), not outer code fences
    let resolved: ResolvedMediaTarget | null = null
    if (target instanceof Element && paneEl.contains(target) && target.closest('.md-prose, .split-preview-content')) {
      const img = target instanceof HTMLImageElement ? target : target.closest('img')
      if (img && paneEl.contains(img) && isValidLoadedImage(img)) {
        resolved = { kind: 'image', element: img, anchor: img }
      } else {
        const diagramBox = target.closest<HTMLElement>('.md-diagram')
        if (diagramBox && paneEl.contains(diagramBox)) {
          const svg = isValidRenderedDiagram(diagramBox)
          if (svg) resolved = { kind: 'diagram', element: svg, anchor: diagramBox }
        }
      }
    }

    if (
      resolved?.element !== hoveredTarget?.element ||
      resolved?.anchor !== hoveredTarget?.anchor
    ) {
      hoveredTarget = resolved
      updatePosition()
    } else if (resolved && button.hidden) {
      updatePosition()
    }
  }

  const onPointerLeave = () => {
    pointerOnButton = false
    hoveredTarget = null
    updatePosition()
  }

  const onFocusIn = (event: FocusEvent) => {
    if (disposed) return
    const target = event.target
    if (target === button) {
      updatePosition()
      return
    }
    focusedTarget = resolveMediaFromNode(paneEl, target)
    updatePosition()
  }

  const onFocusOut = () => {
    queueMicrotask(() => {
      if (disposed) return
      const active = document.activeElement
      // Keep trigger visible while the modal dialog owns focus so Esc can restore focus back to button
      if (options.preview.dom.open && active && options.preview.dom.contains(active)) {
        return
      }
      if (active === button) {
        updatePosition()
        return
      }
      focusedTarget = active && paneEl.contains(active) ? resolveMediaFromNode(paneEl, active) : null
      updatePosition()
    })
  }

  const onScroll = () => {
    if (!button.hidden || hoveredTarget || focusedTarget) {
      updatePosition()
    }
  }

  paneEl.addEventListener('pointerover', onPointerMove, { passive: true })
  paneEl.addEventListener('pointermove', onPointerMove, { passive: true })
  paneEl.addEventListener('pointerleave', onPointerLeave, { passive: true })
  paneEl.addEventListener('focusin', onFocusIn)
  paneEl.addEventListener('focusout', onFocusOut)
  paneEl.addEventListener('scroll', onScroll, { capture: true, passive: true })

  let resizeObserver: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (!button.hidden || hoveredTarget || focusedTarget) {
        updatePosition()
      }
    })
    resizeObserver.observe(paneEl)
  }

  return {
    button,
    syncFocusTarget(container: Element | null) {
      if (disposed) return
      focusedTarget = container ? resolveMediaFromNode(paneEl, container) : null
      updatePosition()
    },
    reposition() {
      updatePosition()
    },
    hide() {
      hoveredTarget = null
      focusedTarget = null
      activeTarget = null
      pointerOnButton = false
      button.hidden = true
    },
    destroy() {
      if (disposed) return
      disposed = true
      resizeObserver?.disconnect()
      resizeObserver = undefined
      paneEl.removeEventListener('pointerover', onPointerMove)
      paneEl.removeEventListener('pointermove', onPointerMove)
      paneEl.removeEventListener('pointerleave', onPointerLeave)
      paneEl.removeEventListener('focusin', onFocusIn)
      paneEl.removeEventListener('focusout', onFocusOut)
      paneEl.removeEventListener('scroll', onScroll, true)
      button.onpointerenter = null
      button.onpointerleave = null
      button.onpointerdown = null
      button.onclick = null
      hoveredTarget = null
      focusedTarget = null
      activeTarget = null
      focusBeforeButtonPointer = null
      button.remove()
    },
  }
}
