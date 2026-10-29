import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorDocument } from '../../types'
import { htmlLanguage } from '@codemirror/lang-html'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { sanitizeMarkup } from '../markdown/html/sanitize'
import { codeAdapters, extractCodeSymbols } from './codeAdapters'
import { resolveLanguage } from '../languages'

let inlineMarkdown:InstanceType<typeof MarkdownIt>|undefined
// A Live pane has no CodeMirror viewport to advance its incremental parser.
// Tokenize Markdown independently so headings after the initial parse budget
// remain available. This parser only inspects tokens; HTML is never mounted.
let outlineMarkdown:InstanceType<typeof MarkdownIt>|undefined
// Outline rows navigate the editor. Titles must not add nested links, images,
// event handlers or remote requests inside those navigation buttons.
function inlineParser(){
  if(inlineMarkdown)return inlineMarkdown
  const parser=new MarkdownIt({html:false,linkify:false})
  parser.renderer.rules.link_open=parser.renderer.rules.link_close=()=>''
  parser.renderer.rules.image=(tokens,index)=>parser.utils.escapeHtml(tokens[index].content)
  parser.renderer.rules.softbreak=()=> ' '
  return inlineMarkdown=parser
}
const unescapeHtml=(source:string)=>inlineParser().utils.unescapeAll(source)
function headingLabel(source:string){
  const labelHtml=sanitizeMarkup(DOMPurify,inlineParser().renderInline(source),{ALLOWED_TAGS:['strong','em','s','code','br'],ALLOWED_ATTR:[]})
  return {name:unescapeHtml(labelHtml.replace(/<[^>]*>/g,'')),labelHtml}
}

export interface OutlineItem {
  id: string; name: string; level: number; lineNumber: number
  from?:number; to?:number
  labelHtml?:string
  kind?: 'heading' | 'function' | 'method' | 'constructor' | 'class' | 'interface' | 'struct' | 'enum' | 'trait' | 'impl' | 'type' | 'field' | 'member' | 'namespace' | 'object'
  parentId?:string; scopeFrom?:number; detail?:string
}
export type OutlineCapability = 'markdown' | 'code' | 'unsupported'
export type OutlineParseStatus = 'loading' | 'ready' | 'empty' | 'error' | 'paused'
export interface OutlineResult { items:OutlineItem[]; notice:string; status:OutlineParseStatus }
/** Capability describes the selected language, never a parse attempt or its
 * symbol count. It must remain stable while the same parser loads or fails. */
export function getOutlineCapability(doc:Pick<EditorDocument,'language'|'kind'|'encoding'>|null|undefined):OutlineCapability {
  if(!doc || doc.kind && doc.kind!=='text' || doc.encoding==='Hex')return 'unsupported'
  const language=resolveLanguage(doc.language || 'Plain Text')
  if(language?.name==='Markdown')return 'markdown'
  return language?.parser==='lezer' && !!codeAdapters[language.name] ? 'code' : 'unsupported'
}
const cache = new WeakMap<Text, Map<string,{tree:ReturnType<typeof syntaxTree>;result:OutlineResult}>>()
export const MAX_CODE_OUTLINE_SIZE = 256 * 1024
export const isMarkdownOutline=(doc:EditorDocument|null)=>getOutlineCapability(doc)==='markdown'
function markdownOutline(text: Text): OutlineItem[] {
  const tokens = (outlineMarkdown??=new MarkdownIt({html:true,linkify:false})).parse(text.toString(), {}), items: OutlineItem[] = []
  for (let index = 0; index < tokens.length && items.length < 1000; index++) {
    const token = tokens[index]
    if (!token.map) continue
    const line = text.line(token.map[0] + 1)
    if (token.type === 'heading_open') {
      const source = tokens[index + 1]?.content || ''
      const end = text.line(Math.min(text.lines, token.map[1])).to
      items.push({id:`h-${line.from}`, ...headingLabel(source), level:Number(token.tag.slice(1)), lineNumber:line.number, from:line.from, to:end, kind:'heading'})
    } else if (token.type === 'html_block') {
      const end = token.map[1] < text.lines ? text.line(token.map[1] + 1).from : text.length
      const raw = text.sliceString(line.from, end)
      htmlLanguage.parser.parse(raw).iterate({enter(node){
        if(node.name !== 'Element')return
        const open=node.node.getChild('OpenTag'), tag=open?.getChild('TagName')
        const name=tag&&raw.slice(tag.from,tag.to).toLowerCase()
        if(name&&/^(script|style|template|iframe|object)$/.test(name))return false
        if(!name||!/^h[1-6]$/.test(name)||!open||items.length>=1000)return
        const close=node.node.getChild('CloseTag'), from=line.from+node.from
        items.push({id:`h-${from}`,name:unescapeHtml(raw.slice(open.to,close?.from??node.to).replace(/<[^>]*>/g,'')).trim(),level:Number(name[1]),lineNumber:text.lineAt(from).number,from,to:line.from+node.to,kind:'heading'})
        return false
      }})
    }
  }
  return items
}
export function extractOutline(doc: EditorDocument | null, state: EditorState | undefined): OutlineItem[] {
  return outlineResult(doc,state).items
}

export function outlineResult(doc:EditorDocument|null,state:EditorState|undefined):OutlineResult {
  const empty=(notice='',status:OutlineParseStatus='empty'):OutlineResult=>({items:[],notice,status})
  const capability=getOutlineCapability(doc)
  if(!doc||!state||capability==='unsupported')return empty()
  const markdown=capability==='markdown'
  if(doc.languageStatus==='error')return empty(`${markdown?'大纲':'代码结构'}加载失败。${doc.languageError || '请重新加载语言解析器后重试。'}`,'error')
  if(doc.languageStatus!=='ready')return empty(markdown?'正在加载大纲…':'正在加载代码结构…','loading')
  const language=resolveLanguage(doc.language)!.name
  const text=state.doc,tree=syntaxTree(state),key=markdown?'markdown':language
  if(text.length>(markdown?1024*1024:MAX_CODE_OUTLINE_SIZE))return empty('文档较大，大纲已暂停。','paused')
  if(!markdown){
    if(tree.length<text.length || !syntaxTreeAvailable(state,text.length))return empty('正在加载代码结构…','loading')
  }
  const cached=cache.get(text)?.get(key)
  if(cached && (markdown||cached.tree===tree))return cached.result
  let result:OutlineResult
  try {
    if(markdown){const items=markdownOutline(text);result={items,status:items.length?'ready':'empty',notice:items.length>=1000?'大纲最多显示前 1000 项。':''}}
    else{
      const parsed=extractCodeSymbols(tree,text,language)
      result={items:parsed.items,status:parsed.items.length?'ready':'empty',notice:parsed.limited?'结构提取达到预算，已截断（最多 1000 项 / 50000 节点 / 30ms）。':''}
    }
  }catch{return empty('结构提取失败，请重新加载语言解析器后重试。','error')}
  let entries=cache.get(text);if(!entries)cache.set(text,entries=new Map())
  entries.set(key,{tree,result});return result
}
