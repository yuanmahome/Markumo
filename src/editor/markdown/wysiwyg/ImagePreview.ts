// Preview only uses the URL of an image already loaded through MarkdownResources.
// Zoom changes this dialog's pixels, never the Markdown or a neighbouring image.
export class ImagePreview {
  readonly dom = document.createElement('dialog')
  private image = document.createElement('img')
  private surface = document.createElement('div')
  private percent = document.createElement('output')
  private openOriginalBtn = document.createElement('button')
  private target: HTMLImageElement | null = null
  private restore: HTMLElement | null = null
  private scale = 1
  private current = () => true
  private restoreFocus: (() => void) | null = null
  private fullUrl: string | null = null
  private onOpenOriginalCallback: (() => void) | null = null

  constructor(parent: HTMLElement) {
    this.dom.className = 'md-image-lightbox'
    this.dom.setAttribute('aria-label', '图片放大预览')
    const bar = document.createElement('div')
    bar.className = 'md-image-lightbox-tools'
    const button = (label: string, action: () => void) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.textContent = label
      el.setAttribute('aria-label', label)
      el.onclick = action
      return el
    }

    this.openOriginalBtn.type = 'button'
    this.openOriginalBtn.textContent = '打开原文件'
    this.openOriginalBtn.setAttribute('aria-label', '打开原文件')
    this.openOriginalBtn.hidden = true
    this.openOriginalBtn.onclick = () => this.onOpenOriginalCallback?.()

    bar.append(
      button('缩小', () => this.zoom(this.scale / 1.25)),
      this.percent,
      button('放大', () => this.zoom(this.scale * 1.25)),
      button('适应窗口', () => this.fit()),
      button('原始大小', () => this.zoom(1)),
      this.openOriginalBtn,
      button('关闭预览', () => this.dom.close()),
    )
    this.surface.className = 'md-image-lightbox-surface'
    this.surface.append(this.image)
    this.dom.append(bar, this.surface)
    parent.append(this.dom)
    this.image.draggable = false
    let pan: { x: number; y: number; left: number; top: number } | null = null
    this.surface.onpointerdown = event => {
      if (event.button !== 0) return
      pan = { x: event.clientX, y: event.clientY, left: this.surface.scrollLeft, top: this.surface.scrollTop }
      this.surface.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
    this.surface.onpointermove = event => {
      if (pan) this.surface.scrollTo(pan.left + pan.x - event.clientX, pan.top + pan.y - event.clientY)
    }
    this.surface.onpointerup = this.surface.onpointercancel = () => { pan = null }
    this.dom.onclick = event => {
      if (event.target === this.dom) this.dom.close()
    }
    this.dom.onclose = () => {
      this.target = null
      this.image.removeAttribute('src')
      if (this.fullUrl) {
        URL.revokeObjectURL(this.fullUrl)
        this.fullUrl = null
      }
      this.onOpenOriginalCallback = null
      this.openOriginalBtn.hidden = true
      if (this.restoreFocus) this.restoreFocus()
      else if (this.restore?.isConnected) this.restore.focus({ preventScroll: true })
      this.restore = null
      this.restoreFocus = null
    }
    window.addEventListener('resize', this.onResize)
  }

  private onResize = () => {
    if (this.dom.open) this.fit()
  }

  open(
    image: HTMLImageElement,
    current: () => boolean = () => true,
    restoreFocus?: () => void,
    fullLoader?: () => Promise<string | null>,
    onOpenOriginal?: () => void,
  ) {
    if (!image.isConnected || !image.naturalWidth) return
    this.restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.restoreFocus = restoreFocus ?? null
    this.target = image
    this.current = current
    this.image.src = image.src
    this.image.alt = image.alt
    this.onOpenOriginalCallback = onOpenOriginal ?? null
    this.openOriginalBtn.hidden = !onOpenOriginal
    if (!this.dom.open) this.dom.showModal()
    this.fit()

    if (fullLoader) {
      void fullLoader().then(fullUrl => {
        if (!this.dom.open || this.target !== image || !fullUrl) return
        this.fullUrl = fullUrl
        this.image.src = fullUrl
        this.image.onload = () => {
          if (!this.dom.open) return
          this.fit()
        }
      })
    }
  }

  private fit() {
    if (!this.target) return
    const w = this.image.naturalWidth || this.target.naturalWidth
    const h = this.image.naturalHeight || this.target.naturalHeight
    this.zoom(Math.min(1, Math.max(120, this.surface.clientWidth - 32) / w, Math.max(120, this.surface.clientHeight - 32) / h))
    this.surface.scrollTo(0, 0)
  }

  private zoom(scale: number) {
    if (!this.target) return
    const w = this.image.naturalWidth || this.target.naturalWidth
    const h = this.image.naturalHeight || this.target.naturalHeight
    this.scale = Math.max(.001, Math.min(8, scale))
    this.percent.value = `${Math.round(this.scale * 1000) / 10}%`
    this.image.style.width = `${w * this.scale}px`
    this.image.style.height = `${h * this.scale}px`
  }

  refresh() {
    if (this.dom.open && (!this.current() || !this.target?.isConnected || this.target.src !== this.image.src)) {
      this.dom.close()
    }
  }

  destroy() {
    window.removeEventListener('resize', this.onResize)
    this.restore = null
    this.restoreFocus = null
    this.dom.onclose = null
    if (this.fullUrl) {
      URL.revokeObjectURL(this.fullUrl)
      this.fullUrl = null
    }
    if (this.dom.open) this.dom.close()
    this.dom.remove()
  }
}
