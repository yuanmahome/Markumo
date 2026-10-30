import type { Mark } from 'prosemirror-model'

export interface SourcePatch { from:number;to:number;insert:string;blockId?:string;htmlOrdinal?:number;imageDraft?:{from:number;to:number};inlineEdit?:{from:number;to:number;inherited:readonly Mark[]} }
export function textPatch(before:string,after:string):SourcePatch|null {
  if(before===after)return null
  let from=0,to=before.length,end=after.length
  while(from<to&&from<end&&before[from]===after[from])from++
  if(from && /[\uD800-\uDBFF]/.test(before[from-1]))from--
  while(to>from&&end>from&&before[to-1]===after[end-1]){to--;end--}
  if(to<before.length&&to>0&&/[\uD800-\uDBFF]/.test(before[to-1])){to++;end++}
  return {from,to,insert:after.slice(from,end)}
}
