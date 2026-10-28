import { ref, computed, watch, onMounted, onUnmounted, markRaw, reactive, nextTick } from 'vue'
import { isTauri, invoke } from '@tauri-apps/api/core'
import { DesktopStartup } from './desktopStartup'
import { DocumentManager } from '../editor/core/DocumentManager'
import { sampleDocuments } from '../features/tabs/sampleDocuments'
import type { LanguageName } from '../editor/languages'
import { getOutlineCapability } from '../editor/outline/outlineService'
import type { AppMode, SidebarPanel, MarkdownMode } from '../types'
import type CommandPalette from '../components/modals/CommandPalette.vue'
import type SettingsModal from '../components/modals/SettingsModal.vue'
import type DiscardDialog from '../components/modals/DiscardDialog.vue'
import type Toast from '../components/common/Toast.vue'
import type UpdateConfirm from '../components/modals/UpdateConfirm.vue'
import type HistoryDialog from '../components/layout/HistoryDialog.vue'
import { migrateLegacyHistory } from '../features/history/historyService'
import { relativeMarkdownLink } from '../editor/markdown/links'
import { FileController, fileError } from '../features/files/FileController'
import { openDroppedDirectories, type NativeDropInput } from '../features/files/nativeDrop'
import { sameFilePath } from '../features/files/pathKey'
import { isMedia } from '../features/files/media'
import { AutoSaveController } from '../features/files/AutoSaveController'
import {
  cancelDetach,
  commitDetach,
  detachDocumentToWindow,
  listenDetachCommitted,
  setDetachRequestHandler,
  takeDetachedDocument,
  receiveDetachCommitted,receiveDetachCanceled,setHandoffBusyHandler,disposeHandoffs,
} from '../features/windows/tabDetach'
import { resolvePaneDropZone,tabDragService,type TabDragResult } from '../editor/layout/TabDragService'
import type { SplitDirection } from '../editor/layout/types'
import type { EditorDocument } from '../types'
import { RecoveryController } from '../features/recovery/RecoveryController'
import { tauriRecovery } from '../features/recovery/tauriRecovery'
import { tauriFiles } from '../features/files/tauriFiles'
import type { Encoding, FileOpenEncoding, Preferences } from '../features/files/contracts'
import { WorkspaceController } from '../features/workspace/WorkspaceController'
import { tauriWorkspace } from '../features/workspace/tauriWorkspace'
import { relativeFilePath } from '../features/shell/editorSettings'
import { readablePath } from '../features/shell/pathDisplay'
import { textClipboard } from '../features/shell/clipboard'
import { EditorView } from '@codemirror/view'
import { WindowCloseGuard, type CloseSource } from '../features/shell/WindowCloseGuard'
import { EmptyDetachedWindow } from '../features/shell/EmptyDetachedWindow'
import { initializeLaunch, sessionInput, SessionWriter, restoreEditorLayout } from '../features/shell/launchSession'
import { ImageImporter, imageGateway, clipboardImages, isImageFile, imageRuleKey, type ImageSource, type NativeImageInput } from '../editor/markdown/imageImport'
import { UpdateManager, updateState, openProjectPage } from '../features/shell/AppUpdater'
import { prepareInstallation } from '../features/shell/updater/prepareInstallation'
import { ExportController, ImportController } from '../features/document-conversion'
import { useShellPreferences } from './useShellPreferences'
import { useShellCommands } from './useShellCommands'
import { computeWindowCloseStatus, computeUpdateReportStatus, computeUpdatePrepareBusy } from './shellStatus'

export function useAppShell() {
  const desktop = isTauri()
  const demo = !desktop && new URLSearchParams(location.search).get('demo') === '1'

  // --- Core Layout & Navigation State ---
  const appMode = ref<AppMode>(demo ? 'workspace' : 'single')
  const sidebarVisible = ref(demo)
  const sidebarWidth = ref(254)
  const sidebarPanel = ref<SidebarPanel>('files')
  const focusMode = ref(false)
  const savedSidebarVisible = ref<boolean | null>(null)

  // --- Modal & Tool Component Refs ---
  const paletteRef = ref<InstanceType<typeof CommandPalette> | null>(null)
  const settingsRef = ref<InstanceType<typeof SettingsModal> | null>(null)
  const updateConfirmRef = ref<InstanceType<typeof UpdateConfirm> | null>(null)
  const discardRef = ref<InstanceType<typeof DiscardDialog> | null>(null)
  const toastRef = ref<InstanceType<typeof Toast> | null>(null)
  const gotoLineRef = ref<{ open: () => void; close: () => void; visible: boolean } | null>(null)

  // Saved-version history for the active file. Bodies stay in the native store;
  // this dialog only holds the version the user is looking at.
  const historyRef = ref<InstanceType<typeof HistoryDialog> | null>(null)
  const historyOpen = ref(false)
  const historyPath = ref('')
  const historyDocumentId = ref<string | null>(null)
  const historyContent = ref('')

  function openHistory() {
    const doc = manager.activeDocument
    if (!doc?.path) {
      toast('当前文件尚未保存，无法查看历史版本。')
      return
    }
    historyPath.value = doc.path
    historyDocumentId.value = doc.id
    historyContent.value = manager.getText(doc.id) ?? ''
    historyOpen.value = true
  }

  function toast(message: string) {
    toastRef.value?.show(message)
  }

  // --- Core Services & Controllers ---
  const manager = markRaw(new DocumentManager(demo ? sampleDocuments : []))
  const files = markRaw(new FileController(manager, tauriFiles, toast))
  const recovery = markRaw(new RecoveryController(manager, files, tauriRecovery, toast))
  files.setSavedHandler(id => recovery.onSaved(id))
  files.external.setRecoveryCheckpoint(id => recovery.checkpointBeforeReload(id))
  const exportController = new ExportController(manager, msg => toast(msg))
  const importController = new ImportController(manager, msg => toast(msg))
  const workspace = reactive(new WorkspaceController(tauriWorkspace, manager, files, toast, false)) as unknown as WorkspaceController
  workspace.connect()

  const recentFiles = ref<Preferences['recent']>([])
  const fileBusy = ref(false)
  const updateInstalling = ref(false)

  const autoSaver = new AutoSaveController(
    manager,
    files,
    () =>
      startupLoading.value ||
      updateInstalling.value ||
      fileBusy.value ||
      !!discardRef.value?.visible ||
      !!settingsRef.value?.visible ||
      !!document.querySelector('.workspace-operation-dialog'),
  )

  const revision = ref(0)
  const unsubscribe = manager.subscribe(() => revision.value++)
  function onWorkspaceOpenedSuccess() {
    preserveFocusLayout(() => {
      if (focusMode.value) {
        focusMode.value = false
        savedSidebarVisible.value = null
      }
      wasNarrow = window.innerWidth < 900
      appMode.value = 'workspace'
      sidebarPanel.value = 'files'
      sidebarVisible.value = true
    })
    if (paletteRef.value?.visible) paletteRef.value.close()
  }
  const unsubscribeWorkspaceOpened = workspace.onOpened?.(onWorkspaceOpenedSuccess)
  const unsubscribeWorkspace = workspace.subscribe(() => {
    revision.value++
  })

  if (demo) {
    for (const id of ['rust-doc', 'ts-doc', 'json-doc', 'readme-doc']) {
      manager.open(id, sampleDocuments.find(doc => doc.id === id)?.pinned === false)
    }
    manager.select('rust-doc')
  }

  const openedDocuments = computed(() => { revision.value; return manager.openedDocuments })
  const mainOpenedDocuments = computed(() => { revision.value; return manager.mainOpenedDocuments })
  const mainActiveId = computed(() => { revision.value; return manager.group.activeId })
  const activeDoc = computed(() => { revision.value; return manager.activeDocument })
  const activeDocId = computed(() => { revision.value; return manager.activeId })

  let alive = true
  const isAlive = () => alive

  // --- Preferences Coordinator ---
  const preferences = useShellPreferences({
    desktop,
    isAlive,
    toast,
    manager,
    workspace,
    autoSaver,
    revision,
    getActiveDoc: () => activeDoc.value,
  })
  // Only a rendered workspace content panel occupies the left dock. The rail
  // and the outline itself never feed back into sidebar preferences.
  const leftSidebarOccupied = computed(() => !focusMode.value && appMode.value === 'workspace' && sidebarVisible.value && (sidebarPanel.value === 'files' || sidebarPanel.value === 'search'))
  const effectiveOutlinePosition = computed(() => leftSidebarOccupied.value ? 'right' as const : 'left' as const)
  const outlineCapability = computed(() => getOutlineCapability(activeDoc.value))
  const outlineSupported = computed(() => outlineCapability.value !== 'unsupported')
  const outlineVisible = computed(() => preferences.showOutline.value && outlineSupported.value && !focusMode.value)
  function toggleOutline() {
    if(!outlineSupported.value){toast('当前文件不支持大纲');return}
    preferences.showOutline.value=!preferences.showOutline.value
  }

  watch([preferences.externalFileMonitoring, preferences.autoReloadExternal, preferences.settingsReady], () => {
    files.external.configure(desktop && preferences.settingsReady.value && preferences.externalFileMonitoring.value, preferences.autoReloadExternal.value)
  }, { immediate: true })

  // --- Image Import Controller ---
  const imageImporter = new ImageImporter(
    manager,
    imageGateway,
    async id => {
      toast('请先保存 Markdown 文档，再导入图片。')
      return files.save(id)
    },
    id => {
      const path = manager.metadata(id)?.path
      return (path && preferences.documentImageRules.value[imageRuleKey(path)]) || preferences.imageRules.value
    },
  )

  async function importImages(id: string, sources: ImageSource[]) {
    if (!desktop || fileBusy.value || files.workspaceBusy || files.activeOperationCount || manager.isComposing || discardRef.value?.visible || settingsRef.value?.visible) {
      await imageGateway.release(sources.filter((s): s is NativeImageInput => 'token' in s).map(s => s.token)).catch(() => {})
      toast('请先完成当前文件操作，再导入图片。')
      return
    }
    fileBusy.value = true
    try {
      await imageImporter.insert(id, sources)
    } catch (error) {
      toast(fileError(error))
    } finally {
      fileBusy.value = false
      await refreshRecent()
      void drainPending()
    }
  }

  async function chooseImages() {
    const doc = manager.activeDocument
    if (!desktop || !doc?.mode || fileBusy.value || manager.isComposing) return
    manager.pin(doc.id)
    fileBusy.value = true
    try {
      await imageImporter.insert(doc.id, () => invoke<NativeImageInput[]>('choose_markdown_images'))
    } catch (error) {
      toast(fileError(error))
    } finally {
      fileBusy.value = false
      await refreshRecent()
      void drainPending()
    }
  }

  const startupLoading = ref(desktop)
  const startupError = ref('')

  // --- File Links, Paste & Drag/Drop ---
  async function openRelativeLink(event: Event) {
    const detail = (event as CustomEvent<{ id: string; href: string; pane?: string }>).detail
    const doc = detail && manager.metadata(detail.id)
    if (!desktop || !doc?.fileToken || fileBusy.value || manager.isComposing) return
    const target = relativeMarkdownLink(doc.path, detail.href)
    if (!target) {
      toast('链接路径无效，未打开文件。')
      return
    }
    fileBusy.value = true
    try {
      const file = await tauriWorkspace.openWorkspaceFile(target.path)
      if (!files.accept(file, false, detail.pane ?? manager.activePane)) return
      const id = manager.openedDocuments.find(item => sameFilePath(item.path, file.path))?.id
      if (id && target.anchor) {
        const source = manager.getText(id) || ''
        const lines = source.split('\n')
        const line = lines.findIndex(
          text => text.replace(/^#{1,6}\s+/, '').trim().toLowerCase().replace(/\s+/g, '-') === target.anchor,
        )
        if (line >= 0) manager.revealPosition(id, line + 1, 1)
      }
    } catch (error) {
      toast(`无法打开相对链接：${fileError(error)}。请将目标加入授权工作区。`)
    } finally {
      fileBusy.value = false
    }
  }

  function imagePaste(event: ClipboardEvent) {
    const target = event.target instanceof Element ? event.target : null
    const view = target?.closest('.cm-editor') ? EditorView.findFromDOM(target.closest('.cm-editor')!) : null
    const doc = manager.activeDocument
    if (!doc?.mode || (!view && !target?.closest('.md-prose')) || !desktop) return
    const images = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/') || isImageFile(file.name))
    if (!images.length) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void importImages(doc.id, images)
  }

  async function nativeFileDrop(payload: { inputs: NativeDropInput[]; x: number; y: number }) {
    const tokens = payload.inputs.map(input => input.token)
    try {
      if (startupLoading.value) return
      let inputs = payload.inputs
      if (inputs.some(input => input.isDirectory)) {
        if (fileBusy.value || files.workspaceBusy || files.activeOperationCount || manager.isComposing || discardRef.value?.visible || settingsRef.value?.visible) {
          toast('请完成当前操作后重新拖入文件夹。')
          return
        }
        fileBusy.value = true
        try {
          inputs = await openDroppedDirectories(inputs, token => workspace.openDroppedWorkspace(token))
        } finally {
          fileBusy.value = false
        }
      }
      if (!inputs.length) return
      const target = document.elementFromPoint(payload.x, payload.y)
      const pane = target?.closest<HTMLElement>('[data-pane-id],.pane')
      const inEditor = !!target?.closest('.pane-body')
      if (pane) {
        manager.focusPane(
          (pane.dataset.paneId ||
            [...pane.classList].find(name => name.startsWith('pane-'))?.slice(5) ||
            (pane.classList.contains('secondary-pane') ? 'secondary' : 'main')) as Parameters<DocumentManager['focusPane']>[0],
          false,
        )
      }
      const doc = manager.activeDocument
      const images = inputs.filter(file => isImageFile(file.name))
      if (inEditor && doc?.mode && images.length) {
        const ignored = inputs.filter(file => !isImageFile(file.name))
        await imageGateway.release(ignored.map(s => s.token))
        if (ignored.length) toast('已忽略非图片文件；请拖到编辑区外打开。')
        const view = target?.closest('.cm-editor') ? EditorView.findFromDOM(target.closest('.cm-editor')!) : null
        const position = view?.posAtCoords({ x: payload.x, y: payload.y })
        if (position != null && !manager.isComposing) view?.dispatch({ selection: { anchor: position } })
        await importImages(doc.id, images)
      } else {
        if (fileBusy.value || manager.isComposing || discardRef.value?.visible) {
          toast('请完成当前操作后重新拖入文件。')
          return
        }
        fileBusy.value = true
        try {
          files.acceptBatch(await invoke('open_dropped_files', { tokens: inputs.map(s => s.token) }))
        } finally {
          fileBusy.value = false
          void refreshRecent()
        }
      }
    } finally {
      await imageGateway.release(tokens).catch(error => toast(fileError(error)))
    }
  }

  // --- Window Closing, Save Queue & Lifecycle State ---
  let pendingClose: { kind: 'document'; id: string; pane: string } | { kind: 'window' } | { kind: 'reopen'; id: string; encoding: FileOpenEncoding } | null = null
  let tabCloseQueue: { id: string; pane: string }[] = []
  let layoutTimer: ReturnType<typeof setTimeout> | undefined
  let preferencesReady = false
  let pendingDrain = false
  let draining = false
  let sessionWriter: SessionWriter | undefined
  let launchReady = false

  // --- Update Manager ---
  const updateStatus = reactive(updateState())
  const updatePanelOpen = ref(false)
  const updateManager = markRaw(
    new UpdateManager(updateStatus, {
      check: async () => {
        if (!desktop) throw Error('应用更新需要 Tauri 桌面版')
        const { check } = await import('@tauri-apps/plugin-updater')
        return check({ timeout: 15000 })
      },
      prepare: prepareUpdate,
      finishPreparation: () => {
        updateInstalling.value = false
      },
      acquire: async () => {
        if (import.meta.env.DEV) throw Error('开发模式不执行安装，请使用已安装的正式版。')
        await validateUpdateWindows()
        await invoke('begin_update_install')
      },
      release: () => invoke('end_update_install'),
      markPending: async version => {
        await invoke('mark_update_pending', { targetVersion: version })
        await invoke('ensure_update_window')
        if (manager.hasDirtyDocuments || manager.isComposing || fileBusy.value || files.workspaceBusy || files.activeOperationCount) {
          throw Error('编辑状态已变化，停止安装。')
        }
      },
      clearPending: () => invoke('clear_update_pending'),
      relaunch: async () => {
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      },
      notify: toast,
    }),
  )

  async function openUpdatePanel() {
    updatePanelOpen.value = true
    if (['idle', 'error'].includes(updateStatus.phase)) await updateManager.checkForUpdates()
  }

  async function openUpdateRelease() {
    try {
      await openProjectPage(desktop, true, updateStatus.version || updateStatus.confirmedVersion || undefined)
    } catch (error) {
      updateStatus.error = `无法打开更新日志：${fileError(error)}`
      toast(updateStatus.error)
    }
  }

  async function openUpdateLink(url: string) {
    try {
      if (desktop) await invoke('open_external_link', { url })
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      updateStatus.error = fileError(error)
    }
  }

  let reportTimer: ReturnType<typeof setTimeout> | undefined
  let lastWindowReport = ''
  function reportUpdateWindow() {
    if (!desktop || !alive || reportTimer) return
    reportTimer = setTimeout(() => {
      reportTimer = undefined
      const status = computeUpdateReportStatus({
        dirtyCount: manager.openedDocuments.filter(doc => doc.dirty).length,
        fileBusy: fileBusy.value,
        workspaceBusy: files.workspaceBusy,
        savingCount: files.activeOperationCount,
        composing: manager.isComposing,
        ready: launchReady,
      })
      const signature = JSON.stringify(status)
      if (signature === lastWindowReport) return
      lastWindowReport = signature
      void invoke('report_update_window', { status }).catch(() => {
        lastWindowReport = ''
      })
    }, 150)
  }

  watch([revision, fileBusy, updateInstalling, startupLoading], reportUpdateWindow)
  // The palette's file pool is intentionally assembled only while it is open.
  // Recompute the command/file projection when visibility changes so the first
  // Ctrl+P already sees the workspace index instead of an empty file list.
  watch(() => paletteRef.value?.visible, () => { revision.value++ })
  watch(
    [preferences.autoCheckUpdates, preferences.autoDownloadUpdates, startupLoading],
    () =>
      updateManager.configure(
        { autoCheckUpdates: preferences.autoCheckUpdates.value, autoDownloadUpdates: preferences.autoDownloadUpdates.value },
        !startupLoading.value,
      ),
    { immediate: true },
  )

  // --- Window Close Guard ---
  async function destroyNativeWindow(){
    if(!alive)return
    const win=(await import('@tauri-apps/api/window')).getCurrentWindow()
    startup.exit();window.dispatchEvent(new CustomEvent('markumo:dispose-window'));await win.destroy()
  }
  const windowClose = new WindowCloseGuard({
    status: () =>
      computeWindowCloseStatus({
        fileBusy: fileBusy.value,
        workspaceBusy: files.workspaceBusy,
        updateInstalling: updateInstalling.value,
        updateConfirmVisible: Boolean(updateConfirmRef.value?.visible),
        savingCount: files.activeOperationCount,
        composing: manager.isComposing,
        dirtyCount: manager.openedDocuments.filter(doc => doc.dirty).length,
        documentCount: manager.openedDocuments.length,
        activePane: manager.activePane,
        activeId: manager.activeId,
      }),
    flush: async () => {
      await flushCloseState()
    },
    confirmDirty: () => {
      if (pendingClose?.kind === 'window' && discardRef.value?.visible) return
      pendingClose = { kind: 'window' }
      paletteRef.value?.close()
      settingsRef.value?.close()
      discardRef.value?.open('当前窗口中的文档')
    },
    destroy: async () => {
      await destroyNativeWindow()
    },
    blocked: reason => toast(reason === 'composing' ? '请先完成当前输入法输入，再关闭窗口。' : '请等待当前文件操作完成后再关闭。'),
    failed: () => toast('关闭窗口失败，编辑内容仍保留在当前窗口。'),
    diagnose: data => console.info('[Markumo close]', data),
  })

  let wasNarrow = window.innerWidth < 900
  function adaptWindowWidth() {
    const narrow = window.innerWidth < 900
    if (narrow && !wasNarrow) sidebarVisible.value = false
    wasNarrow = narrow
  }

  // --- File Operations ---
  async function refreshRecent() {
    if (!desktop || !alive || updateInstalling.value) return
    try {
      const prefs = await tauriFiles.preferences()
      if (alive) recentFiles.value = prefs.recent
    } catch (error) {
      toast(fileError(error))
    }
  }

  async function openFile(encoding?: FileOpenEncoding) {
    if (startupLoading.value) return
    if (!desktop) {
      toast('浏览器仅支持内存编辑；请使用 Tauri 桌面版打开或保存磁盘文件。')
      return
    }
    if (fileBusy.value || manager.isComposing) {
      composingHint()
      return
    }
    fileBusy.value = true
    try {
      await files.open(encoding)
      await refreshRecent()
    } finally {
      fileBusy.value = false
      void drainPending()
    }
  }

  async function openRecent(path: string, preview = false) {
    if (startupLoading.value) return
    if (fileBusy.value || manager.isComposing) {
      composingHint()
      return
    }
    fileBusy.value = true
    try {
      await files.recent(path, undefined, preview)
      await refreshRecent()
    } finally {
      fileBusy.value = false
      void drainPending()
    }
  }

  async function openWorkspaceFolder(add = false): Promise<boolean> {
    if (startupLoading.value) return false
    if (!desktop && workspace.gateway === tauriWorkspace) {
      toast('浏览器仅支持内存编辑；请使用 Tauri 桌面版打开工作区文件夹。')
      return false
    }
    return workspace.openWorkspaceDialog(add)
  }

  async function openWorkspacePath(path: string, add = false): Promise<boolean> {
    if (startupLoading.value) return false
    if (!desktop && workspace.gateway === tauriWorkspace) {
      toast('浏览器仅支持内存编辑；请使用 Tauri 桌面版打开工作区文件夹。')
      return false
    }
    return workspace.openWorkspacePath(path, add)
  }

  async function runFileOperation(action: () => Promise<unknown>) {
    if (fileBusy.value || files.workspaceBusy || updateInstalling.value || manager.isComposing) {
      toast('请先完成当前文件操作和输入。')
      return
    }
    fileBusy.value = true
    try {
      await action()
    } catch (error) {
      toast(fileError(error))
    } finally {
      fileBusy.value = false
      void drainPending()
    }
  }

  async function saveDoc(id: string, saveAs = false, encoding?: Encoding) {
    if (!desktop) {
      toast('浏览器仅支持内存编辑；请使用 Tauri 桌面版打开或保存磁盘文件。')
      return false
    }
    if (fileBusy.value) return false
    fileBusy.value = true
    try {
      const result = await files.saveDetailed(id, saveAs, encoding)
      await refreshRecent()
      if (result.code === 'saved') {
        return true
      }
      if (result.code === 'changed') {
        toast('已保存至磁盘，但检测到有新编辑，仍保留未保存修改')
        return true
      }
      if (result.code === 'cancelled') {
        return false
      }
      if (result.code === 'conflict') {
        toast(`保存失败：${result.message || '文件已被外部更改，已阻止覆盖；请使用另存为'}`)
        return false
      }
      if (result.code === 'permission') {
        toast(`保存失败：${result.message || '文件只读或无写入权限；请使用另存为'}`)
        return false
      }
      if (result.code === 'already_open') {
        toast(`保存失败：${result.message || '目标文件已在其他标签打开，请选择其他文件名'}`)
        return false
      }
      if (!result.success) {
        toast(`保存失败：${result.message || '操作未完成，内容与恢复快照仍保留；可重试或另存为'}`)
        return false
      }
      return true
    } finally {
      fileBusy.value = false
      void drainPending()
    }
  }

  function saveActive(saveAs = false, encoding?: Encoding) {
    if (manager.activeId) return saveDoc(manager.activeId, saveAs, encoding)
    return Promise.resolve(false)
  }

  async function quitApp(source: CloseSource = 'command') {
    if (!desktop) return
    try {
      await windowClose.request(source)
    } catch (error) {
      toast(`退出失败：${fileError(error)}`)
    }
  }

  async function validateUpdateWindows() {
    const other = await invoke<({ dirtyCount: number; ready: boolean } | null)[]>('update_windows_status')
    if (other.length) {
      const dirty = other.reduce((n, state) => n + (state?.dirtyCount || 0), 0)
      throw Error(
        '另有 ' +
          other.length +
          ' 个 Markumo 窗口' +
          (dirty ? '，包含 ' + dirty + ' 个未保存文档' : '') +
          (other.some(state => !state?.ready) ? '（部分窗口状态尚未就绪）' : '') +
          '。请先在这些窗口保存修改并关闭窗口，再重试安装。',
      )
    }
    await invoke('ensure_update_window')
  }

  async function prepareUpdate() {
    if (!desktop) return false
    if (!launchReady) throw Error('启动会话恢复尚未就绪，请重新启动后再安装更新。')
    return prepareInstallation({
      status: () => ({
        dirtyIds: manager.openedDocuments.filter(doc => doc.dirty).map(doc => doc.id),
        busy: computeUpdatePrepareBusy({
          startupLoading: startupLoading.value,
          fileBusy: fileBusy.value,
          workspaceBusy: files.workspaceBusy,
          savingCount: files.activeOperationCount,
          discardVisible: Boolean(discardRef.value?.visible),
          hasWorkspaceDialog: Boolean(document.querySelector('.workspace-operation-dialog')),
        }),
        composing: manager.isComposing,
      }),
      validateWindows: validateUpdateWindows,
      confirmSave: async count => {
        settingsRef.value?.close()
        paletteRef.value?.close()
        return (await updateConfirmRef.value?.confirm(count)) ?? false
      },
      save: id => files.save(id),
      lock: value => {
        updateInstalling.value = value
      },
      persist: async () => {
        await preferences.flushSettings(true)
        const writer = sessionWriter || new SessionWriter(input => invoke('persist_session', { input, forUpdate: true }), () => {})
        try {
          writer.schedule(sessionInput(manager, workspace.roots, { mode: appMode.value, sidebarVisible: sidebarVisible.value, sidebarWidth: sidebarWidth.value }))
          await writer.flush(true)
        } finally {
          if (!sessionWriter) writer.dispose()
        }
      },
    })
  }

  async function reopenEncoding(encoding: FileOpenEncoding, force = false) {
    const doc = manager.activeDocument
    if (isMedia(doc)) return
    if (!doc?.fileToken) {
      toast('请先打开真实文件。')
      return
    }
    if (doc.kind === 'javaClass' && encoding !== 'Hex') {
      toast('请使用“编辑文件字节”切回可编辑内容。')
      return
    }
    if (fileBusy.value || manager.isComposing) {
      composingHint()
      return
    }
    if (doc.dirty && !force) {
      pendingClose = { kind: 'reopen', id: doc.id, encoding }
      paletteRef.value?.close()
      settingsRef.value?.close()
      discardRef.value?.open(doc.name)
      return
    }
    fileBusy.value = true
    try {
      await files.reopen(encoding, true)
    } finally {
      fileBusy.value = false
      void drainPending()
    }
  }

  async function convertEncoding(payload: { encoding: Encoding; bom: boolean }) {
    const doc = manager.activeDocument
    if (!doc?.fileToken) {
      toast('内存草稿请直接另存为；已有磁盘文件方可转换编码。')
      return
    }
    if (doc.kind === 'javaClass' || doc.encoding === 'Hex') {
      toast('二进制/字节模式不支持直接转换文本编码。')
      return
    }
    if (fileBusy.value || manager.isComposing) {
      composingHint()
      return
    }
    fileBusy.value = true
    try {
      const saved = await files.save(doc.id, false, payload.encoding, payload.bom)
      if (saved) {
        await refreshRecent()
      }
    } finally {
      fileBusy.value = false
      void drainPending()
    }
  }

  function saveAsEncoding(encoding: Encoding) {
    const doc = manager.activeDocument
    if (!doc) return
    if (doc.kind === 'javaClass' || doc.encoding === 'Hex') {
      toast('二进制/字节模式不支持直接转换文本编码。')
      return
    }
    void saveActive(true, encoding)
  }

  async function drainPending() {
    if (!desktop || !alive || updateInstalling.value) return
    pendingDrain = true
    if (!launchReady || draining || fileBusy.value || manager.isComposing || discardRef.value?.visible) return
    draining = true
    fileBusy.value = true
    try {
      while (pendingDrain && alive) {
        pendingDrain = false
        const batch = await tauriFiles.drainPending()
        files.acceptBatch(batch)
        if (batch.files.length && !manager.isComposing) manager.focusPane(manager.activePane)
      }
      await refreshRecent()
    } catch (error) {
      toast(fileError(error))
    } finally {
      draining = false
      fileBusy.value = false
      advanceTabCloseQueue()
    }
  }

  async function activateExternal(paths: readonly string[]) {
    if (!desktop || !alive || !paths.length) return
    let activated = 0
    for (const pane of manager.layout.getAllLeafIds()) {
      for (const tab of manager.layout.getPane(pane)?.group.tabs || []) {
        const doc = manager.metadata(tab.documentId)
        if (!doc?.path || !paths.some(path => sameFilePath(path, doc.path))) continue
        if (manager.open(doc.id, false, pane)) activated++
      }
    }
    if (activated) {
      manager.focusPane(manager.activePane)
      return
    }
    void drainPending()
  }

  function setMode(mode: AppMode) {
    appMode.value = mode
    sidebarVisible.value = mode === 'workspace'
  }

  function toggleSidebar() {
    if (appMode.value === 'single') { appMode.value = 'workspace'; sidebarVisible.value = true; return }
    sidebarVisible.value = !sidebarVisible.value
  }

  function handleSelectPanel(panel: SidebarPanel) {
    if(panel==='search'){workspace.focusWorkspaceSearch();return}
    if (panel === 'outline') { toggleOutline(); return }
    if (sidebarPanel.value === panel && sidebarVisible.value) sidebarVisible.value = false
    else {
      sidebarPanel.value = panel
      sidebarVisible.value = true
    }
  }

  function preserveFocusLayout(change: () => void) {
    const activePane = manager.activePane
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.closest('.editor-host')
      ? document.activeElement : null
    const positions = Array.from(document.querySelectorAll<HTMLElement>('.cm-scroller, .markdown-live, .split-preview-content'))
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }))
    change()
    void nextTick(() => {
      manager.focusPane(activePane, false)
      // PM focus also synchronizes its DOM selection/observer. Native focus on
      // the prose root alone can trigger a delayed scrollToSelection after a modal.
      if (!manager.isComposing && manager.activeLiveEditor && (!focused || focused.matches('.md-prose'))) manager.activeLiveEditor.focus()
      else if (focused?.isConnected) focused.focus({ preventScroll: true })
      else if (!manager.isComposing) {
        manager.activeEditorView?.focus()
      }
      for (const { element, top, left } of positions) element.scrollTo({ top, left })
    })
  }

  function exitFocus() {
    if (!focusMode.value) return
    preserveFocusLayout(() => {
      focusMode.value = false
      if (savedSidebarVisible.value !== null) sidebarVisible.value = savedSidebarVisible.value
      savedSidebarVisible.value = null
    })
  }

  function toggleFocus() {
    if (focusMode.value) { exitFocus(); return }
    preserveFocusLayout(() => {
      savedSidebarVisible.value = sidebarVisible.value
      sidebarVisible.value = false
      focusMode.value = true
    })
  }

  function toggleTypewriter() {
    preferences.typewriterMode.value = !preferences.typewriterMode.value
  }

  function openSettings(section?: string) {
    if(workspace.searchDialogOpen)workspace.closeSearchDialog(false)
    if (discardRef.value?.visible) return
    paletteRef.value?.close()
    if (section && settingsRef.value?.openSection) {
      void settingsRef.value.openSection(section)
    } else {
      settingsRef.value?.open()
    }
  }

  function openPalette(category: 'action' | 'file' | 'all' = 'all') {
    if(workspace.searchDialogOpen)workspace.closeSearchDialog(false)
    if (discardRef.value?.visible) return
    settingsRef.value?.close()
    if (category !== 'action') void workspace.ensureFileIndex()
    paletteRef.value?.open(category)
    // Open() flips the component's visible flag; bump the projection after it so
    // the very first render includes the workspace file pool.
    revision.value++
  }

  function composingHint() {
    toast('请先完成当前输入法输入，再切换或关闭文档。')
  }

  function selectDocById(id: string) {
    if (!manager.select(id, 'main') && manager.isComposing) composingHint()
  }

  function handleSelectDoc(id: string, preview = true) {
    if (!manager.open(id, preview) && manager.isComposing) composingHint()
  }

  function pinDocById(id: string) {
    manager.pin(id)
  }

  function createNewDoc() {
    if (startupLoading.value) return
    if (!manager.createUntitled()) composingHint()
  }

  function closeDocById(id: string, pane: string = manager.activePane, queued = false) {
    if (!queued) tabCloseQueue = []
    if (fileBusy.value) {
      toast('文件操作进行中，请稍后关闭。')
      return
    }
    const result = files.close(id, false, pane)
    if (result === 'dirty') {
      pendingClose = { kind: 'document', id, pane }
      paletteRef.value?.close()
      settingsRef.value?.close()
      discardRef.value?.open(manager.metadata(id)?.name || '文档')
    } else if (result === 'composing') {
      tabCloseQueue = []
      composingHint()
    } else if (result === 'saving') tabCloseQueue = []
    return result === 'closed' || result === 'missing'
  }

  function advanceTabCloseQueue() {
    while (tabCloseQueue.length && !fileBusy.value && !pendingClose && !discardRef.value?.visible) {
      const next = tabCloseQueue.shift()!
      if (!closeDocById(next.id, next.pane, true)) break
    }
  }

  function closeOtherTabs(id: string, pane: string) {
    if (fileBusy.value || files.activeOperationCount || manager.isComposing || discardRef.value?.visible) {
      toast('请等待当前文件操作完成。')
      return
    }
    if (!manager.select(id, pane)) return
    const paneModel = manager.layout.getPane(pane)
    const docs = paneModel ? paneModel.group.tabs.map(t => manager.metadata(t.documentId)!).filter(Boolean) : []
    tabCloseQueue = docs.filter(doc => doc.id !== id).map(doc => ({ id: doc.id, pane }))
    advanceTabCloseQueue()
  }

  function cancelPendingClose() {
    pendingClose = null
    tabCloseQueue = []
  }

  async function discardPending() {
    if (fileBusy.value || files.activeOperationCount || files.workspaceBusy || manager.isComposing) {
      composingHint()
      return
    }
    const pending = pendingClose
    pendingClose = null
    if (pending?.kind === 'document') {
      const result = files.close(pending.id, true, pending.pane)
      if (result === 'closed' || result === 'missing') await recovery.discardDocument(pending.id)
    }
    else if (pending?.kind === 'reopen') {
      fileBusy.value = true
      try {
        await files.reopen(pending.encoding, true)
      } finally {
        fileBusy.value = false
        void drainPending()
      }
    } else if (pending?.kind === 'window') {
      try {
        await flushCloseState()
        if (fileBusy.value || files.activeOperationCount || files.workspaceBusy || manager.isComposing) {
          pendingClose = pending
          return
        }
        await recovery.discardActive()
        startup.exit()
        await destroyNativeWindow()
      } catch {
        toast('关闭窗口失败，编辑内容仍保留在当前窗口。')
      }
    }
    advanceTabCloseQueue()
    void drainPending()
  }

  async function savePending() {
    const pending = pendingClose
    if (!pending || fileBusy.value || manager.isComposing) return
    if (pending.kind === 'reopen') {
      const saved = await saveDoc(pending.id)
      if (saved) {
        discardRef.value?.close()
        pendingClose = null
        fileBusy.value = true
        try {
          await files.reopen(pending.encoding, true)
        } finally {
          fileBusy.value = false
          void drainPending()
        }
      }
      return
    }
    const ids = pending.kind === 'document' ? [pending.id] : manager.openedDocuments.filter(doc => doc.dirty).map(doc => doc.id)
    for (const id of ids) if (!(await saveDoc(id))) return
    if (pendingClose !== pending || manager.isComposing || (pending.kind === 'window' && manager.hasDirtyDocuments)) return
    discardRef.value?.close()
    if (pending.kind === 'document') {
      files.close(pending.id, false, pending.pane)
      pendingClose = null
      advanceTabCloseQueue()
    } else await discardPending()
    void drainPending()
  }

  function setLanguage(language: LanguageName) {
    if (manager.activeId) void manager.setLanguage(manager.activeId, language)
  }

  function setMarkdownMode(mode: MarkdownMode) {
    if (manager.activeId && !manager.setMarkdownMode(manager.activeId, mode) && manager.isComposing) composingHint()
  }

  function openGotoLine() {
    if (isMedia(manager.activeDocument)) return
    gotoLineRef.value?.open()
  }

  function handleGotoLine(payload: { line: number; column: number }) {
    if (manager.activeId) {
      manager.gotoLine(manager.activeId, payload.line, payload.column)
    }
  }

  function toggleSplitPane() {
    if (manager.isComposing) {
      composingHint()
      return
    }
    if (manager.isSplit) {
      manager.closeSplit()
    } else {
      manager.splitEditor()
    }
  }

  async function copyFullPath() {
    if (activeDoc.value?.path) {
      try {
        // Clipboard consumers get the readable form, never `\\?\` verbatim.
        await textClipboard.writeText(readablePath(activeDoc.value.path))
      } catch {
        toast('复制失败')
      }
    }
  }

  async function copyRelativePath() {
    if (activeDoc.value?.path) {
      const p = relativeFilePath(readablePath(activeDoc.value.path), workspace.rootPath ? readablePath(workspace.rootPath) : null)
      try {
        await textClipboard.writeText(p)
      } catch {
        toast('复制失败')
      }
    }
  }

  async function revealInExplorer() {
    if (activeDoc.value?.fileToken && desktop) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('reveal_in_explorer', { token: activeDoc.value.fileToken })
      } catch (e) {
        toast(`在文件管理器显示失败: ${e}`)
      }
    }
  }

  async function revealInExplorerToken(token: string) {
    if (token && desktop) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('reveal_in_explorer', { token })
      } catch (e) {
        toast(`在文件管理器显示失败: ${e}`)
      }
    }
  }

  function handleEditorWheel(event: WheelEvent) {
    if (!(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const hovered = document.elementFromPoint(event.clientX, event.clientY) || event.target
    if (!(hovered instanceof Element) || !hovered.closest('.pane-body')) return
    if (hovered.closest('.media-viewer')) return
    if (!event.deltaY || manager.isComposing) return
    if (event.deltaY < 0) preferences.zoomIn()
    else preferences.zoomOut()
  }

  function beforeUnload(event: BeforeUnloadEvent) {
    if (manager.hasDirtyDocuments || manager.isComposing || fileBusy.value || files.activeOperationCount) {
      event.preventDefault()
      event.returnValue = ''
    }
  }

  function scheduleSession() {
    if (!launchReady || !sessionWriter) return
    sessionWriter.schedule(
      sessionInput(manager, workspace.roots, {
        mode: appMode.value,
        sidebarVisible: sidebarVisible.value,
        sidebarWidth: sidebarWidth.value,
      }),
    )
  }

  async function flushCloseState() {
    await recovery.flushForClose()
    await startup.flushForClose(
      () => preferences.flushSettings(true),
      sessionWriter ? async () => { scheduleSession(); await sessionWriter!.flush(true) } : undefined,
    )
  }

  watch([revision, appMode, sidebarVisible, sidebarWidth], scheduleSession)

  function editorNotice(event: Event) {
    toast((event as CustomEvent<string>).detail)
  }

  watch([appMode, sidebarVisible, sidebarWidth], () => {
    if (!desktop || !launchReady || !preferencesReady) return
    if (layoutTimer) clearTimeout(layoutTimer)
    layoutTimer = setTimeout(() => {
      void tauriFiles
        .persistLayout({
          mode: appMode.value,
          sidebarVisible: sidebarVisible.value,
          sidebarWidth: sidebarWidth.value,
        })
        .catch(error => toast(fileError(error)))
    }, 250)
  })

  function resumePending() {
    setTimeout(() => {
      if (pendingDrain) void drainPending()
    }, 0)
  }

  watch(() => discardRef.value?.visible, value => {
    if (!value) resumePending()
  })

  // --- Commands & Keybindings Coordinator ---
  const commands = useShellCommands({
    desktop,
    demo,
    manager,
    files,
    workspace,
    exportController,
    importController,
    imageImporter,
    shortcuts: preferences.shortcuts,
    keymapPreset: preferences.keymapPreset,
    activeDoc,
    openedDocuments,
    recentFiles,
    fileBusy,
    startupLoading,
    updateInstalling,
    focusMode,
    typewriterMode: preferences.typewriterMode,
    sidebarVisible,
    sidebarPanel,
    appMode,
    showOutline: preferences.showOutline,
    outlineSupported,
    toggleOutline,
    wordWrap: preferences.wordWrap,
    revision,
    paletteRef,
    settingsRef,
    discardRef,
    gotoLineRef,
    toast,
    openHistory,
    openFile,
    openRecent,
    openWorkspaceFolder,
    openWorkspacePath,
    saveActive,
    closeDocById,
    quitApp,
    createNewDoc,
    handleSelectDoc,
    openSettings,
    openPalette,
    toggleSidebar,
    toggleFocus,
    exitFocus,
    toggleTypewriter,
    toggleTheme: preferences.toggleTheme,
    setMode,
    setMarkdownMode,
    openGotoLine,
    copyFullPath,
    copyRelativePath,
    revealInExplorer,
    zoomIn: preferences.zoomIn,
    zoomOut: preferences.zoomOut,
    resetZoom: preferences.resetZoom,
    chooseImages,
    importImages,
    refreshRecent,
    drainPending,
    reopenEncoding,
    runFileOperation,
    clipboardImages,
  })

  // --- Global Lifecycle (Mount / Unmount) ---

  let currentLaunchKind: 'app' | 'detached' | 'file' = 'app'

  /**
   * Target side of a tab handoff. The body already exists in this process, so
   * nothing is read from disk: unsaved text, encoding, mode, caret and scroll all
   * come from the source window. Only after this window really mounted the
   * document does it tell the source to release its tab.
   */
  async function adoptIncomingDocument(x?: number, y?: number,handoffId?:string): Promise<EditorDocument | null> {
    if(!alive||fileBusy.value||files.workspaceBusy||files.activeOperationCount||manager.isComposing||discardRef.value?.visible||pendingClose){if(handoffId){await cancelDetach(handoffId);if(alive)toast('请先完成当前窗口操作，再接收标签。')}return null}
    const adopted = await takeDetachedDocument(handoffId)
    if (!adopted) return null
    const { handoffId:receivedId, payload } = adopted
    let incomingId:string|null=null,createdPane:string|null=null,release:(()=>void)|null=null
    try {
      if(manager.openedDocuments.some(doc=>doc.id===payload.documentId||!!payload.path&&sameFilePath(doc.path,payload.path)))throw Error('目标窗口已打开此文档，已取消移交以保留两边内容。')
      if(!alive)throw Error('目标窗口已关闭')
      files.workspaceBusy=true
      let targetPane = manager.activePane
      let targetZone: 'center' | 'left' | 'right' | 'top' | 'bottom' = 'center'
      if (typeof x === 'number' && typeof y === 'number') {
        const under = document.elementFromPoint(x, y)
        const paneEl = under?.closest<HTMLElement>('.pane[data-pane-id]')
        if (paneEl?.dataset.paneId && manager.layout.getPane(paneEl.dataset.paneId)) {
          targetPane = paneEl.dataset.paneId
          const body = paneEl.querySelector<HTMLElement>('.pane-document-shell')
            || paneEl.querySelector<HTMLElement>('.pane-document')
            || paneEl
          const rect = body.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            targetZone = under?.closest('.tabs')?'center':resolvePaneDropZone(rect, x, y)
          }
        }
      }

      const pane = targetZone === 'center'
        ? targetPane
        : manager.splitPane(targetZone as SplitDirection, targetPane, undefined, targetPane, false)
      if(targetZone!=='center')createdPane=pane
      manager.focusPane(pane,false)

      let docId: string | null = null
      if (!payload.fileToken && !payload.path) {
        docId = manager.createRecoveredDocument({
          id: `untitled-${payload.documentId}`,
          name: payload.name,
          text: payload.text,
          encoding: payload.encoding,
          bom: payload.bom,
          eol: payload.eol as EditorDocument['eol'],
          mode: payload.markdownMode as MarkdownMode | undefined,
        })
      } else {
        const accepted = files.accept(
          {
            token: payload.fileToken || `detached-${payload.documentId}`,
            path: payload.path || '',
            name: payload.name,
            kind:payload.kind||'text',media:payload.media,classInfo:payload.classInfo,
            text: payload.text,
            encoding: payload.encoding as unknown as Encoding,
            bom: payload.bom,
            eol: payload.eol as EditorDocument['eol'],
            readOnly: payload.readOnly,
            version: payload.version || '',
          } as import('../features/files/contracts').OpenFile,
          false,
          pane,
          false,
        )
        if (!accepted) {
          if (targetZone !== 'center') manager.closePane(pane)
          throw Error('目标窗口无法打开移交文档')
        }
        const doc =
          manager.openedDocuments.find(item => item.fileToken === payload.fileToken && payload.fileToken) ||
          manager.openedDocuments.find(item => !!payload.path&&sameFilePath(item.path,payload.path))
        docId = doc?.id ?? null
      }

      if (!docId) {
        if (targetZone !== 'center') manager.closePane(pane)
        throw Error('移交文档身份不可用')
      }
      incomingId=docId

      // `restoreRecoveredText` applies the transferred body without adding an
      // undo step and marks the document dirty, which is exactly the state the
      // source had (its undo history stays behind by design).
      if (payload.dirty) manager.restoreRecoveredText(docId, payload.text)
      if (payload.markdownMode) {
        manager.setMarkdownMode(docId, payload.markdownMode as MarkdownMode, pane)
      }
      if (payload.pinned) manager.pin(docId, pane)
      else if(!payload.dirty)manager.paneGroup(pane).unpin(docId)
      if(payload.mediaView)Object.assign(manager.mediaViewState(docId,pane),payload.mediaView)
      manager.setSelectionOffsets(docId, payload.anchor, payload.head, pane)
      manager.restoreScroll(docId, payload.scrollTop, payload.scrollLeft, pane)
      manager.focusPane(pane, true)
      release=manager.holdForHandoff(docId)
      if(!release||!alive)throw Error('目标窗口尚未准备好')
      await commitDetach(receivedId)
      release();release=null
      return manager.metadata(docId)
    } catch (error) {
      const committed=await cancelDetach(receivedId)
      if(committed&&incomingId){release?.();return manager.metadata(incomingId)}
      if(incomingId)for(const pane of manager.layout.getAllLeafIds())manager.close(incomingId,true,pane)
      release?.()
      if(createdPane&&manager.layout.getPane(createdPane))manager.closePane(createdPane)
      throw error
    }finally{files.workspaceBusy=false}
  }

  async function adoptDetachedDocument(): Promise<EditorDocument | null> {
    return adoptIncomingDocument()
  }
  const emptyDetached=new EmptyDetachedWindow(()=>({detached:currentLaunchKind==='detached',ready:alive&&launchReady&&!startupLoading.value,documents:manager.openedDocuments.length,busy:fileBusy.value||files.workspaceBusy||files.activeOperationCount>0||manager.isComposing}),()=>windowClose.request('native'))
  watch([revision,startupLoading,fileBusy],()=>emptyDetached.refresh(),{flush:'post'})
  const disposeEmptyDetached=()=>emptyDetached.dispose()
  window.addEventListener('markumo:dispose-window',disposeEmptyDetached,{once:true})
  function outgoingCommitted(event:{handoffId:string;documentId:string}){
    if(!receiveDetachCommitted(event))return
    emptyDetached.refresh()
  }

  const startup = new DesktopStartup({
    protect: async scope => {
      const win=(await import('@tauri-apps/api/window')).getCurrentWindow()
      await scope.register('close', async () =>win.onCloseRequested(async event => {
        event.preventDefault()
        if (!alive) return
        await windowClose.request('native')
      }))
      await scope.register('detach',()=>listenDetachCommitted(outgoingCommitted))
      await scope.register('detach-canceled',()=>win.listen<{handoffId:string;documentId:string}>('markumo:detach-canceled',event=>receiveDetachCanceled(event.payload)))
    },
    loadPreferences: current => preferences.loadPreferences(current),
    initialize: initializeLaunch,
    adopt: async (launch, current) => {
      currentLaunchKind = launch.kind
      if (launch.kind === 'app' && !launch.ownsSession) throw Error('主会话所有权未确认，已停止恢复。')
      workspace.restoreSession(launch.roots)
      // A detached window boots with nothing restored: its body arrives through
      // the detach handshake instead of the session or the disk.
      const adopted = launch.kind === 'detached' ? await adoptDetachedDocument() : null
      if(launch.kind==='detached'&&!adopted)throw Error('标签移交已取消，原窗口保留文档。')
      if (!adopted) files.acceptBatch(launch.files)
      const selected = adopted
        || manager.openedDocuments.find(doc => doc.path === launch.activePath) || manager.openedDocuments[0]
      if (selected&&!adopted) manager.select(selected.id, 'main')
      if(!adopted)restoreEditorLayout(manager, launch.editorLayout)
      appMode.value = launch.kind === 'app' ? launch.layout.mode : 'single'
      sidebarWidth.value = launch.layout.sidebarWidth
      wasNarrow = window.innerWidth < 900
      sidebarVisible.value = launch.kind === 'app' && !!workspace.rootPath && launch.layout.sidebarVisible && !wasNarrow
      if (launch.warnings.length) toast(launch.warnings.join('\n'))
      if (launch.ownsSession) {
        sessionWriter = new SessionWriter(
          input => invoke('persist_session', { input }),
          error => toast(`会话记录失败：${fileError(error)}`),
        )
        // Confirm native persistence before exposing an editable owner window.
        sessionWriter.schedule(sessionInput(manager, workspace.roots, {
          mode: appMode.value, sidebarVisible: sidebarVisible.value, sidebarWidth: sidebarWidth.value,
        }))
        await sessionWriter.flush(true)
      }
      if (launch.ownsSession) await recovery.start()
      if (current()) await nextTick()
      return launch.ownsSession ? 'owner' : 'temporary'
    },
    release: async launch => {
      const adopted = new Set(manager.openedDocuments.map(doc => doc.fileToken))
      await Promise.all(launch.files.files.filter(file => !adopted.has(file.token)).map(file => tauriFiles.release(file.token)))
    },
    changed: state => {
      launchReady = state.phase === 'ready'
      startupLoading.value = !launchReady
      startupError.value = state.error
    },
  })

  async function commitWorkspaceDrop(result:TabDragResult){
    if(result.payload.kind!=='file')return
    const pane=result.paneDrop?.paneId||result.tabInsert?.paneId
    if(!pane)return
    const opened=await workspace.openWorkspaceFileInPane({path:result.payload.path,paneId:pane,pin:true,zone:result.paneDrop?.zone||'center'})
    if(opened.success&&opened.docId&&opened.paneId&&result.tabInsert){
      const tabs=manager.paneGroup(opened.paneId).tabs,at=tabs.findIndex(tab=>tab.documentId===result.tabInsert!.targetDocId)
      if(result.tabInsert.targetDocId!==opened.docId)manager.transferTab(opened.docId,opened.paneId,opened.paneId,{targetIndex:at<0?tabs.length:at+(result.tabInsert.position==='after'?1:0)})
    }
  }
  onMounted(async () => {
    tabDragService.configure(undefined,result=>void commitWorkspaceDrop(result))
    if (desktop) await files.external.start()
    // One-time move of the previous localStorage history into the native store.
    if (desktop) void migrateLegacyHistory(toast).catch(() => {})
    // The tab bar only raises the intent; the shell owns the transfer.
    setDetachRequestHandler((documentId, paneId, drop) => {
      if(fileBusy.value||files.workspaceBusy||files.activeOperationCount||manager.isComposing){toast('请等待当前文件操作或输入完成。');return}
      void detachDocumentToWindow(manager, documentId, paneId, drop, toast)
    })
    setHandoffBusyHandler(busy=>{files.workspaceBusy=busy;emptyDetached.refresh()})
    window.addEventListener('editor-notice', editorNotice)
    window.addEventListener('markdown-open-relative', openRelativeLink)
    window.addEventListener('paste', imagePaste, true)
    wasNarrow = window.innerWidth < 900
    window.addEventListener('resize', adaptWindowWidth)
    commands.mountListeners(window)
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('compositionend', resumePending)
    window.addEventListener('compositioncancel', resumePending)
    window.addEventListener('wheel', handleEditorWheel, { passive: false, capture: true })

    if (desktop) {
      await startup.start()
      if (!alive || !launchReady) return
      try {
        await startup.listeners.register('tab-drag',async()=> (await import('@tauri-apps/api/window')).getCurrentWindow().listen<{id:string;point:{x:number;y:number;ctrlKey:boolean;altKey:boolean}|null}>('markumo:tab-drag-finished',event=>tabDragService.nativeFinished(event.payload.id,event.payload.point)))
        if(!alive)return
        tabDragService.configure({begin:id=>invoke<boolean>('begin_tab_drag',{id}),cancel:id=>{if(id)void invoke('cancel_tab_drag',{id}).catch(()=>{})}},result=>void commitWorkspaceDrop(result))
        await startup.listeners.register('pending', async () => (await import('@tauri-apps/api/window')).getCurrentWindow().listen('files-pending', () => void drainPending()))
        if (!alive || !launchReady) return
        await startup.listeners.register('activate', async () => (await import('@tauri-apps/api/window')).getCurrentWindow().listen<string[]>('external-activate', event => {
          void activateExternal(event.payload)
        }))
        if (!alive || !launchReady) return
        await startup.listeners.register('drop', async () => (await import('@tauri-apps/api/window')).getCurrentWindow().listen<{ inputs: NativeDropInput[]; x: number; y: number }>('native-file-drop', event => {
          void nativeFileDrop(event.payload).catch(error => toast(fileError(error)))
        }))
        if (!alive || !launchReady) return
        await startup.listeners.register('incoming-tab', async () => (await import('@tauri-apps/api/window')).getCurrentWindow().listen<{ handoffId: string; x?: number; y?: number }>('markumo:incoming-tab', event => {
          void adoptIncomingDocument(event.payload.x, event.payload.y,event.payload.handoffId).catch(error => toast(`接收标签失败：${fileError(error)}`))
        }))
        if (!alive || !launchReady) return
        if (!alive || !launchReady) return
        const prefs = await tauriFiles.preferences()
        if (alive) {
          recentFiles.value = prefs.recent
          if (prefs.warning) toast(prefs.warning)
          await nextTick()
          if (!alive || !launchReady) return
          preferencesReady = true
          await drainPending()
        }
      } catch (error) {
        if (alive) toast(fileError(error))
      }
    } else {
      await preferences.loadPreferences()
    }
    if (!alive) return
    autoSaver.configure(desktop && preferences.autoSave.value, preferences.autoSaveDelay.value)

    if (desktop && alive) {
      try {
        const runtime = await invoke<{ version: string; platform: string; installSupported: boolean }>('update_runtime')
        if (!alive) return
        Object.assign(updateStatus, {
          currentVersion: runtime.version,
          platform: runtime.platform,
          installSupported: runtime.installSupported,
        })
        const confirmation = await invoke<{ confirmed: boolean; targetVersion: string } | null>('confirm_update_startup')
        if (!alive) return
        if (confirmation?.confirmed) {
          updateStatus.confirmedVersion = runtime.version
        } else if (confirmation) {
          toast('上次更新尚未确认，当前运行版本为 v' + runtime.version + '，可重新检查更新。')
        }
      } catch (error) {
        if (!alive) return
        updateStatus.error = fileError(error)
      }
      if (!alive) return
      updateManager.start(!import.meta.env.DEV)
      reportUpdateWindow()
    }
  })

  onUnmounted(() => {
    emptyDetached.dispose();window.removeEventListener('markumo:dispose-window',disposeEmptyDetached)
    tabDragService.dispose();setDetachRequestHandler(null);disposeHandoffs()
    window.removeEventListener('editor-notice', editorNotice)
    window.removeEventListener('markdown-open-relative', openRelativeLink)
    window.removeEventListener('paste', imagePaste, true)
    window.removeEventListener('resize', adaptWindowWidth)
    alive = false
    if (desktop) startup.dispose()
    updateManager.dispose()
    if (reportTimer) clearTimeout(reportTimer)
    if (layoutTimer) clearTimeout(layoutTimer)
    preferences.dispose()
    commands.unmountListeners(window)
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('compositionend', resumePending)
    window.removeEventListener('compositioncancel', resumePending)
    window.removeEventListener('wheel', handleEditorWheel, true)
    sessionWriter?.dispose()
    autoSaver.dispose()
    recovery.dispose()
    files.dispose()
    workspace.destroy()
    unsubscribeWorkspaceOpened?.()
    unsubscribeWorkspace()
    unsubscribe()
    manager.dispose()
    exportController.dispose()
  })

  // --- Return Exact Interface for App.vue ---
  return {
    autoCheckUpdates: preferences.autoCheckUpdates,
    autoDownloadUpdates: preferences.autoDownloadUpdates,
    updateStatus,
    updatePanelOpen,
    updateConfirmRef,
    updateManager,
    openUpdatePanel,
    openUpdateRelease,
    openUpdateLink,
    caretAnimation: preferences.caretAnimation,
    outlineWidth: preferences.outlineWidth,
    markdownClipboard: preferences.markdownClipboard,
    markdownTypography: preferences.markdownTypography,
    appMode,
    sidebarVisible,
    sidebarWidth,
    sidebarPanel,
    focusMode,
    theme: preferences.theme,
    uiFontSize: preferences.uiFontSize,
    fontSize: preferences.fontSize,
    fontFamily: preferences.fontFamily,
    indentSize: preferences.indentSize,
    useTabs: preferences.useTabs,
    shortcuts: preferences.shortcuts,
    updateShortcuts: preferences.updateShortcuts,
    updateKeymap: preferences.updateKeymap,
    keymapPreset: preferences.keymapPreset,
    wordWrap: preferences.wordWrap,
    showOutline: preferences.showOutline,
    typewriterMode: preferences.typewriterMode,
    defaultMdMode: preferences.defaultMdMode,
    liveToolbar: preferences.liveToolbar,
    externalFileMonitoring: preferences.externalFileMonitoring,
    autoReloadExternal: preferences.autoReloadExternal,
    autoSave: preferences.autoSave,
    autoSaveDelay: preferences.autoSaveDelay,
    treeClickMode: preferences.treeClickMode,
    autoFollowActiveFile: preferences.autoFollowActiveFile,
    smartExpand: preferences.smartExpand,
    compactFolders: preferences.compactFolders,
    syntaxStyle: preferences.syntaxStyle,
    bracketMode: preferences.bracketMode,
    imageRules: preferences.imageRules,
    currentDocumentImageRules: preferences.currentDocumentImageRules,
    updateDocumentImageRules: preferences.updateDocumentImageRules,
    paletteRef,
    settingsRef,
    discardRef,
    toastRef,
    historyRef,
    historyOpen,
    historyPath,
    historyDocumentId,
    historyContent,
    manager,
    files,
    workspace,
    revision,
    openedDocuments,
    mainOpenedDocuments,
    mainActiveId,
    activeDoc,
    activeDocId,
    exportProgress: exportController.progress,
    cancelExport: () => exportController.cancelExport(),
    paletteActions: commands.paletteActions,
    menuGroups: commands.menuGroups,
    commandRegistry: commands.commandRegistry,
    executeCommand: commands.executeCommand,
    setMode,
    toggleSidebar,
    handleSelectPanel,
    leftSidebarOccupied,
    effectiveOutlinePosition,
    outlineCapability,
    outlineSupported,
    toggleOutline,
    outlineVisible,
    toggleTheme: preferences.toggleTheme,
    toggleFocus,
    toggleTypewriter,
    openSettings,
    openPalette,
    selectDocById,
    handleSelectDoc,
    pinDocById,
    createNewDoc,
    closeDocById,
    closeOtherTabs,
    cancelPendingClose,
    discardPending,
    savePending,
    setLanguage,
    setMarkdownMode,
    reopenEncoding,
    convertEncoding,
    saveAsEncoding,
    gotoLineRef,
    openGotoLine,
    handleGotoLine,
    toggleSplitPane,
    copyFullPath,
    copyRelativePath,
    revealInExplorer,
    revealInExplorerToken,
    zoomIn: preferences.zoomIn,
    zoomOut: preferences.zoomOut,
    resetZoom: preferences.resetZoom,
    desktop,
    demo,
    fileBusy,
    recentFiles,
    openFile,
    openRecent,
    openWorkspaceFolder,
    openWorkspacePath,
    saveActive,
    quitApp,
    startupLoading,
    startupError,
    settingsReady: preferences.settingsReady,
    updateInstalling,
    prepareUpdate,
    recoveryRecords: recovery.records,
    recoveryVisible: recovery.visible,
    recoveryBusy: recovery.busy,
    recoveryError: recovery.lastError,
    recoveryDiff: recovery.diff,
    openRecovery: () => recovery.open(),
    closeRecovery: () => recovery.close(),
    restoreRecovery: (record: Parameters<typeof recovery.restore>[0]) => recovery.restore(record),
    discardRecovery: (record: Parameters<typeof recovery.discard>[0]) => recovery.discard(record),
    restoreAllRecovery: () => recovery.restoreAll(),
    showRecoveryDiff: (record: Parameters<typeof recovery.showDiff>[0]) => recovery.showDiff(record),
    clearRecoveryDiff: () => recovery.clearDiff(),
  }
}
