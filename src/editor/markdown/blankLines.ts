/** Source spans of editable gap paragraphs, established by native Typora GUI
 * input/save measurements (see tests/phase042/fixtures/typora-blank-lines.json).
 * After the block terminator and separator, an empty paragraph owns TWO empty
 * source lines. An unmatched line stays in prefix/tail, byte-for-byte. This is
 * a source mapping, not a visual filter over physical-line paragraphs.
 * Whitespace-bearing lines remain individual editable content: never concatenate
 * their spaces/tabs or normalize them into empty lines. Tokenizer boundaries
 * keep fence, HTML and list interiors out of this scan. */
export function blankLineRanges(source: string, from: number, to: number, edge: 'start' | 'between' | 'end') {
  const ranges: { from: number; to: number; text: string }[] = []
  const gap = source.slice(from, to)
  if (/[^\t \r\n]/.test(gap)) return ranges
  const lines = [...gap.matchAll(/[^\n]*\n|[^\n]+$/g)]
  let separator = edge === 'between'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], raw = line[0], text = raw.replace(/\r?\n$/, '')
    if (i === 0 && edge !== 'start') continue
    if (separator) { separator = false; if (!text) continue }
    if (text) {
      ranges.push({ from: from + line.index!, to: from + line.index! + raw.length, text })
      continue
    }
    const next = lines[i + 1]
    if (!next || !raw.endsWith('\n') || !/^\r?\n$/.test(next[0])) continue
    ranges.push({ from: from + line.index!, to: from + next.index! + next[0].length, text: '' })
    i++
  }
  return ranges
}

/** Check if a node represents an editable blank paragraph (not a trailing placeholder). */
export function isBlankParagraphNode(node: { type: { name: string }; content: { content: readonly any[]; size?: number }; attrs?: { editorTrailing?: boolean } }) {
  if (node.type.name !== 'paragraph' || node.attrs?.editorTrailing) return false
  return node.content.content.every(child => child.isText && (!child.marks || !child.marks.length) && /^[\t ]*$/.test(child.text || ''))
}

/** An unclosed fence owns its trailing newlines; they are code content. */
export function markdownBlockEnd(source:string,from:number,end:number,fence?:string) {
  let to=end
  while(to>from&&source[to-1]==='\n'){
    to--;if(source[to-1]==='\r')to--
  }
  if(fence){
    const start=source.lastIndexOf('\n',to-1)+1
    const line=source.slice(start,to)
    const closing=new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
    if(start<=from||!closing.test(line))return end
  }
  return to
}
