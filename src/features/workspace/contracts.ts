import type { OpenFile } from '../files/contracts'

export interface WorkspaceNode {
  id: string
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink: boolean
  isReadOnly: boolean
  size: number
  mtime: number | null
  hasChildren: boolean
  children?: WorkspaceNode[]
  isExpanded?: boolean
  isLoading?: boolean
}

export interface WorkspaceInfo {
  rootPath: string
  name: string
  entries: WorkspaceNode[]
  warning?: string | null
}

export interface SearchMatch {
  id?: string
  document_id?: string | null
  version?: string
  snippet_column?: number
  search_id: string
  path: string
  relative_path: string
  line_number: number
  column_number: number
  line_text: string
  match_length: number
}

export interface SearchQuery {
  scope?: 'workspace' | 'directory' | 'opened'
  include_globs?: string[]
  exclude_globs?: string[]
  search_id: string
  query: string
  is_case_sensitive: boolean
  is_whole_word: boolean
  is_regex: boolean
  max_results?: number
  include_ignored?: boolean
  directory?: string | null
  buffers?: { path: string; text: string; encoding?: string; document_id?:string;relative_path?:string;read_only?:boolean }[]
}

export interface ReplaceEdit {
  from: number
  to: number
  line: number
  column: number
  before: string
  insert: string
  context: string
}
export interface ReplaceFile { path: string; version: string; buffer: boolean; edits: ReplaceEdit[]; document_id?:string|null }
export interface ReplacePreview { files: ReplaceFile[]; skipped: string[]; limited: boolean; canceled: boolean }
export interface ReplaceApply { query: SearchQuery; replacement: string; path: string; version: string; selected: number[] }

export interface SearchDonePayload {
  search_id: string
  total: usize
  canceled: boolean
  limited?: boolean
  skipped?: number
  reason?: string | null
  error?: string | null
}

export interface SearchPreviewRequest {path:string;version:string;line:number;column:number;length:number;query:SearchQuery}
export interface SearchSourcePreview {path:string;version:string;text:string;start_line:number;selection_from:number;selection_to:number;hits:{from:number;to:number}[];truncated:boolean}

type usize = number

export interface WorkspaceGateway {
  previewSearch?(request:SearchPreviewRequest):Promise<SearchSourcePreview>
  clearSearchPreview?():Promise<void>
  chooseSearchDirectory?():Promise<string|null>
  previewReplace?(query: SearchQuery, replacement: string, targets: string[]): Promise<ReplacePreview>
  applyReplace?(request: ReplaceApply): Promise<number>
  validateReplace?(path: string, version: string, query: SearchQuery): Promise<void>
  isVisibleFile?(path: string): Promise<boolean>
  openWorkspaceDialog(add?: boolean): Promise<WorkspaceInfo | null>
  removeWorkspaceFolder(path: string): Promise<void>
  restoreWorkspaces(): Promise<WorkspaceInfo[]>
  openWorkspacePath(path: string, add?: boolean): Promise<WorkspaceInfo>
  openDroppedWorkspace(token: string): Promise<WorkspaceInfo>
  openWorkspaceFile(path: string, encoding?: string): Promise<OpenFile>
  readDirectory(path: string): Promise<WorkspaceNode[]>
  createFile(parentDir: string, name: string): Promise<WorkspaceNode>
  createDirectory(parentDir: string, name: string): Promise<WorkspaceNode>
  renameNode(oldPath: string, newName: string): Promise<[string, string]>
  deleteNode(path: string): Promise<string>
  moveNode(srcPath: string, destDir: string): Promise<[string, string]>
  findFiles(query: string, includeIgnored: boolean, limit?: number): Promise<{ name: string; path: string; relativePath: string }[]>
  setShowIgnored(show: boolean): Promise<WorkspaceNode[]>
  getRecentWorkspaces(): Promise<string[]>
  revealNode?(path:string):Promise<void>
  revealOpenFile?(token:string):Promise<void>
  searchWorkspace(query: SearchQuery): Promise<number>
  cancelSearch(searchId: string): Promise<void>
  onSearchBatch(listener: (batch: SearchMatch[]) => void): () => void
  onSearchDone(listener: (payload: SearchDonePayload) => void): () => void
}
