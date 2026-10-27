<template>
  <div class="app" :class="{ focus: focusMode }" :inert="updateInstalling || startupLoading || undefined">
    <!-- 顶部标题栏 -->
    <TopBar
      v-if="!focusMode"
      :app-mode="appMode"
      :theme="theme"
      :focus-mode="focusMode"
      :desktop="desktop"
      :file-busy="fileBusy || (!!activeDoc?.kind && activeDoc.kind !== 'text')"
      :menu-groups="menuGroups"
      :command-registry="commandRegistry"
      :quick-shortcut="shortcuts['quick-open']"
      :update-state="updateStatus"
      @open-update="openUpdatePanel"
      @execute-command="executeCommand"
      @open-file="openFile()"
      @save-file="saveActive()"
      @request-close="quitApp('titlebar')"
      @set-mode="setMode"
      @toggle-theme="toggleTheme"
      @toggle-focus="toggleFocus"
      @open-settings="openSettings"
      @open-palette="openPalette"
    />

    <!-- 主工作区容器 -->
    <div class="workspace-layout">
      <!-- 活动栏 (单文件模式可自动折叠) -->
      <ActivityBar
        v-if="!focusMode && appMode === 'workspace'"
        :ui-font-size="uiFontSize"
        :active-panel="sidebarPanel"
        :sidebar-visible="sidebarVisible"
        :outline-visible="showOutline"
        :outline-supported="outlineSupported"
        @select-panel="handleSelectPanel"
        @toggle-outline="toggleOutline"
        @open-settings="openSettings"
      />

      <!-- 工作区内容侧边栏；大纲由编辑容器统一停靠 -->
      <Sidebar
        ref="navigationSidebar"
        v-if="leftSidebarOccupied"
        v-model:width="sidebarWidth"
        :active-panel="sidebarPanel"
        :active-doc-id="activeDocId"
        :open-docs="openedDocuments"
        :recent-files="recentFiles"
        :workspace="workspace"
        :manager="manager"
        :desktop="desktop"
        :tree-click-mode="treeClickMode"
        :auto-follow-active-file="autoFollowActiveFile"
        :smart-expand="smartExpand"
        :compact-folders="compactFolders"
        :ui-font-size="uiFontSize"
        @open-recent="openRecent"
        @toggle-side="toggleSidebar"
        @new-doc="createNewDoc"
        @select-doc="handleSelectDoc"
      />

      <!-- 编辑主体区 -->
      <section class="center-area">
        <!-- 主编辑器容器 -->
        <EditorContainer
          v-model:outline-width="outlineWidth"
          :doc="activeDoc"
          :manager="manager"
          :show-outline="outlineVisible"
          :outline-position="effectiveOutlinePosition"
          :focus-mode="focusMode"
          :desktop="desktop"
          :word-wrap="wordWrap"
          :files="files"
          :welcome="!openedDocuments.length && !workspace.rootPath"
          :startup-loading="startupLoading"
          :root-path="workspace.rootPath"
          :live-toolbar="liveToolbar"
          :markdown-width="markdownTypography.width"
          :workspace="workspace"
          @open-file="openFile()"
          @open-workspace="workspace.openWorkspaceDialog()"
          @new-doc="createNewDoc"
          @open-palette="openPalette"
          @close-outline="showOutline = false"
          @close-tab="closeDocById($event.id, $event.pane)"
          @open-path="openRecent($event)"
          @open-workspace-file="workspace.openWorkspaceFileInPane($event)"
          @reveal-in-explorer="revealInExplorerToken($event)"
          @toggle-outline="toggleOutline"
          @update:markdown-width="updateMarkdownWidth"
        />
      </section>
    </div>

    <!-- 底部状态栏 -->
    <StatusBar
      v-if="!focusMode"
      :doc="activeDoc"
      :manager="manager"
      :outline-enabled="outlineVisible"
      @set-language="setLanguage"
      @reopen-encoding="reopenEncoding"
      @convert-encoding="convertEncoding"
      @save-as-encoding="saveAsEncoding"
      :root="activeRoot"
      :multi-root="workspace.roots.length > 1"
      :indent-size="indentSize"
      :use-tabs="useTabs"
      :recovery-count="recoveryRecords.length"
      @open-recovery="openRecovery"
    />

    <!-- 命令面板模态框 -->
    <CommandPalette
      ref="paletteRef"
      :items="paletteActions"
      :loading="workspace.fileIndexLoading"
    />

    <!-- 转到指定行模态框 (Ctrl+G) -->
    <GotoLineModal
      ref="gotoLineRef"
      :max-lines="activeDocLineCount"
      @goto="handleGotoLine"
    />

    <!-- 历史版本面板：正文按需从本地存储读取 -->
    <HistoryDialog
      :open="historyOpen"
      :file-path="historyPath"
      :current-content="historyContent"
      :document-id="historyDocumentId"
      :manager="manager"
      @close="historyOpen = false"
      @restored="historyOpen = false"
    />

    <!-- 首选项模态框 -->
    <SettingsModal
      v-model:auto-check-updates="autoCheckUpdates"
      v-model:auto-download-updates="autoDownloadUpdates"
      :current-version="updateStatus.currentVersion"
      @check-update="settingsRef?.close();openUpdatePanel()"
      v-model:markdown-clipboard="markdownClipboard"
      v-model:markdown-typography="markdownTypography"
      v-model:image-rules="imageRules"
      :document-image-rules="currentDocumentImageRules"
      :markdown-path="activeDoc?.mode && activeDoc?.fileToken ? activeDoc.path : undefined"
      :markdown-name="activeDoc?.mode ? activeDoc.name : undefined"
      @update:document-image-rules="updateDocumentImageRules"
      ref="settingsRef"
      v-model:theme="theme"
      v-model:ui-font-size="uiFontSize"
      v-model:font-size="fontSize"
      v-model:caret-animation="caretAnimation"
      v-model:syntax-style="syntaxStyle"
      v-model:bracket-mode="bracketMode"
      v-model:word-wrap="wordWrap"
      v-model:typewriter-mode="typewriterMode"
      v-model:show-outline="showOutline"
      v-model:default-md-mode="defaultMdMode"
      v-model:live-toolbar="liveToolbar"
      v-model:font-family="fontFamily"
      v-model:indent-size="indentSize"
      v-model:use-tabs="useTabs"
      v-model:external-file-monitoring="externalFileMonitoring"
      v-model:auto-reload-external="autoReloadExternal"
      v-model:auto-save="autoSave"
      v-model:auto-save-delay="autoSaveDelay"
      v-model:tree-click-mode="treeClickMode"
      v-model:auto-follow-active-file="autoFollowActiveFile"
      v-model:smart-expand="smartExpand"
      v-model:compact-folders="compactFolders"
      :keymap-preset="keymapPreset"
      @update:keymap="updateKeymap"
      :shortcuts="shortcuts"
      @update:shortcuts="updateShortcuts"
    />

    <!-- 专注模式退出浮动提示 -->
    <div v-if="focusMode" class="focus-exit-dock">
      <button class="focus-exit-btn" title="退出专注模式 (Esc / F8)" @click="toggleFocus">
        <span class="focus-exit-icon">✕</span>
        <span>退出专注模式 (Esc)</span>
      </button>
    </div>

    <!-- 操作提示 Toast -->
    <ExternalFileDialogs :files="files" />
    <Toast ref="toastRef" />
  </div>
  <div v-if="startupLoading" class="startup-overlay" role="status" :aria-busy="!startupError">
    <p>{{ startupError || '正在安全初始化设置和会话…' }}</p>
    <button @click="quitApp('titlebar')">关闭窗口</button>
  </div>
  <DiscardDialog ref="discardRef" :can-save="desktop" :busy="fileBusy" @save="savePending" @discard="discardPending" @cancel="cancelPendingClose" />
  <RecoveryDialog
    v-if="!updateInstalling"
    :visible="recoveryVisible"
    :records="recoveryRecords"
    :busy="recoveryBusy"
    :diff="recoveryDiff"
    :error="recoveryError"
    @close="closeRecovery"
    @restore="restoreRecovery"
    @discard="discardRecovery"
    @restore-all="restoreAllRecovery"
    @diff="showRecoveryDiff"
    @close-diff="clearRecoveryDiff"
  />
  <UpdatePanel v-if="updatePanelOpen" :state="updateStatus" @close="updatePanelOpen=false" @check="updateManager.checkForUpdates()" @download="updateManager.downloadUpdate()" @install="updateManager.installUpdate()" @release="openUpdateRelease" @link="openUpdateLink" />
  <UpdateConfirm ref="updateConfirmRef" />
  <div v-if="exportProgress" class="docx-export-progress" role="status" aria-label="Word 导出进度">
    <span>{{ exportProgress.phase === 'generating' ? '正在生成 Word 文档…' : '正在写入 Word 文件…' }}</span>
    <button type="button" :disabled="exportProgress.phase === 'writing'" @click="cancelExport">取消导出</button>
  </div>
  <div v-if="updateInstalling" class="update-install-overlay" role="status">{{ updateStatus.phase==='preparing' ? '正在保存文档和工作现场…' : '正在安装更新，请稍候…' }}</div>
</template>

<script setup lang="ts">
import ExternalFileDialogs from './components/modals/ExternalFileDialogs.vue'
import TopBar from './components/layout/TopBar.vue'
import ActivityBar from './components/layout/ActivityBar.vue'
import Sidebar from './components/layout/Sidebar.vue'
import EditorContainer from './components/layout/EditorContainer.vue'
import StatusBar from './components/layout/StatusBar.vue'
import CommandPalette from './components/modals/CommandPalette.vue'
import SettingsModal from './components/modals/SettingsModal.vue'
import DiscardDialog from './components/modals/DiscardDialog.vue'
import GotoLineModal from './components/modals/GotoLineModal.vue'
import Toast from './components/common/Toast.vue'
import UpdatePanel from './components/common/UpdatePanel.vue'
import UpdateConfirm from './components/modals/UpdateConfirm.vue'
import RecoveryDialog from './components/modals/RecoveryDialog.vue'
import HistoryDialog from './components/layout/HistoryDialog.vue'
import { computed, nextTick, provide, ref } from 'vue'
import { workspaceNavigationKey } from './features/workspace/navigation'
import { useAppShell } from './app/useAppShell'
const { autoCheckUpdates,autoDownloadUpdates,updateStatus,updatePanelOpen,updateConfirmRef,updateManager,openUpdatePanel,openUpdateRelease,openUpdateLink,caretAnimation,outlineWidth,markdownClipboard,markdownTypography,appMode, sidebarVisible, sidebarWidth, sidebarPanel, focusMode, theme, uiFontSize, fontSize, fontFamily, indentSize, useTabs, shortcuts, updateShortcuts, updateKeymap, keymapPreset, wordWrap, showOutline, typewriterMode, defaultMdMode, liveToolbar, externalFileMonitoring, autoReloadExternal, autoSave, autoSaveDelay, treeClickMode, autoFollowActiveFile, smartExpand, compactFolders, syntaxStyle, bracketMode, imageRules,currentDocumentImageRules,updateDocumentImageRules,
  paletteRef, settingsRef, discardRef, toastRef, historyOpen, historyPath, historyDocumentId, historyContent, manager, files, workspace, openedDocuments, activeDoc, activeDocId, exportProgress, cancelExport, paletteActions, menuGroups,commandRegistry,executeCommand,
  setMode, toggleSidebar, handleSelectPanel, leftSidebarOccupied, effectiveOutlinePosition, outlineSupported, outlineVisible, toggleOutline, toggleTheme, toggleFocus, openSettings, openPalette, handleSelectDoc,
  createNewDoc, closeDocById, cancelPendingClose, discardPending, savePending, setLanguage,
  reopenEncoding, convertEncoding, saveAsEncoding,
  gotoLineRef, handleGotoLine, revealInExplorerToken,
  desktop, fileBusy, recentFiles, openFile, openRecent, saveActive, quitApp, startupLoading, startupError, settingsReady, updateInstalling,
  recoveryRecords, recoveryVisible, recoveryBusy, recoveryError, recoveryDiff, openRecovery, closeRecovery,
  restoreRecovery, discardRecovery, restoreAllRecovery, showRecoveryDiff, clearRecoveryDiff } = useAppShell()
const navigationSidebar=ref<InstanceType<typeof Sidebar>>()
provide(workspaceNavigationKey, {workspace,enabled:()=>appMode.value==='workspace',reveal:async(path)=>{
  const id=manager.activeId,pane=manager.activePane,generation=workspace.openRevision
  const valid=()=>appMode.value==='workspace'&&manager.activeId===id&&manager.activePane===pane&&workspace.openRevision===generation&&manager.activeDocument?.path===path
  if(!valid())return false
  const found=await workspace.revealFileInTree(path)
  if(!found||!valid())return false
  sidebarPanel.value='files';sidebarVisible.value=true
  await nextTick()
  if(!valid())return false
  await navigationSidebar.value?.locateCurrentFile()
  return valid()
}})
defineExpose({ settingsReady })
function updateMarkdownWidth(width: number) {
  markdownTypography.value = { ...markdownTypography.value, width: Math.max(480, Math.min(1400, Math.round(width))) }
}
// These refs are bound by name from the template only; TypeScript cannot see
// string template refs, so reference them explicitly.
void [updateConfirmRef, paletteRef, discardRef, toastRef, gotoLineRef]

const activeDocLineCount = computed(() => {
  if (!activeDoc.value) return 1
  const state = manager.getState(activeDoc.value.id)
  return state ? state.doc.lines : 1
})
const activeRoot = computed(() => appMode.value === 'workspace' && activeDoc.value?.path ? workspace.roots.find(root => root.rootPath === workspace.rootForPath(activeDoc.value!.path)) : null)
</script>

<style scoped>
.update-install-overlay {position:fixed;inset:0;z-index:2000;display:grid;place-items:center;background:var(--app);color:var(--ink);font-size:15px}
.startup-overlay {position:fixed;inset:0;z-index:900;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;background:var(--app);color:var(--ink)}
.startup-overlay button {padding:8px 16px;background:var(--soft);color:var(--ink);border-radius:6px}
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--app);
  color: var(--ink);
  position: relative;
  overflow: hidden;
}

.workspace-layout {
  min-height: 0;
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

@media (max-width: 900px) {
  .workspace-layout > .sidebar-wrapper { width: 210px !important; }
}

.focus-exit-dock {
  position: fixed;
  top: 12px;
  right: 18px;
  z-index: 1000;
  opacity: 0.35;
  transition: opacity 0.2s ease;
}
.focus-exit-dock:hover {
  opacity: 1;
}
.focus-exit-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.4;
  background: var(--soft);
  color: var(--ink);
  border: 1px solid var(--line);
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  user-select: none;
}
.focus-exit-btn:hover {
  background: var(--hover);
  color: var(--bright);
}

.center-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--editor);
}
.docx-export-progress { position:fixed;right:20px;bottom:36px;z-index:2000;display:flex;gap:16px;align-items:center;padding:12px 16px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow); }
.docx-export-progress button { cursor:pointer;padding:4px 10px;border:1px solid var(--line);border-radius:4px;color:var(--ink);background:var(--hover); }
.docx-export-progress button:disabled { cursor:default;opacity:.55; }
</style>
