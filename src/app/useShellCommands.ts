import { computed, type Ref, type ComputedRef } from 'vue'
import { EditorView } from '@codemirror/view'
import type { Preferences, Encoding, FileOpenEncoding } from '../features/files/contracts'
import { fileError, type FileController } from '../features/files/FileController'
import type { WorkspaceController } from '../features/workspace/WorkspaceController'
import type { DocumentManager } from '../editor/core/DocumentManager'
import type { ExportController, ImportController } from '../features/document-conversion'
import type { ImageImporter, ImageSource } from '../editor/markdown/imageImport'
import type { AppMode, SidebarPanel, PaletteAction, PaletteExecuteOptions, MarkdownMode, EditorDocument } from '../types'
import {
  allCommands,
  commandDefinition,
  matchingCommand,
  keybindingContext,
  isManagedDefault,
  type KeymapPresetId,
} from '../features/shell/keybindings'
import { DoubleShiftShortcut } from '../features/shell/keybindings/DoubleShiftShortcut'
import { CommandRegistry, recentFileCommand, recentWorkspaceCommand } from '../features/shell/menuModel'
import { mainMenu } from '../features/shell/mainMenu'
import { shortcutLabel, eventShortcut } from '../features/shell/editorSettings'
import { textClipboard } from '../features/shell/clipboard'
import { editorClipboard, inputClipboard, type ClipboardOperation } from '../editor/commands/clipboard'
import { isMedia } from '../features/files/media'
import { markdownFormats } from '../editor/markdown/formatCommands'
import { displayPathKey, readablePath } from '../features/shell/pathDisplay'
import type { CloseSource } from '../features/shell/WindowCloseGuard'
import type CommandPalette from '../components/modals/CommandPalette.vue'
import type SettingsModal from '../components/modals/SettingsModal.vue'
import type DiscardDialog from '../components/modals/DiscardDialog.vue'

export interface ShellCommandsHost {
  desktop: boolean
  demo: boolean
  manager: DocumentManager
  files: FileController
  workspace: WorkspaceController
  exportController: ExportController
  importController: ImportController
  imageImporter: ImageImporter
  shortcuts: Ref<Record<string, string>>
  keymapPreset: Ref<KeymapPresetId>
  activeDoc: ComputedRef<EditorDocument | null>
  openedDocuments: ComputedRef<EditorDocument[]>
  recentFiles: Ref<Preferences['recent']>
  fileBusy: Ref<boolean>
  startupLoading: Ref<boolean>
  updateInstalling: Ref<boolean>
  focusMode: Ref<boolean>
  typewriterMode: Ref<boolean>
  sidebarVisible: Ref<boolean>
  sidebarPanel: Ref<SidebarPanel>
  appMode: Ref<AppMode>
  showOutline: Ref<boolean>
  outlineSupported: ComputedRef<boolean>
  toggleOutline: () => void
  wordWrap: Ref<boolean>
  revision: Ref<number>
  // Modal visibility guards
  paletteRef: Ref<InstanceType<typeof CommandPalette> | null>
  settingsRef: Ref<InstanceType<typeof SettingsModal> | null>
  discardRef: Ref<InstanceType<typeof DiscardDialog> | null>
  gotoLineRef: Ref<{ open: () => void; close: () => void; visible: boolean } | null>
  // UI and business callbacks
  toast: (message: string) => void
  openFile: (encoding?: FileOpenEncoding) => Promise<void>
  openRecent: (path: string, preview?: boolean) => Promise<void>
  saveActive: (saveAs?: boolean, encoding?: Encoding) => Promise<boolean>
  closeDocById: (id: string, pane?: string) => boolean | undefined
  quitApp: (source?: CloseSource) => Promise<void>
  createNewDoc: () => void
  handleSelectDoc: (id: string, preview?: boolean) => void
  openSettings: (section?: string) => void
  openPalette: (category?: 'action' | 'file' | 'all') => void
  toggleSidebar: () => void
  toggleFocus: () => void
  exitFocus: () => void
  toggleTypewriter: () => void
  toggleTheme: () => void
  setMode: (mode: AppMode) => void
  setMarkdownMode: (mode: MarkdownMode) => void
  openGotoLine: () => void
  copyFullPath: () => Promise<void>
  copyRelativePath: () => Promise<void>
  revealInExplorer: () => Promise<void>
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  chooseImages: () => Promise<void>
  importImages: (id: string, sources: ImageSource[]) => Promise<void>
  refreshRecent: () => Promise<void>
  drainPending: () => Promise<void>
  reopenEncoding: (encoding: FileOpenEncoding, force?: boolean) => Promise<void>
  runFileOperation: (action: () => Promise<unknown>) => Promise<void>
  clipboardImages: () => Promise<ImageSource[]>
  openHistory: () => void
}

export function useShellCommands(host: ShellCommandsHost) {
  // Recent entries come from disk. A single malformed record must never be able
  // to throw inside a computed that App.vue reads while rendering: a thrown
  // render leaves the last painted frame on screen forever ("正在打开…") even
  // though startup already finished.
  const recentFiles = (): Preferences['recent'] =>
    Array.isArray(host.recentFiles.value) ? host.recentFiles.value.filter(file => !!file && typeof file.path === 'string' && typeof file.name === 'string') : []
  const recentWorkspaces = (): string[] => {
    const list = host.workspace.recentWorkspaces
    return Array.isArray(list) ? list.filter((path): path is string => typeof path === 'string') : []
  }
  const reportedRenderErrors = new Set<string>()
  function reportRenderError(scope: string, error: unknown) {
    const key = `${scope}:${error instanceof Error ? error.message : String(error)}`
    console.error(`Markumo: ${scope} failed`, error)
    if (reportedRenderErrors.has(key)) return
    reportedRenderErrors.add(key)
    window.dispatchEvent(new CustomEvent('editor-notice', { detail: `界面渲染异常（${scope}）：${error instanceof Error ? error.message : String(error)}` }))
  }

  function docByPath(path?: string | null) {
    if (!path) return undefined
    return host.openedDocuments.value.find(doc => doc.path && displayPathKey(doc.path) === displayPathKey(path))
  }

  function focusActiveEditor() {
    host.manager.focusPane(host.manager.activePane)
  }

  function focusOpenedPath(path: string | null | undefined, options?: PaletteExecuteOptions) {
    const doc = docByPath(path)
    if (!doc) return
    // A slower workspace load must not steal focus after a newer navigation.
    const active = host.manager.activeDocument
    if (!active?.path || displayPathKey(active.path) !== displayPathKey(path!)) return
    // Opening from the palette must leave the caret in the editor, not in the
    // now-closed input. Reveal later; it focuses the exact view.
    focusActiveEditor()
    if (options?.line && !isMedia(doc) && doc.kind !== 'javaClass') {
      host.manager.revealPosition(doc.id, options.line, options.column ?? 1)
    }
  }

  async function openWorkspaceEntry(
    node: Parameters<WorkspaceController['openFile']>[0],
    options?: PaletteExecuteOptions,
  ) {
    try {
      await host.workspace.openFile(node, !options?.pinned)
      focusOpenedPath(node.path, options)
    } catch (error) {
      host.toast(fileError(error))
    }
  }

  async function openRecentEntry(path: string, options?: PaletteExecuteOptions) {
    try {
      await host.openRecent(path, !options?.pinned)
      focusOpenedPath(path, options)
    } catch (error) {
      host.toast(fileError(error))
    }
  }
  const paletteActions = computed<PaletteAction[]>(() => {
    try {
      return buildPaletteActions()
    } catch (error) {
      reportRenderError('命令面板', error)
      return []
    }
  })
  function buildPaletteActions(): PaletteAction[] {
    host.revision.value
    const actions: PaletteAction[] = [
      { id: 'palette', title: '命令面板', detail: '', category: 'action', action: () => host.openPalette('action') },
      { id: 'quick-open', title: '快速打开文件', detail: '', category: 'action', action: () => host.openPalette('file') },
      { id: 'new', title: '新建文本草稿', detail: 'Ctrl+N', category: 'action', action: host.createNewDoc },
      { id: 'new-markdown', title: '新建 Markdown 文档', detail: 'Markdown', category: 'action', action: () => { host.manager.createUntitled('md') } },
      { id: 'close-current', title: '关闭文件', detail: '', category: 'action', disabled: !host.activeDoc.value, action: () => { if (host.manager.activeId) host.closeDocById(host.manager.activeId, host.manager.activePane) } },
      { id: 'quit', title: '退出应用', detail: '', category: 'action', disabled: !host.desktop, action: () => { void host.quitApp() } },
      { id: 'cut', title: '剪切', detail: shortcutLabel('Mod+X'), category: 'action', disabled: !host.activeDoc.value || host.activeDoc.value.kind === 'javaClass', action: () => { void clipboardAction('cut') } },
      { id: 'copy', title: '复制', detail: shortcutLabel('Mod+C'), category: 'action', disabled: !host.activeDoc.value, action: () => { void clipboardAction('copy') } },
      { id: 'paste', title: '粘贴', detail: shortcutLabel('Mod+V'), category: 'action', disabled: !host.activeDoc.value || host.activeDoc.value.kind === 'javaClass', action: () => { void clipboardAction('paste') } },
      { id: 'select-all', title: '全选', detail: shortcutLabel('Mod+A'), category: 'action', disabled: !host.activeDoc.value, action: () => { void clipboardAction('select-all') } },
      { id: 'wrap', title: '自动换行', detail: '', category: 'action', action: () => { host.wordWrap.value = !host.wordWrap.value } },
      { id: 'explorer', title: '资源管理器', detail: '', category: 'action', action: () => { host.exitFocus(); host.appMode.value = 'workspace'; host.sidebarPanel.value = 'files'; host.sidebarVisible.value = true } },
      // One palette entry per command: the id and label come from the command
      // catalog, so the palette, the menus and the shortcut settings cannot
      // drift apart or list the same action twice under different ids.
      ...markdownFormats.map(([format, fallbackTitle]) => {
        const definition = commandDefinition(format)
        return {
          id: definition?.id ?? `format-${format}`,
          title: definition?.label ?? fallbackTitle,
          detail: '',
          category: 'action' as const,
          disabled:
            host.activeDoc.value?.kind === 'javaClass' ||
            !host.activeDoc.value?.mode ||
            host.manager.isComposing ||
            (format === 'image' && (!host.desktop || host.fileBusy.value || !!host.activeDoc.value?.readOnly)),
          action: () => {
            if (format === 'image' && host.desktop) {
              if (host.fileBusy.value || host.activeDoc.value?.readOnly) return
              void host.chooseImages()
            } else host.manager.formatMarkdown(format)
          },
        }
      }),
      ...(['live', 'source', 'split'] as const).map(mode => ({
        id: `md-mode-${mode}`,
        title: { live: 'Markdown 实时排版', source: 'Markdown 源码编辑', split: 'Markdown 双栏预览' }[mode],
        detail: '',
        category: 'action' as const,
        disabled: !host.activeDoc.value?.mode || host.manager.isComposing,
        action: () => host.setMarkdownMode(mode),
      })),
      { id: 'open', title: '打开文件', detail: host.desktop ? 'Ctrl+O' : '需要 Tauri 桌面版', category: 'file', disabled: !host.desktop || host.fileBusy.value, action: () => void host.openFile() },
      { id: 'save', title: '保存文件', detail: 'Ctrl+S', category: 'action', disabled: !host.desktop || host.fileBusy.value || host.activeDoc.value?.kind === 'javaClass', action: () => void host.saveActive() },
      { id: 'save-as', title: '另存为', detail: 'Ctrl+Shift+S', category: 'action', disabled: !host.desktop || host.fileBusy.value || host.activeDoc.value?.kind === 'javaClass', action: () => void host.saveActive(true) },
      { id: 'history', title: '历史版本…', detail: '查看并恢复已保存的版本', category: 'action', disabled: !host.desktop || !host.activeDoc.value?.path, action: () => host.openHistory() },
      { id: 'save-utf8', title: '另存为 UTF-8', detail: '转换编码，无 BOM', category: 'action', disabled: !host.desktop || host.fileBusy.value || host.activeDoc.value?.kind === 'javaClass' || host.activeDoc.value?.encoding === 'Hex', action: () => void host.saveActive(true, 'UTF-8') },
      { id: 'import-html', title: '导入 HTML…', detail: 'HTML 转 Markdown', category: 'action', action: () => void host.runFileOperation(() => host.importController.importDocument('html')) },
      { id: 'import-docx', title: '导入 Word (.docx)…', detail: 'Word 转 Markdown (Pandoc)', category: 'action', action: () => void host.runFileOperation(() => host.importController.importDocument('docx')) },
      { id: 'export-pdf', title: '导出 PDF…', detail: '导出为 PDF 文档', category: 'action', disabled: !host.exportController.canExportActive(), action: () => void host.runFileOperation(() => host.exportController.exportDocument('pdf')) },
      { id: 'export-html', title: '导出 HTML…', detail: '包含排版样式', category: 'action', disabled: !host.exportController.canExportActive(), action: () => void host.runFileOperation(() => host.exportController.exportDocument('html')) },
      { id: 'export-html-plain', title: '导出 HTML（无主题样式）…', detail: '语义化纯 HTML', category: 'action', disabled: !host.exportController.canExportActive(), action: () => void host.runFileOperation(() => host.exportController.exportDocument('html-plain')) },
      { id: 'export-docx', title: '导出 Word (.docx)…', detail: 'Markdown 转 Word (Pandoc)', category: 'action', disabled: !host.exportController.canExportActive(), action: () => void host.runFileOperation(() => host.exportController.exportDocument('docx')) },
      { id: 'export-png', title: '导出 PNG 长图…', detail: '整页高清长图', category: 'action', disabled: !host.exportController.canExportActive(), action: () => void host.runFileOperation(() => host.exportController.exportDocument('png')) },
      { id: 'export-repeat', title: '使用上一次设置导出', detail: '', category: 'action', disabled: !host.exportController.canExportActive(), action: () => void host.runFileOperation(() => host.exportController.exportRepeat()) },
      { id: 'export-settings', title: '导出设置…', detail: '首选项', category: 'action', action: () => host.openSettings('conversion') },
      { id: 'find', title: '查找当前文档', detail: 'Ctrl+F', category: 'action', action: () => host.manager.command('find') },
      { id: 'replace', title: '替换当前文档', detail: 'Ctrl+R', category: 'action', disabled: host.activeDoc.value?.kind === 'javaClass', action: () => host.manager.command('replace') },
      { id: 'find-next', title: '查找下一个', detail: 'F3', category: 'action', action: () => host.manager.command('find-next') },
      { id: 'find-previous', title: '查找上一个', detail: 'Shift+F3', category: 'action', action: () => host.manager.command('find-previous') },
      { id: 'switch-pane', title: '切换活动窗格', detail: 'Ctrl+Alt+Right', category: 'action', disabled: !host.manager.isSplit, action: () => host.manager.switchPane() },
      { id: 'uppercase', title: '选区转大写', detail: 'Ctrl+Alt+U', category: 'action', action: () => host.manager.transformSelection(true) },
      { id: 'lowercase', title: '选区转小写', detail: 'Ctrl+Alt+L', category: 'action', action: () => host.manager.transformSelection(false) },
      { id: 'goto-line', title: '转到指定行', detail: 'Ctrl+G', category: 'action', action: host.openGotoLine },
      { id: 'split-editor', title: '向右拆分分栏', detail: '', category: 'action', action: () => host.manager.splitPane('right') },
      { id: 'split-down', title: '向下拆分', detail: '', category: 'action', action: () => host.manager.splitPane('bottom') },
      { id: 'split-left', title: '向左拆分', detail: '', category: 'action', action: () => host.manager.splitPane('left') },
      { id: 'split-up', title: '向上拆分', detail: '', category: 'action', action: () => host.manager.splitPane('top') },
      { id: 'maximize-pane', title: '最大化当前编辑器', detail: '', category: 'action', action: () => host.manager.layout.maximizePane(host.manager.activePaneId) },
      { id: 'restore-pane', title: '恢复编辑器布局', detail: '', category: 'action', action: () => host.manager.layout.restoreMaximized() },
      { id: 'merge-panes', title: '合并所有分栏', detail: '', category: 'action', action: () => host.manager.mergeAllPanes() },
      { id: 'close-current-pane', title: '关闭当前分栏', detail: '', category: 'action', disabled: !host.manager.isSplit, action: () => host.manager.closePane(host.manager.activePaneId) },
      { id: 'delete-line', title: '删除当前行', detail: 'Ctrl+Shift+K', category: 'action', action: () => host.manager.command('delete-line') },
      { id: 'copy-line-down', title: '向下复制行', detail: 'Shift+Alt+Down', category: 'action', action: () => host.manager.command('copy-line-down') },
      { id: 'move-line-up', title: '向上移动行', detail: 'Alt+Up', category: 'action', action: () => host.manager.command('move-line-up') },
      { id: 'move-line-down', title: '向下移动行', detail: 'Alt+Down', category: 'action', action: () => host.manager.command('move-line-down') },
      { id: 'comment-line', title: '切换行注释', detail: 'Ctrl+/', category: 'action', action: () => host.manager.command('comment-line') },
      { id: 'fold-code', title: '折叠当前代码块', detail: 'Ctrl+Alt+[', category: 'action', action: () => host.manager.command('fold-code') },
      { id: 'unfold-code', title: '展开当前代码块', detail: 'Ctrl+Alt+]', category: 'action', action: () => host.manager.command('unfold-code') },
      {
        id: 'next-tab',
        title: '切换到下一标签',
        detail: '',
        category: 'action',
        action: () => {
          const group = host.manager.paneGroup(host.manager.activePane)
          const tabs = group.tabs
          if (tabs.length > 1 && group.activeId) {
            const idx = tabs.findIndex(t => t.documentId === group.activeId)
            const next = tabs[(idx + 1) % tabs.length]
            if (next) host.manager.select(next.documentId, host.manager.activePane)
          }
        },
      },
      {
        id: 'previous-tab',
        title: '切换到上一标签',
        detail: '',
        category: 'action',
        action: () => {
          const group = host.manager.paneGroup(host.manager.activePane)
          const tabs = group.tabs
          if (tabs.length > 1 && group.activeId) {
            const idx = tabs.findIndex(t => t.documentId === group.activeId)
            const prev = tabs[(idx - 1 + tabs.length) % tabs.length]
            if (prev) host.manager.select(prev.documentId, host.manager.activePane)
          }
        },
      },
      { id: 'recent-tab', title: '切换最近使用标签', detail: '', category: 'action', action: () => {
        const pane=host.manager.activePane,group=host.manager.paneGroup(pane)
        const id=group.recentDocumentIds.find(id=>id!==group.activeId)
        if(id){host.manager.select(id,pane);host.manager.focusPane(pane)}
      } },
      { id: 'show-open-tabs', title: '显示已打开文件', detail: '', category: 'action', action: () => {
        const pane=[...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(element=>element.dataset.paneId===host.manager.activePane)
        pane?.querySelector<HTMLButtonElement>('.open-tabs-button')?.click()
      } },
      { id: 'toggle-outline', title: '显示/隐藏大纲', detail: host.outlineSupported.value ? '' : '当前文件不支持大纲', category: 'action', disabled: !host.outlineSupported.value, action: host.toggleOutline },
      { id: 'toggle-focus', title: '切换专注模式', detail: 'F8', category: 'action', action: host.toggleFocus },
      { id: 'toggle-typewriter', title: '切换打字机模式', detail: 'F9', category: 'action', action: host.toggleTypewriter },
      { id: 'focus-left-pane', title: '聚焦左侧分栏', detail: '', category: 'action', action: () => host.manager.layout.focusDirection('left') },
      { id: 'focus-right-pane', title: '聚焦右侧分栏', detail: '', category: 'action', action: () => host.manager.layout.focusDirection('right') },
      { id: 'focus-up-pane', title: '聚焦上方分栏', detail: '', category: 'action', action: () => host.manager.layout.focusDirection('up') },
      { id: 'focus-down-pane', title: '聚焦下方分栏', detail: '', category: 'action', action: () => host.manager.layout.focusDirection('down') },
      { id: 'focus-next-pane', title: '切换到下一个分栏', detail: '', category: 'action', action: () => host.manager.layout.focusNextPane() },
      { id: 'copy-path', title: '复制文件完整路径', detail: '剪贴板', category: 'action', disabled: !host.activeDoc.value?.path, action: () => void host.copyFullPath() },
      { id: 'copy-relative-path', title: '复制文件相对路径', detail: '剪贴板', category: 'action', disabled: !host.activeDoc.value?.path, action: () => void host.copyRelativePath() },
      { id: 'reveal-explorer', title: '在文件管理器中显示', detail: host.desktop ? '系统资源管理器' : '需要 Tauri 桌面版', category: 'action', disabled: !host.desktop || !host.activeDoc.value?.fileToken, action: () => void host.revealInExplorer() },
      { id: 'zoom-in', title: '放大字体', detail: 'Ctrl+=', category: 'action', action: host.zoomIn },
      { id: 'zoom-out', title: '缩小字体', detail: 'Ctrl+-', category: 'action', action: host.zoomOut },
      { id: 'zoom-reset', title: '恢复默认字体大小', detail: 'Ctrl+0', category: 'action', action: host.resetZoom },
      { id: 'undo', title: '撤销', detail: 'Ctrl+Z', category: 'action', action: () => host.manager.command('undo') },
      { id: 'redo', title: '重做', detail: 'Ctrl+Y', category: 'action', action: () => host.manager.command('redo') },
      { id: 'open-workspace', title: '打开工作区文件夹', detail: host.desktop ? '选择目录' : '需要 Tauri 桌面版', category: 'action', disabled: !host.desktop || host.fileBusy.value, action: () => void host.workspace.openWorkspaceDialog() },
      { id: 'add-workspace', title: '添加文件夹到工作区…', detail: host.desktop ? '选择目录 · 保留现有文件夹' : '需要 Tauri 桌面版', category: 'action', disabled: !host.desktop || host.fileBusy.value, action: () => void host.workspace.openWorkspaceDialog(true) },
      { id: 'workspace-search', title: '工作区全文搜索', detail: 'Ctrl+Shift+F', category: 'action', action: () => { host.appMode.value = 'workspace'; host.sidebarPanel.value = 'search'; host.sidebarVisible.value = true; host.workspace.focusWorkspaceSearch() } },
      { id: 'workspace-replace', title: '工作区替换', detail: 'Ctrl+Shift+R', category: 'action', action: () => { host.appMode.value = 'workspace'; host.sidebarPanel.value = 'search'; host.sidebarVisible.value = true; host.workspace.focusWorkspaceSearch(true) } },
      { id: 'refresh-workspace', title: '刷新工作区目录树', detail: '工作区', category: 'action', disabled: !host.workspace.rootPath, action: () => void host.workspace.refreshDirectory() },
      { id: 'single', title: '切换到单文件模式', detail: '布局', category: 'action', action: () => host.setMode('single') },
      { id: 'workspace', title: '切换到工作区模式', detail: '布局', category: 'action', action: () => host.setMode('workspace') },
      { id: 'sidebar', title: '显示/隐藏侧边栏', detail: '', category: 'action', action: host.toggleSidebar },
      { id: 'theme', title: '切换主题：深色 / 浅色 / 跟随系统', detail: '外观', category: 'action', action: host.toggleTheme },
      { id: 'settings', title: '打开首选项', detail: '设置', category: 'action', action: host.openSettings },
    ]
    const encodings: Encoding[] = ['UTF-8', 'UTF-16LE', 'UTF-16BE', 'GB18030', 'windows-1252']
    if (isMedia(host.activeDoc.value)) {
      const textCommands = new Set([
        'save',
        'save-as',
        'save-utf8',
        'cut',
        'paste',
        'replace',
        'undo',
        'redo',
        'uppercase',
        'lowercase',
        'goto-line',
        'delete-line',
        'copy-line-down',
        'move-line-up',
        'move-line-down',
        'comment-line',
        'fold-code',
        'unfold-code',
      ])
      for (const action of actions) if (textCommands.has(action.id)) action.disabled = true
    }
    for (const action of actions) {
      const definition = commandDefinition(action.id)
      if (definition) action.detail = shortcutLabel(host.shortcuts.value[definition.id])
    }
    return [
      ...actions,
      { id: 'open-file-bytes', title: '以字节方式打开文件', detail: '可编辑十六进制', category: 'action' as const, disabled: !host.desktop || host.fileBusy.value, action: () => void host.openFile('Hex') },
      { id: 'edit-file-bytes', title: '编辑文件字节', detail: '可编辑十六进制', category: 'action' as const, disabled: !host.desktop || !host.activeDoc.value?.fileToken || host.fileBusy.value || isMedia(host.activeDoc.value), action: () => void host.reopenEncoding('Hex') },
      { id: 'inspect-class', title: '查看 JVM ClassFile 结构', detail: '只读结构信息', category: 'action' as const, disabled: !host.desktop || !host.activeDoc.value?.fileToken || host.activeDoc.value.encoding !== 'Hex' || host.fileBusy.value, action: () => void host.reopenEncoding('ClassInfo') },
      ...encodings.map(encoding => ({ id: `open-${encoding}`, title: `按 ${encoding} 编码打开文件`, detail: '原生文件选择', category: 'action' as const, disabled: !host.desktop || host.fileBusy.value, action: () => void host.openFile(encoding) })),
      ...encodings.map(encoding => ({ id: `reopen-${encoding}`, title: `用 ${encoding} 编码重新打开`, detail: '需要先保存修改', category: 'action' as const, disabled: !host.desktop || !host.activeDoc.value?.fileToken || host.fileBusy.value || isMedia(host.activeDoc.value), action: () => void host.reopenEncoding(encoding) })),
      ...recentWorkspaces().map(path => ({ id: recentWorkspaceCommand(path), title: `打开工作区：${path.split(/[\\/]/).pop()}`, detail: readablePath(path), category: 'action' as const, disabled: !host.desktop || host.fileBusy.value, action: () => void host.workspace.openWorkspacePath(path) })),
      ...(host.demo ? host.manager.catalog : host.openedDocuments.value).map(doc => ({
        id: `file-${doc.id}`,
        title: doc.name,
        fileName: doc.name,
        detail: doc.path ? readablePath(doc.path) : '未命名 · 内存草稿',
        category: 'file' as const,
        source: 'open' as const,
        path: doc.path || undefined,
        relativePath: doc.path ? readablePath(doc.path) : undefined,
        priority: host.activeDoc.value?.id === doc.id ? 36 : 24,
        action: () => host.handleSelectDoc(doc.id),
        execute: (options: PaletteExecuteOptions) => {
          if (options.pinned) host.manager.pin(doc.id)
          host.handleSelectDoc(doc.id, !options.pinned)
          if (doc.path) focusOpenedPath(doc.path, options)
          else focusActiveEditor()
        },
      })),
      ...(host.paletteRef.value?.visible ? host.workspace.getAllKnownFiles() : []).map(file => {
        const node = {
          id: file.relativePath,
          name: file.name,
          path: file.path,
          relativePath: file.relativePath,
          isDirectory: false,
          isSymlink: false,
          isReadOnly: false,
          size: 0,
          mtime: null,
          hasChildren: false,
        }
        return {
          id: `ws-${file.path}`,
          title: file.name,
          fileName: file.name,
          detail: file.relativePath,
          category: 'file' as const,
          source: 'workspace' as const,
          path: file.path,
          relativePath: file.relativePath,
          priority: 0,
          disabled: host.fileBusy.value,
          action: () => void openWorkspaceEntry(node),
          execute: (options: PaletteExecuteOptions) => openWorkspaceEntry(node, options),
        }
      }),
      ...recentFiles().map((file, index) => ({
        id: recentFileCommand(file.path),
        title: file.name,
        fileName: file.name,
        detail: readablePath(file.path),
        category: 'file' as const,
        source: 'recent' as const,
        path: file.path,
        relativePath: readablePath(file.path),
        priority: Math.max(2, 14 - index),
        disabled: !host.desktop || host.fileBusy.value,
        action: () => void openRecentEntry(file.path),
        execute: (options: PaletteExecuteOptions) => openRecentEntry(file.path, options),
      })),
    ]
  }

  const commandRegistry = computed(() => {
    const actions = paletteActions.value
    const commands = actions.map(action => {
      const definition = commandDefinition(action.id)
      const clipboardKey = ({ cut: 'Mod+X', copy: 'Mod+C', paste: 'Mod+V', 'select-all': 'Mod+A' } as Record<string, string>)[action.id]
      return {
        id: action.id,
        title: action.title,
        detail: action.detail,
        enabled: !action.disabled && (definition?.category !== 'markdown' || (!!host.activeDoc.value?.mode && !host.manager.isComposing)),
        shortcut: definition ? host.shortcuts.value[definition.id] : clipboardKey,
        run: action.action,
      }
    })
    for (const command of allCommands) {
      if (commands.some(item => item.id === command.id)) continue
      const entry = commands.find(item => item.id === command.executeId)
      if (entry) commands.push({ ...entry, id: command.id, shortcut: host.shortcuts.value[command.id] })
    }
    return new CommandRegistry(commands)
  })

  const menuGroups = computed(() => {
    try {
      host.revision.value
      return mainMenu({
        sidebar: host.sidebarVisible.value,
        outline: host.showOutline.value,
        wrap: host.wordWrap.value,
        split: host.manager.isSplit,
        focus: host.focusMode.value,
        markdown: !!host.activeDoc.value?.mode,
        markdownMode: host.activeDoc.value?.mode,
        composing: host.manager.isComposing,
        recentFiles: recentFiles(),
        recentWorkspaces: recentWorkspaces(),
        canExport: host.exportController.canExportActive(),
      })
    } catch (error) {
      reportRenderError('主菜单', error)
      return []
    }
  })

  function executeCommand(id: string) {
    if (host.startupLoading.value) return
    try {
      const result = commandRegistry.value.execute(id)
      if (result instanceof Promise) void result.catch(error => host.toast(fileError(error)))
    } catch (error) {
      host.toast(fileError(error))
    }
  }

  async function clipboardAction(operation: ClipboardOperation) {
    try {
      const element = document.activeElement
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        await inputClipboard(element, operation, textClipboard)
      } else if (host.manager.activeDocument?.kind === 'pdf') {
        if (operation === 'copy') await textClipboard.writeText(window.getSelection()?.toString() || '')
        else if (operation === 'select-all') {
          const targetPane = host.manager.activePane
          const hostEl = document.querySelector(`[data-pane-id="${targetPane}"] .pdf-pages`)
          if (hostEl) {
            const range = document.createRange()
            range.selectNodeContents(hostEl)
            window.getSelection()?.removeAllRanges()
            window.getSelection()?.addRange(range)
          }
        }
      } else {
        const editor = element instanceof HTMLElement ? element.closest<HTMLElement>('.cm-editor') : null
        const view = (editor && EditorView.findFromDOM(editor)) || host.manager.activeEditorView
        if (operation === 'paste' && host.manager.activeDocument?.mode && host.desktop && view && !host.manager.activeLiveEditor) {
          if (host.fileBusy.value || host.manager.isComposing || host.files.workspaceBusy || host.files.saving.size) return
          const id = host.manager.activeId!
          host.manager.pin(id)
          host.fileBusy.value = true
          const before = view.state
          let hasImages = false
          try {
            await host.imageImporter.insert(id, async () => {
              const sources = await host.clipboardImages()
              hasImages = !!sources.length
              return sources
            })
            if (hasImages) return
          } finally {
            host.fileBusy.value = false
            void host.drainPending()
          }
          if (host.manager.activeId !== id || host.manager.activeEditorView !== view || view.state.doc !== before.doc || !view.state.selection.eq(before.selection)) {
            throw new Error('读取剪贴板期间文档或选区变化，已取消粘贴。')
          }
        }
        if (host.manager.activeLiveEditor) {
          const live = host.manager.activeLiveEditor
          const id = host.manager.activeId!
          const selection = live.selection
          if (operation === 'paste' && host.desktop) {
            const sources = await host.clipboardImages()
            if (host.manager.activeLiveEditor !== live || host.manager.activeId !== id || live.selection.anchor !== selection.anchor || live.selection.head !== selection.head) {
              throw new Error('读取剪贴板期间文档或选区变化，已取消粘贴。')
            }
            if (sources.length) {
              await host.importImages(id, sources)
              return
            }
          }
          await live.clipboard(operation)
        } else if (view) {
          await editorClipboard(view, operation, textClipboard)
        }
      }
    } catch (error) {
      host.toast(fileError(error))
    }
  }

  const doubleShift = new DoubleShiftShortcut(
    () => executeCommand('quick-open'),
    event =>
      !host.updateInstalling.value &&
      !host.startupLoading.value &&
      !host.manager.isComposing &&
      !host.paletteRef.value?.visible &&
      !host.settingsRef.value?.visible &&
      !host.discardRef.value?.visible &&
      !host.gotoLineRef.value?.visible &&
      !document.querySelector('.recording-box,.workspace-operation-dialog,.app-menu-popup,[aria-modal="true"]') &&
      keybindingContext(event.target, !!host.manager.activeDocument?.mode) !== 'dialog',
  )

  function handleGlobalKeydown(event: KeyboardEvent) {
    doubleShift.keydown(event)
    if (host.updateInstalling.value) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (document.querySelector('.recording-box')) return
    if (host.startupLoading.value) {
      if (event.ctrlKey || event.metaKey) event.preventDefault()
      return
    }
    const alreadyHandled = event.defaultPrevented
    // Never let the WebView reload, including dialogs and customized bindings.
    if (eventShortcut(event) === 'Mod+R') event.preventDefault()
    if (
      document.querySelector('.app-menu-popup') &&
      document.activeElement?.closest('[data-menu-popup],.app-menu') &&
      !(event.ctrlKey || event.metaKey || event.altKey)
    ) return
    if (
      document.querySelector('.workspace-operation-dialog') ||
      event.isComposing ||
      alreadyHandled ||
      host.manager.isComposing ||
      host.paletteRef.value?.visible ||
      host.settingsRef.value?.visible ||
      host.discardRef.value?.visible ||
      host.gotoLineRef.value?.visible
    ) return
    const binding = eventShortcut(event)
    const context = keybindingContext(event.target, !!host.manager.activeDocument?.mode)
    if (context === 'dialog') return
    if (
      (context === 'input' || context === 'search') &&
      ['Mod+Z', 'Mod+Y', 'Mod+Shift+Z', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A'].includes(binding)
    ) return
    if (
      host.desktop &&
      binding === 'Mod+V' &&
      event.target instanceof Element &&
      event.target.closest('.cm-content,.md-prose') &&
      host.manager.activeDocument?.mode
    ) {
      event.preventDefault()
      event.stopPropagation()
      void clipboardAction('paste')
      return
    }
    const command = matchingCommand(binding, host.shortcuts.value, context)
    if (command) {
      // Resolve the focused pane before executing; nested CodeMirror commands
      // are routed by DocumentManager to that exact view.
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat && !command.repeatable) return
      const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId : undefined
      if (pane) host.manager.focusPane(pane, false)
      executeCommand(command.id)
      return
    }
    if (isManagedDefault(binding, context, host.keymapPreset.value)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (host.manager.activeLiveEditor?.shortcut(event)) return
    if (event.key === 'Escape' && host.focusMode.value && !document.querySelector('.cm-search, .cm-tooltip')) {
      event.preventDefault()
      host.exitFocus()
    }
  }

  function mountListeners(target: Window) {
    target.addEventListener('keydown', handleGlobalKeydown, true)
    target.addEventListener('keyup', doubleShift.keyup, true)
    target.addEventListener('blur', doubleShift.reset)
    target.addEventListener('pointerdown', doubleShift.reset, true)
    target.addEventListener('compositionstart', doubleShift.reset, true)
  }

  function unmountListeners(target: Window) {
    target.removeEventListener('keydown', handleGlobalKeydown, true)
    target.removeEventListener('keyup', doubleShift.keyup, true)
    target.removeEventListener('blur', doubleShift.reset)
    target.removeEventListener('pointerdown', doubleShift.reset, true)
    target.removeEventListener('compositionstart', doubleShift.reset, true)
    doubleShift.reset()
  }

  return {
    paletteActions,
    commandRegistry,
    menuGroups,
    executeCommand,
    clipboardAction,
    handleGlobalKeydown,
    doubleShift,
    mountListeners,
    unmountListeners,
  }
}
