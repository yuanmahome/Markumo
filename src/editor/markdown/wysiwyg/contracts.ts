import type { BracketMode } from '../../core/brackets'
import type { MarkdownFormat } from '../formatCommands'
import type { MarkdownResources } from '../images'
import type { CaretAnimation } from '../../core/caretMotion'
export interface MarkdownTypography { width:number; fontSize:number; fontFamily:string; lineHeight:number; codeLineNumbers:boolean; codeWrap:boolean; imageBorder:boolean }
export const defaultMarkdownTypography=():MarkdownTypography=>({width:860,fontSize:16,fontFamily:'system',lineHeight:1.6,codeLineNumbers:true,codeWrap:false,imageBorder:true})
export interface MarkdownClipboardSettings { copyAcrossBlocks: boolean; copyWholeLine: boolean }
export const defaultMarkdownClipboard = (): MarkdownClipboardSettings => ({ copyAcrossBlocks: true, copyWholeLine: false })
export type MarkdownToolbarCommand = 'footnote' | 'link-reference' | 'math' | 'toc' | 'yaml' | 'callout'
export interface LiveToolbarState {
  heading: number
  bold: boolean
  italic: boolean
  strike: boolean
  inlineCode: boolean
  link: boolean
  quote: boolean
  bullet: boolean
  ordered: boolean
  task: boolean
  codeBlock: boolean
  inCodeBlock: boolean
  hasYaml: boolean
  live: boolean
  readOnly: boolean
  composing: boolean
}
export interface MarkdownToolbarState extends LiveToolbarState { canUndo: boolean; canRedo: boolean }
export interface LiveEditor {
  viewportSourcePosition?(): number | null
  readonly composing:boolean
  readonly selection:{anchor:number;head:number}
  sync(source:string,update?:unknown):void
  focus():void
  reveal(position:number,align?:'nearest'|'start'):void
  format(format:MarkdownFormat):boolean
  toolbarState():LiveToolbarState
  insertToolbar(command:MarkdownToolbarCommand):boolean
  insertTable(rows:number,columns:number):boolean
  typography(settings:MarkdownTypography):void
  indent(size:number,tabs:boolean):void
  caretAnimation(mode:CaretAnimation):void
  bracketMode(mode:BracketMode):void
  clipboardSettings(settings:MarkdownClipboardSettings):void
  shortcut(event:KeyboardEvent):boolean
  clipboard(operation:'copy'|'cut'|'paste'|'select-all'):Promise<void>
  refreshResources():void
  typewriterMode(enabled: boolean): void
  destroy():void
  find(replace?:boolean):void
  findNext():void
  findPrevious():void
  closeSearch():void
}
export interface LiveOptions {
  shortcutLabel?(id:string):string|undefined
  caretAnimation?:CaretAnimation
  bracketMode?:BracketMode
  indentSize?:number
  useTabs?:boolean
  typewriterMode?: boolean
  isPaneActive?(): boolean
  source:string; anchor:number; head:number; resources:MarkdownResources; typography:MarkdownTypography; clipboard?:MarkdownClipboardSettings
  publish(expected:string,patch:{from:number;to:number;insert:string},update:unknown,isolated:boolean):boolean
  selected(anchor:number,head:number):void
  compositionChanged?():void
  history(forward:boolean):void
  focus():void
  openRelative?(href:string):void
  readOnly?():boolean
}
