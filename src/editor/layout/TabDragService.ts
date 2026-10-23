import { ref } from 'vue'

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface TabDragPayload {
  documentId: string
  fromPaneId: string
  documentName: string
  isCopy: boolean
}

export interface TabInsertTarget {
  paneId: string
  targetDocId: string
  position: 'before' | 'after'
}

export interface PaneDropTarget {
  paneId: string
  zone: DropZone
}

export interface TabDragResult {
  payload: TabDragPayload
  paneDrop: PaneDropTarget | null
  tabInsert: TabInsertTarget | null
  /**
   * Set only when the pointer was actually released outside this window's
   * viewport and no in-window target received it. This is the single condition
   * that may detach the tab into a new native window: a lost pointer, a blur or
   * an Escape never produces it.
   */
  outside: { x: number; y: number } | null
}

// Use the closest proportional edge at corners, so left/right do not mask top/bottom.
export function resolvePaneDropZone(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, x: number, y: number): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const rx = (x - rect.left) / rect.width
  const ry = (y - rect.top) / rect.height
  const edges: [DropZone, number][] = [['top', ry], ['bottom', 1 - ry], ['left', rx], ['right', 1 - rx]]
  const closest = edges.reduce((a, b) => b[1] < a[1] ? b : a)
  return closest[1] < 0.28 ? closest[0] : 'center'
}

/** True when a viewport-relative point lies outside the window contents. */
export function isPointerOutside(x: number, y: number, width = window.innerWidth, height = window.innerHeight): boolean {
  const margin = 2
  return x < -margin || y < -margin || x > width + margin || y > height + margin
}

export class TabDragService {
  private static instance: TabDragService

  static getInstance(): TabDragService {
    return TabDragService.instance ||= new TabDragService()
  }

  readonly isDragging = ref(false)
  readonly dragPayload = ref<TabDragPayload | null>(null)
  readonly activePaneDrop = ref<PaneDropTarget | null>(null)
  readonly activeTabInsert = ref<TabInsertTarget | null>(null)

  private ghostEl: HTMLElement | null = null
  private startX = 0
  private startY = 0
  private lastX = 0
  private lastY = 0
  private pointerId: number | null = null
  private captureEl: HTMLElement | null = null
  private pendingPayload: TabDragPayload | null = null
  private scrollFrame = 0
  private clickTimer: ReturnType<typeof setTimeout> | undefined
  private onCommitCallback?: (result: TabDragResult) => void

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.pendingPayload || event.pointerId !== this.pointerId) return
    if (!(event.buttons & 1)) { this.cancelDrag(); return }
    if (!this.isDragging.value) {
      if (Math.hypot(event.clientX - this.startX, event.clientY - this.startY) < 5) return
      this.startDrag(event)
    }
    event.preventDefault()
    this.lastX = event.clientX
    this.lastY = event.clientY
    this.updateCopy(event)
    this.updateGhostPosition()
    this.detectDropTarget()
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return
    let result: TabDragResult | undefined
    const commit = this.onCommitCallback
    if (this.isDragging.value && this.dragPayload.value) {
      this.lastX = event.clientX
      this.lastY = event.clientY
      this.updateCopy(event)
      // Pointerup can arrive at a different position from the last move event.
      this.detectDropTarget()
      const hasTarget = !!(this.activePaneDrop.value || this.activeTabInsert.value)
      // Leaving the window is not a drop by itself: the platform must also have
      // delivered the release. Both conditions are required to detach.
      const outside =
        !hasTarget && isPointerOutside(this.lastX, this.lastY)
          ? { x: this.lastX, y: this.lastY }
          : null
      result = {
        payload: { ...this.dragPayload.value },
        paneDrop: this.activePaneDrop.value,
        tabInsert: this.activeTabInsert.value,
        outside,
      }
      event.preventDefault()
    }
    // Layout changes may unmount the source tab; clean up before committing.
    this.cancelDrag()
    if (result) commit?.(result)
  }

  private updateCopy(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey'>) {
    if (!this.dragPayload.value) return
    const isCopy = event.ctrlKey || event.altKey
    this.dragPayload.value.isCopy = isCopy
    const badge = this.ghostEl?.querySelector<HTMLElement>('.tab-ghost-badge')
    if (badge) badge.hidden = !isCopy
  }

  private handleKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      this.cancelDrag()
    } else {
      this.updateCopy(event)
    }
  }

  private handleCancel = () => this.cancelDrag()
  private handleVisibility = () => { if (document.hidden) this.cancelDrag() }
  private suppressClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    window.removeEventListener('click', this.suppressClick, true)
  }

  startWatching(event: PointerEvent, payload: Omit<TabDragPayload, 'isCopy'>, onCommit: (result: TabDragResult) => void) {
    if (event.button !== 0 || !event.isPrimary) return
    this.cancelDrag()
    clearTimeout(this.clickTimer)
    window.removeEventListener('click', this.suppressClick, true)
    this.startX = this.lastX = event.clientX
    this.startY = this.lastY = event.clientY
    this.pointerId = event.pointerId
    this.captureEl = event.currentTarget as HTMLElement
    this.pendingPayload = { ...payload, isCopy: event.ctrlKey || event.altKey }
    this.onCommitCallback = onCommit
    window.addEventListener('pointermove', this.handlePointerMove, { passive: false, capture: true })
    window.addEventListener('pointerup', this.handlePointerUp, true)
    window.addEventListener('pointercancel', this.handleCancel, true)
    window.addEventListener('blur', this.handleCancel)
    window.addEventListener('keydown', this.handleKey, true)
    window.addEventListener('keyup', this.handleKey, true)
    document.addEventListener('visibilitychange', this.handleVisibility)
    const onLostCapture = () => {
      if (this.isDragging.value) {
        this.cancelDrag()
      }
    }
    this.captureEl?.addEventListener('lostpointercapture', onLostCapture, { once: true })
  }

  private startDrag(event: PointerEvent) {
    this.isDragging.value = true
    this.dragPayload.value = this.pendingPayload
    this.updateCopy(event)
    this.captureEl?.setPointerCapture(event.pointerId)
    document.body.classList.add('is-tab-dragging')
    window.addEventListener('click', this.suppressClick, true)
    this.createGhost()
    this.scrollFrame = requestAnimationFrame(this.autoScroll)
  }

  private detectDropTarget() {
    const x = this.lastX, y = this.lastY
    const underCursor = document.elementFromPoint(x, y)
    this.activePaneDrop.value = null
    this.activeTabInsert.value = null
    const pane = underCursor?.closest<HTMLElement>('.pane[data-pane-id]')
    if (!pane?.dataset.paneId) return
    const paneId = pane.dataset.paneId
    const tabBar = underCursor?.closest<HTMLElement>('.tabs')
    if (tabBar) {
      const tabs = [...tabBar.querySelectorAll<HTMLElement>('.tab[data-document]')]
      const before = tabs.find(tab => {
        const rect = tab.getBoundingClientRect()
        return x < rect.left + rect.width / 2
      })
      this.activeTabInsert.value = {
        paneId,
        targetDocId: (before || tabs[tabs.length - 1])?.dataset.document || '',
        position: before ? 'before' : 'after',
      }
      return
    }
    const body = pane.querySelector<HTMLElement>('.pane-document-shell') || pane.querySelector<HTMLElement>('.pane-document') || pane
    this.activePaneDrop.value = { paneId, zone: resolvePaneDropZone(body.getBoundingClientRect(), x, y) }
  }

  private autoScroll = () => {
    if (!this.isDragging.value) return
    const tabBar = document.elementFromPoint(this.lastX, this.lastY)?.closest<HTMLElement>('.tabs')?.querySelector<HTMLElement>('.tabs-scroll')
    if (tabBar && tabBar.scrollWidth > tabBar.clientWidth) {
      const rect = tabBar.getBoundingClientRect()
      const edge = Math.min(40, rect.width / 4)
      const left = this.lastX - rect.left, right = rect.right - this.lastX
      const speed = left < edge ? -12 * (1 - left / edge) : right < edge ? 12 * (1 - right / edge) : 0
      if (speed) {
        tabBar.scrollLeft += speed
        this.detectDropTarget()
      }
    }
    this.scrollFrame = requestAnimationFrame(this.autoScroll)
  }

  private createGhost() {
    const ghost = document.createElement('div')
    ghost.className = 'tab-drag-ghost'
    ghost.setAttribute('aria-hidden', 'true')
    const name = document.createElement('span')
    name.className = 'tab-ghost-name'
    name.textContent = this.dragPayload.value?.documentName || ''
    const badge = document.createElement('span')
    badge.className = 'tab-ghost-badge'
    badge.textContent = '+ 视图'
    badge.hidden = !this.dragPayload.value?.isCopy
    ghost.append(name, badge)
    document.body.append(ghost)
    this.ghostEl = ghost
    this.updateGhostPosition()
  }

  private updateGhostPosition() {
    if (!this.ghostEl) return
    const x = Math.max(0, Math.min(this.lastX + 14, window.innerWidth - this.ghostEl.offsetWidth - 8))
    const y = Math.max(0, Math.min(this.lastY + 16, window.innerHeight - this.ghostEl.offsetHeight - 8))
    this.ghostEl.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  cancelDrag() {
    const wasDragging = this.isDragging.value
    if (this.pointerId !== null && this.captureEl?.hasPointerCapture(this.pointerId)) {
      this.captureEl.releasePointerCapture(this.pointerId)
    }
    this.isDragging.value = false
    this.dragPayload.value = null
    this.pendingPayload = null
    this.pointerId = null
    this.captureEl = null
    this.activePaneDrop.value = null
    this.activeTabInsert.value = null
    this.onCommitCallback = undefined
    document.body.classList.remove('is-tab-dragging')
    this.ghostEl?.remove()
    this.ghostEl = null
    cancelAnimationFrame(this.scrollFrame)
    window.removeEventListener('pointermove', this.handlePointerMove, true)
    window.removeEventListener('pointerup', this.handlePointerUp, true)
    window.removeEventListener('pointercancel', this.handleCancel, true)
    window.removeEventListener('blur', this.handleCancel)
    window.removeEventListener('keydown', this.handleKey, true)
    window.removeEventListener('keyup', this.handleKey, true)
    document.removeEventListener('visibilitychange', this.handleVisibility)
    if (wasDragging) this.clickTimer = setTimeout(() => window.removeEventListener('click', this.suppressClick, true), 0)
  }
}

export const tabDragService = TabDragService.getInstance()
