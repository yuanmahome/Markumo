import type { SegmentedWindowEditor } from './SegmentedWindowEditor'

/** Byte-progress rail for the laboratory, separate from CM's local height map.
 * It provides access to every byte range including huge single lines, without
 * creating a DOM row per line or using an unbounded CSS height. */
export class SegmentedScrollRail {
  readonly element = document.createElement('div')
  private readonly track = document.createElement('div')
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private readonly onScroll = () => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      const travel = this.element.scrollHeight - this.element.clientHeight
      const byte = Math.round((travel > 0 ? this.element.scrollTop / travel : 0) * this.editor.metrics.byteLength)
      void this.editor.seek(Math.max(0, byte - 32768)).catch(this.notice)
    }, 80)
  }
  constructor(parent: HTMLElement, private readonly editor: SegmentedWindowEditor, private readonly notice: (error: Error) => void) {
    this.element.setAttribute('aria-label', '全文字节进度（原型）')
    this.element.style.cssText = 'height:100%;width:22px;overflow-y:scroll;flex:none'
    this.element.append(this.track); parent.append(this.element)
    this.refresh(); this.element.addEventListener('scroll', this.onScroll, { passive: true })
  }
  refresh() {
    if (this.disposed) return
    const { byteLength } = this.editor.metrics
    this.track.style.height = `${Math.max(this.element.clientHeight + 1, Math.min(16_000_000, Math.ceil(byteLength / 64)))}px`
  }
  destroy() {
    this.disposed = true; if (this.timer) clearTimeout(this.timer)
    this.element.removeEventListener('scroll', this.onScroll); this.element.remove()
  }
}
