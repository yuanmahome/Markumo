import { markRaw } from 'vue'
import { bufferPreview, defaultSearchWindow, globPatterns, searchMatchId, type GlobalSearchStatus } from './searchModel'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { FileController } from '../files/FileController'
import { displayPathKey, readablePath } from '../shell/pathDisplay'
import type { EditorPaneModel, SplitDirection } from '../../editor/layout/types'
import type {
  SearchDonePayload,
  SearchMatch,
  SearchQuery,
  ReplaceFile,
  SearchSourcePreview,
  WorkspaceGateway,
  WorkspaceInfo,
  WorkspaceNode,
} from './contracts'

export interface FileSearchGroup {
  path: string
  relativePath: string
  matches: SearchMatch[]
  isExpanded: boolean
}

export interface OpenWorkspaceFileInPaneOptions {
  path: string
  name?: string
  paneId: string
  zone?: 'center' | 'left' | 'right' | 'top' | 'bottom'
  pin?: boolean
  version?: number
  cancellationToken?: { isCancelled: boolean }
  signal?: AbortSignal
}

export class WorkspaceController {
  rootPath: string | null = null
  rootName = ''
  entries: WorkspaceNode[] = []
  roots: WorkspaceInfo[] = []
  openRevision = 0
  selectedTreePath: string | null = null
  recentWorkspaces: string[] = []
  showIgnored = false
  quickFiles: { name: string; path: string; relativePath: string }[] = []
  workspaceFiles: { name: string; path: string; relativePath: string }[] = []
  fileIndexLoading = false
  private fileIndexEpoch = 0
  private fileIndexRevision = -1
  private fileIndexComplete = false
  private fileIndexPromise: Promise<void> | null = null
  private quickGeneration = 0
  private operationBusy = false
  private disposed = false
  private searchSequence = 0
  private revealSequence = 0
  private expandSequence = 0
  private openFileSeq = 0
  private latestPaneSeq = new Map<string, number>()
  private openEpoch = 0
  private inFlightOpens = new Map<string, {
    requestId: number
    consumers: Map<string, { seq: number; preview: boolean; navigation: number; pane: EditorPaneModel }>
    promise: Promise<void>
  }>()
  private folderLoads = new Map<WorkspaceNode,Promise<boolean>>()
  private pendingReads=new Map<string,Promise<Awaited<ReturnType<WorkspaceGateway['openWorkspaceFile']>>>>()
  expanding = false
  smartExpand = true
  compactFolders = false
  private smartExpandSequence = 0

  // 全文搜索状态
  searchId = ''
  searchQuery = ''
  searching = false
  searchTotal = 0
  searchResults: FileSearchGroup[] = []
  searchDialogOpen=false
  searchRestoreFocus=true
  searchScope:'workspace'|'directory'|'opened'='workspace'
  searchStatus:GlobalSearchStatus='idle'
  searchMessage=''
  searchLimited=false
  searchSkipped=0
  searchInclude=''
  searchExclude=''
  searchIncludeIgnored=false
  searchSort:'path'|'name'|'count'='path'
  searchHistory:string[]=[]
  replacementHistory:string[]=[]
  searchWindow=defaultSearchWindow()
  selectedMatchId=''
  selectedMatches=new Set<string>()
  searchPreview:SearchSourcePreview|null=null
  searchPreviewError=''
  searchPreviewLoading=false
  searchComposing=false
  private previewEpoch=0
  private searchTimer:ReturnType<typeof setTimeout>|undefined
  private batchTimer:ReturnType<typeof setTimeout>|undefined
  private pendingBatch:SearchMatch[]=[]
  private searchDirty=false
  private searchSnapshots=new Map<string,{id:string;text:NonNullable<ReturnType<DocumentManager['getState']>>['doc']}>()
  private stopSearchDocuments:(()=>void)|undefined
  isCaseSensitive = false
  isWholeWord = false
  isRegex = false
  searchDirectory = ''
  replaceExpanded = false
  replacementText = ''
  replaceFiles: (ReplaceFile & { selected: Set<number>; expanded: boolean; status: string })[] = []
  replaceMessage = ''
  replacementReport:string[]=[]
  replaceBusy = false
  replaceApplying = false
  replaceProgress = 0
  searchFocusRevision = 0
  searchFocusReplace = false
  private replaceEpoch = 0
  private replaceCancel = false
  private replaceSearchId = ''
  private replaceQuery: SearchQuery | null = null
  private previewReplacement = ''
  private replaceSkipped:string[]=[]
  private replaceSnapshots = new Map<string, { id: string; token: string | undefined; version:string|null; text: NonNullable<ReturnType<DocumentManager['getState']>>['doc'] }>()

  private listeners = new Set<() => void>()
  private openListeners = new Set<() => void>()
  private searchBatchUnsub: (() => void) | null = null
  private searchDoneUnsub: (() => void) | null = null
  private initialized=false

  constructor(
    readonly gateway: WorkspaceGateway,
    readonly documentManager: DocumentManager,
    readonly fileController: FileController,
    private readonly notify: (msg: string) => void,
    autoConnect = true,
  ) {
    this.loadSearchMetadata()
    if (autoConnect) this.connect()
  }

  connect() {
    if(this.initialized||this.disposed)return
    this.initialized=true;void this.loadRecents()
  }
  private connectSearch(){
    if (this.searchBatchUnsub || this.disposed) return
    this.searchBatchUnsub = this.gateway.onSearchBatch(batch => this.onSearchBatch(batch))
    this.searchDoneUnsub = this.gateway.onSearchDone(payload => this.onSearchDone(payload))
    this.stopSearchDocuments=this.documentManager.subscribe(()=>{
      if(!this.searchQuery||this.replaceApplying)return
      const documents=this.textSearchDocuments()
      const ids=new Set(documents.map(doc=>doc.id))
      const changed=documents.some(doc=>{const before=this.searchSnapshots.get(doc.id);return before?this.documentManager.getState(doc.id)?.doc!==before.text:doc.dirty||this.searchScope==='opened'}) || [...this.searchSnapshots.keys()].some(id=>!ids.has(id))
      if(changed){this.searchDirty=true;if(this.searchDialogOpen)this.scheduleSearch();else this.searchSnapshots=new Map(documents.map(doc=>[doc.id,{id:doc.id,text:markRaw(this.documentManager.getState(doc.id)!.doc)}]))}
    })
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onOpened(fn: () => void) {
    this.openListeners.add(fn)
    return () => this.openListeners.delete(fn)
  }

  private notifyOpened() {
    for (const fn of this.openListeners) fn()
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  selectTreePath(path: string | null) { this.selectedTreePath = path; this.emit() }
  cancelReveal() { this.revealSequence++ }
  private cancelOpens() { this.openEpoch++; this.inFlightOpens.clear(); this.latestPaneSeq.clear() }

  async loadRecents() {
    try {
      const recents = await this.gateway.getRecentWorkspaces()
      if (this.disposed) return
      // Keep the menu/palette contract (a list of paths) even if a gateway
      // returns null; recent entries are persisted data, not trusted shape.
      this.recentWorkspaces = Array.isArray(recents) ? recents.filter((path): path is string => typeof path === 'string') : []
      this.emit()
    } catch {
      // 忽略无法获取最近工作区的异常
    }
  }

  async restoreCurrent() {
    if (!this.beginMutation()) return
    try {
      const roots = await this.gateway.restoreWorkspaces()
      if (this.disposed || this.rootPath || !roots.length) return
      this.applyWorkspace(roots[0])
      for (const root of roots.slice(1)) this.addWorkspace(root)
    } finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  restoreSession(roots: WorkspaceInfo[]) {
    if (this.disposed || this.rootPath || !roots.length) return
    this.applyWorkspace(roots[0])
    for (const root of roots.slice(1)) this.addWorkspace(root)
  }

  async openWorkspaceDialog(add = false): Promise<boolean> {
    if (this.operationBusy || (this.fileController.activeOperationCount ?? this.fileController.saving.size) || this.documentManager.isComposing) {
      this.notify('请等待文件操作和输入完成，再切换工作区。'); return false
    }
    if (!this.beginMutation()) return false
    try {
      const info = await this.gateway.openWorkspaceDialog(add)
      if (!info) return false
      if (add && this.rootPath) this.addWorkspace(info)
      else this.applyWorkspace(info)
      this.notifyOpened()
      return true
    } catch (e) {
      this.notify(String(e))
      return false
    } finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  private addWorkspace(info: WorkspaceInfo) {
    this.cancelOpens(); this.cancelReveal()
    this.cancelExpand()
    if (!this.roots.some(root => root.rootPath === info.rootPath)) this.roots.push(info)
    this.openRevision++
    if (info.warning) this.notify(info.warning)
    this.resetSearchContext()
    this.quickGeneration++; this.quickFiles = []; this.invalidateFileIndex(); void this.loadRecents(); this.emit()
  }

  async removeFolder(path: string) {
    this.cancelExpand();this.revealSequence++
    if (this.operationBusy || (this.fileController.activeOperationCount ?? this.fileController.saving.size) || this.documentManager.isComposing) { this.notify('请等待文件操作和输入完成。'); return }
    if (!this.beginMutation()) return
    this.cancelSearch(); this.quickGeneration++
    try {
      await this.gateway.removeWorkspaceFolder(path)
      this.cancelOpens(); this.openRevision++
      if (this.selectedTreePath && this.isWithin(this.selectedTreePath, path)) this.selectedTreePath = null
      this.roots = this.roots.filter(root => displayPathKey(root.rootPath) !== displayPathKey(path))
      const first = this.roots[0]
      this.rootPath = first?.rootPath || null; this.rootName = first?.name || ''; this.entries = first?.entries || []
      this.resetSearchContext()
      this.quickGeneration++; this.quickFiles = []; this.invalidateFileIndex(); this.emit()
    } catch (error) { this.notify(`移除工作区文件夹失败：${error}`) }
    finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  async openWorkspacePath(path: string, add = false): Promise<boolean> {
    const success = await this.loadWorkspace(() => this.gateway.openWorkspacePath(path, add), add)
    if (success) this.notifyOpened()
    return success
  }

  async openDroppedWorkspace(token: string): Promise<boolean> {
    const success = await this.loadWorkspace(() => this.gateway.openDroppedWorkspace(token), true)
    if (success) this.notifyOpened()
    return success
  }

  private async loadWorkspace(load: () => Promise<WorkspaceInfo>, add: boolean): Promise<boolean> {
    if (this.operationBusy || (this.fileController.activeOperationCount ?? this.fileController.saving.size) || this.documentManager.isComposing) {
      this.notify('请等待文件操作和输入完成，再切换工作区。'); return false
    }
    if (!this.beginMutation()) return false
    try {
      const info = await load()
      if (add && this.rootPath) this.addWorkspace(info)
      else this.applyWorkspace(info)
      return true
    } catch (e) {
      this.notify(String(e))
      return false
    } finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  private applyWorkspace(info: WorkspaceInfo) {
    this.cancelOpens(); this.selectedTreePath = null
    this.cancelExpand(); this.revealSequence++
    this.rootPath = info.rootPath
    this.rootName = info.name
    this.entries = info.entries
    this.roots = [info]
    this.openRevision++
    this.cancelSearch(false)
    this.quickGeneration++
    this.quickFiles = []
    this.invalidateFileIndex()
    if (info.warning) this.notify(info.warning)
    this.resetSearchContext()
    void this.loadRecents()
    this.emit()
  }

  private loadFolder(node: WorkspaceNode): Promise<boolean> {
    if (node.children && (node.children.length || !node.hasChildren) && !node.isLoading) return Promise.resolve(true)
    const pending=this.folderLoads.get(node)
    if(pending)return pending
    const root=this.roots.find(root=>root.rootPath===this.rootForPath(node.path))
    if(!root || node.isSymlink)return Promise.resolve(false)
    node.isLoading=true;this.emit()
    const load=(async()=>{
      try {
        const children=await this.gateway.readDirectory(node.path)
        if(this.disposed||!this.roots.includes(root))return false
        const prefix=displayPathKey(node.path)+'/'
        node.children=children.filter(child=>!child.isSymlink&&displayPathKey(child.path).startsWith(prefix))
        node.hasChildren=!!node.children.length;return true
      }catch(error){this.notify(`读取目录失败：${String(error)}`);return false}
      finally {node.isLoading=false;this.folderLoads.delete(node);this.emit()}
    })()
    this.folderLoads.set(node,load);return load
  }
  async toggleFolder(node: WorkspaceNode, options?: { smart?: boolean }) {
    if (!node.isDirectory || node.isSymlink) return
    this.cancelExpand(); this.cancelReveal()
    const wasExpanded = !!node.isExpanded
    node.isExpanded = !wasExpanded
    this.emit()
    if (!node.isExpanded) return
    const loaded = await this.loadFolder(node)
    if (!loaded || !node.isExpanded || this.disposed) {
      node.isExpanded = false
      this.emit()
      return
    }
    const useSmart = options?.smart ?? this.smartExpand
    if (useSmart) {
      await this.smartExpandChain(node)
    } else if (this.compactFolders) {
      await this.resolveCompactChain(node)
    }
    this.emit()
  }
  cancelExpand() {
    this.expandSequence++
    this.smartExpandSequence++
    this.expanding = false
    this.emit()
  }
  async smartExpandChain(startNode: WorkspaceNode) {
    const sequence = ++this.smartExpandSequence
    const started = Date.now()
    const maxDepth = 48
    const maxTimeout = 3000
    let current = startNode
    let depth = 0

    while (
      !this.disposed &&
      sequence === this.smartExpandSequence &&
      startNode.isExpanded &&
      current.isExpanded &&
      depth < maxDepth &&
      Date.now() - started < maxTimeout
    ) {
      const children = current.children
      if (!children || children.length !== 1) break
      const soleChild = children[0]
      if (!soleChild.isDirectory || soleChild.isSymlink) break

      soleChild.isExpanded = true
      this.emit()

      const loaded = await this.loadFolder(soleChild)
      if (
        this.disposed ||
        sequence !== this.smartExpandSequence ||
        !startNode.isExpanded ||
        !soleChild.isExpanded
      ) {
        if (!loaded && soleChild.isExpanded) soleChild.isExpanded = false
        break
      }
      if (!loaded) {
        soleChild.isExpanded = false
        break
      }

      current = soleChild
      depth++
    }
  }
  async resolveCompactChain(node: WorkspaceNode) {
    if (!this.compactFolders || !node.isDirectory || node.isSymlink) return [node]
    const chain: WorkspaceNode[] = [node]
    let current = node
    let depth = 0
    const maxDepth = 48

    while (depth < maxDepth && !this.disposed) {
      if (!current.children && current.hasChildren) {
        const loaded = await this.loadFolder(current)
        if (!loaded || this.disposed) break
      }
      const children = current.children
      if (!children || children.length !== 1) break
      const soleChild = children[0]
      if (!soleChild.isDirectory || soleChild.isSymlink) break
      chain.push(soleChild)
      current = soleChild
      depth++
    }
    return chain
  }
  collapseCompactChain(chain: WorkspaceNode[]) {
    this.cancelExpand()
    for (const item of chain) {
      item.isExpanded = false
    }
    this.emit()
  }
  async expandCompactChain(chain: WorkspaceNode[], options?: { smart?: boolean }) {
    this.cancelExpand(); this.cancelReveal()
    for (const item of chain) {
      item.isExpanded = true
    }
    this.emit()
    const tail = chain[chain.length - 1]
    const loaded = await this.loadFolder(tail)
    if (!loaded || !tail.isExpanded || this.disposed) {
      if (!loaded) tail.isExpanded = false
      this.emit()
      return
    }
    const useSmart = options?.smart ?? this.smartExpand
    if (useSmart) {
      await this.smartExpandChain(tail)
    } else if (this.compactFolders) {
      await this.resolveCompactChain(tail)
    }
    this.emit()
  }
  collapseAll() {
    this.cancelExpand();this.revealSequence++
    const stack=this.roots.flatMap(root=>root.entries)
    while(stack.length){const node=stack.pop()!;node.isExpanded=false;if(node.children)for(const child of node.children)stack.push(child)}
    this.emit()
  }
  async expandAll(options: {maxNodes?:number;maxDirectories?:number;maxDepth?:number;timeoutMs?:number} = {}) {
    const sequence=++this.expandSequence,roots=[...this.roots],started=Date.now()
    const maxNodes=Math.min(20000,Math.max(1,options.maxNodes??20000)),maxDirectories=Math.min(250,Math.max(1,options.maxDirectories??250)),maxDepth=Math.min(32,Math.max(1,options.maxDepth??32)),timeout=Math.min(5000,Math.max(1,options.timeoutMs??5000))
    const queue=roots.map(root=>({nodes:root.entries,depth:1}))
    let count=0,directories=0,limited=false
    this.expanding=true;this.emit()
    try {
      outer:for(let cursor=0;cursor<queue.length;cursor++){
        const {nodes,depth}=queue[cursor]
        for(const node of nodes){
          if(this.disposed||sequence!==this.expandSequence||roots.some(root=>!this.roots.includes(root)))break outer
          if(++count>maxNodes||Date.now()-started>timeout){limited=true;break outer}
          if(!node.isDirectory||node.isSymlink)continue
          if(depth>maxDepth){limited=true;continue}
          if(++directories>maxDirectories){limited=true;break outer}
          if(!await this.loadFolder(node))continue
          if(sequence!==this.expandSequence||this.disposed)break outer
          node.isExpanded=true
          if(node.children?.length)queue.push({nodes:node.children,depth:depth+1})
          if(directories%8===0){this.emit();await new Promise<void>(resolve=>setTimeout(resolve,0))}
        }
      }
      if(limited&&sequence===this.expandSequence)this.notify('全部展开已达到保护预算，可手动展开剩余目录。')
      return {count,directories,limited,canceled:sequence!==this.expandSequence}
    }finally{if(sequence===this.expandSequence)this.expanding=false;this.emit()}
  }
  async revealFileInTree(path: string) {
    this.cancelExpand()
    const sequence = ++this.revealSequence
    const root = this.roots.find(root => root.rootPath === this.rootForPath(path))
    if (!root) return false
    if (this.gateway.isVisibleFile) {
      try { if (!await this.gateway.isVisibleFile(path)) return false }
      catch { return false }
      if (sequence !== this.revealSequence || this.disposed || !this.roots.includes(root)) return false
    }
    const target = displayPathKey(path), parents: WorkspaceNode[] = []
    let nodes = root.entries, owner: WorkspaceNode | undefined, refreshed = false
    for (let depth = 0; depth < 256 && !this.disposed && sequence === this.revealSequence; depth++) {
      if (nodes.some(node => !node.isDirectory && !node.isSymlink && displayPathKey(node.path) === target)) {
        // Commit expansion only after finding the target. A missing/ignored path
        // or a canceled request must not disturb the user's browsing position.
        for (const parent of parents) parent.isExpanded = true
        this.emit(); return true
      }
      const parent = nodes.find(node => node.isDirectory && !node.isSymlink && this.isWithin(path, node.path))
      if (!parent) {
        if (refreshed) return false
        // A file opened outside the tree may have appeared since this directory
        // was cached. Refresh only this missing level, never the whole path.
        try {
          const fresh = await this.gateway.readDirectory(owner?.path || root.rootPath)
          if (sequence !== this.revealSequence || this.disposed || !this.roots.includes(root)) return false
          nodes = this.mergeDirectory(nodes, fresh)
          if (owner) { owner.children = nodes; owner.hasChildren = !!nodes.length }
          else { root.entries = nodes; if (this.roots[0] === root) this.entries = nodes }
          refreshed = true
          continue
        } catch { return false }
      }
      if (!await this.loadFolder(parent)) return false
      if (sequence !== this.revealSequence || !this.roots.includes(root)) return false
      parents.push(parent)
      owner = parent; nodes = parent.children || []; refreshed = false
    }
    return false
  }
  async revealNode(path:string) {
    if(!this.gateway.revealNode) { this.notify('当前环境不支持系统文件管理器。'); return }
    try {await this.gateway.revealNode(path)}catch(error){this.notify(`在文件管理器中显示失败：${String(error)}`)}
  }

  private mergeDirectory(previous: WorkspaceNode[], fresh: WorkspaceNode[]) {
    const known = new Map(previous.map(node => [displayPathKey(node.path), node]))
    return fresh.map(node => {
      const old = known.get(displayPathKey(node.path))
      if (!old?.isDirectory || !node.isDirectory || !node.hasChildren) return node
      return Object.assign(old, node, {children: old.children, isExpanded: old.isExpanded})
    })
  }

  private reconcileTreeSelection() {
    const path = this.selectedTreePath
    if (!path) return
    const root = this.roots.find(root => this.isWithin(path, root.rootPath))
    if (!root) { this.selectedTreePath = null; return }
    let nodes = root.entries
    for (let depth = 0; depth < 256; depth++) {
      if (displayPathKey(path) === displayPathKey(root.rootPath) || nodes.some(node => displayPathKey(node.path) === displayPathKey(path))) return
      const parent = nodes.find(node => node.isDirectory && this.isWithin(path, node.path))
      if (!parent) { this.selectedTreePath = null; return }
      if (!parent.children || (parent.hasChildren && !parent.children.length)) return
      nodes = parent.children
    }
  }

  async refreshDirectory(node?: WorkspaceNode) {
    this.cancelExpand();this.revealSequence++
    if (!this.rootPath) return
    const revision = this.openRevision
    const rebuildIndex = this.fileIndexRevision === revision || this.fileIndexLoading
    // Retain useful cached files while rebuilding, but fence off any older scan.
    this.invalidateFileIndex(false)
    this.quickFiles = []
    try {
      if (!node) {
        for (const root of [...this.roots]) {
          const fresh = await this.gateway.readDirectory(root.rootPath)
          if (this.disposed || revision !== this.openRevision) return
          this.reconcileIndexedDirectory(root.rootPath, fresh)
          root.entries = this.mergeDirectory(root.entries, fresh)
        }
        this.entries = this.roots[0]?.entries || []
      } else if (node.isDirectory) {
        node.isLoading = true
        this.emit()
        const fresh = await this.gateway.readDirectory(node.path)
        if (this.disposed || revision !== this.openRevision) return
        this.reconcileIndexedDirectory(node.path, fresh)
        node.children = this.mergeDirectory(node.children || [], fresh)
        node.hasChildren = !!node.children.length
        node.isLoading = false
      }
      this.reconcileTreeSelection()
      this.emit()
    } catch (e) {
      this.notify(String(e))
    } finally {
      if (node) node.isLoading = false
      this.emit()
      if (!this.disposed && revision === this.openRevision) {
        // Quick Open may have started another scan while the directory read was
        // pending. That snapshot also predates the completed refresh.
        const rebuild = rebuildIndex || this.fileIndexLoading || this.fileIndexRevision === revision
        this.invalidateFileIndex(false)
        if (rebuild) await this.ensureFileIndex()
      }
    }
  }

  private reconcileIndexedDirectory(path: string, fresh: WorkspaceNode[]) {
    const prefix = displayPathKey(path) + '/'
    const children = new Map(fresh.map(child => [displayPathKey(child.path), child]))
    this.workspaceFiles = this.workspaceFiles.filter(file => {
      const key = displayPathKey(file.path)
      if (!key.startsWith(prefix)) return true
      const slash = key.indexOf('/', prefix.length)
      const child = children.get(slash < 0 ? key : key.slice(0, slash))
      return !!child && !child.isSymlink && (slash < 0 ? !child.isDirectory : child.isDirectory)
    })
  }

  async openFile(node: WorkspaceNode, preview = true) {
    if (this.disposed || this.operationBusy || node.isDirectory || node.isSymlink || this.documentManager.isComposing) return
    const manager = this.documentManager, targetPane = manager.activePaneId, targetPath = node.path
    const pane = manager.layout.getPane(targetPane)
    if (!pane) return
    // Every intent counts, including an existing tab and A -> B -> pending A.
    const seq = ++this.openFileSeq, epoch = this.openEpoch, key = displayPathKey(targetPath)
    this.latestPaneSeq.set(targetPane, seq)
    const existingDoc = manager.openedDocuments.find(doc => doc.path && displayPathKey(doc.path) === key)
    if (existingDoc) {
      manager.open(existingDoc.id, preview, targetPane, false)
      return
    }
    const inFlight = this.inFlightOpens.get(key)
    const consumer = { seq, preview: preview && (inFlight?.consumers.get(targetPane)?.preview ?? true), navigation: manager.navigationRevision(targetPane), pane }
    if (inFlight) {
      inFlight.consumers.set(targetPane, consumer)
      return inFlight.promise
    }
    const request = { requestId: seq, consumers: new Map([[targetPane, consumer]]), promise: Promise.resolve() }
    const valid = (id: string, intent: typeof consumer) => !this.disposed && epoch === this.openEpoch &&
      this.latestPaneSeq.get(id) === intent.seq && manager.layout.getPane(id) === intent.pane &&
      manager.navigationRevision(id) === intent.navigation
    request.promise = (async () => {
      try {
        const file = await this.readWorkspaceFile(targetPath)
        const consumers = [...request.consumers].filter(([id, intent]) => valid(id, intent))
        if (!consumers.length) {
          if (!manager.openedDocuments.some(doc => doc.fileToken === file.token))
            this.releaseUnadopted(file.token)
          return
        }
        // Import once, then share the document with each still-valid pane.
        // Completion never changes the currently focused pane.
        const [firstPane, first] = consumers[0]
        if (!this.fileController.accept(file, first.preview, firstPane, false)) return
        const doc = manager.openedDocuments.find(doc => doc.fileToken === file.token || displayPathKey(doc.path) === displayPathKey(file.path))
        if (doc) for (const [id, intent] of consumers.slice(1)) if (valid(id, intent)) manager.open(doc.id, intent.preview, id, false)
      } catch (e) {
        if ([...request.consumers].some(([id, intent]) => valid(id, intent))) this.notify(`打开工作区文件失败: ${e}`)
      } finally {
        if (this.inFlightOpens.get(key)?.requestId === request.requestId) this.inFlightOpens.delete(key)
      }
    })()
    this.inFlightOpens.set(key, request)
    return request.promise
  }

  private readWorkspaceFile(path:string){
    const key=displayPathKey(path),pending=this.pendingReads.get(key)
    if(pending)return pending
    if(this.pendingReads.size>=8)return Promise.reject(Error('正在打开的文件过多，请稍后再试。'))
    const request=this.gateway.openWorkspaceFile(path).finally(()=>{if(this.pendingReads.get(key)===request)this.pendingReads.delete(key)})
    this.pendingReads.set(key,request);return request
  }
  private releaseUnadopted(token:string){queueMicrotask(()=>{if(!this.documentManager.openedDocuments.some(doc=>doc.fileToken===token))void this.fileController.gateway.release(token).catch(error=>{if(!this.disposed)this.notify('释放文件授权失败：'+String(error))})})}
  async openWorkspaceFileInPane(options: OpenWorkspaceFileInPaneOptions): Promise<{ success: boolean; paneId?: string; docId?: string }> {
    if (this.disposed || this.operationBusy || this.documentManager.isComposing) {
      return { success: false }
    }
    if (options.cancellationToken?.isCancelled || options.signal?.aborted) {
      return { success: false }
    }
    const targetPath = options.path
    if (!targetPath) return { success: false }

    // Do not open directories as regular files
    const knownNode = this.findNodeByPath(this.roots.flatMap(r => r.entries), targetPath)
    if (knownNode?.isDirectory) {
      return { success: false }
    }

    const targetPane = options.paneId
    const zone = options.zone || 'center'
    const pin = options.pin ?? true
    const manager = this.documentManager
    const requestedPane=manager.layout.getPane(targetPane),epoch=this.openEpoch
    if(!requestedPane)return {success:false}
    const key = displayPathKey(targetPath)

    // Dropping a file always produces a real (pinned) tab so the next preview
    // navigation cannot silently replace what the user just dropped.
    const preview = !pin

    // Ensure targetPane exists; if not, fallback to activePane
    const effectivePane = manager.layout.getPane(targetPane) ? targetPane : manager.activePane

    const existingDoc = manager.openedDocuments.find(
      doc => doc.path && displayPathKey(doc.path) === key
    )
    if (existingDoc) {
      if (options.cancellationToken?.isCancelled || options.signal?.aborted) {
        return { success: false }
      }
      const pane = zone === 'center'
        ? effectivePane
        : manager.splitPane(zone as SplitDirection, effectivePane, existingDoc.id)
      manager.open(existingDoc.id, preview, pane, false)
      if (pin) manager.pin(existingDoc.id, pane)
      manager.focusPane(pane, true)
      return { success: true, paneId: pane, docId: existingDoc.id }
    }

    // Load first: a failed or cancelled read must not leave a stray empty pane.
    let file: Awaited<ReturnType<WorkspaceGateway['openWorkspaceFile']>>
    try {
      file = await this.readWorkspaceFile(targetPath)
    } catch (e) {
      if (!options.cancellationToken?.isCancelled && !options.signal?.aborted) {
        this.notify(`打开工作区文件失败: ${e}`)
      }
      return { success: false }
    }
    if (this.disposed || epoch!==this.openEpoch||manager.layout.getPane(targetPane)!==requestedPane||options.cancellationToken?.isCancelled || options.signal?.aborted) {
      this.releaseUnadopted(file.token)
      return { success: false }
    }

    const validTargetPane = manager.layout.getPane(effectivePane) ? effectivePane : manager.activePane

    // `cloneActive: false` keeps the new pane empty until this file is adopted,
    // so no temporary duplicate of the source document is ever left behind.
    const pane = zone === 'center'
      ? validTargetPane
      : manager.splitPane(zone as SplitDirection, validTargetPane, undefined, validTargetPane, false)

    if (!this.fileController.accept(file, preview, pane, false)) {
      if (zone !== 'center') {
        manager.closePane(pane)
      }
      return { success: false }
    }
    const opened = manager.openedDocuments.find(
      doc => doc.fileToken === file.token || (doc.path && displayPathKey(doc.path) === key)
    )
    if (opened && pin) manager.pin(opened.id, pane)
    manager.focusPane(pane, true)
    return { success: true, paneId: pane, docId: opened?.id }
  }

  async createFile(parentDir: string, name: string) {
    if (!this.beginMutation()) return
    let created: WorkspaceNode | undefined
    try {
      const newNode = await this.gateway.createFile(parentDir, name)
      await this.insertNode(parentDir, newNode)
      created = newNode
    } catch (e) {
      this.notify(`创建文件失败: ${e}`)
    } finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
    if (created) await this.openFile(created)
  }

  async createDirectory(parentDir: string, name: string) {
    if (!this.beginMutation()) return
    try {
      const newNode = await this.gateway.createDirectory(parentDir, name)
      await this.insertNode(parentDir, newNode)
    } catch (e) {
      this.notify(`创建文件夹失败: ${e}`)
    } finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  private async insertNode(parentDir: string, node: WorkspaceNode) {
    const root = this.roots.find(item => item.rootPath === parentDir)
    if (root) {
      root.entries.push(node)
      this.sortNodes(root.entries)
    } else {
      const parent = this.roots.map(root => this.findNodeByPath(root.entries, parentDir)).find(Boolean)
      if (parent && parent.isDirectory) {
        parent.children = await this.gateway.readDirectory(parent.path)
        parent.isExpanded = true
      }
    }
    this.emit()
  }

  async renameNode(node: WorkspaceNode, newName: string) {
    if (!newName.trim() || newName === node.name) return
    if (!this.beginMutation()) return
    const oldPath = node.path
    try {
      const [oldRel, newRel] = await this.gateway.renameNode(oldPath, newName)
      this.relocate(oldRel, newRel, this.rootForPath(oldPath) || this.rootPath!)
      this.emit()
    } catch (e) {
      this.notify(`重命名失败: ${e}`)
    } finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  private beginMutation() {
    if (this.operationBusy || (this.fileController.activeOperationCount ?? this.fileController.saving.size) || this.documentManager.isComposing) {
      this.notify('请等待文件操作和输入完成。'); return false
    }
    this.operationBusy = true
    this.invalidateReplace()
    this.fileController.workspaceBusy = true
    this.cancelOpens(); this.cancelReveal()
    return true
  }

  rootForPath(path: string) {
    const normalized = displayPathKey(path)
    return [...this.roots].sort((a,b)=>b.rootPath.length-a.rootPath.length).find(root => {
      const base = displayPathKey(root.rootPath).replace(/\/$/,'')
      return normalized === base || normalized.startsWith(base + '/')
    })?.rootPath || null
  }

  private isWithin(path: string, parent: string) {
    const key = displayPathKey(path), base = displayPathKey(parent).replace(/\/$/, '')
    return key === base || key.startsWith(base + '/')
  }

  private absolute(relative: string, root: string) {
    const separator = root.includes('\\') ? '\\' : '/'
    return `${root.replace(/[\\/]+$/, '')}${separator}${relative.replace(/\//g, separator)}`
  }

  private relocate(oldRelative: string, newRelative: string, root: string) {
    const old = this.absolute(oldRelative, root), next = this.absolute(newRelative, root)
    this.cancelOpens(); this.cancelReveal()
    const movedPath = (path: string) => next + readablePath(path).replace(/\\/g, '/').slice(readablePath(old).replace(/\\/g, '/').length)
    if (this.selectedTreePath && this.isWithin(this.selectedTreePath, old)) this.selectedTreePath = movedPath(this.selectedTreePath)
    for (const doc of this.documentManager.openedDocuments) {
      if (this.isWithin(doc.path, old)) {
        const moved = movedPath(doc.path)
        this.documentManager.renamePath(doc.path, moved, moved.split(/[\\/]/).pop()!)
      }
    }
    const visit = (nodes: WorkspaceNode[]) => {
      for (const item of nodes) {
        if (item.relativePath === oldRelative || item.relativePath.startsWith(oldRelative + '/')) {
          item.relativePath = newRelative + item.relativePath.slice(oldRelative.length)
          item.path = this.absolute(item.relativePath, root)
          item.id = item.relativePath
          item.name = item.relativePath.split('/').pop()!
        }
        if (item.children) visit(item.children)
      }
      this.sortNodes(nodes)
    }
    visit(this.roots.find(item => item.rootPath === root)?.entries || this.entries)
    this.cancelSearch()
    this.resetSearchContext()
    this.quickGeneration++; this.quickFiles = []
    this.invalidateFileIndex()
  }

  async moveNode(node: WorkspaceNode, destination: string) {
    if (!this.beginMutation()) return
    try {
      const rootPath = this.rootForPath(node.path) || this.rootPath!
      const [oldRelative, newRelative] = await this.gateway.moveNode(node.path, destination)
      this.relocate(oldRelative, newRelative, rootPath)
      // Relocation changes identity, but cached sibling lists also need to move
      // the node. Otherwise a loaded destination would never read it again.
      for (const root of this.roots) this.removeNodeFromTree(root.entries, node.path)
      const root = this.roots.find(root => displayPathKey(root.rootPath) === displayPathKey(destination))
      const parent = this.roots.map(root => this.findNodeByPath(root.entries, destination)).find(Boolean)
      if (root) { root.entries.push(node); this.sortNodes(root.entries) }
      else if (parent) {
        if (parent.children && (parent.children.length || !parent.hasChildren)) {
          parent.children.push(node); this.sortNodes(parent.children)
        }
        parent.hasChildren = true
      }
      await this.refreshDirectory()
    } catch (e) { this.notify(`移动失败: ${e}`) }
    finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  async deleteNode(node: WorkspaceNode) {
    if (this.documentManager.openedDocuments.some(doc => this.isWithin(doc.path, node.path))) {
      this.notify('请先保存并关闭此条目内的已打开文件，再删除。'); return
    }
    if (!this.beginMutation()) return
    try {
      await this.gateway.deleteNode(node.path)
      this.cancelOpens(); this.cancelReveal()
      if (this.selectedTreePath && this.isWithin(this.selectedTreePath, node.path)) this.selectedTreePath = null
      for (const root of this.roots) this.removeNodeFromTree(root.entries, node.path)
      this.cancelSearch()
      this.resetSearchContext()
      this.quickGeneration++; this.quickFiles = []
      this.invalidateFileIndex()
      this.emit()
    } catch (e) {
      this.notify(`删除失败: ${e}`)
    } finally { this.operationBusy = false; this.fileController.workspaceBusy = false }
  }

  private removeNodeFromTree(list: WorkspaceNode[], path: string): boolean {
    const idx = list.findIndex(n => displayPathKey(n.path) === displayPathKey(path))
    if (idx !== -1) {
      list.splice(idx, 1)
      return true
    }
    for (const item of list) {
      if (item.children && this.removeNodeFromTree(item.children, path)) {
        item.hasChildren = !!item.children.length
        return true
      }
    }
    return false
  }

  private findNodeByPath(list: WorkspaceNode[], path: string): WorkspaceNode | null {
    for (const item of list) {
      if (displayPathKey(item.path) === displayPathKey(path)) return item
      if (item.children) {
        const found = this.findNodeByPath(item.children, path)
        if (found) return found
      }
    }
    return null
  }

  private sortNodes(nodes: WorkspaceNode[]) {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  // --- 全文搜索管理 ---

  textSearchDocuments(){return this.documentManager.openedDocuments.filter(doc=>(!doc.kind||doc.kind==='text')&&doc.encoding!=='Hex'&&this.documentManager.getState(doc.id))}
  searchRelativePath(path:string,name:string){
    const root=this.roots.find(root=>this.isWithin(path,root.rootPath))
    if(root){
      const label=this.roots.some(other=>other!==root&&other.name===root.name)?readablePath(root.rootPath):root.name
      return (this.roots.length>1?label+'/':'')+readablePath(path).replace(/\\/g,'/').slice(readablePath(root.rootPath).replace(/\\/g,'/').replace(/\/$/,'').length+1)
    }
    return path?readablePath(path).split(/[\\/]/).slice(-2).join('/'):name
  }
  searchDirectoryContext(){
    const path=this.selectedTreePath||this.documentManager.activeDocument?.path
    if(path){
      const root=this.roots.find(root=>displayPathKey(root.rootPath)===displayPathKey(path));if(root)return root.rootPath
      const node=this.roots.map(root=>this.findNodeByPath(root.entries,path)).find(Boolean)
      if(node?.isDirectory)return node.path
      if(this.rootForPath(path))return path.replace(/[\\/][^\\/]+$/,'')
    }
    return this.rootPath||undefined
  }
  private loadSearchMetadata(){
    try{
      const saved=JSON.parse(localStorage.getItem('markumo.globalSearch.v1')||'null')
      if(!saved)return
      const history=(values:unknown)=>Array.isArray(values)?values.filter((value):value is string=>typeof value==='string'&&value.length<=4096).slice(0,20):[]
      this.searchHistory=history(saved.queries);this.replacementHistory=history(saved.replacements)
      if(saved.window&&typeof saved.window==='object'){
        for(const key of ['x','y','width','height','split'] as const){const value=saved.window[key];if(typeof value==='number'&&Number.isFinite(value))this.searchWindow[key]=value}
        this.searchWindow.pinned=saved.window.pinned===true
      }
    }catch(error){this.searchMessage='搜索历史设置读取失败：'+String(error)}
  }
  persistSearchMetadata(){
    try{localStorage.setItem('markumo.globalSearch.v1',JSON.stringify({queries:this.searchHistory,replacements:this.replacementHistory,window:this.searchWindow}))}
    catch(error){this.searchMessage='搜索历史设置保存失败：'+String(error);this.emit()}
  }
  clearSearchHistory(replacements=false){if(replacements)this.replacementHistory=[];else this.searchHistory=[];this.persistSearchMetadata();this.emit()}
  private rememberSearch(replacement=false){
    const value=replacement?this.replacementText:this.searchQuery
    if(!value||value.length>4096)return
    const history=replacement?this.replacementHistory:this.searchHistory
    const next=[value,...history.filter(item=>item!==value)].slice(0,20)
    if(replacement)this.replacementHistory=next;else this.searchHistory=next
    this.persistSearchMetadata()
  }
  focusWorkspaceSearch(replace=false,directory?:string){
    this.replaceExpanded=replace;this.searchFocusReplace=replace
    const changed=directory!==undefined&&(this.searchDirectory!==directory||this.searchScope!=='directory')
    if(directory!==undefined){this.searchScope='directory';this.searchDirectory=directory}
    else if(!this.roots.length)this.searchScope='opened'
    this.searchDialogOpen=true;this.searchFocusRevision++
    if((changed||this.searchDirty)&&this.searchQuery)this.scheduleSearch()
    this.emit()
  }
  closeSearchDialog(restoreFocus=true){
    this.searchRestoreFocus=restoreFocus
    this.searchDialogOpen=false;clearTimeout(this.searchTimer)
    if(this.searching)this.cancelSearch()
    if(!this.replaceApplying)this.invalidateReplace()
    this.clearSearchPreview();this.persistSearchMetadata()
    void this.gateway.clearSearchPreview?.().catch(error=>{this.searchMessage='释放预览缓存失败：'+String(error);this.emit()})
    this.emit()
  }
  clearSearchPreview(){++this.previewEpoch;this.searchPreview=null;this.searchPreviewError='';this.searchPreviewLoading=false;this.selectedMatchId=''}
  private resetSearchContext(){
    clearTimeout(this.searchTimer);this.cancelSearch(false);this.invalidateReplace();this.clearSearchPreview()
    this.searchResults=[];this.searchTotal=0;this.selectedMatches=new Set();this.searchStatus='idle';this.searchMessage='';this.searchLimited=false;this.searchSkipped=0;this.searchDirty=true
    if(!this.roots.length)this.searchScope='opened'
    if(this.searchDialogOpen&&this.searchQuery)this.scheduleSearch()
  }
  scheduleSearch(delay=250){
    if(this.replaceApplying)return
    clearTimeout(this.searchTimer);this.cancelSearch(false);this.invalidateReplace();this.clearSearchPreview()
    this.searchResults=[];this.searchTotal=0;this.selectedMatches=new Set();this.searchStatus='idle';this.searchMessage='';this.searchDirty=true
    this.searchTimer=setTimeout(()=>{
      if(this.searchComposing)return
      if(this.documentManager.isComposing){this.scheduleSearch();return}
      void this.search(this.searchQuery)
    },delay);this.emit()
  }
  setSearchComposition(active:boolean){this.searchComposing=active;if(active)clearTimeout(this.searchTimer)}
  async chooseSearchDirectory(){
    if(!this.gateway.chooseSearchDirectory){this.searchMessage='当前环境不支持目录选择';this.emit();return}
    try{const directory=await this.gateway.chooseSearchDirectory();if(directory&&this.searchDialogOpen){this.searchDirectory=directory;this.searchScope='directory';this.scheduleSearch()}}
    catch(error){this.searchMessage='目录选择失败：'+String(error);this.emit()}
  }
  setSearchExpanded(expanded:boolean){for(const group of this.searchResults)group.isExpanded=expanded;this.emit()}
  toggleSearchSelection(match:SearchMatch){const id=searchMatchId(match);if(this.selectedMatches.has(id))this.selectedMatches.delete(id);else this.selectedMatches.add(id);this.emit()}
  private searchDocument(match:SearchMatch){return this.textSearchDocuments().find(doc=>doc.id===match.document_id||displayPathKey(doc.path||doc.id)===displayPathKey(match.path))}
  canRevealSearchMatch(match:SearchMatch){return !!this.rootForPath(match.path)||!!(this.gateway.revealOpenFile&&this.searchDocument(match)?.fileToken)}
  async revealSearchMatch(match:SearchMatch){
    try{
      if(this.rootForPath(match.path))await this.gateway.revealNode?.(match.path)
      else{const token=this.searchDocument(match)?.fileToken;if(!token||!this.gateway.revealOpenFile)throw Error('此结果没有可用的文件授权');await this.gateway.revealOpenFile(token)}
    }catch(error){this.searchPreviewError='无法在文件管理器中显示：'+String(error);this.emit()}
  }
  async selectSearchMatch(match:SearchMatch){
    if(!this.searchResults.some(group=>group.matches.some(item=>searchMatchId(item)===searchMatchId(match))))return
    const id=searchMatchId(match),epoch=++this.previewEpoch
    this.selectedMatchId=id;this.searchPreview=null;this.searchPreviewError='';this.searchPreviewLoading=true;this.emit()
    try{
      const doc=this.textSearchDocuments().find(doc=>doc.id===match.document_id||displayPathKey(doc.path)===displayPathKey(match.path))
      let preview:SearchSourcePreview
      if(doc){
        const state=this.documentManager.getState(doc.id)!,snapshot=this.searchSnapshots.get(doc.id)
        if(!snapshot||snapshot.text!==state.doc)throw Error('当前缓冲区与搜索时不一致，请重新搜索')
        const matches=this.searchResults.find(group=>group.path===match.path)?.matches||[match]
        preview=bufferPreview(state.doc,match,matches)
      }else{
        if(!this.gateway.previewSearch||!match.version)throw Error('当前环境无法提供有界文件预览，请重新搜索')
        preview=await this.gateway.previewSearch({path:match.path,version:match.version,line:match.line_number,column:match.column_number,length:match.match_length,query:{...this.makeSearchQuery(this.searchId),buffers:[]}})
      }
      if(epoch!==this.previewEpoch||this.disposed||!this.searchDialogOpen)return
      this.searchPreview=preview
    }catch(error){if(epoch===this.previewEpoch)this.searchPreviewError=String(error)}
    finally{if(epoch===this.previewEpoch){this.searchPreviewLoading=false;this.emit()}}
  }
  async previewSelectedMatches(){
    const matches=this.searchResults.flatMap(group=>group.matches).filter(match=>this.selectedMatches.has(searchMatchId(match)))
    if(matches.length)await this.previewReplace(undefined,undefined,matches)
  }

  invalidateReplace() {
    this.replaceEpoch++
    if (this.replaceSearchId) void this.gateway.cancelSearch(this.replaceSearchId).catch(() => {})
    this.replaceSearchId = ''
    this.replaceFiles = []
    this.replaceSkipped=[]
    this.replaceMessage = ''
    this.replaceSnapshots.clear()
    this.replaceQuery = null
    if (!this.replaceApplying) this.replaceBusy = false
    this.emit()
  }

  private makeSearchQuery(id: string, text = this.searchQuery): SearchQuery {
    return {
      search_id: id, query: text, is_case_sensitive: this.isCaseSensitive,
      is_whole_word: this.isWholeWord, is_regex: this.isRegex, max_results: 1000,
      scope:this.searchScope,include_globs:globPatterns(this.searchInclude),exclude_globs:globPatterns(this.searchExclude),
      include_ignored: this.searchIncludeIgnored, directory: this.searchScope==='directory'?this.searchDirectory || null:null,
      buffers: this.textSearchDocuments().filter(doc => this.searchScope==='opened'||this.roots.some(root => this.isWithin(doc.path, root.rootPath)))
        .filter(doc => this.searchScope!=='directory'||!this.searchDirectory || this.isWithin(doc.path, this.searchDirectory))
        .map(doc => ({ path: doc.path||doc.id, document_id:doc.id,relative_path:this.searchRelativePath(doc.path,doc.name),read_only:doc.readOnly,text: this.documentManager.getText(doc.id) ?? '', encoding: doc.encoding })),
    }
  }

  async previewReplace(path?: string, match?: SearchMatch, selection?:SearchMatch[]) {
    if (this.replaceApplying || !this.searchQuery || this.searching || this.documentManager.isComposing) return
    if (!this.gateway.previewReplace) { this.notify('当前环境不支持工作区替换预览。'); return }
    if(!path&&!selection&&this.searchStatus!=='complete'&&this.searchStatus!=='empty'){this.replaceMessage='搜索结果不完整；请缩小范围，或明确选择文件/匹配后核对替换预览';this.emit();return}
    this.invalidateReplace()
    this.rememberSearch(true)
    const epoch = this.replaceEpoch
    const query = this.makeSearchQuery(`replace-${Date.now()}-${++this.searchSequence}`)
    const replacement = this.replacementText
    const snapshots:typeof this.replaceSnapshots = new Map()
    for (const doc of this.documentManager.openedDocuments) {
      const state = this.documentManager.getState(doc.id)
      if (state) snapshots.set(displayPathKey(doc.path||doc.id), { id: doc.id, token: doc.fileToken,version:doc.lastDiskVersion, text: markRaw(state.doc) })
    }
    this.replaceBusy = true; this.replaceSearchId = query.search_id; this.replaceMessage = '正在生成替换预览…'; this.emit()
    try {
      const preview = await this.gateway.previewReplace(query, replacement, path ? [path] : selection?[...new Set(selection.map(item=>item.path))]:[])
      if (epoch !== this.replaceEpoch || this.disposed) return
      this.replaceQuery = query; this.previewReplacement = replacement; this.replaceSnapshots = snapshots
      this.replaceSkipped=preview.skipped.map(reason=>'跳过：'+reason)
      this.replaceFiles = preview.canceled ? [] : preview.files.map(file => ({ ...file, expanded: true, status: '',
        selected: new Set(file.edits.flatMap((edit, index) => selection?selection.some(item=>item.path===file.path&&item.line_number===edit.line&&item.column_number===edit.column)?[index]:[]:!match || (edit.line === match.line_number && edit.column === match.column_number) ? [index] : [])),
      }))
      const total = this.replaceFiles.reduce((sum, file) => sum + file.edits.length, 0)
      this.replaceMessage = `${this.replaceFiles.length} 个文件，${total} 处匹配${preview.limited ? '；达到预览预算（最多 1000 处/32 MiB/10 秒），仅预览当前有界结果，请缩小范围' : ''}${preview.canceled ? '；已取消' : ''}${preview.skipped.length ? `；跳过 ${preview.skipped.length} 项：${preview.skipped.join('；')}` : ''}`
    } catch (error) { if (epoch === this.replaceEpoch) this.replaceMessage = `预览失败：${String(error)}` }
    finally { if (epoch === this.replaceEpoch) { this.replaceBusy = false; this.replaceSearchId = ''; this.emit() } }
  }

  selectReplacements(selected: boolean, path?: string) {
    if (this.replaceBusy) return
    for (const file of this.replaceFiles) if (!path || file.path === path) file.selected = new Set(selected ? file.edits.map((_, index) => index) : [])
    this.emit()
  }
  toggleReplacement(file: typeof this.replaceFiles[number], index: number) {
    if (this.replaceBusy) return
    if (file.selected.has(index)) file.selected.delete(index); else file.selected.add(index)
    this.emit()
  }
  cancelReplace() {
    this.replaceCancel = true
    if (!this.replaceApplying) { this.invalidateReplace(); this.replaceMessage = '预览已取消'; this.emit() }
    else { this.replaceMessage = '正在取消：当前文件完成后停止后续文件'; this.emit() }
  }

  async applyReplacements() {
    const query = this.replaceQuery
    if (!query || this.replaceBusy || !this.gateway.applyReplace || this.operationBusy || this.fileController.activeOperationCount || this.documentManager.isComposing) return
    // Inputs must still describe exactly the preview presented to the user.
    const current = this.makeSearchQuery(query.search_id)
    if (this.previewReplacement !== this.replacementText || ['query','scope','directory','is_regex','is_whole_word','is_case_sensitive','include_ignored','include_globs','exclude_globs'].some(key => JSON.stringify(current[key as keyof SearchQuery]) !== JSON.stringify(query[key as keyof SearchQuery]))) {
      this.invalidateReplace(); this.replaceMessage = '搜索或替换条件已变化，请重新预览'; return
    }
    const files = this.replaceFiles.filter(file => file.selected.size && !file.status)
    if (!files.length) return
    this.replaceBusy = true; this.replaceApplying = true; this.replaceCancel = false; this.replaceProgress = 0
    this.operationBusy = true; this.fileController.workspaceBusy = true
    let success = 0, failure = 0, canceled = 0
    this.emit()
    try {
      for (const file of files) {
        if (this.replaceCancel || this.disposed) { file.status = '已取消（未执行）'; canceled++; continue }
        const selected = [...file.selected].sort((a,b) => a-b)
        try {
          const doc = this.documentManager.openedDocuments.find(doc => doc.id===file.document_id||displayPathKey(doc.path||doc.id) === displayPathKey(file.path))
          if (file.buffer) {
            const snapshot = this.replaceSnapshots.get(displayPathKey(file.path))
            if (!snapshot || doc?.id !== snapshot.id || doc.fileToken !== snapshot.token || this.fileController.external.blocked(doc.id) || this.fileController.saving.has(doc.id)) throw new Error('打开文档的身份或状态已变化，请重新预览')
            // Revalidate current workspace authorization/ignore rules and disk version.
            if(doc.fileToken&&snapshot.version){
              if(!this.fileController.gateway.checkExternal)throw Error('缺少打开文件版本校验')
              if(await this.fileController.gateway.checkExternal(doc.fileToken)!==snapshot.version)throw Error('磁盘文件发生外部变化，请先处理冲突再重新预览')
            }
            if(query.scope!=='opened'){
              if (!this.gateway.validateReplace) throw new Error('缺少替换授权校验')
              await this.gateway.validateReplace(file.path, file.version, query)
            }
            if (this.replaceCancel || this.disposed) { file.status = '已取消（未执行）'; canceled++; continue }
            const current = this.documentManager.metadata(doc.id)
            if (!current || current.fileToken !== snapshot.token || displayPathKey(current.path||current.id) !== displayPathKey(file.path)) throw new Error('验证期间文档身份已变化，请重新预览')
            if (!this.documentManager.applyWorkspaceReplacement(doc.id, snapshot.text, selected.map(index => file.edits[index]))) throw new Error('编辑缓冲区已变化或正在输入，请重新预览')
            file.status = `已修改缓冲区 ${selected.length} 处（可撤销，待保存）`
          } else {
            if (doc) throw new Error('文件已打开，请重新预览后通过编辑器事务替换')
            await this.gateway.applyReplace({ query: { ...query, buffers: [] }, replacement: this.previewReplacement, path: file.path, version: file.version, selected })
            file.status = `已保存 ${selected.length} 处`
          }
          success++
        } catch (error) { file.status = `失败：${String(error)}`; failure++ }
        this.replaceProgress++; this.emit()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      this.replaceMessage = `完成：成功 ${success} 个文件，失败 ${failure} 个，取消 ${canceled} 个。打开文件待保存；关闭文件已分别保存。`
      this.replacementReport=[...files.map(file=>`${this.searchRelativePath(file.path,file.path)}：${file.status}`),...this.replaceSkipped]
    } finally {
      this.replaceBusy = false; this.replaceApplying = false; this.operationBusy = false; this.fileController.workspaceBusy = false
      this.replaceQuery = null; this.replaceSnapshots.clear(); this.emit()
      if(!this.searchDialogOpen)this.replaceFiles=[]
      // Keep the per-file report while refreshing search, including modified buffers.
      if (!this.disposed&&this.searchDialogOpen) await this.search(this.searchQuery, true)
      else this.searchDirty=true
    }
  }

  async search(queryText:string,keepReplaceReport=false){
    if(this.replaceApplying)return
    clearTimeout(this.searchTimer)
    if(!keepReplaceReport)this.invalidateReplace()
    this.cancelSearch(false);this.clearSearchPreview();this.searchResults=[];this.searchTotal=0;this.selectedMatches=new Set();this.searchLimited=false;this.searchSkipped=0;this.searchMessage=''
    this.searchQuery=queryText;this.searchDirty=false
    if(!queryText){this.searchId='';this.searchStatus='idle';this.emit();return}
    this.connectSearch()
    if(this.searchScope!=='opened'&&!this.roots.length){this.searchStatus='error';this.searchMessage='未打开工作区；请选择已打开文件范围或打开文件夹';this.emit();return}
    this.searchId='search-'+Date.now()+'-'+(++this.searchSequence);const id=this.searchId
    this.searchSnapshots=new Map(this.textSearchDocuments().map(doc=>[doc.id,{id:doc.id,text:markRaw(this.documentManager.getState(doc.id)!.doc)}]))
    this.searching=true;this.searchStatus='searching';this.rememberSearch();this.emit()
    try{await this.gateway.searchWorkspace(this.makeSearchQuery(id))}
    catch(error){if(id!==this.searchId||this.disposed||!this.searching)return;this.flushSearchBatch();this.searching=false;this.searchStatus='error';this.searchMessage='搜索失败：'+String(error);this.emit()}
  }
  cancelSearch(markCanceled=true){
    clearTimeout(this.searchTimer)
    if(this.searching&&this.searchId){
      const id=this.searchId;this.flushSearchBatch();this.searching=false
      if(markCanceled){this.searchStatus='canceled';this.searchMessage='搜索已取消；当前结果不完整'}
      void this.gateway.cancelSearch(id).catch(error=>{this.searchMessage='取消请求失败：'+String(error);this.emit()})
    }
    clearTimeout(this.batchTimer);this.pendingBatch=[];this.emit()
  }
  private onSearchBatch(batch:SearchMatch[]){
    if(this.disposed||!this.searching)return
    this.pendingBatch.push(...batch.filter(match=>match.search_id===this.searchId).slice(0,Math.max(0,1000-this.searchTotal-this.pendingBatch.length)))
    if(!this.batchTimer)this.batchTimer=setTimeout(()=>{this.batchTimer=undefined;this.flushSearchBatch()},50)
  }
  private flushSearchBatch(){
    clearTimeout(this.batchTimer);this.batchTimer=undefined
    const incoming=this.pendingBatch;this.pendingBatch=[]
    if(!incoming.length)return
    const groups=new Map(this.searchResults.map(group=>[displayPathKey(group.path),group]))
    for(const item of incoming){
      if(item.search_id!==this.searchId)continue
      const key=displayPathKey(item.path);let group=groups.get(key)
      if(!group){group={path:item.path,relativePath:item.relative_path,matches:[],isExpanded:true};groups.set(key,group);this.searchResults.push(group)}
      if(!group.matches.some(match=>searchMatchId(match)===searchMatchId(item))){group.matches.push(item);this.searchTotal++}
    }
    this.emit()
  }
  private onSearchDone(payload:SearchDonePayload){
    if(payload.search_id!==this.searchId||!this.searching||this.disposed)return
    this.flushSearchBatch();this.searching=false;this.searchLimited=!!payload.limited||payload.total>=1000;this.searchSkipped=payload.skipped||0
    this.searchStatus=payload.error?'error':payload.canceled?'canceled':this.searchLimited?'limited':this.searchSkipped?'partial':this.searchTotal?'complete':'empty'
    this.searchMessage=payload.error||payload.reason||(payload.canceled?'搜索已取消；当前结果不完整':this.searchLimited?'结果达到上限，请缩小范围':this.searchSkipped?'部分文件因大小、二进制、权限或解码限制被跳过':'')
    this.emit()
  }
  async locateMatch(match:SearchMatch,mode:'preview'|'pinned'|'split'='pinned'){
    const pane=this.documentManager.activePane
    try{
      await this.selectSearchMatch(match)
      if(this.searchPreviewError||this.selectedMatchId!==searchMatchId(match))return
      const existing=this.textSearchDocuments().find(doc=>doc.id===match.document_id||displayPathKey(doc.path||doc.id)===displayPathKey(match.path))
      if(existing){
        this.documentManager.open(existing.id,mode==='preview',pane)
        if(mode!=='preview')this.documentManager.pin(existing.id,pane)
        if(mode==='split')this.documentManager.splitPane('right',pane,existing.id)
      }else{
        await this.openWorkspaceFileInPane({path:match.path,paneId:pane,pin:mode!=='preview',zone:mode==='split'?'right':'center'})
      }
      const document=this.documentManager.activeDocument
      if(!document||this.documentManager.isComposing)return
      if(!match.document_id&&match.version&&document.lastDiskVersion!==match.version)throw Error('打开时文件版本已变化，请重新搜索')
      this.documentManager.revealPosition(document.id,match.line_number,match.column_number)
      if(!this.searchWindow.pinned)this.closeSearchDialog(false)
    }catch(error){this.searchPreviewError='打开匹配失败：'+String(error);this.emit()}
  }

  // 获取工作区所有已知的文件列表（供 Quick Open 快速打开）
  getAllKnownFiles(): { name: string; path: string; relativePath: string }[] {
    // A refreshed index is authoritative; cached, collapsed tree descendants
    // can still describe files deleted outside the app.
    if (this.fileIndexComplete) return this.workspaceFiles
    const files: { name: string; path: string; relativePath: string }[] = [...this.workspaceFiles]
    const traverse = (nodes: WorkspaceNode[], prefix: string) => {
      for (const node of nodes) {
        if (!node.isDirectory) {
          files.push({
            name: node.name,
            path: node.path,
            relativePath: prefix + node.relativePath,
          })
        } else if (node.children) {
          traverse(node.children, prefix)
        }
      }
    }
    for (const root of this.roots) traverse(root.entries, this.roots.length > 1 ? `${root.name}/` : '')
    files.push(...this.quickFiles)
    return [...new Map(files.map(file => [displayPathKey(file.path), file])).values()]
  }

  /**
   * Load the bounded workspace file index once per workspace. Quick Open then
   * scores this array synchronously; it never walks the filesystem per keystroke.
   */
  async ensureFileIndex(): Promise<void> {
    if (!this.rootPath || this.disposed) return
    if (this.fileIndexRevision === this.openRevision) return
    if (this.fileIndexPromise) return this.fileIndexPromise
    const epoch = ++this.fileIndexEpoch
    const revision = this.openRevision
    this.fileIndexLoading = true
    this.emit()
    let timer: ReturnType<typeof setTimeout> | undefined
    const request = (async () => {
      try {
        const files = await Promise.race([
          this.gateway.findFiles('', this.showIgnored, 50_000),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('索引超过 12 秒限制')), 12_000)
          }),
        ])
        if (this.disposed || epoch !== this.fileIndexEpoch || revision !== this.openRevision) return
        this.workspaceFiles = files
        this.fileIndexComplete = true
        this.fileIndexRevision = revision
      } catch (error) {
        if (!this.disposed && epoch === this.fileIndexEpoch && revision === this.openRevision) {
          // Retry only after an explicit invalidation, not on every palette open.
          this.fileIndexRevision = revision
          this.notify(`工作区文件索引失败：${error}`)
        }
      } finally {
        clearTimeout(timer)
        if (!this.disposed && epoch === this.fileIndexEpoch) {
          this.fileIndexLoading = false
          this.fileIndexPromise = null
          this.emit()
        }
      }
    })()
    this.fileIndexPromise = request
    return request
  }

  invalidateFileIndex(clear = true) {
    this.fileIndexEpoch++
    this.fileIndexRevision = -1
    this.fileIndexComplete = false
    if (clear) this.workspaceFiles = []
    this.fileIndexLoading = false
    this.fileIndexPromise = null
  }

  /** Compatibility entry: Quick Open now consumes the cached index. */
  async quickOpen(_query: string) {
    await this.ensureFileIndex()
  }

  async toggleIgnored() {
    if (!this.rootPath) return
    try {
      const next = !this.showIgnored
      this.entries = await this.gateway.setShowIgnored(next)
      this.showIgnored = next
      await this.refreshDirectory()
      this.quickGeneration++; this.quickFiles = []; this.invalidateFileIndex(); this.cancelSearch(); this.emit()
    } catch (error) { this.notify(String(error)) }
  }

  destroy() {
    this.stopSearchDocuments?.();clearTimeout(this.searchTimer);clearTimeout(this.batchTimer);this.clearSearchPreview()
    void this.gateway.clearSearchPreview?.().catch(error=>{this.searchMessage='释放预览失败：'+String(error)})
    this.cancelReplace()
    this.cancelOpens()
    this.cancelExpand();this.revealSequence++
    this.disposed = true
    this.quickGeneration++
    this.invalidateFileIndex()
    this.cancelSearch()
    if (this.searchBatchUnsub) this.searchBatchUnsub()
    if (this.searchDoneUnsub) this.searchDoneUnsub()
    this.listeners.clear()
    this.openListeners.clear()
  }
}
