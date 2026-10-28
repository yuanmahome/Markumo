import { Mark, type Node } from 'prosemirror-model'
import { parseMarkdown, tokenizer } from './MarkdownParser'
import { textPatch } from './sourcePatch'

interface Difference { before:Node;after:Node;code?:boolean }
function singleDifference(before:Node,after:Node):Difference|null {
  if(before.eq(after))return null
  if(!before.sameMarkup(after)||before.isText||after.isText)return {before,after}
  if(before.childCount!==after.childCount)return null
  let difference:Difference|null=null
  for(let index=0;index<before.childCount;index++){
    const a=before.child(index),b=after.child(index)
    if(a.eq(b))continue
    if(difference)return null
    difference=singleDifference(a,b)
    if(!difference)return null
  }
  return difference?{...difference,code:difference.code||before.type.name==='code_block'}:null
}
/** Decode only lexical text escapes, retaining atomic source boundaries. The
 * segments store exceptions, not one retained offset per document character. */
function decodedText(raw:string,verbatim=false,indent='') {
  const atoms:{from:number;to:number;start:number;end:number}[]=[],parts:string[]=[]
  let cursor=0,size=0
  const escaped=/\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);|\r\n/g
  const prefix=indent.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const pattern=new RegExp((verbatim?'\\r\\n':escaped.source)+(indent?'|^'+prefix:''),'gm')
  for(const match of raw.matchAll(pattern)){
    const value=indent&&match[0]===indent?'':match[0]==='\r\n'?'\n':tokenizer.utils.unescapeAll(match[0])
    if(value===match[0])continue
    const plain=raw.slice(cursor,match.index);parts.push(plain,value);size+=plain.length
    atoms.push({from:match.index,to:match.index+match[0].length,start:size,end:size+value.length})
    size+=value.length;cursor=match.index+match[0].length
  }
  parts.push(raw.slice(cursor))
  return {text:parts.join(''),indent,original(position:number){
    let delta=0
    for(const atom of atoms){
      if(position<atom.from)break
      if(position<atom.to)return atom.start
      delta=atom.to-atom.end
    }
    return position-delta
  },offset(position:number):number|null {
    let delta=0
    for(const atom of atoms){
      if(position<atom.start)break
      if(position===atom.start)return atom.start===atom.end?atom.to:atom.from
      if(position<atom.end)return null
      if(position===atom.end)return atom.to
      delta=atom.to-atom.end
    }
    return position+delta
  }}
}

/** Map source/display coordinates using the same sparse lexical boundaries as
 * text patches. Delimiters and stripped indentation map to the nearest text
 * edge; entities are indivisible. No map survives the current call/revision. */
export function sourceTextPosition(node:Node,raw:string,position:number,reverse=false){
  const ranges:{from:number;to:number;start:number;end:number;source:(n:number)=>number;display:(n:number)=>number}[]=[]
  let cursor=0
  const opening=node.type.name==='code_block'?/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/.exec(raw)?.[0].length||0:0
  const body=raw.slice(opening),plain=decodedText(body),verbatim=decodedText(body,true)
  node.descendants((child,pos,parent)=>{
    if(child.type.name==='image_source'||child.type.name==='html_inline'){
      const source=String(child.attrs.source??''),at=source?raw.indexOf(source,cursor):-1
      if(at>=0){ranges.push({from:pos,to:pos+child.nodeSize,start:at,end:at+source.length,source:n=>n===pos?at:at+source.length,display:n=>n===at+source.length?pos+child.nodeSize:pos});cursor=at+source.length}
    }
    if(!child.isText)return
    const code=parent?.type.name==='code_block'||child.marks.some(mark=>mark.type.name==='code')
    const variants=[code?verbatim:plain],text=child.text!
    if(code){
      const line=text.split('\n').find(value=>value.trim())
      if(line){let count=0;for(let at=body.indexOf(line);at>=0&&count++<16;at=body.indexOf(line,at+1)){
        const prefix=body.slice(body.lastIndexOf('\n',at-1)+1,at)
        if(/^[ \t>]+$/.test(prefix))variants.unshift(decodedText(body,true,prefix))
      }}
    }
    for(const variant of variants){
      const at=variant.text.indexOf(text,variant.original(Math.max(0,cursor-opening)))
      if(at<0)continue
      const start=variant.offset(at),end=variant.offset(at+text.length)
      if(start===null||end===null)continue
      ranges.push({from:pos,to:pos+text.length,start:opening+start,end:opening+end,
        source:n=>opening+(variant.offset(at+n-pos)??start),display:n=>pos+variant.original(n-opening)-at})
      cursor=opening+end;break
    }
  })
  for(const range of ranges){
    if(reverse&&position>=range.start&&position<=range.end)return Math.max(range.from,Math.min(range.to,range.display(position)))
    if(!reverse&&position>=range.from&&position<range.to)return range.source(position)
  }
  if(!reverse){const end=ranges.find(range=>position===range.to);if(end)return end.source(position)}
  let nearest:{distance:number;position:number}|undefined
  for(const range of ranges)for(const edge of reverse?[[range.start,range.from],[range.end,range.to]]:[[range.from,range.start],[range.to,range.end]]){
    const distance=Math.abs(position-edge[0]);if(!nearest||distance<nearest.distance)nearest={distance,position:edge[1]}
  }
  return nearest?.position??Math.max(0,Math.min(reverse?node.content.size:raw.length,position))
}
function literal(text:string,verbatim:boolean){
  return verbatim?text:text.replace(/&/g,'&amp;').replace(/[\\`*_[\]<>!#~+(){}=\-]/g,'\\$&')
}

/** Preserve all unaffected source, accepting a candidate only when parsing it
 * produces exactly the intended PM block. Ambiguous repeated words are tested
 * against the whole block rather than matched by text alone. */
export function patchSourceBlock(before:Node,after:Node,raw:string,environment:Record<string,unknown>):string|null {
  const accepts=(candidate:string)=>{
    try{
      const parsed=parseMarkdown(candidate,environment)
      if(parsed.blocks.length!==1)return false
      const node=parsed.blocks[0].node
      return node.type.create({...node.attrs,sourceId:after.attrs.sourceId},node.content,node.marks).eq(after)
    }catch{return false}
  }
  const difference=singleDifference(before,after)
  if(!difference)return null
  const {before:a,after:b}=difference
  if(a.isText&&b.isText&&Mark.sameSet(a.marks,b.marks)){
    const change=textPatch(a.text!,b.text!)
    if(!change)return raw
    const verbatim=!!difference.code||before.type.name==='code_block'||a.marks.some(mark=>mark.type.name==='code')
    const variants=[{text:raw,indent:'',offset:(position:number):number|null=>position}]
    if(!verbatim||raw.includes('\r\n'))variants.push(decodedText(raw,verbatim))
    if(verbatim&&a.text!.includes('\n')){
      const line=a.text!.split('\n').find(line=>line.trim())
      if(line){let count=0;for(let at=raw.indexOf(line);at>=0&&count++<16;at=raw.indexOf(line,at+1)){
        const prefix=raw.slice(raw.lastIndexOf('\n',at-1)+1,at)
        if(/^[ \t>]+$/.test(prefix))variants.push(decodedText(raw,true,prefix))
      }}
    }
    let attempts=0
    for(const variant of variants){
      for(let at=variant.text.indexOf(a.text!);at>=0&&attempts<64;at=variant.text.indexOf(a.text!,at+1)){
        attempts++
        let from=change.from,to=change.to
        while(from>0&&variant.offset(at+from)===null)from--
        while(to<a.text!.length&&variant.offset(at+to)===null)to++
        const start=variant.offset(at+from),end=variant.offset(at+to)
        if(start===null||end===null)continue
        const insert=a.text!.slice(from,change.from)+change.insert+a.text!.slice(change.to,to)
        const direct=raw.slice(0,start)+insert.replace(/\n/g,'\n'+variant.indent)+raw.slice(end)
        if(accepts(direct))return direct
        const inserted=literal(insert,verbatim).replace(/\n/g,'\n'+variant.indent)
        const candidate=raw.slice(0,start)+inserted+raw.slice(end)
        if(candidate!==direct&&accepts(candidate))return candidate
        // Removing boundary whitespace can make underscore emphasis intraword.
        // Expand only to the touching delimiters; keep entities and all other
        // source untouched, and prove the resulting block semantics again.
        if(!verbatim)for(const marker of ['__','_']){
          if(raw.startsWith(marker,end)){
            let closing=raw.indexOf(marker,end+marker.length),count=0
            while(closing>=0&&count++<16){
              const repaired=raw.slice(0,start)+literal(insert,false)+'*'.repeat(marker.length)+raw.slice(end+marker.length,closing)+'*'.repeat(marker.length)+raw.slice(closing+marker.length)
              if(accepts(repaired))return repaired
              closing=raw.indexOf(marker,closing+marker.length)
            }
          }
          if(raw.slice(0,start).endsWith(marker)){
            let opening=raw.lastIndexOf(marker,start-marker.length-1),count=0
            while(opening>=0&&count++<16){
              const repaired=raw.slice(0,opening)+'*'.repeat(marker.length)+raw.slice(opening+marker.length,start-marker.length)+'*'.repeat(marker.length)+literal(insert,false)+raw.slice(end)
              if(accepts(repaired))return repaired
              opening=raw.lastIndexOf(marker,opening-1)
            }
          }
        }
      }
    }
  }
  if(a.type.name==='heading'&&b.type===a.type&&a.content.eq(b.content)){
    const match=/^( {0,3})(#{1,6})(?=[ \t]|$)/.exec(raw)
    if(match){const candidate=match[1]+'#'.repeat(b.attrs.level)+raw.slice(match[0].length);if(accepts(candidate))return candidate}
    const setext=/^(.*\r?\n)([ \t]*)(=+|-+)([ \t]*)$/.exec(raw)
    if(setext&&b.attrs.level<=2){const candidate=setext[1]+setext[2]+(b.attrs.level===1?'=':'-').repeat(setext[3].length)+setext[4];if(accepts(candidate))return candidate}
  }
  if(a.type.name==='image'&&b.type===a.type&&a.attrs.src!==b.attrs.src){
    const needle=String(a.attrs.src),insert=String(b.attrs.src)
    if(needle)for(let at=raw.indexOf(needle);at>=0;at=raw.indexOf(needle,at+needle.length)){
      const candidate=raw.slice(0,at)+insert+raw.slice(at+needle.length);if(accepts(candidate))return candidate
    }
  }
  if(a.type.name==='list_item'&&b.type===a.type&&a.content.eq(b.content)){
    for(const match of raw.matchAll(/^([ \t]*[-+*][ \t]+\[)[ xX](\][ \t])/gm)){
      const at=match.index+match[1].length,candidate=raw.slice(0,at)+(b.attrs.checked?'x':' ')+raw.slice(at+1)
      if(accepts(candidate))return candidate
    }
  }
  return null
}
