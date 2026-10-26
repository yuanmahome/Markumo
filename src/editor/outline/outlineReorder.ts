import type { OutlineItem } from './outlineService'

export interface SectionRange {
  from: number
  to: number
  item: OutlineItem
  descendantCount: number
}

/** One minimal edit against the current source text. */
export interface SourceChange {
  from: number
  to: number
  insert: string
}

export interface OutlineMovePlan {
  valid: boolean
  error?: string
  sourceRange: { from: number; to: number }
  /** Insertion point in the *original* source, for reference and selection. */
  targetPos: number
  /** Minimal edits that perform the move; empty when invalid. */
  changes: SourceChange[]
  /** Where the moved heading starts after the edits are applied. */
  newCaretPos: number
}

/** Position of the first newline ending at each line start, for exact slices. */
function headingStart(from: number): number {
  // `from` already points at a line start recorded by the parser; keep any
  // leading indentation of that line so the whole heading line moves verbatim.
  return Math.max(0, from)
}

/**
 * Full source range of one section: its heading, its body and every descendant
 * heading. The end is the start of the next heading of the same or higher level,
 * which the caller took from the parser, never from a guessed offset.
 */
export function getSectionRange(items: OutlineItem[], sourceItem: OutlineItem, sourceLength: number): SectionRange | null {
  const index = items.findIndex(item => item.id === sourceItem.id)
  if (index === -1) return null
  const from = sourceItem.from
  if (typeof from !== 'number' || from < 0 || from > sourceLength) return null

  let to = sourceLength
  let descendantCount = 0
  for (let cursor = index + 1; cursor < items.length; cursor++) {
    const next = items[cursor]
    if (next.level <= sourceItem.level) {
      if (typeof next.from !== 'number') return null
      to = next.from
      break
    }
    descendantCount++
  }
  if (to < from) return null
  return { from: headingStart(from), to, item: sourceItem, descendantCount }
}

/**
 * Plans moving a whole section without touching anything else.
 *
 * Two disjoint edits move the section and transfer its boundary separator.
 * A section at EOF has no following separator: borrow its preceding separator
 * instead, preserving the document's exact final-newline suffix separately.
 */
export function planOutlineMove(
  fullSource: string,
  items: OutlineItem[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): OutlineMovePlan {
  const invalid = (error: string): OutlineMovePlan => ({
    valid: false,
    error,
    sourceRange: { from: 0, to: 0 },
    targetPos: 0,
    changes: [],
    newCaretPos: 0,
  })

  if (sourceId === targetId) return invalid('不能移动到自身')
  const sourceItem = items.find(item => item.id === sourceId)
  const targetItem = items.find(item => item.id === targetId)
  if (!sourceItem || !targetItem) return invalid('未找到对应章节')

  const sourceRange = getSectionRange(items, sourceItem, fullSource.length)
  const targetRange = getSectionRange(items, targetItem, fullSource.length)
  if (!sourceRange || !targetRange) return invalid('章节位置来自解析结果，当前无法定位')

  // A section can never be dropped inside itself or its own descendants.
  if (targetRange.from >= sourceRange.from && targetRange.from < sourceRange.to) {
    return invalid('禁止拖拽到自身或子章节内部')
  }
  if (sourceRange.to <= sourceRange.from) return invalid('章节内容为空，无法移动')

  const insertPos = position === 'before' ? targetRange.from : targetRange.to
  if (insertPos >= sourceRange.from && insertPos <= sourceRange.to) {
    return invalid('目标位置位于该章节内部')
  }

  const section = fullSource.slice(sourceRange.from, sourceRange.to)
  if (!section) return invalid('章节源码为空')
  const trailing = (text: string) => /(?:\r\n|\n|\r)+$/.exec(text)?.[0] || ''
  const finalSuffix = trailing(fullSource)
  const sectionSuffix = trailing(section)
  const core = section.slice(0, section.length - sectionSuffix.length)
  const sourceAtEnd = sourceRange.to === fullSource.length
  const preceding = sourceAtEnd ? trailing(fullSource.slice(0, sourceRange.from)) : ''
  const separator = sourceAtEnd ? preceding : sectionSuffix
  if (!separator) return invalid('章节边界缺少可保留的换行分隔符')
  const deleteFrom = sourceRange.from - preceding.length
  const removal: SourceChange = { from: deleteFrom, to: sourceRange.to, insert: sourceAtEnd ? finalSuffix : '' }
  const destination: SourceChange = insertPos === fullSource.length
    ? { from: insertPos - finalSuffix.length, to: insertPos, insert: separator + core + finalSuffix }
    : { from: insertPos, to: insertPos, insert: core + separator }
  const changes = [removal, destination].sort((a, b) => a.from - b.from)
  if (changes[0].to > changes[1].from) return invalid('章节边界重叠')
  const shift = removal.from < destination.from ? removal.insert.length - (removal.to - removal.from) : 0
  const newCaretPos = destination.from + shift + (insertPos === fullSource.length ? separator.length : 0)

  return {
    valid: true,
    sourceRange: { from: sourceRange.from, to: sourceRange.to },
    targetPos: insertPos,
    changes,
    newCaretPos,
  }
}
