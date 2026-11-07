import { invoke } from '@tauri-apps/api/core'
import type { OpenBatch, Preferences } from '../files/contracts'
import type { WorkspaceInfo } from '../workspace/contracts'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import { mapInfo } from '../workspace/tauriWorkspace'
import type { SerializedLayoutNode } from '../../editor/layout/types'
import { sameFilePath } from '../files/pathKey'
export interface EditorSessionLayout { root: SerializedLayoutNode; activePane: string; maximizedPane: string | null; modes?:Record<string,Record<string,string>> }

export interface LaunchResult {
  kind: 'app' | 'file' | 'detached'; ownsSession: boolean; files: OpenBatch; roots: WorkspaceInfo[]
  activePath: string | null; layout: Preferences['layout']; warnings: string[]
  editorLayout?: EditorSessionLayout | null
}
export interface SessionInput {
  kind: 'single' | 'workspace'; tabs: { token:string; encoding:string }[]; activeToken: string | null; layout: Preferences['layout']
  editorLayout?: EditorSessionLayout
}
export async function initializeLaunch(): Promise<LaunchResult> {
  const result=await invoke<Omit<LaunchResult,'roots'> & {roots:Parameters<typeof mapInfo>[0][]}>('initialize_launch')
  return {...result,roots:result.roots.map(mapInfo)}
}
export function sessionInput(manager:DocumentManager, roots:readonly WorkspaceInfo[], layout:Preferences['layout']):SessionInput {
  const docs=manager.openedDocuments.filter(doc=>!!doc.fileToken&&!!doc.path)
  return {kind:roots.length?'workspace':'single',tabs:docs.map(doc=>({token:doc.fileToken!,encoding:doc.kind==='javaClass'?'ClassInfo':doc.kind==='image'||doc.kind==='pdf'?'Media':doc.encoding})),
    activeToken:docs.find(doc=>doc.id===manager.activeId)?.fileToken||docs[0]?.fileToken||null,layout:{...layout},
    editorLayout:{root:mapEditorLayout(manager.layout.serialize(),id=>manager.metadata(id)?.fileToken||null),activePane:manager.activePane,maximizedPane:manager.layout.maximizedPaneId,
      modes:Object.fromEntries(manager.layout.getAllPanes().map(pane=>[pane.id,Object.fromEntries(pane.group.tabs.flatMap(tab=>{const doc=manager.metadata(tab.documentId);return doc?.fileToken&&doc.mode?[[doc.fileToken,manager.getMarkdownMode(doc.id,pane.id)||doc.mode]]:[]}))]))}}
}
function mapEditorLayout(node:SerializedLayoutNode,resolve:(id:string)=>string|null):SerializedLayoutNode {
  if(node.type==='split')return {...node,first:mapEditorLayout(node.first,resolve),second:mapEditorLayout(node.second,resolve)}
  return {...node,tabs:node.tabs.flatMap(tab=>{const documentId=resolve(tab.documentId);return documentId?[{...tab,documentId}]:[]}),activeId:node.activeId?resolve(node.activeId):null}
}
export function restoreEditorLayout(manager:DocumentManager,layout:EditorSessionLayout|null|undefined) {
  if(!layout)return
  const root=mapEditorLayout(layout.root,path=>manager.openedDocuments.find(doc=>sameFilePath(doc.path,path))?.id||null)
  // Reuse the existing layout serializer and normal pane activation path.
  if(manager.restoreLayout(root)){
    for(const [pane,modes]of Object.entries(layout.modes||{}))for(const[path,mode]of Object.entries(modes)){
      const doc=manager.openedDocuments.find(doc=>sameFilePath(doc.path,path));if(doc&&['live','source','split'].includes(mode))manager.setMarkdownMode(doc.id,mode as 'live'|'source'|'split',pane)
    }
    manager.layout.focusPane(layout.activePane)
    if(layout.maximizedPane&&manager.layout.getPane(layout.maximizedPane))manager.layout.maximizedPaneId=layout.maximizedPane
    manager.notify()
  }
}

// Coalesce metadata-only snapshots. No text bodies or per-keystroke IPC.
export class SessionWriter {
  private timer:ReturnType<typeof setTimeout>|undefined
  private next:SessionInput|null=null
  private last=''
  private pending:Promise<void>=Promise.resolve()
  private error:unknown=null
  constructor(private readonly write:(input:SessionInput)=>Promise<unknown>,private readonly failed:(error:unknown)=>void){}
  invalidate(){this.last=''}
  prime(input:SessionInput){this.last=JSON.stringify(input)}
  schedule(input:SessionInput){
    const signature=JSON.stringify(input)
    if(signature===this.last)return
    this.last=signature;this.next=input
    if(this.timer)clearTimeout(this.timer)
    this.timer=setTimeout(()=>{void this.flush()},250)
  }
  flush(strict=false):Promise<void>{
    if(this.timer)clearTimeout(this.timer);this.timer=undefined
    this.pending=this.pending.then(async()=>{
      const input=this.next;this.next=null
      if(!input)return
      try{await this.write(input);this.error=null}catch(error){this.error=error;if(!this.next){this.last='';this.failed(error)}}
    })
    return this.pending.then(()=>{if(strict&&this.error)throw this.error})
  }
  dispose(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.next=null}
}
