import { Fragment, Slice, type Node } from 'prosemirror-model'
import { parseMarkdown, type SourceBlock } from './MarkdownParser'
import { patchTable, serializeBlock } from './MarkdownSerializer'
import { isTrailingParagraph, withoutTrailingParagraph } from './TrailingParagraph'
import { isBlankParagraphNode } from '../blankLines'
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
    // Remove only the source lines represented by editable gap paragraphs.
    // The remaining prefix is the original Markdown block separator, including
    // its exact EOL spelling. It is emitted once per gap, never per paragraph.
    const separators=new Map<string,string>()
    const gaps=new Map<string,{blanks:SourceBlock[];tail:string}>()
    let gapBlanks:SourceBlock[]=[]
    let separator='',firstId:string|undefined
    for(const block of this.blocks){
      separator+=block.prefix
      if(block.blank){gapBlanks.push(block);continue}
      firstId??=block.id
      gaps.set(block.id,{blanks:gapBlanks,tail:block.prefix});gapBlanks=[]
      separators.set(block.id,separator);separator=''
    }
    const originalTail=separator+this.tail
    const tailGap={blanks:gapBlanks,tail:this.tail}
    const eol=this.source.match(/\r?\n/)?.[0] || '\n'
    const entries:{node:Node;id:string;old?:SourceBlock;raw:string;blank:boolean}[]=[]
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
      if(!old?.node.eq(node))raw=raw.replace(/\r?\n/g,old?.raw.match(/\r?\n/)?.[0] || eol)
      const blank=isBlankParagraphNode(node)
      if(blank)raw=old?.blank&&old.node.eq(node)?old.raw:node.textContent+eol+eol
      entries.push({node,id,old,raw,blank})
      if(node.type.name==='protected_source' && !old?.node.eq(node) && (node.attrs.kind === 'reference' || old?.node.attrs.kind === 'reference' || /^\s*\[[^\]]+\]:/m.test(raw)))definitionsChanged=true
    })
    const emit=(entry:typeof entries[number],prefix:string)=>{
      source+=prefix;const from=source.length;source+=entry.raw
      blocks.push({id:entry.id,from,to:source.length,raw:entry.raw,prefix,node:entry.node,blank:entry.blank || undefined})
    }
    // Structural bytes can sit AFTER an editable span too (odd-length gaps,
    // or a space/tab line). Keep them in their original order around surviving
    // spans, instead of collecting every prefix at the start of the gap.
    const gapLayout=(pending:typeof entries,prefix:string,gap?:{blanks:SourceBlock[];tail:string})=>{
      const ids=new Set(pending.filter(entry=>entry.old?.blank).map(entry=>entry.id))
      const prefixes=new Map<string,string>();let carry=''
      for(const block of gap?.blanks || []){
        carry+=block.prefix
        if(ids.has(block.id)){prefixes.set(block.id,carry);carry=''}
      }
      if(!prefixes.size)return {prefixes:pending.map((_,i)=>i===0?prefix:''),tail:''}
      carry+=gap!.tail
      const result=pending.map(entry=>prefixes.get(entry.id)||'')
      // A newly inserted paragraph before the first surviving span shares its
      // leading separator; it must not acquire another copy of that separator.
      const first=pending.findIndex(entry=>prefixes.has(entry.id))
      if(first>0){result[0]=result[first];result[first]=''}
      return {prefixes:result,tail:carry}
    }
    let pending:typeof entries=[],hasContent=false
    for(const entry of entries){
      if(entry.blank){pending.push(entry);continue}
      const original=entry.old&&!entry.old.blank?separators.get(entry.id):undefined
      let prefix=hasContent?(original || eol+eol):(entry.id===firstId?original || '':'')
      if(pending.length){
        const layout=gapLayout(pending,prefix,gaps.get(entry.id))
        prefix=layout.prefixes[0]
        // Minimal Markdown may have just one terminator between blocks. An
        // inserted paragraph still needs its own span beyond the normal
        // separator. A whitespace-bearing line remains actual user content.
        if(hasContent&&!pending[0].node.textContent){
          const count=(prefix.match(/\n/g)||[]).length
          if(count<2)prefix+=eol.repeat(2-count)
        }
        layout.prefixes[0]=prefix
        pending.forEach((blank,index)=>{
          if(!blank.raw.endsWith('\n'))blank.raw=blank.node.textContent+eol+eol
          emit(blank,layout.prefixes[index])
        })
        emit(entry,layout.tail);pending=[]
      }else emit(entry,prefix)
      hasContent=true
    }
    let tail=originalTail
    if(pending.length){
      // The final editable position in a whitespace-only document owns no
      // bytes. Preserve existing spans; only a newly inserted final position
      // is zero-byte. Moving that position into the interior materializes a
      // complete paragraph span, just like an ordinary Enter.
      if(!hasContent){
        pending.forEach((entry,index)=>{
          if(index===pending.length-1 && !entry.old)entry.raw=entry.node.textContent
          else if(index<pending.length-1&&!entry.raw.endsWith('\n'))entry.raw=entry.node.textContent+eol+eol
        })
      }else{
        pending.forEach((entry,index)=>{
          if(!entry.raw.endsWith('\n')&&(index<pending.length-1||!entry.raw))entry.raw=entry.node.textContent+eol+eol
        })
      }
      const prefix=hasContent?(originalTail || eol):''
      const layout=gapLayout(pending,prefix,tailGap)
      pending.forEach((entry,index)=>emit(entry,layout.prefixes[index]))
      tail=layout.tail
    }
    if(inlinePatch&&!inlineApplied)throw new Error('局部源码目标已失效，拒绝修改。')
    source+=tail
    const patch=textPatch(this.source,source)
    if(this.blocks.some(block=>!used.has(block.id)&&(block.node.attrs.kind === 'reference'||/^\s*\[[^\]]+\]:/m.test(block.raw))))definitionsChanged=true
    return {source,patch,definitionsChanged,commit:()=>{this.source=source;this.doc=withoutTrailingParagraph(doc);this.blocks=blocks;this.tail=tail;if(definitionsChanged)this.environment=parseMarkdown(source).environment}}
  }
  sourcePosition(pos:number){
    let offset=0
    for(const b of this.blocks){if(pos<offset+b.node.nodeSize){
      const local=Math.max(0,pos-offset-1)
      if(b.node.type.name==='code_block'){const opening=/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/.exec(b.raw);return Math.min(b.to,b.from+(opening?.[0].length||0)+local)}
      const mapped=inlineSourcePosition(b.node,b.raw,local)
      return Math.min(b.to,b.from+mapped)
    }offset+=b.node.nodeSize}
    return this.source.length
  }
  documentPosition(sourcePos:number){
    let offset=0
    for(const b of this.blocks){if(sourcePos<b.to || sourcePos===b.to&&!b.blank){
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
