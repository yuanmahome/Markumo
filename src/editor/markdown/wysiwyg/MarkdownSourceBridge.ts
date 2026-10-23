import { Fragment, Slice, type Node } from 'prosemirror-model'
import { parseMarkdown, type SourceBlock } from './MarkdownParser'
import { patchTable, serializeBlock } from './MarkdownSerializer'
import { isTrailingParagraph, withoutTrailingParagraph } from './TrailingParagraph'
export interface SourcePatch { from:number;to:number;insert:string;blockId?:string;htmlOrdinal?:number;imageDraft?:{from:number;to:number} }
export function textPatch(before:string,after:string):SourcePatch|null {
  if(before===after)return null
  let from=0,to=before.length,end=after.length
  while(from<to&&from<end&&before[from]===after[from])from++
  // Do not split UTF-16 surrogate pairs when constructing CM changes.
  if(from && /[\uD800-\uDBFF]/.test(before[from-1]))from--
  while(to>from&&end>from&&before[to-1]===after[end-1]){to--;end--}
  if(to<before.length&&to>0&&/[\uD800-\uDBFF]/.test(before[to-1])){to++;end++}
  return {from,to,insert:after.slice(from,end)}
}
export class MarkdownSourceBridge {
  source:string; doc:Node; blocks:SourceBlock[]; tail:string; environment:Record<string,unknown>
  constructor(source:string,previous?:{blocks:readonly SourceBlock[];environment:Record<string,unknown>}){this.source=source;const parsed=parseMarkdown(source,{},previous);this.doc=parsed.doc;this.blocks=parsed.blocks;this.tail=parsed.tail;this.environment=parsed.environment}
  /** Prepare without mutating; commit only after the canonical document accepts
   * the patch against the exact expected source revision. */
  prepare(doc:Node, inlinePatch?:SourcePatch){
    const byId=new Map(this.blocks.map(b=>[b.id,b])),used=new Set<string>(),blocks:SourceBlock[]=[]
    let source='',definitionsChanged=false,inlineApplied=false
    doc.forEach(node=>{
      if(isTrailingParagraph(node) && !node.content.size)return
      const id=node.attrs.sourceId as string,old=id&&!used.has(id)?byId.get(id):undefined
      if(id)used.add(id)
      let inlineRaw:string|undefined
      if(old && inlinePatch && (!inlinePatch.blockId||inlinePatch.blockId===old.id) && inlinePatch.from>=old.from && inlinePatch.to<=old.to){
        const candidate=old.raw.slice(0,inlinePatch.from-old.from)+inlinePatch.insert+old.raw.slice(inlinePatch.to-old.from)
        const parsed=parseMarkdown(candidate,this.environment).doc
        if(parsed.childCount===1){
          const parsedNode=parsed.firstChild!
          if(parsedNode.type.create({...parsedNode.attrs,sourceId:node.attrs.sourceId},parsedNode.content,parsedNode.marks).eq(node))inlineRaw=candidate
        }
        // During HTML composition an incomplete tag is still an editable raw
        // atom. Validate the exact old raw range AND the sole changed PM atom;
        // never accept an arbitrary replacement merely because it is HTML.
        if(inlineRaw===undefined&&inlinePatch.htmlOrdinal!==undefined){
          let ordinal=0,found=false
          const replace=(current:Node):Node=>{
            if(current.type.name==='html_inline'&&ordinal++===inlinePatch.htmlOrdinal){
              if(current.attrs.source!==old.raw.slice(inlinePatch.from-old.from,inlinePatch.to-old.from))return current
              found=true;return current.type.create({...current.attrs,source:inlinePatch.insert},current.content,current.marks)
            }
            if(current.isLeaf)return current
            return current.copy(Fragment.from(current.content.content.map(replace)))
          }
          if(replace(old.node).eq(node)&&found)inlineRaw=candidate
        }
        if (inlineRaw === undefined && inlinePatch.imageDraft) {
          const { from, to } = inlinePatch.imageDraft
          // Accept only the exact image/text atom being edited, with all other
          // content unchanged. Incomplete syntax is real canonical source too.
          const previous = old.node.slice(from, to).content
          if (previous.childCount === 1 && ['image', 'image_source'].includes(previous.firstChild!.type.name)) {
            const draft = node.type.schema.nodes.image_source.create({ source: inlinePatch.insert }, null, previous.firstChild!.marks)
            if (old.node.replace(from, to, new Slice(Fragment.from(draft), 0, 0)).eq(node)) inlineRaw = candidate
          }
        }
        if(inlineRaw===undefined)throw new Error('局部源码与文档节点不一致，拒绝修改。')
        inlineApplied=true
      }
      let raw=inlineRaw??(old?.node.eq(node)?old.raw:old&&node.type.name==='table'&&old.node.type===node.type?(patchTable(old.node,node,old.raw)??serializeBlock(node)):serializeBlock(node))
      if(old && !old.node.eq(node) && old.raw.includes('\r\n')) raw=raw.replace(/\r?\n/g,'\r\n')
      // An empty source has a placeholder paragraph but no source block. Two
      // missing blocks must not count as the same existing first block.
      const prefix = !blocks.length ? (old && old === this.blocks[0] ? old.prefix : '') : (old ? old.prefix || (!raw.startsWith('\n') ? '\n\n' : '') : (!raw.startsWith('\n') ? '\n\n' : ''))
      source+=prefix;const from=source.length;source+=raw
      if(node.type.name==='protected_source' && !old?.node.eq(node) && (node.attrs.kind === 'reference' || old?.node.attrs.kind === 'reference' || /^\s*\[[^\]]+\]:/m.test(raw)))definitionsChanged=true
      blocks.push({id,from,to:source.length,raw,prefix,node})
    })
    if(inlinePatch&&!inlineApplied)throw new Error('局部源码目标已失效，拒绝修改。')
    source+=this.tail
    const patch=textPatch(this.source,source)
    if(this.blocks.some(block=>!used.has(block.id)&&(block.node.attrs.kind === 'reference'||/^\s*\[[^\]]+\]:/m.test(block.raw))))definitionsChanged=true
    return {source,patch,definitionsChanged,commit:()=>{this.source=source;this.doc=withoutTrailingParagraph(doc);this.blocks=blocks;if(definitionsChanged)this.environment=parseMarkdown(source).environment}}
  }
  sourcePosition(pos:number){
    let offset=0
    for(const b of this.blocks){if(pos<=offset+b.node.nodeSize){
      const local=Math.max(0,pos-offset-1)
      if(b.node.type.name==='code_block'){const opening=/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/.exec(b.raw);return Math.min(b.to,b.from+(opening?.[0].length||0)+local)}
      const mapped=inlineSourcePosition(b.node,b.raw,local)
      return Math.min(b.to,b.from+mapped)
    }offset+=b.node.nodeSize}
    return this.source.length
  }
  documentPosition(sourcePos:number){
    let offset=0
    for(const b of this.blocks){if(sourcePos<=b.to){
      let local=Math.max(0,sourcePos-b.from)
      if(b.node.type.name==='code_block'){const opening=/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/.exec(b.raw);local=Math.max(0,local-(opening?.[0].length||0))}
      return Math.min(offset+b.node.nodeSize-1,offset+1+local)
    }offset+=b.node.nodeSize}
    return Math.max(0,this.doc.content.size-1)
  }
}
function inlineSourcePosition(node:Node,raw:string,position:number){
  let cursor=0,result:number|undefined
  node.descendants((child,pos)=>{
    if(result!==undefined)return false
    if (child.type.name === 'image_source') {
      const start = raw.indexOf(child.attrs.source, cursor)
      if (start >= 0) { if (position >= pos && position <= pos + 1) result = start; cursor = start + child.attrs.source.length }
    }
    if(child.isText){
      const text=child.text!,start=raw.indexOf(text,cursor)
      if(start>=0){if(position>=pos&&position<=pos+text.length)result=start+position-pos;cursor=start+text.length}
    }
  })
  return result??Math.min(raw.length,position)
}
