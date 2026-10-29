import type { ByteEdit, TextWindow } from './protocol'

/** Bounded window mapping, independently derived from UTF-8 scalar widths.
 * Offsets are typed arrays, not IPC number[] proportional to the entire file. */
export class WindowMap {
  readonly text: string
  readonly bytes: Uint32Array
  private readonly storage: Uint32Array
  readonly endByte: number
  constructor(readonly raw: string, readonly startByte: number) {
    if (!Number.isSafeInteger(startByte) || startByte < 0) throw new RangeError('无效全局字节偏移。')
    this.text = raw.replace(/\r\n?|\n/g, '\n')
    this.bytes = new Uint32Array(this.text.length + 1)
    this.storage = new Uint32Array(this.text.length + 1)
    let local = 0, at = 0, bytes = 0
    while (at < raw.length) {
      const scalar = raw.codePointAt(at)!
      if (scalar >= 0xd800 && scalar <= 0xdfff) throw new RangeError('不接受未配对的 UTF-16 代理项；原内容仍保留。')
      const crlf = scalar === 13 && raw.charCodeAt(at + 1) === 10
      const width = scalar > 0xffff ? 2 : 1
      if (width === 2) { this.bytes[local + 1] = bytes; this.storage[local + 1] = at }
      local += width
      at += crlf ? 2 : width
      bytes += crlf ? 2 : scalar < 0x80 ? 1 : scalar < 0x800 ? 2 : scalar < 0x10000 ? 3 : 4
      this.bytes[local] = bytes
      this.storage[local] = at
    }
    this.endByte = startByte + bytes
  }
  get retainedBytes() { return this.bytes.byteLength + this.storage.byteLength + 2 * (this.raw.length + this.text.length) }
  private assertLocal(offset: number) {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length ||
      (offset > 0 && offset < this.text.length && /[\uD800-\uDBFF]/.test(this.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(this.text[offset])))
      throw new RangeError('位置超出窗口或切开 UTF-16 代理对；未提交编辑。')
  }
  toByte(offset: number) { this.assertLocal(offset); return this.startByte + this.bytes[offset] }
  toLocal(byte: number) {
    if (!Number.isSafeInteger(byte) || byte < this.startByte || byte > this.endByte) throw new RangeError('字节位置不在窗口内。')
    const wanted = byte - this.startByte
    let a = 0, b = this.bytes.length - 1
    while (a < b) { const mid = (a + b) >>> 1; if (this.bytes[mid] < wanted) a = mid + 1; else b = mid }
    if (this.bytes[a] !== wanted) throw new RangeError('位置切开 UTF-8 字符或 CRLF。')
    return a
  }
  /** All ranges belong to one pre-edit revision, as in CM ChangeSet. */
  change(changes: readonly { from: number; to: number; insert: string }[], separator: '\n' | '\r\n' | '\r') {
    const edits: ByteEdit[] = []
    let raw = this.raw, end = 0
    for (const change of changes) {
      this.assertLocal(change.from); this.assertLocal(change.to)
      if (change.from < end || change.to < change.from) throw new RangeError('编辑范围重叠。')
      end = change.to
      edits.push({ from: this.toByte(change.from), to: this.toByte(change.to), insert: change.insert.replace(/\r\n?|\n/g, separator) })
    }
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i]
      raw = raw.slice(0, this.storage[change.from]) + edits[i].insert + raw.slice(this.storage[change.to])
    }
    return { edits, mapping: new WindowMap(raw, this.startByte) }
  }
  static from(window: TextWindow) {
    const mapping = new WindowMap(window.text, window.startByte)
    if (mapping.endByte !== window.endByte) throw new Error('窗口内容与字节边界不匹配。')
    return mapping
  }
}
