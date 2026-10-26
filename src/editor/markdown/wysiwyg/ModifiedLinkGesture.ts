interface LinkTarget {
  element: HTMLAnchorElement
  href: string
  valid(): boolean
}

interface Gesture {
  target: LinkTarget
  pointer: number
  x: number
  y: number
  ctrl: boolean
  meta: boolean
  valid: boolean
  released: boolean
}

/** Own the entire modified click before native/ProseMirror selection handling.
 * Navigation happens only on click, after a matching, stationary pointerup. */
export class ModifiedLinkGesture {
  private gesture: Gesture | null = null
  private tracking?: AbortController
  private listeners = new AbortController()
  private releaseTimer?: ReturnType<typeof setTimeout>

  constructor(
    private root: HTMLElement,
    private target: (event: MouseEvent) => LinkTarget | null,
    private begin: () => void,
    private navigate: (href: string) => void,
  ) {
    const options = { capture: true, signal: this.listeners.signal }
    root.addEventListener('pointerdown', this.pointerDown, options)
    root.addEventListener('mousedown', this.mouseDown, options)
    root.addEventListener('click', this.click, options)
  }

  get active() { return this.gesture !== null && !this.gesture.released }

  private consume(event: Event) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private sameModifiers(event: MouseEvent | KeyboardEvent, gesture: Gesture) {
    return event.ctrlKey === gesture.ctrl && event.metaKey === gesture.meta && !event.altKey && !event.shiftKey
  }

  private pointerDown = (event: PointerEvent) => {
    this.clear()
    if (event.button !== 0 || !event.isPrimary || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    const target = this.target(event)
    if (!target) return
    this.gesture = { target, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      ctrl: event.ctrlKey, meta: event.metaKey, valid: true, released: false }
    this.begin()
    this.consume(event)
    this.tracking = new AbortController()
    const options = { capture: true, signal: this.tracking.signal }
    const doc = this.root.ownerDocument
    doc.addEventListener('pointermove', this.pointerMove, options)
    doc.addEventListener('pointerup', this.pointerUp, options)
    doc.addEventListener('pointercancel', this.cancel, options)
    doc.addEventListener('dragstart', this.drag, options)
    doc.addEventListener('keydown', this.keyChange, options)
    doc.addEventListener('keyup', this.keyChange, options)
    doc.addEventListener('visibilitychange', this.cancel, options)
    doc.defaultView?.addEventListener('blur', this.cancel, options)
  }

  private mouseDown = (event: MouseEvent) => {
    // Some engines deliver compatibility mouse events despite pointerdown being
    // cancelled. Never let them reach ProseMirror's mouse-selection handler.
    if (event.button === 0 && (this.gesture || ((event.ctrlKey || event.metaKey) && this.target(event)))) this.consume(event)
  }

  private pointerMove = (event: PointerEvent) => {
    const gesture = this.gesture
    if (!gesture || event.pointerId !== gesture.pointer) return
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5 || !this.sameModifiers(event, gesture)) gesture.valid = false
  }

  private pointerUp = (event: PointerEvent) => {
    const gesture = this.gesture
    if (!gesture || event.pointerId !== gesture.pointer) return
    this.pointerMove(event)
    gesture.released = event.button === 0 && this.sameModifiers(event, gesture) && this.target(event)?.element === gesture.target.element
    if (!gesture.released) gesture.valid = false
    this.tracking?.abort()
    // A release outside this editor has no click here. Do not keep the gesture
    // or its selection guard alive after the browser finishes this event turn.
    this.releaseTimer = setTimeout(() => this.clear(), 0)
  }

  private keyChange = (event: KeyboardEvent) => {
    if (this.gesture && !this.sameModifiers(event, this.gesture)) this.gesture.valid = false
  }

  private cancel = () => {
    if (this.gesture) { this.gesture.valid = false; this.gesture.released = true }
    this.tracking?.abort()
  }

  private drag = (event: DragEvent) => { this.cancel(); this.consume(event) }

  private click = (event: MouseEvent) => {
    if (event.button !== 0) return
    const gesture = this.gesture
    const target = this.target(event)
    if (!gesture && !((event.ctrlKey || event.metaKey) && target)) return
    this.consume(event)
    this.clear()
    if (gesture?.valid && gesture.released && this.sameModifiers(event, gesture) &&
      target?.element === gesture.target.element && target.href === gesture.target.href &&
      target.element.isConnected && gesture.target.valid()) this.navigate(gesture.target.href)
  }

  private clear() {
    if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer)
    this.releaseTimer = undefined
    this.tracking?.abort()
    this.tracking = undefined
    this.gesture = null
  }

  destroy() { this.clear(); this.listeners.abort() }
}
