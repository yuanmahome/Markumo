import {isTauri,invoke} from '@tauri-apps/api/core'
import {listen} from '@tauri-apps/api/event'
import {getCurrentWindow} from '@tauri-apps/api/window'
import {onMounted,onUnmounted,watch,type Ref} from 'vue'
import type {WorkspaceController} from './WorkspaceController'
import {searchMatchId} from './searchModel'

// Only UI metadata, bounded snippets and the active bounded preview cross IPC.
// Neither DocumentManager nor workspace buffers are serialized.
export const searchViewFields=[
 'searchShowDiff','searchPreviewVisible','searchId','searchQuery','searching','searchTotal','searchResults','searchDialogOpen','searchScope','searchStatus','searchMessage','searchSkipped',
 'searchInclude','searchExclude','searchIncludeIgnored','searchSort','searchHistory','replacementHistory','searchWindow','selectedMatchId',
 'searchPreview','searchPreviewError','searchPreviewLoading','isCaseSensitive','isWholeWord','isRegex','searchDirectory','replaceExpanded',
 'replacementText','replaceMessage','replacementReport','replaceBusy','replaceApplying','replaceProgress','searchFocusRevision','searchFocusReplace',
] as const
export const searchInputFields=['searchShowDiff','searchPreviewVisible','searchQuery','replacementText','searchScope','searchInclude','searchExclude','searchIncludeIgnored','isCaseSensitive','isWholeWord','isRegex','searchDirectory','replaceExpanded','searchSort'] as const
export interface SearchMessage {session:string;payload:{kind:string;client?:string;request?:number;searchId?:string;action?:string;args?:unknown[];patch?:Record<string,unknown>}}
export function useSearchWindow(workspace:WorkspaceController,shortcuts:Ref<Record<string,string>>,blocked:()=>boolean,mini:()=>boolean){
 let session='',label='',viewClient='',revision=0,lastRequest=0,disposed=false,timer:ReturnType<typeof setTimeout>|undefined
 const stops:(()=>void)[]=[]
 let observer:MutationObserver|undefined,opening=false,healthTimer:ReturnType<typeof setTimeout>|undefined
 let listenersReady:Promise<void>|undefined
 function heartbeat(){clearTimeout(healthTimer);healthTimer=setTimeout(()=>{if(session){workspace.searchMessage='独立搜索窗口连接中断';void dock(true).catch(error=>{workspace.searchMessage=String(error)})}},12000)}
 function schedule(){if(!session||disposed||timer)return;timer=setTimeout(()=>{timer=undefined;void publish()},40)}
 async function publish(){
  if(!session||disposed)return
  const state=Object.fromEntries(searchViewFields.map(key=>[key,workspace[key]]))
  const clip=(value:string,limit:number)=>value.length>limit?value.slice(0,limit)+'\n…（片段已截断）':value
  const files=workspace.replaceFiles.map(file=>({...file,selected:[...file.selected],edits:file.edits.map(edit=>({...edit,before:clip(edit.before,1000),insert:clip(edit.insert,1000),context:clip(edit.context,256)}))}))
  const payload={kind:'snapshot',client:viewClient,ack:lastRequest,revision:++revision,state:{...state,canDock:!mini(),canSearchPeers:!!workspace.searchPeers,roots:workspace.roots.map(root=>({rootPath:root.rootPath})),selectedMatches:[...workspace.selectedMatches],replaceFiles:files,openedCount:workspace.textSearchDocuments().length},shortcuts:shortcuts.value,appearance:{light:document.body.classList.contains('light'),style:document.documentElement.style.cssText}}
  try{await invoke('search_window_send',{session,payload:JSON.parse(JSON.stringify(payload))})}catch(error){if(session&&!disposed){workspace.searchMessage='搜索窗口通信失败：'+String(error)}}
 }
 function find(id:unknown){
  if(typeof id!=='string')return
  for(const group of workspace.searchResults){
   const match=group.matches.find(match=>searchMatchId(match)===id)
   if(match)return match
  }
 }
 function patch(values:Record<string,unknown>={}){
  if(workspace.replaceApplying)return
  for(const key of searchInputFields){const value=values[key];if(typeof value===typeof workspace[key]){
   if(key==='searchScope'&&!['workspace','opened','directory','windows'].includes(value as string))continue
   if(key==='searchSort'&&!['path','name','count'].includes(value as string))continue
   Object.assign(workspace,{[key]:value})
  }}
  if(typeof values.split==='number'&&Number.isFinite(values.split))workspace.searchWindow.split=Math.max(.2,Math.min(.8,values.split))
  if(Array.isArray(values.selected)){const valid=new Set(workspace.searchResults.flatMap(g=>g.matches.map(searchMatchId)));workspace.selectedMatches=new Set(values.selected.filter((id):id is string=>typeof id==='string'&&valid.has(id)))}
  if(Array.isArray(values.expanded))for(const group of workspace.searchResults){const value=values.expanded.find(item=>Array.isArray(item)&&item[0]===group.path);if(value)group.isExpanded=!!value[1]}
 }
 async function receive(message:SearchMessage){
  if(message.session!==session||disposed)return
  const p=message.payload
  if(p.kind==='ready'&&typeof p.client==='string'&&p.client.length<=80){viewClient=p.client;lastRequest=0;clearTimeout(healthTimer);await publish();return}
  if(p.kind!=='action'||p.client!==viewClient||!p.request||p.request<=lastRequest)return
  lastRequest=p.request
  const request = p.request
  const respond = (error?:string) => {
   if(message.session!==session||p.client!==viewClient)return
   return invoke('search_window_send',{session,payload:{kind:'reply',client:viewClient,request,error}}).catch(()=>{})
  }
  if(blocked()&&!['closeSearchDialog','cancelSearch','cancelReplace','clearSearchPreview'].includes(p.action||'')){
   if(p.action==='applySearchEdit')await respond('编辑窗口正忙，请稍后重试')
   workspace.searchMessage='主窗口正在处理关闭或更新，请稍后再操作';schedule();return
  }
  const args=p.args||[],match=find(args[0])
  const resultAction=['selectSearchMatch','copySearchMatch','locateMatch','previewReplace','previewSelectedMatches','toggleSearchSelection','selectReplacements','toggleReplacement','applyReplacements','applySearchEdit']
  if(p.action==='applySearchEdit'&&(!match||p.searchId!==workspace.searchId)){
   await respond('搜索结果已过期，请重新搜索')
   return
  }
  if(resultAction.includes(p.action||'')&&p.searchId!==workspace.searchId){schedule();return}
  patch(p.patch)
  try{
   switch(p.action){
    case 'patch':break
    case 'scheduleSearch':workspace.scheduleSearch();break
    case 'search':await workspace.search(workspace.searchQuery);break
    case 'setSearchComposition':workspace.setSearchComposition(!!args[0]);break
    case 'invalidateReplace':if(!workspace.replaceApplying)workspace.invalidateReplace();break
    case 'cancelSearch':workspace.cancelSearch();break
    case 'cancelReplace':workspace.cancelReplace();break
    case 'clearSearchPreview':workspace.clearSearchPreview(args[0]!==false);break
    case 'clearSearchHistory':workspace.clearSearchHistory(!!args[0]);break
    case 'persistSearchMetadata':workspace.persistSearchMetadata();break
    case 'setSearchExpanded':workspace.setSearchExpanded(!!args[0]);break
    case 'chooseSearchDirectory':await workspace.chooseSearchDirectory();break
    case 'openWorkspaceDialog':await workspace.openWorkspaceDialog();break
    case 'selectSearchMatch': {
     if(!match)break
     const withPreview=args[1]!==false
     // The automatic first hit and a click can arrive before the same
     // snapshot. Keep the excerpt (and edit version) for the selected hit.
     const alreadySelected=workspace.selectedMatchId===searchMatchId(match)
     if(withPreview&&alreadySelected&&(workspace.searchPreview||workspace.searchPreviewLoading))break
     await workspace.selectSearchMatch(match,withPreview)
     break
    }
    case 'copySearchMatch':if(match)await workspace.copySearchMatch(match);break
    case 'locateMatch':if(match){await workspace.locateMatch(match,['preview','pinned','split'].includes(String(args[1]))?args[1] as 'pinned':'pinned');if(!match.owner_window)await getCurrentWindow().setFocus()}break
    case 'applySearchEdit': {
     if(!match||typeof args[1]!=='string'||typeof args[2]!=='string')throw Error('编辑请求无效')
     await workspace.applySearchEdit(match,args[1],args[2])
     await respond()
     break
    }
    case 'toggleSearchSelection':if(match)workspace.toggleSearchSelection(match);break
    case 'previewSelectedMatches':await workspace.previewSelectedMatches();break
    case 'previewReplace':{const path=typeof args[0]==='string'?args[0]:undefined;const current=find(args[1]);if(!path||workspace.searchResults.some(g=>g.path===path))await workspace.previewReplace(path,current);break}
    case 'selectReplacements':workspace.selectReplacements(!!args[0],typeof args[1]==='string'?args[1]:undefined);break
    case 'toggleReplacement':{const file=workspace.replaceFiles.find(f=>f.path===args[0]);if(file&&Number.isInteger(args[1])&&Number(args[1])>=0&&Number(args[1])<file.edits.length)workspace.toggleReplacement(file,Number(args[1]));break}
    case 'applyReplacements':await workspace.applyReplacements();break
    case 'revealSearchMatch':if(match)await workspace.revealSearchMatch(match);break
    case 'focusWorkspaceSearch':workspace.focusWorkspaceSearch(!!args[0],typeof args[1]==='string'?args[1]:undefined);break
    case 'closeSearchDialog':workspace.closeSearchDialog();break
   }
  }catch(error){
   if(p.action==='applySearchEdit')await respond(String(error))
   else workspace.searchPreviewError=String(error)
  }finally{schedule()}
 }
 async function dock(docked:boolean){if(session)await invoke('search_window_dock',{session,docked})}
 async function detachSearch(){
  if(!isTauri()||opening)return
  opening=true
  try{if(session&&label){await invoke('search_window_open',{session});return}
   workspace.searchDetached=true
   workspace.searchDocked=false
   workspace.searchRestoreFocus=false
   await listenersReady
   if(disposed||!workspace.searchDialogOpen){workspace.searchDetached=false;return}
   session=crypto.randomUUID();viewClient='';revision=0;lastRequest=0;heartbeat()
   const attempt=session
   const child=await invoke<string>('search_window_open',{session})
   if(session!==attempt)return
   label=child
   if(disposed||!workspace.searchDialogOpen)await dock(false)
   else await publish()
  }catch(error){clearTimeout(healthTimer);session='';label='';workspace.searchDetached=false;workspace.searchDocked=true;workspace.searchMessage='无法弹出搜索窗口：'+String(error)}finally{opening=false}
 }
 async function listenToWindow(){
  const messageStop=await listen<SearchMessage>('search-window-message',event=>void receive(event.payload));if(disposed){messageStop();return}stops.push(messageStop)
  const closeStop=await listen<{session:string;error?:string;docked:boolean}>('search-window-closed',event=>{
   if(event.payload.session!==session)return
   session='';label='';clearTimeout(healthTimer);workspace.searchDetached=false;workspace.setSearchComposition(false)
   if(event.payload.docked&&!mini()&&workspace.searchDialogOpen){
    workspace.searchDocked=true
    workspace.searchRestoreFocus=true
    void getCurrentWindow().setFocus().catch(()=>{})
   }else if(workspace.searchDialogOpen)workspace.closeSearchDialog()
   if(event.payload.error)workspace.searchMessage='窗口位置保存失败：'+event.payload.error
  });if(disposed){closeStop();return}stops.push(closeStop)
  stops.push(workspace.subscribe(schedule))
  stops.push(watch(()=>searchViewFields.map(key=>workspace[key]),schedule))
  stops.push(watch(()=>[mini(),workspace.searchPeers],schedule))
  stops.push(watch(shortcuts,schedule))
  observer=new MutationObserver(schedule);observer.observe(document.body,{attributes:true,attributeFilter:['class']});observer.observe(document.documentElement,{attributes:true,attributeFilter:['style']})
 }
 onMounted(()=>{
  if(!isTauri())return
  listenersReady=listenToWindow()
  void listenersReady.catch(console.error)
  stops.push(watch(()=>workspace.searchFocusRevision,()=>{if(workspace.searchDialogOpen)void detachSearch()}))
  stops.push(watch(()=>workspace.searchDialogOpen,open=>{if(!open&&label)void dock(false).catch(()=>{})}))
 })
 onUnmounted(()=>{disposed=true;clearTimeout(timer);clearTimeout(healthTimer);observer?.disconnect();stops.forEach(stop=>stop());if(label)void dock(false).catch(()=>{})})
 return {detachSearch}
}
