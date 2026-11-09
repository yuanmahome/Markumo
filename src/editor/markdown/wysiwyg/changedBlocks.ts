import type { Node } from 'prosemirror-model'

/** Inspect the changed top-level containers and their neighbours. Neighbours
 * matter when deleting a separator joins two lists. Whole changed containers
 * preserve nested-list and table normalization without walking unrelated trees. */
export function visitChangedBlocks(before: Node, after: Node, visit: Parameters<Node['nodesBetween']>[2]) {
  const start = before.content.findDiffStart(after.content)
  if (start === null) return
  const end = before.content.findDiffEnd(after.content)
  const first = Math.max(0, after.resolve(Math.min(start, after.content.size)).index(0) - 1)
  const last = Math.min(after.childCount, after.resolve(Math.min(end?.b ?? start, after.content.size)).index(0) + 2)
  let from = 0, to = 0
  for (let i = 0; i < last; i++) {
    if (i < first) from += after.child(i).nodeSize
    to += after.child(i).nodeSize
  }
  after.nodesBetween(from, to, visit)
}
