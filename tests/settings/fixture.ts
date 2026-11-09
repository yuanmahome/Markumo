import { defaultSettings, persistedSettings, settingsFrom, saveEditorSettings, loadEditorSettings } from '../../src/features/shell/editorSettings'
import { statisticKinds } from '../../src/features/document-stats/counts'
import { prepareInstallation } from '../../src/features/shell/updater/prepareInstallation'

Object.assign(window, { settingsAPI: { defaultSettings, persistedSettings, settingsFrom, saveEditorSettings, loadEditorSettings, statisticKinds, prepareInstallation } })
