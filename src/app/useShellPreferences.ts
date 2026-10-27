import { ref, computed, watch, nextTick, type Ref } from 'vue'
import type { Theme, ThemePreference, MarkdownMode } from '../types'
import {
  currentSettingsVersion,
  currentShortcutVersion,
  defaultShortcuts,
  normalizeShortcut,
  fontFamilies,
  loadEditorSettings,
  saveEditorSettings,
  validateShortcuts,
  shortcutLabel,
  type EditorSettings,
  type ShortcutAction,
} from '../features/shell/editorSettings'
import { allCommands, getPresetBindings, type KeymapPresetId } from '../features/shell/keybindings'
import { defaultImageRules, imageRuleKey, type ImageRules } from '../editor/markdown/imageImport'
import { defaultMarkdownTypography, defaultMarkdownClipboard } from '../editor/markdown/wysiwyg/contracts'
import { applySyntaxStyle } from '../editor/core/syntaxTheme'
import { fileError } from '../features/files/FileController'
import type { DocumentManager } from '../editor/core/DocumentManager'
import type { WorkspaceController } from '../features/workspace/WorkspaceController'
import type { AutoSaveController } from '../features/files/AutoSaveController'

export interface ShellPreferencesHost {
  desktop: boolean
  isAlive: () => boolean
  toast: (message: string) => void
  manager: DocumentManager
  workspace: WorkspaceController
  autoSaver: AutoSaveController
  revision: Ref<number>
  getActiveDoc: () => { path?: string; fileToken?: string; mode?: unknown; name?: string } | null
}

export function useShellPreferences(host: ShellPreferencesHost) {
  const theme = ref<ThemePreference>('system')
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  const systemDark = ref(systemTheme.matches)
  const resolvedTheme = computed<Theme>(() => (theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value))

  function updateSystemTheme(event: MediaQueryListEvent) {
    systemDark.value = event.matches
  }
  systemTheme.addEventListener('change', updateSystemTheme)

  const uiFontSize = ref(14)
  const fontSize = ref(14)
  const wordWrap = ref(false)
  const showOutline = ref(false)
  // Persist only the user's choice. File capability, parser progress and layout
  // visibility are derived elsewhere and must never write back to this ref.
  const defaultMdMode = ref<MarkdownMode>('live')
  const liveToolbar = ref(true)
  const fontFamily = ref<EditorSettings['fontFamily']>('system')
  const indentSize = ref(2)
  const useTabs = ref(false)

  const autoCheckUpdates = ref(true)
  const autoDownloadUpdates = ref(false)
  const externalFileMonitoring = ref(true)
  const autoReloadExternal = ref(true)
  const autoSave = ref(false)
  const autoSaveDelay = ref(1500)

  const treeClickMode = ref<'double' | 'single'>('single')
  const autoFollowActiveFile = ref(false)
  const smartExpand = ref(true)
  const compactFolders = ref(false)

  const syntaxStyle = ref<EditorSettings['syntaxStyle']>('soft')
  const bracketMode = ref<EditorSettings['bracketMode']>('matching')
  const keymapPreset = ref<KeymapPresetId>('markumo')
  const caretAnimation = ref<EditorSettings['caretAnimation']>('smooth')
  const typewriterMode = ref(false)

  const markdownTypography = ref(defaultMarkdownTypography())
  const outlineWidth = ref(240)
  const markdownClipboard = ref(defaultMarkdownClipboard())

  const imageRules = ref(defaultImageRules())
  const documentImageRules = ref<Record<string, ImageRules>>({})

  const shortcuts = ref<EditorSettings['shortcuts']>({ ...defaultShortcuts })
  const fileModes = ref<Record<string, MarkdownMode>>({})
  const customShortcuts = ref<ShortcutAction[]>([])

  const settingsReady = ref(false)
  let settingsTimer: ReturnType<typeof setTimeout> | undefined
  let settingsWrites: Promise<void> = Promise.resolve()
  let settingsError: unknown = null
  let disposed = false
  let loadGeneration = 0

  const currentDocumentImageRules = computed(() => {
    const doc = host.getActiveDoc()
    return doc?.path ? documentImageRules.value[imageRuleKey(doc.path)] || null : null
  })

  function updateDocumentImageRules(rules: ImageRules | null) {
    const doc = host.getActiveDoc()
    if (!doc?.fileToken || !doc.mode || !doc.path) return
    const key = imageRuleKey(doc.path)
    const next = { ...documentImageRules.value }
    if (rules) next[key] = rules
    else delete next[key]
    documentImageRules.value = Object.fromEntries(Object.entries(next).slice(-100))
  }

  // --- Document Manager and Workspace Synchronization Watchers ---

  watch(
    resolvedTheme,
    value => {
      document.body.classList.toggle('light', value === 'light')
      document.documentElement.style.colorScheme = value
      host.manager.setTheme(value)
    },
    { immediate: true },
  )

  // Serialize native updates so rapid choices cannot leave the title bar on an older theme.
  let nativeThemeWrites: Promise<void> = Promise.resolve()
  watch(
    theme,
    value => {
      if (!host.desktop) return
      nativeThemeWrites = nativeThemeWrites
        .then(async () => {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          if (host.isAlive()) await getCurrentWindow().setTheme(value === 'system' ? null : value)
        })
        .catch(error => {
          if (host.isAlive()) host.toast(`窗口主题切换失败：${fileError(error)}`)
        })
    },
    { immediate: true },
  )

  watch(wordWrap, value => host.manager.setWrap(value), { immediate: true })
  watch(defaultMdMode, value => host.manager.setDefaultMarkdownMode(value), { immediate: true })
  watch(syntaxStyle, value => applySyntaxStyle(value), { immediate: true, flush: 'sync' })
  watch(bracketMode, value => host.manager.setBracketMode(value), { immediate: true })
  watch(caretAnimation, value => host.manager.setCaretAnimation(value), { immediate: true })
  watch(typewriterMode, value => host.manager.setTypewriterMode(value), { immediate: true })
  watch(markdownTypography, value => host.manager.setMarkdownTypography(value), { immediate: true, deep: true })
  watch(markdownClipboard, value => host.manager.setMarkdownClipboard(value), { immediate: true, deep: true })

  watch(
    uiFontSize,
    value => {
      document.documentElement.style.setProperty('--ui-font-size', `${value}px`)
    },
    { immediate: true },
  )

  watch(
    fontSize,
    value => {
      document.documentElement.style.setProperty('--editor-size', `${value}px`)
      host.manager.refreshTypography()
    },
    { immediate: true },
  )

  watch(
    fontFamily,
    value => {
      document.documentElement.style.setProperty('--font-mono', fontFamilies[value])
      host.manager.refreshTypography()
    },
    { immediate: true },
  )

  watch([indentSize, useTabs], () => host.manager.setIndent(indentSize.value, useTabs.value), { immediate: true })

  watch(
    shortcuts,
    value =>
      host.manager.setShortcutLabels(
        Object.fromEntries(Object.entries(value).map(([id, binding]) => [id, shortcutLabel(binding)])),
      ),
    { immediate: true, deep: true },
  )

  watch([autoSave, autoSaveDelay], () =>
    host.autoSaver.configure(host.desktop && settingsReady.value && autoSave.value, autoSaveDelay.value),
  )

  watch(smartExpand, v => {
    host.workspace.smartExpand = v
  }, { immediate: true })

  watch(compactFolders, v => {
    host.workspace.compactFolders = v
  }, { immediate: true })

  // --- Snapshot, Persistence & Debounced Saving ---

  function settingsSnapshot(): EditorSettings {
    return {
      autoCheckUpdates: autoCheckUpdates.value,
      autoDownloadUpdates: autoDownloadUpdates.value,
      caretAnimation: caretAnimation.value,
      outlineWidth: outlineWidth.value,
      markdownClipboard: { ...markdownClipboard.value },
      markdownTypography: { ...markdownTypography.value },
      theme: theme.value,
      uiFontSize: uiFontSize.value,
      fontSize: fontSize.value,
      fontFamily: fontFamily.value,
      wordWrap: wordWrap.value,
      showOutline: showOutline.value,
      typewriterMode: typewriterMode.value,
      externalFileMonitoring: externalFileMonitoring.value,
      autoReloadExternal: autoReloadExternal.value,
      autoSave: autoSave.value,
      autoSaveDelay: autoSaveDelay.value,
      treeClickMode: treeClickMode.value,
      autoFollowActiveFile: autoFollowActiveFile.value,
      smartExpand: smartExpand.value,
      compactFolders: compactFolders.value,
      syntaxStyle: syntaxStyle.value,
      bracketMode: bracketMode.value,
      keymapPreset: keymapPreset.value,
      defaultMdMode: defaultMdMode.value,
      liveToolbar: liveToolbar.value,
      indentSize: indentSize.value,
      useTabs: useTabs.value,
      imageRules: { ...imageRules.value },
      documentImageRules: { ...documentImageRules.value },
      settingsVersion: currentSettingsVersion,
      legacyAutoSaveNotice: false,
      shortcutVersion: currentShortcutVersion,
      customShortcuts: [...customShortcuts.value],
      shortcuts: { ...shortcuts.value },
      fileModes: { ...fileModes.value },
    }
  }

  function flushSettings(strict = false) {
    if (settingsTimer) clearTimeout(settingsTimer)
    settingsTimer = undefined
    if (!settingsReady.value) return settingsWrites
    const settings = settingsSnapshot()
    settingsWrites = settingsWrites
      .then(() => saveEditorSettings(settings))
      .then(() => {
        settingsError = null
      })
      .catch(error => {
        settingsError = error
        host.toast(`首选项保存失败：${fileError(error)}`)
      })
    return settingsWrites.then(() => {
      if (strict && settingsError) throw settingsError
    })
  }

  watch(
    [
      autoCheckUpdates,
      autoDownloadUpdates,
      caretAnimation,
      outlineWidth,
      markdownClipboard,
      markdownTypography,
      theme,
      uiFontSize,
      fontSize,
      fontFamily,
      wordWrap,
      showOutline,
      defaultMdMode,
      indentSize,
      useTabs,
      shortcuts,
      fileModes,
      externalFileMonitoring,
      autoReloadExternal,
      autoSave,
      autoSaveDelay,
      treeClickMode,
      autoFollowActiveFile,
      smartExpand,
      compactFolders,
      syntaxStyle,
      bracketMode,
      keymapPreset,
      imageRules,
      documentImageRules,
    ],
    () => {
      if (!settingsReady.value) return
      if (settingsTimer) clearTimeout(settingsTimer)
      settingsTimer = setTimeout(() => void flushSettings(), 250)
    },
    { deep: true },
  )

  watch(host.revision, () => {
    if (!settingsReady.value) return
    for (const doc of host.manager.openedDocuments) {
      if (doc.fileToken && doc.mode && fileModes.value[doc.path] !== doc.mode) {
        fileModes.value = Object.fromEntries([
          ...Object.entries(fileModes.value).filter(([path]) => path !== doc.path),
          [doc.path, doc.mode],
        ].slice(-100))
        host.manager.setFileModes(fileModes.value)
      }
    }
  })

  // --- Shortcut & Keymap Updaters ---

  function updateShortcuts(value: EditorSettings['shortcuts']) {
    value = Object.fromEntries(
      allCommands.map(command => [
        command.id,
        value[command.id] === '' ? '' : normalizeShortcut(value[command.id]) || value[command.id],
      ]),
    )
    const error = validateShortcuts(value, shortcuts.value)
    if (error) {
      host.toast(error)
      return
    }
    customShortcuts.value = allCommands
      .filter(command => value[command.id] !== getPresetBindings(keymapPreset.value)[command.id])
      .map(command => command.id)
    shortcuts.value = value
  }

  function updateKeymap(value: { preset: KeymapPresetId; bindings: Record<string, string> }) {
    const error = validateShortcuts(value.bindings)
    if (error) {
      host.toast(error)
      return
    }
    keymapPreset.value = value.preset
    updateShortcuts(value.bindings)
  }

  // --- Load Settings on Startup ---

  async function loadPreferences(current = () => true, read = loadEditorSettings) {
    const generation = ++loadGeneration
    const canApply = () => !disposed && host.isAlive() && current() && generation === loadGeneration
    try {
      const settings = await read()
      if (!canApply()) return
      uiFontSize.value = settings.uiFontSize
      theme.value = settings.theme
      fontSize.value = settings.fontSize
      fontFamily.value = settings.fontFamily
      wordWrap.value = settings.wordWrap
      externalFileMonitoring.value = settings.externalFileMonitoring
      autoReloadExternal.value = settings.autoReloadExternal
      autoSave.value = settings.autoSave
      autoSaveDelay.value = settings.autoSaveDelay
      autoCheckUpdates.value = settings.autoCheckUpdates
      autoDownloadUpdates.value = settings.autoDownloadUpdates
      caretAnimation.value = settings.caretAnimation
      markdownTypography.value = settings.markdownTypography
      outlineWidth.value = settings.outlineWidth
      markdownClipboard.value = settings.markdownClipboard
      imageRules.value = settings.imageRules
      documentImageRules.value = settings.documentImageRules
      showOutline.value = settings.showOutline
      defaultMdMode.value = settings.defaultMdMode
      liveToolbar.value = settings.liveToolbar
      indentSize.value = settings.indentSize
      useTabs.value = settings.useTabs
      treeClickMode.value = settings.treeClickMode
      autoFollowActiveFile.value = settings.autoFollowActiveFile
      smartExpand.value = settings.smartExpand
      compactFolders.value = settings.compactFolders
      syntaxStyle.value = settings.syntaxStyle
      bracketMode.value = settings.bracketMode
      keymapPreset.value = settings.keymapPreset || 'markumo'
      shortcuts.value = settings.shortcuts
      fileModes.value = settings.fileModes
      host.manager.setFileModes(settings.fileModes)
      customShortcuts.value = settings.customShortcuts
      if (settings.legacyAutoSaveNotice) {
        host.toast('自动保存此前已开启并已保留；如不需要可在“设置”中关闭。')
      }
      await nextTick()
    } catch (error) {
      if (!canApply()) return
      if (host.desktop) throw error
      host.toast(`首选项读取失败，使用默认值：${fileError(error)}`)
    }
    if (canApply()) settingsReady.value = true
  }

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : theme.value === 'light' ? 'system' : 'dark'
  }

  function zoomIn() {
    fontSize.value = Math.min(24, fontSize.value + 1)
  }

  function zoomOut() {
    fontSize.value = Math.max(10, fontSize.value - 1)
  }

  function resetZoom() {
    fontSize.value = 14
  }

  function dispose() {
    if (disposed) return
    disposed = true
    loadGeneration++
    systemTheme.removeEventListener('change', updateSystemTheme)
    if (settingsTimer) clearTimeout(settingsTimer)
    void flushSettings()
  }

  return {
    theme,
    resolvedTheme,
    uiFontSize,
    fontSize,
    fontFamily,
    wordWrap,
    showOutline,
    typewriterMode,
    defaultMdMode,
    liveToolbar,
    indentSize,
    useTabs,
    autoCheckUpdates,
    autoDownloadUpdates,
    externalFileMonitoring,
    autoReloadExternal,
    autoSave,
    autoSaveDelay,
    treeClickMode,
    autoFollowActiveFile,
    smartExpand,
    compactFolders,
    syntaxStyle,
    bracketMode,
    keymapPreset,
    caretAnimation,
    markdownTypography,
    outlineWidth,
    markdownClipboard,
    imageRules,
    documentImageRules,
    currentDocumentImageRules,
    updateDocumentImageRules,
    shortcuts,
    fileModes,
    customShortcuts,
    settingsReady,
    settingsSnapshot,
    flushSettings,
    updateShortcuts,
    updateKeymap,
    loadPreferences,
    toggleTheme,
    zoomIn,
    zoomOut,
    resetZoom,
    dispose,
  }
}
