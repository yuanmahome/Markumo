<template>
  <div v-if="ready && error" class="search-window-error" role="alert">{{error}}</div>
  <GlobalSearchDialog v-if="ready" ref="searchDialog" :workspace="view" :shortcuts="shortcuts" :can-dock="data.canDock" :can-search-peers="data.canSearchPeers" standalone @dock="dock(true)" />
  <div v-else class="search-connection" role="status">{{error||'正在连接搜索会话…'}}<button v-if="error" @click="dock(false)">关闭窗口</button></div>
</template>
<script setup lang="ts">
import {onMounted,onUnmounted,reactive,ref,shallowRef,nextTick,watch,markRaw} from 'vue'
import {invoke} from '@tauri-apps/api/core'
import {listen} from '@tauri-apps/api/event'
import {getCurrentWindow} from '@tauri-apps/api/window'
import type {WorkspaceController} from '../../features/workspace/WorkspaceController'
import type {SearchMatch} from '../../features/workspace/contracts'
import {searchInputFields} from '../../features/workspace/searchWindow'
import {searchMatchId} from '../../features/workspace/searchModel'
import GlobalSearchDialog from './GlobalSearchDialog.vue'
const ready=ref(false),error=ref(''),shortcuts=shallowRef<Record<string,string>>({})
const searchDialog=ref<InstanceType<typeof GlobalSearchDialog>>()
const data=reactive<Record<string,any>>({searchResults:[],searchWindow:{split:.52},selectedMatches:new Set(),replaceFiles:[]})
const view=data as unknown as WorkspaceController
const client=crypto.randomUUID()
let session='',request=0,revision=0,applying=false,disposed=false,stop:(()=>void)|undefined,stopClose:(()=>void)|undefined,queue=Promise.resolve()
const sent = new Map<string,string>()
const pending = new Map<string,{request:number; value:unknown}>()
const replies = new Map<number,(error?:string)=>void>()
let nativeLight:boolean|undefined
const id=(match:SearchMatch)=>searchMatchId(match)
function editableState(){
 return {...Object.fromEntries(searchInputFields.map(key=>[key,data[key]])),split:data.searchWindow.split,
  selected:[...data.selectedMatches],expanded:data.searchResults.map((g:any)=>[g.path,g.isExpanded])} as Record<string,unknown>
}
function send(action:string,args:unknown[]=[],awaitReply=false){
 const patch:Record<string,unknown>={}
 const id=++request
 for(const [key,value] of Object.entries(editableState())){
  const serialized=JSON.stringify(value)
  if(sent.get(key)===serialized)continue
  sent.set(key,serialized)
  pending.set(key,{request:id,value})
  patch[key]=value
 }
 if(action==='patch'&&!Object.keys(patch).length)return Promise.resolve()
 const payload={kind:'action',client,request:id,searchId:data.searchId,action,args,patch}
 const response=awaitReply?new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>replies.get(id)?.('编辑响应超时'),16000)
  replies.set(id,error=>{clearTimeout(timer);replies.delete(id);if(error)reject(Error(error));else resolve()})
 }):undefined
 queue=queue.then(()=>invoke('search_window_send',{session,payload})).then(()=>{},e=>{
  if(awaitReply)replies.get(id)?.(String(e))
  else if(!disposed)error.value=String(e)
 })
 return response||queue
}
// A lightweight presentation facade. It owns no controllers, documents or file IPC.
const direct=['scheduleSearch','search','setSearchComposition','invalidateReplace','cancelSearch','cancelReplace','clearSearchPreview','clearSearchHistory','persistSearchMetadata','setSearchExpanded','chooseSearchDirectory','openWorkspaceDialog','previewSelectedMatches','selectReplacements','applyReplacements','closeSearchDialog','focusWorkspaceSearch']
for(const action of direct)data[action]=(...args:unknown[])=>send(action,args)
for(const action of ['selectSearchMatch','copySearchMatch','locateMatch','toggleSearchSelection','revealSearchMatch'])data[action]=(match:SearchMatch,...args:unknown[])=>send(action,[id(match),...args])
data.previewReplace=(path?:string,match?:SearchMatch)=>send('previewReplace',[path??null,match?id(match):null])
data.toggleReplacement=(file:{path:string},index:number)=>send('toggleReplacement',[file.path,index])
data.applySearchEdit=(match:SearchMatch,editId:string,insert:string)=>send('applySearchEdit',[id(match),editId,insert],true)
data.textSearchDocuments=()=>Array(data.openedCount||0)
data.rootForPath=(path:string)=>data.roots?.find((root:any)=>path.split('\\').join('/').startsWith(root.rootPath.split('\\').join('/')))?.rootPath
data.canRevealSearchMatch=(match:SearchMatch)=>!!match.path
watch(()=>[...searchInputFields.map(key=>data[key]),data.searchWindow.split,[...data.selectedMatches].join('|'),data.searchResults.map((g:any)=>g.isExpanded).join('|')],()=>{if(ready.value&&!applying)void send('patch')})
async function dock(docked:boolean){try{if(session)await invoke('search_window_dock',{session,docked});else await getCurrentWindow().destroy()}catch(e){error.value=String(e)}}
onMounted(async()=>{
 try{
  stopClose=await getCurrentWindow().listen('search-window-close-request',()=>{
   if(searchDialog.value)searchDialog.value.close()
   else void dock(false)
  })
  if(disposed){stopClose();return}
  const identity=await invoke<[string,string]>('search_window_identity');session=identity[1]
  stop=await listen<any>('search-window-message',async event=>{
   if(disposed||event.payload.session!==session)return
   const p=event.payload.payload
   if(p.kind==='focus'){(document.querySelector('[aria-label="全局搜索文本"]') as HTMLInputElement)?.focus();return}
   if(p.kind==='reply'&&p.client===client){replies.get(p.request)?.(p.error);return}
   if(p.kind!=='snapshot'||p.client!==client||p.revision<=revision)return
   revision=p.revision;applying=true
   Object.assign(data,p.state,{selectedMatches:new Set(p.state.selectedMatches),replaceFiles:p.state.replaceFiles.map((file:any)=>({...file,selected:new Set(file.selected)})),searchResults:p.state.searchResults.map((group:any)=>({...group,matches:markRaw(group.matches)})),searchPreview:p.state.searchPreview?markRaw(p.state.searchPreview):null})
   for(const [key,entry] of pending){
    if(entry.request<=p.ack){pending.delete(key);continue}
    if(key==='split')data.searchWindow.split=entry.value
    else if(key==='selected')data.selectedMatches=new Set(entry.value as string[])
    else if(key==='expanded'){
     const groups=new Map(entry.value as [string,boolean][])
     for(const group of data.searchResults)if(groups.has(group.path))group.isExpanded=groups.get(group.path)
    }else data[key]=entry.value
   }
   for(const [key,value] of Object.entries(editableState()))sent.set(key,JSON.stringify(value))
   shortcuts.value=p.shortcuts;document.body.classList.toggle('light',p.appearance.light);document.documentElement.style.cssText=p.appearance.style
   if(nativeLight!==p.appearance.light){nativeLight=p.appearance.light;void getCurrentWindow().setTheme(nativeLight?'light':'dark').catch(e=>{error.value='窗口主题设置失败：'+String(e)})}
   ready.value=true;await nextTick();applying=false
  })
  if(disposed){stop();return}
  await invoke('search_window_send',{session,payload:{kind:'ready',client}})
 }catch(e){error.value=String(e)}
})
onUnmounted(()=>{disposed=true;stop?.();stopClose?.();for(const finish of replies.values())finish('搜索窗口已关闭')})
</script>
<style scoped>.search-window-error{position:fixed;top:0;left:0;right:0;z-index:10;background:var(--bar);color:var(--pink);padding:4px;font-size:var(--ui-small-font-size)}.search-connection{padding:24px;color:var(--sub)}.search-connection button{display:block;padding:8px}</style>
