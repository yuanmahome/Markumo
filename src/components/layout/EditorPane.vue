<template>
  <div class="pane-body" :class="{ 'class-pane': doc?.kind === 'javaClass' }">
    <div v-if="currentMode === 'live' && tooLarge" class="markdown-budget" role="status">文档超过 Live 安全预算，当前使用源码编辑。</div>
    <ImageViewer v-if="doc?.kind === 'image'" :key="`${doc.id}:${doc.fileToken}:${doc.lastDiskVersion}:${pane}`" :doc="doc" :state="manager.mediaViewState(doc.id, pane)" @metadata="(media, version) => doc && manager.updateMediaMetadata(doc.id, media, version)" />
    <PdfViewer v-if="doc?.kind === 'pdf'" :key="`${doc.id}:${doc.fileToken}:${doc.lastDiskVersion}:${pane}`" :doc="doc" :pane="pane" :state="manager.mediaViewState(doc.id, pane)" @metadata="(media, version) => doc && manager.updateMediaMetadata(doc.id, media, version)" />
    <div v-show="doc && !isMedia(doc)" ref="host" class="editor-host" :style="hostStyle" @scroll.capture="onEditorScroll"></div>
    <div v-if="currentMode === 'split' && !tooLarge" class="split-resizer" role="separator" aria-label="调整 Markdown 双栏比例" aria-orientation="vertical" :aria-valuenow="Math.round(splitRatio * 100)" :aria-valuemin="20" :aria-valuemax="80" tabindex="0" title="拖动调整双栏比例" @keydown.left.prevent="splitRatio = Math.max(.2, splitRatio - .05)" @keydown.right.prevent="splitRatio = Math.min(.8, splitRatio + .05)" @mousedown.prevent="startSplitResize"></div>
    <SplitPreview v-if="currentMode === 'split'" ref="preview" :style="previewStyle" :typography="manager.getMarkdownTypography()" :image-border="manager.getMarkdownTypography().imageBorder" :content="text" :too-large="tooLarge" :resources="resources" :resource-key="`${doc?.fileToken||''}|${doc?.path||''}`" @scroll-line="onPreviewScroll" @edit-image="editImage" />
    <ClassHexPanel v-if="doc?.kind === 'javaClass'" :key="doc.id" :doc="doc" :files="files" />
    <EmptyEditorPane v-if="!doc" @new-doc="newDocument" @quick-open="quickOpen" />
  </div>
</template>
<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { isMedia } from '../../features/files/media'
const ImageViewer = defineAsyncComponent(() => import('../viewers/ImageViewer.vue'))
const PdfViewer = defineAsyncComponent(() => import('../viewers/PdfViewer.vue'))
import SplitPreview from '../../editor/markdown/splitPreview.vue'
import type { DocumentManager, Pane } from '../../editor/core/DocumentManager'
import type { EditorDocument } from '../../types'
import type { Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import ClassHexPanel from './ClassHexPanel.vue'
import type { FileController } from '../../features/files/FileController'
import { markdownResources } from '../../editor/markdown/images'
import EmptyEditorPane from './EmptyEditorPane.vue'

const props = defineProps<{ manager: DocumentManager; pane: Pane; doc: EditorDocument | null; files?: FileController }>()
const emit = defineEmits<{ (e: 'quick-open'): void }>()

function newDocument() { props.manager.focusPane(props.pane, false); props.manager.createUntitled() }
function quickOpen() { props.manager.focusPane(props.pane, false); emit('quick-open') }

const host = ref<HTMLElement | null>(null), preview = ref<InstanceType<typeof SplitPreview> | null>(null)
let previousText: Text | undefined, serialized = '', disposed = false

const currentMode = computed(() => {
  return props.doc && props.manager ? props.manager.getMarkdownMode(props.doc.id, props.pane) : null
})

const splitRatio = ref(0.5)
const hostStyle = computed(() => {
  if (currentMode.value === 'split') {
    return { flex: `0 0 calc(${splitRatio.value * 100}% - ${splitRatio.value * 5}px)` }
  }
  return { flex: '1 1 0%' }
})
const previewStyle = computed(() => {
  return { flex: '1 1 0%' }
})

let stopSplitResize: (() => void) | undefined
function startSplitResize(_e: MouseEvent) {
  stopSplitResize?.()
  const container = host.value?.parentElement
  if (!container) return
  const startRect = container.getBoundingClientRect()
  const onMouseMove = (moveEvent: MouseEvent) => {
    const newRatio = (moveEvent.clientX - startRect.left) / startRect.width
    splitRatio.value = Math.max(0.2, Math.min(0.8, newRatio))
  }
  const onMouseUp = () => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    stopSplitResize = undefined
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  stopSplitResize = onMouseUp
}

const tooLarge = computed(() => !!props.doc && (props.manager.getState(props.doc.id)?.doc.length || 0) > 1024 * 1024)
const resources = computed(() => props.doc ? props.manager.getState(props.doc.id)?.facet(markdownResources) : undefined)

function editImage(from: number, snapshot: string) {
  const id = props.doc?.id, state = id && props.manager.getState(id)
  if (!id || !state || props.manager.isComposing || state.doc.toString() !== snapshot || from < 0 || from > state.doc.length) return
  const line = state.doc.lineAt(from)
  props.manager.focusPane(props.pane, false)
  props.manager.revealPosition(id, line.number, from - line.from + 1)
}

const text = computed(() => {
  const doc = (currentMode.value === 'split' && props.doc) ? props.manager.getState(props.doc.id)?.doc : undefined
  if (!doc || tooLarge.value) { previousText = undefined; serialized = ''; return '' }
  if (doc !== previousText) { previousText = doc; serialized = doc.toString() }
  return serialized
})

let expectedTop: number | null = null
function currentView() { const element = host.value?.querySelector<HTMLElement>('.cm-editor'); return element ? EditorView.findFromDOM(element) : null }

function onEditorScroll(event: Event) {
  const scroller = event.target as HTMLElement
  if (currentMode.value !== 'split' || !scroller.classList.contains('cm-scroller')) return
  if (expectedTop !== null && Math.abs(scroller.scrollTop - expectedTop) <= 1) { expectedTop = null; return }
  expectedTop = null
  const view = currentView()
  if (!view) return
  const height = Math.max(0, scroller.getBoundingClientRect().top - view.documentTop)
  const block = view.lineBlockAtHeight(height), line = view.state.doc.lineAt(block.from)
  preview.value?.syncScroll(line.number + Math.max(0, Math.min(1, (height - block.top) / Math.max(block.height, 1))))
}

function onPreviewScroll(lineNumber: number) {
  const scroller = host.value?.querySelector<HTMLElement>('.cm-scroller')
  if (!scroller || currentMode.value !== 'split') return
  const view = currentView()
  if (!view) return
  const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, Math.floor(lineNumber))))
  const block = view.lineBlockAt(line.from)
  const next = block.top + (lineNumber % 1) * block.height + view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop
  if (Math.abs(next - scroller.scrollTop) > 1) { scroller.scrollTop = next; expectedTop = scroller.scrollTop }
}

watch([currentMode, preview], async () => {
  expectedTop = null
  await nextTick()
  if (disposed) return
  const view = currentView()
  if (currentMode.value === 'split' && view) onEditorScroll({ target: view.scrollDOM } as unknown as Event)
}, { flush: 'post' })

onMounted(() => { if (!disposed && host.value) props.manager.mountPane(host.value, props.pane) })
watch(() => props.pane, (pane, previous) => {
  if (disposed) return
  props.manager.unmount(previous, host.value)
  if (host.value) props.manager.mountPane(host.value, pane)
}, { flush: 'post' })
watch(() => !!props.doc, (present, previous) => {
  if (disposed) return
  if (present && !previous && props.manager.activePane === props.pane) props.manager.focusPane(props.pane)
}, { flush: 'post' })
onBeforeUnmount(() => {
  disposed = true
  stopSplitResize?.()
  previousText = undefined
  serialized = ''
  props.manager.unmount(props.pane, host.value, true)
})
</script>
<style scoped>
.pane-body { flex: 1; display: flex; min-width: 0; min-height: 0; position: relative; overflow: hidden }
.editor-host { min-height: 0; min-width: 0; overflow: hidden; display: flex }
.editor-host :deep(.cm-editor) { height: 100%; width: 100% }
.split-resizer {
  width: 5px;
  background: var(--line);
  cursor: col-resize;
  flex: none;
  transition: background 0.15s;
  z-index: 5;
}
.split-resizer:hover {
  background: var(--accent);
}
.markdown-budget { position: absolute; top: 0; right: 12px; z-index: 8; font-size: var(--ui-font-size); background: var(--side); padding: 5px; color: var(--muted) }
@media(max-width:900px) { .class-pane { flex-direction: column } }
</style>
