import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { EditorDocument } from '../../types'

/** A document body travelling between windows. Mirrors the Rust payload. */
export interface DetachPayload {
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
  return { x: Math.round(window.innerWidth / 2), y: 80 }
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
  const text = manager.getText(documentId)
  if (text === undefined) return null
  const snapshot = manager.paneSnapshot(documentId, paneId)
  return {
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
  })
}

/** Rollback: the source keeps its document and the reservation is dropped. */
export async function cancelDetach(handoffId: string): Promise<void> {
  await invoke('cancel_detach', { handoffId }).catch(() => {})
}

/**
 * A freshly created detached window asks for the body parked for it.
 * Returns null for ordinary windows, which boot through `initialize_launch`.
 */
export async function takeDetachedDocument(): Promise<
  { handoffId: string; sourceLabel: string; payload: DetachPayload } | null
> {
  if (!isTauri()) return null
  return (await invoke<unknown>('take_detached_document')) as
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
  const unlisten = await listen<{ handoffId: string; documentId: string }>(
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
  const isPinned = manager.paneGroup(paneId)?.tabs.find(t => t.documentId === documentId)?.pinned ?? true
  const payload = buildDetachPayload(manager, documentId, paneId, isPinned)
  if (!payload) {
    notify('无法移动该标签：文档尚未准备好。')
    return false
  }
  try {
    await beginDetach(payload, drop)
    return true
  } catch (error) {
    notify(`无法移动到新窗口：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
