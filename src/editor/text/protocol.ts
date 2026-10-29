import type { Text } from '@codemirror/state'

/** Storage ownership is explicit. Full-text callers keep synchronous CM input;
 * only the experimental segmented port crosses a process boundary. */
export interface FullTextDocument {
  readonly mode: 'full-text'
  readonly positionUnit: 'utf16'
  readonly snapshot: Text
}
export interface TextWindow {
  revision: number
  startByte: number
  endByte: number
  text: string
}
export interface ByteEdit { from: number; to: number; insert: string }
export interface SegmentedStatus { revision: number; byteLength: number; canUndo: boolean; canRedo: boolean }
export interface SegmentedTextDocument {
  readonly mode: 'segmented'
  readonly positionUnit: 'utf8'
  window(revision: number, startByte: number, budget: number): Promise<TextWindow>
  edit(revision: number, changes: readonly ByteEdit[]): Promise<SegmentedStatus>
  undo(revision: number): Promise<SegmentedStatus>
  redo(revision: number): Promise<SegmentedStatus>
  position(revision: number, byte: number): Promise<{ byte: number; line: number; column: number }>
  lineStart(revision: number, line: number): Promise<{ byte: number }>
  search(revision: number, query: string, start: number, limit: number): Promise<{ count: number; matches: [number, number][] }>
  replace(revision: number, query: string, replacement: string): Promise<SegmentedStatus>
  checkpoint(revision: number): Promise<void>
  saveCopy(revision: number, path: string): Promise<void>
  close(discard: boolean): Promise<void>
}
export type TextDocument = FullTextDocument | SegmentedTextDocument
export const segmentedBudgets = Object.freeze({ windowBytes: 64 * 1024, maxWindowBytes: 256 * 1024, pendingEditBytes: 1024 * 1024, resultLimit: 1024 })
