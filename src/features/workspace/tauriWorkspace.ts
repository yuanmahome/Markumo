import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { OpenFile } from '../files/contracts'
import type {
  SearchDonePayload,
  SearchMatch,
  SearchQuery,
  ReplacePreview,
  SearchSourcePreview,
  WorkspaceGateway,
  WorkspaceInfo,
  WorkspaceNode,
} from './contracts'

interface RawWorkspaceNode {
  id: string
  name: string
  path: string
  relative_path: string
  is_directory: boolean
  is_symlink: boolean
  is_readonly: boolean
  size: number
  mtime: number | null
  has_children: boolean
}

interface RawWorkspaceInfo {
  root_path: string
  name: string
  entries: RawWorkspaceNode[]
  warning?: string | null
}

function mapNode(raw: RawWorkspaceNode): WorkspaceNode {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    relativePath: raw.relative_path,
    isDirectory: raw.is_directory,
    isSymlink: raw.is_symlink,
    isReadOnly: raw.is_readonly,
    size: raw.size,
    mtime: raw.mtime,
    hasChildren: raw.has_children,
    children: raw.is_directory ? [] : undefined,
    isExpanded: false,
    isLoading: false,
  }
}

export function mapInfo(raw: RawWorkspaceInfo): WorkspaceInfo {
  return {
    rootPath: raw.root_path,
    name: raw.name,
    entries: raw.entries.map(mapNode),
    warning: raw.warning,
  }
}

const pendingSubscriptions=new Set<Promise<unknown>>()
let searchSubscriptionError=''
function subscribe<T>(name: string, listener: (payload: T) => void): () => void {
  if (!isTauri()) return () => {}
  let disposed = false, unlistenFn: (() => void) | undefined
  const ready=getCurrentWindow().listen<T>(name, event => { if (!disposed) listener(event.payload) }).then(unlisten => {
    if (disposed) unlisten(); else unlistenFn = unlisten
  }).catch(error => {searchSubscriptionError=`工作区事件注册失败: ${String(error)}`;console.error(searchSubscriptionError)})
  pendingSubscriptions.add(ready);void ready.finally(()=>pendingSubscriptions.delete(ready))
  return () => { disposed = true; unlistenFn?.() }
}

export const tauriWorkspace: WorkspaceGateway = {
  previewSearch(request) {return invoke<SearchSourcePreview>('preview_workspace_search',{request})},
  clearSearchPreview() {return invoke<void>('clear_workspace_search_preview')},
  chooseSearchDirectory() {return invoke<string|null>('choose_workspace_search_directory')},
  previewReplace(query, replacement, targets) { return invoke<ReplacePreview>('preview_workspace_replace', { query, replacement, targets }) },
  applyReplace(request) { return invoke<number>('apply_workspace_replace', { request }) },
  validateReplace(path, version, query) { return invoke<void>('validate_workspace_replace', { path, version, query: { ...query, buffers: [] } }) },
  async isVisibleFile(path) { return invoke<boolean>('workspace_file_visible', { path }) },
  async openWorkspaceDialog(add = false): Promise<WorkspaceInfo | null> {
    const raw = await invoke<RawWorkspaceInfo | null>('open_workspace_dialog', { add })
    return raw ? mapInfo(raw) : null
  },
  async removeWorkspaceFolder(path) { await invoke('remove_workspace_folder', { path }) },
  async revealNode(path) { await invoke('reveal_workspace_node',{path}) },
  async revealOpenFile(token) { await invoke('reveal_in_explorer',{token}) },
  async restoreWorkspaces() { return (await invoke<RawWorkspaceInfo[]>('restore_workspace_folders')).map(mapInfo) },

  async openWorkspacePath(path: string, add = false): Promise<WorkspaceInfo> {
    const raw = await invoke<RawWorkspaceInfo>('open_workspace_path', { path, add })
    return mapInfo(raw)
  },

  async openWorkspaceFile(path: string, encoding?: string): Promise<OpenFile> {
    return invoke<OpenFile>('open_workspace_file', { path, encoding: encoding ?? null })
  },

  async openDroppedWorkspace(token: string): Promise<WorkspaceInfo> {
    return mapInfo(await invoke<RawWorkspaceInfo>('open_dropped_workspace', { token }))
  },

  async readDirectory(path: string): Promise<WorkspaceNode[]> {
    const raw = await invoke<RawWorkspaceNode[]>('read_directory', { path })
    return raw.map(mapNode)
  },

  async createFile(parentDir: string, name: string): Promise<WorkspaceNode> {
    const raw = await invoke<RawWorkspaceNode>('create_workspace_file', { parentDir, name })
    return mapNode(raw)
  },

  async createDirectory(parentDir: string, name: string): Promise<WorkspaceNode> {
    const raw = await invoke<RawWorkspaceNode>('create_workspace_directory', { parentDir, name })
    return mapNode(raw)
  },

  async renameNode(oldPath: string, newName: string): Promise<[string, string]> {
    return invoke<[string, string]>('rename_workspace_node', { oldPath, newName })
  },

  async deleteNode(path: string): Promise<string> {
    return invoke<string>('delete_workspace_node', { path })
  },

  async moveNode(srcPath: string, destDir: string): Promise<[string, string]> {
    return invoke<[string, string]>('move_workspace_node', { srcPath, destDir })
  },

  async getRecentWorkspaces(): Promise<string[]> {
    if (!isTauri()) return []
    return invoke<string[]>('get_recent_workspaces')
  },
  async findFiles(query, includeIgnored, limit) {
    const files = await invoke<{ name: string; path: string; relative_path: string }[]>('find_workspace_files', { query, includeIgnored, limit: limit ?? null })
    return files.map(file => ({ ...file, relativePath: file.relative_path }))
  },
  async setShowIgnored(show) {
    return (await invoke<RawWorkspaceNode[]>('set_workspace_ignored', { show })).map(mapNode)
  },

  async searchWorkspace(query: SearchQuery): Promise<number> {
    await Promise.all([...pendingSubscriptions])
    if(searchSubscriptionError)throw Error(searchSubscriptionError)
    return invoke<number>('search_workspace', { query })
  },

  async cancelSearch(searchId: string): Promise<void> {
    return invoke<void>('cancel_workspace_search', { searchId })
  },

  onSearchBatch(listener: (batch: SearchMatch[]) => void): () => void {
    return subscribe('workspace-search-batch', listener)
  },

  onSearchDone(listener: (payload: SearchDonePayload) => void): () => void {
    return subscribe('workspace-search-done', listener)
  },
}
