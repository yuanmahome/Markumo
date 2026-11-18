import {invoke, isTauri} from '@tauri-apps/api/core'
import {getCurrentWindow} from '@tauri-apps/api/window'
import {onMounted, onUnmounted} from 'vue'
import type {Text} from '@codemirror/state'
import type {SearchMatch, SearchQuery} from './contracts'
import type {WorkspaceController} from './WorkspaceController'

type PeerAction =
  | {kind:'search'; query: SearchQuery}
  | {kind:'preview'; match: SearchMatch}
  | {kind:'edit'; match: SearchMatch; insert: string}
  | {kind:'open'; match: SearchMatch; mode:'preview'|'pinned'|'split'}
type PeerMessage =
  | (PeerAction & {id:string})
  | {kind:'cancel'; id:string}
  | {kind:'reply'; id:string; result?:unknown; error?:string}
  | {kind:'changed'}

export interface SearchPeers {
  windows(): Promise<string[]>
  request<T = void>(target: string, action: PeerAction, signal?: AbortSignal): Promise<T>
}

// Editor windows run their own searches over their live buffers. Only hit
// summaries, the selected excerpt and explicit edits cross between webviews.
export function useSearchPeers(workspace: WorkspaceController, blocked:()=>boolean) {
  if (!isTauri()) return
  const current = getCurrentWindow()
  const pending = new Map<string, {target:string; finish:(error?:string, result?:unknown)=>void}>()
  const running = new Map<string,string>()
  const send = (target: string|null, payload: PeerMessage) => invoke<void>('search_peer_send', {target, payload})
  let disposed = false
  let unlisten: (()=>void)|undefined
  let stopDocuments: (()=>void)|undefined
  let notifyTimer: ReturnType<typeof setTimeout>|undefined
  let documents = new Map<string,Text>()

  function request<T>(target: string, action: PeerAction, signal?: AbortSignal): Promise<T> {
    if (disposed || signal?.aborted) return Promise.reject(new Error('跨窗口搜索已取消'))
    const id = crypto.randomUUID()
    return new Promise((resolve,reject) => {
      const cancel = () => {
        if (action.kind==='search') void send(target,{kind:'cancel',id}).catch(()=>{})
        finish('跨窗口搜索已取消或超时')
      }
      const finish = (error?:string, result?:unknown) => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort',cancel)
        pending.delete(id)
        if (error) reject(new Error(error))
        else resolve(result as T)
      }
      const timeout = setTimeout(cancel,12000)
      pending.set(id,{target,finish})
      signal?.addEventListener('abort',cancel,{once:true})
      void send(target,{...action,id}).catch(error=>finish(String(error)))
    })
  }

  async function receive(source: string, payload: PeerMessage) {
    if (disposed) return
    if (payload.kind==='changed') {
      if (workspace.searchScope==='windows' && workspace.searchDialogOpen && workspace.searchQuery) workspace.scheduleSearch()
      return
    }
    if (payload.kind==='reply') {
      const entry = pending.get(payload.id)
      if (entry?.target===source) entry.finish(payload.error,payload.result)
      return
    }
    const key = source+':'+payload.id
    if (payload.kind==='cancel') {
      const searchId = running.get(key)
      if (searchId) await workspace.gateway.cancelSearch(searchId)
      return
    }
    try {
      let result: unknown
      if (payload.kind==='search') {
        const scratchId='peer-'+crypto.randomUUID()
        const buffers = workspace.searchPeerBuffers()
        const revisions = new Map(buffers.map(({buffer,revision})=>[buffer.document_id,revision]))
        running.set(key,scratchId)
        try {
          const [matches,summary] = await invoke<[SearchMatch[],{limited:boolean;skipped:number}]>(
            'search_peer_buffers', {query:{...payload.query,search_id:scratchId,buffers:buffers.map(entry=>entry.buffer)}},
          )
          result = {...summary,matches:matches.map(match=>({...match,buffer_revision:revisions.get(match.document_id||'')}))}
        } finally {
          running.delete(key)
        }
      } else if (payload.kind==='preview') {
        result = workspace.previewPeerMatch(payload.match)
      } else {
        if (blocked()) throw Error('对应窗口正在处理关闭或更新')
        if (payload.kind==='edit') workspace.editPeerMatch(payload.match,payload.insert)
        else {
          workspace.openPeerMatch(payload.match,payload.mode)
          await current.setFocus()
        }
      }
      await send(source,{kind:'reply',id:payload.id,result})
    } catch (error) {
      await send(source,{kind:'reply',id:payload.id,error:String(error)}).catch(()=>{})
    }
  }

  function onDocumentsChanged() {
    const next = new Map(workspace.textSearchDocuments().map(doc=>[doc.id,workspace.documentManager.getState(doc.id)!.doc]))
    if (next.size===documents.size && [...next].every(([id,text])=>documents.get(id)===text)) return
    documents = next
    clearTimeout(notifyTimer)
    notifyTimer = setTimeout(()=>void send(null,{kind:'changed'}).catch(()=>{}),120)
  }

  onMounted(async()=>{
    try {
      const stop = await current.listen<{source:string;payload:PeerMessage}>('search-peer-message',
        ({payload})=>void receive(payload.source,payload.payload).catch(console.error))
      if (disposed) { stop(); return }
      unlisten = stop
      workspace.searchPeers = {windows:()=>invoke('search_peer_windows'),request}
      stopDocuments = workspace.documentManager.subscribe(onDocumentsChanged)
      onDocumentsChanged()
    } catch (error) {
      console.error('跨窗口搜索初始化失败',error)
    }
  })
  onUnmounted(()=>{
    disposed = true
    workspace.searchPeers = undefined
    unlisten?.()
    stopDocuments?.()
    clearTimeout(notifyTimer)
    for (const entry of pending.values()) entry.finish('编辑窗口已关闭')
    for (const searchId of running.values()) void workspace.gateway.cancelSearch(searchId).catch(()=>{})
    running.clear()
  })
}
