<template>
  <div ref="container" class="editor-container" :data-revision="revision" :data-outline-position="outlinePosition">
    <div class="editor-main" :class="{ 'is-split-pane': manager.isSplit }">
      <div v-if="doc?.languageStatus === 'error'" class="language-message" role="status">
        {{ doc.languageError }}
      </div>

      <!-- 编辑主体区（递归 Split Tree） -->
      <div class="panes-container">
        <SplitLayoutNode
          :node="manager.layout.root"
          :manager="manager"
          :revision="revision"
          :files="files"
          :welcome="welcome"
          :startup-loading="startupLoading"
          :desktop="desktop"
          :root-path="rootPath"
          :live-toolbar="liveToolbar"
          :outline-visible="showOutline && !focusMode"
          :focus-mode="focusMode"
          :markdown-width="markdownWidth"
          @new-doc="$emit('new-doc')"
          @open-file="$emit('open-file')"
          @open-workspace="$emit('open-workspace')"
          @open-palette="$emit('open-palette', $event)"
          @close-tab="handleCloseTab"
          @open-workspace-file="handleOpenWorkspaceFile"
          @reveal-in-explorer="$emit('reveal-in-explorer', $event)"
          @toggle-outline="$emit('toggle-outline')"
          @update:markdown-width="$emit('update:markdown-width', $event)"
        />
      </div>
    </div>

    <div v-show="docked" class="outline-resizer" role="separator" aria-label="调整大纲宽度" aria-orientation="vertical" tabindex="0"
      :aria-valuenow="visibleOutlineWidth" :aria-valuemin="160" :aria-valuemax="maxOutlineWidth" title="拖动调整大纲宽度，双击恢复默认"
      @pointerdown="startOutlineResize" @lostpointercapture="cancelOutlineResize" @dblclick="setOutlineWidth(240)"
      @keydown.left.prevent="setOutlineWidth(visibleOutlineWidth + (outlinePosition === 'right' ? 10 : -10))" @keydown.right.prevent="setOutlineWidth(visibleOutlineWidth + (outlinePosition === 'left' ? 10 : -10))"
      @keydown.home.prevent="setOutlineWidth(160)" @keydown.end.prevent="setOutlineWidth(maxOutlineWidth)"
    ></div>
    <aside v-show="docked" class="outline-sidebar" :data-capability="capability" :data-parse-status="structure.status" :style="{ width: `${visibleOutlineWidth}px` }" aria-label="文档大纲">
      <div class="outline-head">
        <span>大纲</span>
        <div class="outline-actions">
        <button class="tinyclose" aria-label="全部展开大纲" title="全部展开" @click="outlineView?.expandAll()">⊞</button>
        <button class="tinyclose" aria-label="全部收起大纲" title="全部收起" @click="outlineView?.collapseAll()">⊟</button>
        <button
          class="tinyclose"
          aria-label="关闭大纲"
          title="关闭大纲"
          @click="$emit('close-outline')"
        >
          ✕
        </button>
        </div>
      </div>
      <OutlineView
        ref="outlineView"
        :items="outlineItems"
        :is-markdown="isMarkdownDoc"
        :notice="outlineNotice"
        :status="structure.status"
        :manager="manager"
        :document-id="outlineDocument?.id"
        @select-item="handleSelectOutline"
        @retry="retryOutline"
      />
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import SplitLayoutNode from './SplitLayoutNode.vue'
import OutlineView from './OutlineView.vue'
import { getOutlineCapability, type OutlineItem } from '../../editor/outline/outlineService'
import type { LanguageName } from '../../editor/languages'
import { useDocumentOutline } from '../../editor/outline/useDocumentOutline'
import type { EditorDocument } from '../../types'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { FileController } from '../../features/files/FileController'
import type { WorkspaceController } from '../../features/workspace/WorkspaceController'
import type { DropZone } from './DropZoneOverlay.vue'

const props = withDefaults(defineProps<{
  doc: EditorDocument | null
  manager: DocumentManager
  showOutline: boolean
  outlinePosition?: 'left' | 'right'
  focusMode?: boolean
  outlineWidth?: number
  desktop: boolean
  wordWrap?: boolean
  files?: FileController
  welcome?: boolean
  startupLoading?: boolean
  rootPath?: string | null
  liveToolbar?: boolean
  markdownWidth?: number
  workspace?: WorkspaceController
}>(), { liveToolbar: true, outlinePosition: 'right' })

const emit = defineEmits<{
  (e: 'new-doc'): void
  (e: 'open-file'): void
  (e: 'open-workspace'): void
  (e: 'open-palette', cat: 'action' | 'file' | 'all'): void
  (e: 'close-outline'): void
  (e: 'update:outlineWidth', width: number): void
  // One event for every pane: the pane id travels with the tab, so a close can
  // never be handled twice (which would prompt for the same dirty file twice).
  (e: 'close-tab', payload: { id: string; pane: string }): void
  (e: 'open-path', path: string): void
  (e: 'open-workspace-file', payload: { path: string; name: string; paneId: string; zone: DropZone }): void
  (e: 'reveal-in-explorer', token: string): void
  (e: 'toggle-outline'): void
  (e: 'update:markdown-width', width: number): void
}>()

const revision = ref(0)
const unsubscribe = props.manager.subscribe(() => revision.value++)
const container = ref<HTMLElement | null>(null), containerWidth = ref(0), localOutlineWidth = ref(240)
const outlineView = ref<InstanceType<typeof OutlineView> | null>(null)
const dragWidth = ref<number | null>(null), spaceCollapsed = ref(true)
const minimumEditorWidth = computed(() => {
  revision.value
  const width = (node: typeof props.manager.layout.root): number => {
    if (node.type === 'leaf') {
      const id = props.manager.paneGroup(node.id).activeId
      return id && props.manager.getMarkdownMode(id, node.id) === 'split' ? 420 : 280
    }
    if (node.orientation !== 'horizontal') return Math.max(width(node.first), width(node.second))
    const ratio = Math.max(.05, Math.min(.95, node.ratio))
    return Math.max(width(node.first) / ratio, width(node.second) / (1 - ratio)) + 4
  }
  const maximized = props.manager.layout.maximizedPaneId
  return width(maximized ? { type: 'leaf', id: maximized } : props.manager.layout.root)
})
const maxOutlineWidth = computed(() => Math.max(160, Math.min(520, containerWidth.value - minimumEditorWidth.value - 4)))
const visibleOutlineWidth = computed(() => Math.min(maxOutlineWidth.value, Math.max(160, dragWidth.value ?? props.outlineWidth ?? localOutlineWidth.value)))
const outlineDocument = computed(() => { revision.value; return props.manager.activeDocument })
const capability = computed(() => getOutlineCapability(outlineDocument.value))
const docked = computed(() => props.showOutline && capability.value !== 'unsupported' && !props.focusMode && !spaceCollapsed.value)
watch([containerWidth, minimumEditorWidth], ([available, minimum]) => {
  const threshold = minimum + 164
  if (available < threshold) spaceCollapsed.value = true
  else if (available >= threshold + 32) spaceCollapsed.value = false
}, { immediate: true })
let observer: ResizeObserver | undefined
let resize: { pointer: number; x: number; width: number; cursor: string; selection: string; handle: HTMLElement; moved: boolean } | null = null
function setOutlineWidth(width: number) {
  const value = Math.round(Math.max(160, Math.min(520, width)))
  localOutlineWidth.value = value
  emit('update:outlineWidth', value)
}
function startOutlineResize(event: PointerEvent) {
  if (event.button !== 0) return
  cancelOutlineResize()
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  resize = {pointer:event.pointerId,x:event.clientX,width:visibleOutlineWidth.value,cursor:document.body.style.cursor,selection:document.body.style.userSelect,handle,moved:false}
  handle.setPointerCapture(event.pointerId)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', moveOutlineResize)
  window.addEventListener('pointerup', stopOutlineResize)
  window.addEventListener('pointercancel', cancelOutlineResize)
  window.addEventListener('blur', cancelOutlineResize)
}
function moveOutlineResize(event: PointerEvent) {
  if (resize && event.pointerId === resize.pointer) {
    const delta = (event.clientX - resize.x) * (props.outlinePosition === 'left' ? 1 : -1)
    resize.moved ||= Math.abs(delta) > 1
    dragWidth.value = Math.round(Math.max(160, Math.min(maxOutlineWidth.value, resize.width + delta)))
  }
}
function cancelOutlineResize(event?: Event) { stopOutlineResize(event, false) }
function stopOutlineResize(event?: Event, save = true) {
  if (!resize) return
  if (event instanceof PointerEvent && event.pointerId !== resize.pointer) return
  const {handle, pointer, moved} = resize
  const finalWidth = dragWidth.value
  document.body.style.cursor = resize.cursor
  document.body.style.userSelect = resize.selection
  resize = null
  dragWidth.value = null
  if (save && moved && finalWidth !== null) setOutlineWidth(finalWidth)
  if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
  window.removeEventListener('pointermove', moveOutlineResize)
  window.removeEventListener('pointerup', stopOutlineResize)
  window.removeEventListener('pointercancel', cancelOutlineResize)
  window.removeEventListener('blur', cancelOutlineResize)
}
watch([docked, () => props.outlinePosition], () => cancelOutlineResize())
onMounted(() => {
  if (!container.value) return
  containerWidth.value = container.value.clientWidth
  observer = new ResizeObserver(entries => { containerWidth.value = entries[0].contentRect.width })
  observer.observe(container.value)
})

function handleCloseTab(payload: { id: string; pane: string }) {
  emit('close-tab', payload)
}

function handleOpenWorkspaceFile(payload: { path: string; name: string; paneId: string; zone: DropZone }) {
  if (props.workspace) {
    void props.workspace.openWorkspaceFileInPane(payload)
  } else {
    emit('open-workspace-file', payload)
  }
}

const isMarkdownDoc = computed(() => capability.value === 'markdown')

const structure=useDocumentOutline(()=>props.manager,()=>outlineDocument.value,()=>docked.value)
const outlineItems=computed(()=>structure.value.items)
const outlineNotice=computed(()=>structure.value.notice)

function handleSelectOutline(item: OutlineItem) {
  if (outlineDocument.value) props.manager.revealOutline(outlineDocument.value.id, item)
}
function retryOutline() {
  const document=outlineDocument.value
  if(document&&capability.value!=='unsupported')void props.manager.setLanguage(document.id,document.language as LanguageName)
}

onUnmounted(() => {
  observer?.disconnect()
  cancelOutlineResize()
  unsubscribe()
})
</script>

<style scoped>
.editor-container {
  min-height: 0;
  flex: 1;
  display: flex;
  background: var(--editor);
  overflow: hidden;
  position: relative;
}

.editor-main {
  order: 0;
  min-width: 0;
  flex-direction: column;
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.language-message {
  color: var(--yellow);
  padding: 4px 18px;
  font-size: var(--ui-small-font-size);
}

.panes-container {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  position: relative;
  width: 100%;
  height: 100%;
}

.outline-sidebar {
  order: 2;
  min-width: 0;
  background: var(--sidebar);
  display: flex;
  flex-direction: column;
  flex: none;
}
.outline-resizer {order:1;width:4px;flex:none;background:var(--line);cursor:col-resize;touch-action:none;user-select:none;position:relative;z-index:3}
.editor-container[data-outline-position="left"] .outline-sidebar {order:0}
.editor-container[data-outline-position="left"] .editor-main {order:2}
.outline-actions {display:flex;gap:6px}
.outline-resizer:hover,.outline-resizer:focus-visible {background:var(--accent);outline:none}

.outline-head {
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: var(--ui-small-font-size);
  font-weight: 700;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}

.tinyclose {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--ui-small-font-size);
  color: var(--muted);
  border: none;
  background: transparent;
  cursor: pointer;
}
.tinyclose:hover {
  background: var(--line);
  color: var(--bright);
}
</style>
