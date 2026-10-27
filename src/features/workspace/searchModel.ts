import type {Text} from '@codemirror/state'
import type { SearchMatch, SearchSourcePreview } from './contracts'

export type GlobalSearchStatus='idle'|'searching'|'complete'|'empty'|'canceled'|'limited'|'partial'|'error'
export interface SearchWindowState { x:number|null;y:number|null;width:number;height:number|null;split:number;pinned:boolean }
export const defaultSearchWindow=():SearchWindowState=>({x:null,y:null,width:820,height:null,split:.52,pinned:false})
export function searchMatchId(match:SearchMatch){return match.id || `${match.search_id}:${match.document_id || match.path}:${match.line_number}:${match.column_number}:${match.match_length}`}
// Split the list, not the Glob grammar. Braced alternatives and character
// classes remain intact for Rust globset to parse and validate.
export function globPatterns(value:string){
  const patterns:string[]=[];let start=0,depth=0,escaped=false
  for(let at=0;at<value.length;at++){
    const char=value[at]
    if(escaped){escaped=false;continue}if(char==='\\'){escaped=true;continue}
    if(char==='{'||char==='[')depth++;else if(char==='}'||char===']')depth=Math.max(0,depth-1)
    else if(char===','&&!depth){patterns.push(value.slice(start,at).trim());start=at+1}
  }
  patterns.push(value.slice(start).trim());return patterns.filter(Boolean)
}
export function bufferPreview(source:Text,match:SearchMatch,matches:SearchMatch[]):SearchSourcePreview {
  if(match.line_number<1||match.line_number>source.lines)throw Error('搜索行号已过期，请重新搜索')
  const line=source.line(match.line_number),anchor=line.from+match.column_number-1
  if(anchor<line.from||anchor+match.match_length>line.to)throw Error('搜索列号已过期，请重新搜索')
  let from=source.line(Math.max(1,match.line_number-20)).from,to=source.line(Math.min(source.lines,match.line_number+21)).to
  let truncated=false
  if(to-from>256*1024){truncated=true;from=Math.max(0,anchor-64*1024);to=Math.min(source.length,from+256*1024);if(/[\uDC00-\uDFFF]/.test(source.sliceString(from,from+1)))from++;if(/[\uD800-\uDBFF]/.test(source.sliceString(to-1,to)))to--}
  const hits=matches.flatMap(item=>{
    if(item.line_number<1||item.line_number>source.lines)return []
    const start=source.line(item.line_number).from+item.column_number-1
    return start>=from&&start+item.match_length<=to?[{from:start-from,to:start-from+item.match_length}]:[]
  })
  return {path:match.path,version:match.version||'',text:source.sliceString(from,to),start_line:source.lineAt(from).number,selection_from:anchor-from,selection_to:Math.min(to-from,anchor-from+match.match_length),hits,truncated}
}
