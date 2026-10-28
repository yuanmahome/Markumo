import { invoke, isTauri } from '@tauri-apps/api/core'
import type { MarkdownMode, ThemePreference } from '../../types'
import type { CaretAnimation } from '../../editor/core/caretMotion'
import { defaultUpdatePreferences, type UpdatePreferences } from './updater/UpdatePreferences'
import { defaultImageRules, imageRulesFrom, imageRuleKey, type ImageRules } from '../../editor/markdown/imageImport'
import { bracketModes, type BracketMode } from '../../editor/core/brackets'
import { normalizeSyntaxStyle, type SyntaxStyle } from '../../editor/core/syntaxTheme'
import { fitsSettingsText, maxSettingsPathBytes, setSettingsEntry } from './settingsLimits'
import { defaultMarkdownTypography, defaultMarkdownClipboard, type MarkdownClipboardSettings, type MarkdownTypography } from '../../editor/markdown/wysiwyg/contracts'
import {
  type KeymapPresetId,
  keybindingLabel,
  eventToKeybinding, allCommands, getPresetBindings, normalizeKeybinding, checkBindingConflict, commandsOverlap, intentionalOverlap, isPriorityConflict, effectiveBindings,
} from './keybindings'

export { keybindingLabel, eventToKeybinding }
/** Defaults and settings rows are projections of the executable command catalog. */
export const defaultShortcuts = getPresetBindings('markumo')
export type ShortcutAction = string
export const shortcutLabels: Record<string,string> = Object.fromEntries(allCommands.map(command => [command.id,command.label]))
export const currentShortcutVersion = 4
/** Bumped when a stored preference needs migration. Version 4 made automatic
 * save opt-in: files written by older versions always stored the old `true`
 * default, so that value cannot prove intent. Version 5 adds independent UI typography.
 * Version 6 makes visible text the default clipboard representation for new users and unconfigured settings.
 * Version 7 replaces always-Markdown copying with opt-out automatic cross-block copying. */
export const currentSettingsVersion = 7
export interface EditorSettings extends UpdatePreferences {
  syntaxStyle: SyntaxStyle
  bracketMode: BracketMode
  caretAnimation: CaretAnimation
  outlineWidth: number
  markdownClipboard:MarkdownClipboardSettings
  markdownTypography:MarkdownTypography
  theme: ThemePreference; uiFontSize: number; fontSize: number; fontFamily: 'system' | 'consolas' | 'cascadia'
  wordWrap: boolean; showOutline: boolean; typewriterMode: boolean; indentSize: number; useTabs: boolean; defaultMdMode: MarkdownMode
  liveToolbar: boolean
  externalFileMonitoring: boolean; autoReloadExternal: boolean
  autoSave: boolean; autoSaveDelay: number
  treeClickMode: 'double' | 'single'
  autoFollowActiveFile: boolean
  smartExpand: boolean
  compactFolders: boolean
  keymapPreset: KeymapPresetId
  imageRules: ImageRules
  documentImageRules: Record<string, ImageRules>
  settingsVersion: number
  /** Transient migration notice for the UI. Never persisted. */
  legacyAutoSaveNotice: boolean
  shortcutVersion: number
  customShortcuts: ShortcutAction[]
  shortcuts: Record<ShortcutAction, string>; fileModes: Record<string, MarkdownMode>
}
export const fontFamilies = { system: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', consolas: 'Consolas, monospace', cascadia: '"Cascadia Code", Consolas, monospace' }
export function defaultSettings(): EditorSettings {
  const markdownClipboard = defaultMarkdownClipboard(), outlineWidth = 240
  return { bracketMode: 'matching', syntaxStyle: 'soft', ...defaultUpdatePreferences(), caretAnimation: 'smooth', outlineWidth, markdownClipboard, markdownTypography:defaultMarkdownTypography(), theme: 'system', uiFontSize: 14, fontSize: 14, fontFamily: 'system', wordWrap: false, showOutline: false, typewriterMode: false, indentSize: 2, useTabs: false, defaultMdMode: 'live', liveToolbar: true, externalFileMonitoring: true, autoReloadExternal: true, autoSave: false, autoSaveDelay: 1500, treeClickMode: 'single', autoFollowActiveFile: false, smartExpand: true, compactFolders: false, keymapPreset: 'markumo', imageRules: defaultImageRules(), documentImageRules: {}, settingsVersion: currentSettingsVersion, legacyAutoSaveNotice: false, shortcutVersion: currentShortcutVersion, customShortcuts:[], shortcuts: { ...defaultShortcuts }, fileModes: {} }
}
/** Drop the transient migration notice before writing preferences to disk. */
export function persistedSettings(settings: EditorSettings) {
  const { legacyAutoSaveNotice: _transient, ...persisted } = settings
  return persisted
}
export const normalizeShortcut = normalizeKeybinding
export function validateShortcuts(shortcuts: Record<string,string>, baseline: Record<string,string> = {}): string | null {
  for (const command of allCommands) {
    const raw = shortcuts[command.id]
    if (raw === '') continue // An explicit clear is persistent, never a missing default.
    const binding = normalizeShortcut(raw)
    if (!binding) return '无效快捷键：' + command.label
    const conflict = checkBindingConflict(command.id,binding,shortcuts)
    if (!conflict || isPriorityConflict(command.id,conflict,binding)) continue
    // A legacy ambiguous map is retained. Reject new conflicts, not unrelated edits.
    if (baseline[command.id] === binding && effectiveBindings(conflict.commandId,baseline).includes(binding)) continue
    return command.label + '：' + conflict.description
  }
  return null
}
export function settingsFrom(raw: unknown): EditorSettings {
  const defaults = defaultSettings()
  if (!raw || typeof raw !== 'object') return defaults
  const s = raw as Partial<EditorSettings>
  if (bracketModes.includes(s.bracketMode as BracketMode)) defaults.bracketMode = s.bracketMode!
  defaults.syntaxStyle = normalizeSyntaxStyle(s.syntaxStyle)
  if (s.caretAnimation === 'off' || s.caretAnimation === 'quick' || s.caretAnimation === 'smooth') defaults.caretAnimation = s.caretAnimation
  if (Number.isInteger(s.outlineWidth) && s.outlineWidth! >= 160 && s.outlineWidth! <= 520) defaults.outlineWidth = s.outlineWidth!
  if (s.markdownClipboard && typeof s.markdownClipboard === 'object') {
    // Both legacy copyMarkdown values already copied cross-block selections as
    // Markdown. Keep that behavior while retiring the single-block override;
    // only the new key records an explicit opt-out. Preserve whole-line copying.
    for (const key of ['copyAcrossBlocks', 'copyWholeLine'] as const) if (typeof s.markdownClipboard[key] === 'boolean') defaults.markdownClipboard[key] = s.markdownClipboard[key]
  }
  if(s.markdownTypography&&typeof s.markdownTypography==='object'){
    const md=s.markdownTypography,target=defaults.markdownTypography
    if(Number.isFinite(md.width)&&md.width>=480&&md.width<=1400)target.width=md.width
    if(Number.isFinite(md.fontSize)&&md.fontSize>=12&&md.fontSize<=28)target.fontSize=md.fontSize
    if(Number.isFinite(md.lineHeight)&&md.lineHeight>=1.2&&md.lineHeight<=2.4)target.lineHeight=md.lineHeight
    if(['system','serif','mono'].includes(md.fontFamily))target.fontFamily=md.fontFamily
    if(typeof md.codeLineNumbers==='boolean')target.codeLineNumbers=md.codeLineNumbers
    if(typeof md.codeWrap==='boolean')target.codeWrap=md.codeWrap
    if(typeof md.imageBorder==='boolean')target.imageBorder=md.imageBorder
  }
  defaults.imageRules = imageRulesFrom(s.imageRules)
  if (s.documentImageRules && typeof s.documentImageRules === 'object') for (const [path,rules] of Object.entries(s.documentImageRules).slice(-100)) {
    // Keys are normalized via imageRuleKey so drive casing, Windows backslashes
    // and UNC prefixes resolve to the same configuration entry.
    if (fitsSettingsText(path, maxSettingsPathBytes)) setSettingsEntry(defaults.documentImageRules, imageRuleKey(path), imageRulesFrom(rules))
  }
  if (s.theme === 'dark' || s.theme === 'light' || s.theme === 'system') defaults.theme = s.theme
  if (Number.isInteger(s.uiFontSize) && s.uiFontSize! >= 12 && s.uiFontSize! <= 20) defaults.uiFontSize = s.uiFontSize!
  if (Number.isInteger(s.fontSize) && s.fontSize! >= 10 && s.fontSize! <= 24) defaults.fontSize = s.fontSize!
  if (s.fontFamily && ['system','consolas','cascadia'].includes(s.fontFamily)) defaults.fontFamily = s.fontFamily
  for (const key of ['wordWrap','showOutline','typewriterMode','useTabs','autoCheckUpdates','autoDownloadUpdates','autoFollowActiveFile','smartExpand','compactFolders'] as const) if (typeof s[key] === 'boolean') defaults[key] = s[key]!
  // Automatic save is opt-in. A file written by an older version could not
  // record who enabled it, so an ambiguous legacy `true` is preserved (never
  // overwritten) and surfaced as a one-time notice instead. From version 4 on,
  // the stored value is written only by the settings UI and is authoritative.
  const legacySettings = !(Number.isInteger(s.settingsVersion) && s.settingsVersion! >= 4)
  if (typeof s.externalFileMonitoring === 'boolean') defaults.externalFileMonitoring = s.externalFileMonitoring
  if (typeof s.autoReloadExternal === 'boolean') defaults.autoReloadExternal = s.autoReloadExternal
  if (typeof s.autoSave === 'boolean') {
    defaults.autoSave = s.autoSave
    defaults.legacyAutoSaveNotice = legacySettings && s.autoSave
  } else if (legacySettings && s.autoSave !== undefined) {
    // A non-boolean legacy value is corrupt; fall back to the new safe default.
    defaults.legacyAutoSaveNotice = false
  }
  if (Number.isInteger(s.autoSaveDelay) && s.autoSaveDelay! >= 500 && s.autoSaveDelay! <= 10000) defaults.autoSaveDelay = s.autoSaveDelay!
  if (Number.isInteger(s.indentSize) && s.indentSize! >= 1 && s.indentSize! <= 8) defaults.indentSize = s.indentSize!
  if (['live','source','split'].includes(s.defaultMdMode || '')) defaults.defaultMdMode = s.defaultMdMode!
  if (typeof s.liveToolbar === 'boolean') defaults.liveToolbar = s.liveToolbar
  if (s.treeClickMode === 'single' || s.treeClickMode === 'double') defaults.treeClickMode = s.treeClickMode
  const preset = String(s.keymapPreset || '')
  if (preset === 'lightedit') defaults.keymapPreset = 'markumo'
  else if (['markumo', 'fleet', 'typora'].includes(preset)) {
    defaults.keymapPreset = preset as KeymapPresetId
  }
  const presetDefaults = getPresetBindings(defaults.keymapPreset)
  const stored = s.shortcuts && typeof s.shortcuts === 'object' ? s.shortcuts : {}
  const explicit = new Set(Array.isArray(s.customShortcuts) ? s.customShortcuts.filter(id => allCommands.some(command => command.id === id)) : [])
  const version = s.shortcutVersion || 1
  const oldDefaults: Record<string,string> = { ...defaultShortcuts, sidebar: 'Mod+B', replace: version < 2 ? 'Mod+H' : 'Mod+R' }
  const untouchedLegacy = version < 3 && !explicit.size && Object.entries(stored).every(([id,value]) => oldDefaults[id] === value)
  const shortcuts = {...presetDefaults}
  for (const command of allCommands) {
    const value = stored[command.id]
    if (typeof value !== 'string') continue
    if (untouchedLegacy && ['sidebar','replace'].includes(command.id)) continue
    const normalized = value === '' ? '' : normalizeShortcut(value)
    if (normalized === null) continue // One corrupt entry cannot discard other custom keys.
    shortcuts[command.id] = normalized
    if (normalized !== presetDefaults[command.id]) explicit.add(command.id)
  }
  // A new default never steals a stored user key. Leave it unbound rather than
  // invent an arbitrary replacement; untouched stored bindings remain intact.
  for (const command of allCommands) {
    if (Object.prototype.hasOwnProperty.call(stored,command.id) || !shortcuts[command.id]) continue
    if (allCommands.some(other => Object.prototype.hasOwnProperty.call(stored,other.id) && other.id !== command.id && shortcuts[other.id] === shortcuts[command.id] && commandsOverlap(command.id,other.id) && !intentionalOverlap(command.id,other.id,shortcuts[command.id]))) shortcuts[command.id] = ''
  }
  defaults.customShortcuts = [...explicit]
  defaults.shortcuts = shortcuts
  for (const [path,mode] of Object.entries(s.fileModes || {}).slice(-100)) if (fitsSettingsText(path, maxSettingsPathBytes) && ['live','source','split'].includes(mode)) setSettingsEntry(defaults.fileModes,path,mode)
  return defaults
}
export function macPlatform(platform = globalThis.navigator?.platform || '') { return /Mac|iPhone|iPad/i.test(platform) }
export function shortcutLabel(key: string, platform?: string) {
  return macPlatform(platform) ? key.replace('Mod','⌘').replace('Alt','⌥').replace('Shift','⇧').replace(/\+/g,' ') : key.replace('Mod','Ctrl')
}
export function eventShortcut(event: KeyboardEvent, platform?: string) { return eventToKeybinding(event,platform) || '' }
export async function loadEditorSettings(): Promise<EditorSettings> {
  if (isTauri()) return settingsFrom(await invoke('load_editor_settings'))
  const current = localStorage.getItem('markumo.settings.v1')
  if (current !== null) return settingsFrom(JSON.parse(current))
  const legacy = localStorage.getItem('lightedit.settings.v1')
  const settings = settingsFrom(JSON.parse(legacy || 'null'))
  if (legacy !== null) {
    try {
      localStorage.setItem('markumo.settings.v1', JSON.stringify(persistedSettings(settings)))
      localStorage.removeItem('lightedit.settings.v1')
    } catch (error) {
      // Keep both the loaded preferences and the old key if storage is full.
      console.warn('Markumo 偏好迁移暂未写入，原设置仍保留。', error)
    }
  }
  return settings
}
export async function saveEditorSettings(settings: EditorSettings) {
  const payload = persistedSettings(settings)
  if (isTauri()) await invoke('save_editor_settings', { settings: payload })
  else {
    localStorage.setItem('markumo.settings.v1', JSON.stringify(payload))
    localStorage.removeItem('lightedit.settings.v1')
  }
}
export function relativeFilePath(path: string, root: string | null) {
  if (!root) return path
  const normalized = path.replace(/\\/g, '/'), boundary = root.replace(/\\/g,'/').replace(/\/$/, '') + '/'
  const windows = /^[a-z]:\//i.test(boundary) || boundary.startsWith('//')
  if ((windows ? normalized.toLowerCase() : normalized).startsWith(windows ? boundary.toLowerCase() : boundary)) return normalized.slice(boundary.length)
  return path
}
