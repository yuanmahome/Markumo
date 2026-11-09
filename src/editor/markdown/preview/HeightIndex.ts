/** Measured heights with logarithmic prefix sums and viewport lookup. */
export class HeightIndex {
  private tree: number[] = [0]
  readonly heights: number[] = []
  append(height: number) {
    const n = this.heights.length + 1, low = n & -n
    this.tree[n] = height + this.prefix(n - 1) - this.prefix(n - low)
    this.heights.push(height)
  }
  prefix(count: number) { let sum = 0; for (let i = count; i > 0; i -= i & -i) sum += this.tree[i]; return sum }
  update(index: number, height: number) {
    const delta = height - this.heights[index]; this.heights[index] = height
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta
  }
  at(y: number) {
    let a = 0, b = this.heights.length
    while (a < b) { const mid = (a + b) >>> 1; if (this.prefix(mid + 1) <= y) a = mid + 1; else b = mid }
    return Math.min(a, Math.max(0, this.heights.length - 1))
  }
}
