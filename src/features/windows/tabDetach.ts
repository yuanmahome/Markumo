import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { EditorDocument } from '../../types'
import type {ClassInfo,MediaMetadata} from '../files/contracts'
import type {MediaViewState} from '../files/media'

/** A document body travelling between windows. Mirrors the Rust payload. */
export interface DetachPayload {
  kind?:EditorDocument['kind']
  media?:MediaMetadata
  classInfo?:ClassInfo
  mediaView?:MediaViewState
  documentId: string
  name: string
  path?: string | null
  fileToken?: string | null
  text: string
  version?: string | null
  encoding: string
  bom: boolean
  eol: string
  readOnly: boolean
  dirty: boolean
  markdownMode?: string | null
  anchor: number
  head: number
  scrollTop: number
  scrollLeft: number
  pinned: boolean
  external?: string | null
}

export interface DetachStarted {
  handoffId: string
  label: string
}

/** Where the pointer was released, in this window's CSS pixels. */
export interface DetachDropPoint {
  x: number
  y: number
  forceNew?:boolean
}

export const DETACH_COMMITTED_EVENT = 'markumo:detach-committed'

/** Desktop only: a browser tab cannot become a native window. */
export function canDetach(desktop: boolean): boolean {
  return desktop && isTauri()
}

let detachRequest: ((documentId: string, paneId: string, drop: DetachDropPoint) => void) | null = null

/** Registered once by the shell; the tab bar only raises the intent. */
export function setDetachRequestHandler(
  handler: ((documentId: string, paneId: string, drop: DetachDropPoint) => void) | null,
) {
  detachRequest = handler
}

export function requestDetachToWindow(documentId: string, paneId: string, drop: DetachDropPoint) {
  detachRequest?.(documentId, paneId, drop)
}

/** Places a menu-triggered detach near the top-right of the current window. */
export function defaultDetachDropPoint(): DetachDropPoint {
  return { x: Math.round(window.innerWidth / 2), y: 80,forceNew:true }
}

/** Builds the transferable body for one document and pane. */
export function buildDetachPayload(
  manager: DocumentManager,
  documentId: string,
  paneId: string,
  pinned: boolean,
): DetachPayload | null {
  const doc: EditorDocument | null = manager.metadata(documentId)
  if (!doc) return null
  const text = manager.saveSnapshot(documentId)?.text??(doc.kind==='image'||doc.kind==='pdf'?'':manager.getText(documentId))
  if (text === undefined) return null
  const snapshot = manager.paneSnapshot(documentId, paneId)
  return {
    kind:doc.kind,media:doc.media,classInfo:doc.classInfo,mediaView:doc.kind==='image'||doc.kind==='pdf'?{...manager.mediaViewState(documentId,paneId)}:undefined,
    documentId,
    name: doc.name,
    path: doc.path || null,
    fileToken: doc.fileToken || null,
    text,
    version: doc.lastDiskVersion ?? (doc as { version?: string | null }).version ?? null,
    encoding: doc.encoding || 'UTF-8',
    bom: !!doc.bom,
    eol: doc.eol || 'LF',
    readOnly: !!doc.readOnly,
    dirty: !!manager.metadata(documentId)?.dirty,
    markdownMode: snapshot.mode ?? null,
    anchor: snapshot.anchor,
    head: snapshot.head,
    scrollTop: snapshot.top,
    scrollLeft: snapshot.left,
    pinned,
    external: null,
  }
}

/**
 * Prepare phase. Creates the target window and parks the body in Rust.
 *
 * The source tab is deliberately kept: nothing is removed until the target
 * window reports that it adopted the document.
 */
export async function beginDetach(
  payload: DetachPayload,
  drop: DetachDropPoint,
): Promise<DetachStarted> {
  return invoke<DetachStarted>('detach_tab_to_window', {
    payload,
    dropX: drop.x,
    dropY: drop.y,
    forceNew:!!drop.forceNew,
  })
}

/** Rollback: the source keeps its document and the reservation is dropped. */
export async function cancelDetach(handoffId: string): Promise<boolean> {
  return invoke<boolean>('cancel_detach', { handoffId })
}

/**
 * A freshly created detached window asks for the body parked for it.
 * Returns null for ordinary windows, which boot through `initialize_launch`.
 */
export async function takeDetachedDocument(handoffId?:string): Promise<
  { handoffId: string; sourceLabel: string; payload: DetachPayload } | null
> {
  if (!isTauri()) return null
  return (await invoke<unknown>('take_detached_document',{handoffId:handoffId??null})) as
    | { handoffId: string; sourceLabel: string; payload: DetachPayload }
    | null
}

/** Commit phase, called by the target once the document is really open. */
export async function commitDetach(handoffId: string): Promise<void> {
  await invoke('commit_detach', { handoffId })
}

/**
 * Source-window listener: fires only after a target adopted the body, so the
 * source can drop its tab without ever risking unsaved content.
 */
export async function listenDetachCommitted(
  onCommitted: (payload: { handoffId: string; documentId: string }) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await getCurrentWindow().listen<{ handoffId: string; documentId: string }>(
    DETACH_COMMITTED_EVENT,
    event => onCommitted(event.payload),
  )
  return unlisten
}

/**
 * A tab drag is only a detach request when the pointer really left the window
 * and the platform delivered a pointer release. A lost pointer, a cancelled
 * drag or a stray window blur must never create a window.
 */
export function isOutsideWindow(x: number, y: number, width: number, height: number): boolean {
  const margin = 2
  return x < -margin || y < -margin || x > width + margin || y > height + margin
}

/** Detaches one tab and reports progress to the user. */
export async function detachDocumentToWindow(
  manager: DocumentManager,
  documentId: string,
  paneId: string,
  drop: DetachDropPoint,
  notify: (message: string) => void,
): Promise<boolean> {
  if(outgoing.has(documentId)||manager.isComposing){notify('文档正在移交或输入，请稍后再试。');return false}
  const isPinned = manager.paneGroup(paneId)?.tabs.find(t => t.documentId === documentId)?.pinned ?? true
  const payload = buildDetachPayload(manager, documentId, paneId, isPinned)
  if (!payload) {
    notify('无法移动该标签：文档尚未准备好。')
    return false
  }
  const release=manager.holdForHandoff(documentId)
  if(!release)return false
  const pending:Outgoing={release,manager,notify};outgoing.set(documentId,pending);busyChanged?.(true)
  try {
    const started=await beginDetach(payload, drop)
    if(outgoing.get(documentId)!==pending)return true
    pending.id=started.handoffId
    pending.timer=setTimeout(()=>void settleTimedOut(documentId,pending),15000)
    return true
  } catch (error) {
    finishOutgoing(documentId,false)
    notify(`无法移动到新窗口：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

interface Outgoing {id?:string;release:()=>void;manager:DocumentManager;notify:(message:string)=>void;timer?:ReturnType<typeof setTimeout>}
const outgoing=new Map<string,Outgoing>()
let busyChanged:((busy:boolean)=>void)|undefined
export function setHandoffBusyHandler(handler?: (busy:boolean)=>void){busyChanged=handler}
function finishOutgoing(documentId:string,committed:boolean){
  const pending=outgoing.get(documentId);if(!pending)return false
  outgoing.delete(documentId);clearTimeout(pending.timer);pending.release()
  if(committed)for(const pane of pending.manager.layout.getAllLeafIds())pending.manager.close(documentId,true,pane)
  busyChanged?.(outgoing.size>0);return true
}
export function receiveDetachCommitted(event:{handoffId:string;documentId:string}){
  const pending=outgoing.get(event.documentId)
  return !!pending&&(!pending.id||pending.id===event.handoffId)&&finishOutgoing(event.documentId,true)
}
export function receiveDetachCanceled(event:{handoffId:string;documentId:string}){
  const pending=outgoing.get(event.documentId)
  if(pending&&(!pending.id||pending.id===event.handoffId))finishOutgoing(event.documentId,false)
}
async function settleTimedOut(documentId:string,pending:Outgoing){
  if(outgoing.get(documentId)!==pending||!pending.id)return
  try{
    const status=await invoke<string>('detach_status',{handoffId:pending.id})
    if(status==='committed'){finishOutgoing(documentId,true);return}
    const committed=await cancelDetach(pending.id);finishOutgoing(documentId,committed);if(!committed)pending.notify('移交未完成，原文档已保留。')
  }catch(error){pending.notify('移交状态确认失败，文档保持锁定：'+String(error));pending.timer=setTimeout(()=>void settleTimedOut(documentId,pending),15000)}
}
export function disposeHandoffs(){for(const [id,pending]of outgoing){clearTimeout(pending.timer);pending.release();if(pending.id)void cancelDetach(pending.id).catch(()=>{});outgoing.delete(id)}busyChanged=undefined}
