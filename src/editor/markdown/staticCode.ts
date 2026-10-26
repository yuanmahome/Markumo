import type { SyntaxSpan } from '../core/syntaxSpans'

export interface StaticSearchRange {
  from: number
  to: number
  current: boolean
}

/** Split source ranges, never highlighted HTML. A multi-line token is closed
 * and reopened on each row; overlapping YAML/Lezer/search classes remain combined. */
export function staticCodeLines(
  code: string,
  spans: readonly SyntaxSpan[],
  escape: (value: string) => string,
  compact = false,
  searchRanges: readonly StaticSearchRange[] = []
) {
  const lines = code.split('\n'), starts = [0]
  for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1)
  const ranges: { from: number; to: number; classes: string }[][] = lines.map(() => [])
  const zeroMarkers: { at: number; current: boolean }[][] = lines.map(() => [])

  const findRow = (offset: number) => {
    let low = 0, high = starts.length
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) low = mid; else high = mid }
    return low
  }

  const pushSpan = (span: SyntaxSpan) => {
    const low = findRow(span.from)
    for (let row = low; row < lines.length && starts[row] < span.to; row++) {
      const from = Math.max(0, span.from - starts[row]), to = Math.min(lines[row].length, span.to - starts[row])
      if (to > from) ranges[row].push({ from, to, classes: span.classes })
    }
  }

  for (const span of spans) pushSpan(span)
  for (const sr of searchRanges) {
    if (sr.from < 0 || sr.to < sr.from || sr.to > code.length) continue
    if (sr.from === sr.to) {
      const row = findRow(sr.from)
      const col = Math.max(0, Math.min(lines[row].length, sr.from - starts[row]))
      zeroMarkers[row].push({ at: col, current: sr.current })
    } else {
      pushSpan({
        from: sr.from,
        to: sr.to,
        classes: sr.current
          ? 'cm-searchMatch md-search-match cm-searchMatch-selected md-search-match-current'
          : 'cm-searchMatch md-search-match',
      })
    }
  }

  const renderZeroMarkers = (rowIdx: number, col: number) => {
    const list = zeroMarkers[rowIdx]
    if (!list.length) return ''
    let out = ''
    for (const m of list) {
      if (m.at === col) {
        out += `<span class="cm-searchMatch md-search-zero md-search-match${m.current ? ' cm-searchMatch-selected md-search-match-current' : ''}" aria-hidden="true"></span>`
      }
    }
    return out
  }

  return lines.map((line, index) => {
    const row = ranges[index]
    const zCols = zeroMarkers[index].map(m => m.at)
    const points = [...new Set([0, line.length, ...zCols, ...row.flatMap(range => [range.from, range.to])])].sort((a, b) => a - b)
    let html = renderZeroMarkers(index, 0)
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i], to = points[i + 1], text = escape(line.slice(from, to))
      const classes = [...new Set(row.filter(range => range.from <= from && range.to >= to).flatMap(range => range.classes.split(' ')))].join(' ')
      html += classes ? `<span class="${escape(classes)}">${text}</span>` : text
      html += renderZeroMarkers(index, to)
    }
    if (compact) return `<span class="md-code-line" data-line="${index + 1}"><span class="md-code-number" aria-hidden="true">${index + 1}</span><span class="md-code-text">${html}</span></span>`
    const number = String(index + 1).padStart(Math.max(2, String(lines.length).length), ' ')
    return `<span class="md-code-line"><span class="md-code-number" aria-hidden="true">${number}</span><span class="md-code-text">${html}</span></span>`
  }).join('')
}
