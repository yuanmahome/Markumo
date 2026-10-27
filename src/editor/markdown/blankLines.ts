/** Source ranges of editable whitespace lines outside Markdown blocks.
 * A block's line terminator and one empty separator line are structural.
 * At EOF only the terminator is structural; at BOF every line is editable.
 * Callers supply tokenizer block boundaries, so fences/HTML/list interiors
 * are never inspected here. Offsets always refer to the original source. */
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
    ranges.push({ from: from + line.index!, to: from + line.index! + raw.length, text })
  }
  return ranges
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
