<template>
  <div
    :data-pane-id="paneId"
    :class="[
      `pane pane-${paneId}`,
      paneId === 'main' ? 'main-pane' : 'secondary-pane',
      { active: isActivePane }
    ]"
    @focusin="manager.focusPane(paneId, false)"
    @mousedown="manager.focusPane(paneId, false)"
  >
    <TabBar
      :docs="paneDocs"
      :active-id="paneActiveId"
      :pane="paneId"
      :split="manager.isSplit"
      :manager="manager"
      :files="files"
      :desktop="desktop"
      :root-path="rootPath"
      @select-tab="manager.select($event, paneId)"
      @pin-tab="manager.pin($event, paneId)"
      @unpin-tab="unpinTab($event)"
      @close-tab="$emit('close-tab', { id: $event, pane: paneId })"
      @close-others="closeOthers($event)"
      @close-right="closeRight($event)"
      @close-all="closeAll"
      @new-doc="newDocument"
      @split-tab="handleSplitTab"
      @move-other="handleMoveOther"
      @move-pane="handleMoveToPane"
      @close-pane="handleClosePane"
      @close-split="manager.closeSplit()"
      @merge-splits="manager.mergeAllPanes()"
      @reveal-in-explorer="$emit('reveal-in-explorer', $event)"
    />

    <ExternalFileBanner v-if="activeDoc && files" :files="files" :id="activeDoc.id" />

    <WelcomePage
      v-if="welcome && !activeDoc && !manager.isSplit"
      :loading="startupLoading"
      @new-doc="$emit('new-doc')"
      @open-file="$emit('open-file')"
      @open-workspace="$emit('open-workspace')"
    />

    <div v-else class="pane-document-shell">
      <MarkdownLiveToolbar
        v-if="showMarkdownToolbar"
        :manager="manager"
        :pane="paneId"
        :revision="revision"
        :mode="markdownMode || 'live'"
        :outline-visible="outlineVisible"
        :markdown-width="markdownWidth"
        @change-mode="changeMarkdownMode"
        @toggle-outline="$emit('toggle-outline')"
        @update:markdown-width="updateMarkdownWidth"
      />
      <div class="pane-document">
        <EditorPane
          :manager="manager"
          :pane="paneId"
          :doc="activeDoc"
          :files="files"
          @quick-open="$emit('open-palette', 'file')"
        />
      </div>
    </div>

    <DropZoneOverlay :active="isDropActive" :zone="currentDropZone" :copy="tabDragService.dragPayload.value?.isCopy" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import TabBar from './TabBar.vue'
import ExternalFileBanner from './ExternalFileBanner.vue'
import EditorPane from './EditorPane.vue'
import WelcomePage from './WelcomePage.vue'
import MarkdownLiveToolbar from './MarkdownLiveToolbar.vue'
import DropZoneOverlay, { type DropZone } from './DropZoneOverlay.vue'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { FileController } from '../../features/files/FileController'
import type { SplitDirection } from '../../editor/layout/types'
import { tabDragService } from '../../editor/layout/TabDragService'
import type { MarkdownMode } from '../../types'

const props = withDefaults(defineProps<{
  paneId: string
  manager: DocumentManager
  revision: number
  files?: FileController
  welcome?: boolean
  startupLoading?: boolean
  desktop: boolean
  rootPath?: string | null
  liveToolbar?: boolean
  outlineVisible?: boolean
  focusMode?: boolean
  markdownWidth?: number
}>(), { liveToolbar: true })

const emit = defineEmits<{
  (e: 'new-doc'): void
  (e: 'open-file'): void
  (e: 'open-workspace'): void
  (e: 'open-palette', cat: 'action' | 'file' | 'all'): void
  (e: 'close-tab', payload: { id: string; pane: string }): void
  (e: 'open-workspace-file', payload: { path: string; name: string; paneId: string; zone: DropZone }): void
  (e: 'reveal-in-explorer', token: string): void
  (e: 'toggle-outline'): void
  (e: 'update:markdown-width', width: number): void
}>()

const isDropActive = computed(() => tabDragService.isDragging.value && tabDragService.activePaneDrop.value?.paneId === props.paneId)
const currentDropZone = computed<DropZone>(() => tabDragService.activePaneDrop.value?.paneId === props.paneId ? tabDragService.activePaneDrop.value.zone : 'center')
const paneModel = computed(() => { props.revision; return props.manager.layout.getPane(props.paneId) })
const paneActiveId = computed(() => { props.revision; return paneModel.value?.group.activeId || null })
const paneDocs = computed(() => {
  props.revision
  if (!paneModel.value) return []
  return paneModel.value.group.tabs.flatMap(tab => {
    const doc = props.manager.metadata(tab.documentId)
    return doc ? [{ ...doc, pinned: tab.pinned }] : []
  })
})
const activeDoc = computed(() => {
  props.revision
  return paneActiveId.value ? props.manager.metadata(paneActiveId.value) : null
})
const isActivePane = computed(() => { props.revision; return props.manager.layout.activePaneId === props.paneId })
const markdownMode = computed(() => {
  props.revision
  return props.manager.getMarkdownMode(paneActiveId.value, props.paneId)
})
const showMarkdownToolbar = computed(() => {
  props.revision
  return props.liveToolbar !== false && !!markdownMode.value
})

function changeMarkdownMode(mode: MarkdownMode) {
  if (paneActiveId.value) {
    props.manager.setMarkdownMode(paneActiveId.value, mode, props.paneId)
    props.manager.focusPane(props.paneId, true)
  }
}

function updateMarkdownWidth(width: number) {
  emit('update:markdown-width', width)
}

function newDocument() {
  props.manager.focusPane(props.paneId, false)
  props.manager.createUntitled()
}

function unpinTab(id: string) {
  if (props.manager.metadata(id)?.dirty) return
  const pane = props.manager.layout.getPane(props.paneId)
  const tab = pane?.group.tabs.find(t => t.documentId === id)
  if (tab) {
    pane!.group.unpin(id)
    props.manager.notify()
  }
}

function closeOthers(id: string) {
  if (!paneModel.value) return
  const others = paneModel.value.group.tabs.filter(t => t.documentId !== id)
  for (const tab of others) {
    emit('close-tab', { id: tab.documentId, pane: props.paneId })
  }
}

function closeRight(id: string) {
  if (!paneModel.value) return
  const index = paneModel.value.group.tabs.findIndex(t => t.documentId === id)
  if (index >= 0) {
    const rightTabs = paneModel.value.group.tabs.slice(index + 1)
    for (const tab of rightTabs) {
      emit('close-tab', { id: tab.documentId, pane: props.paneId })
    }
  }
}

function closeAll() {
  if (!paneModel.value) return
  const tabs = [...paneModel.value.group.tabs]
  for (const tab of tabs) {
    emit('close-tab', { id: tab.documentId, pane: props.paneId })
  }
}

function handleSplitTab(payload: { id: string; direction: SplitDirection; duplicate?: boolean }) {
  props.manager.transferTab(payload.id, props.paneId, props.paneId, { direction: payload.direction, copy: payload.duplicate })
}

function handleMoveOther(id: string) {
  const leaves = props.manager.layout.getAllLeafIds()
  const otherPane = leaves.find(pid => pid !== props.paneId)
  if (otherPane) {
    props.manager.moveTab(id, props.paneId, otherPane)
  } else {
    handleSplitTab({ id, direction: 'right' })
  }
}

function handleMoveToPane(payload: { id: string; toPane: string }) {
  props.manager.moveTab(payload.id, props.paneId, payload.toPane)
}

function handleClosePane() {
  props.manager.closePane(props.paneId)
}

</script>

<style scoped>
.pane {
  container-type: inline-size;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  position: relative;
  flex-direction: column;
}

.pane-document-shell {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pane-document {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  position: relative;
}

</style>
