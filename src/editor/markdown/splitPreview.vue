<template>
  <div ref="root" class="split-preview-pane" role="region" aria-label="Markdown 只读预览" @scroll="onScroll">
    <div :style="{ height: `${top}px` }" aria-hidden="true"></div>
    <section v-for="item in visible" :key="item.index" :ref="el => observe(el as Element | null, item.index)" :data-group="item.index">
      <PreviewPartition v-if="item.group.to - item.group.from <= 131072" :content="content.slice(item.group.from, item.group.to)" :references="references" :scroll-root="root" :resources="resources" :resource-key="resourceKey" :typography="typography" :image-border="imageBorder" @edit-image="(from, snapshot) => snapshot === content.slice(item.group.from, item.group.to) && emit('edit-image', from + item.group.from, content)" />
      <div v-else class="preview-local-budget" role="status">此结构超出单次排版预算，源码完整保留。<button @click="emit('scroll-line', item.group.line)">定位源码</button></div>
    </section>
    <div :style="{ height: `${bottom}px` }" aria-hidden="true"></div>
    <div v-if="!complete" class="preview-progress" role="status">{{ failure || '正在准备后续内容…' }}</div>
  </div>
</template>
<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import PreviewPartition from './preview/PreviewPartition.vue'
import { HeightIndex } from './preview/HeightIndex'
import type { PreviewGroup, StructureBatch } from './preview/structure'
import type { MarkdownResources } from './images'
import type { MarkdownTypography } from './wysiwyg/contracts'
const props = defineProps<{ content: string; resources?: MarkdownResources; resourceKey?: string; imageBorder?: boolean; typography?: MarkdownTypography }>()
const emit = defineEmits<{ (e:'scroll-line',line:number):void; (e:'edit-image',from:number,snapshot:string):void }>()
const root = ref<HTMLElement | null>(null), groups = shallowRef<PreviewGroup[]>([]), references = shallowRef<Record<string, unknown>>({})
const totalLines = ref(1)
const complete = ref(false), failure = ref(''), revision = ref(0), start = ref(0), end = ref(0)
let heights = new HeightIndex(), worker: Worker | undefined, resize: ResizeObserver | undefined, disposed = false
let pendingLine: number | undefined, expected = false, frame = 0
const visible = computed(() => groups.value.slice(start.value, end.value).map((group, offset) => ({ group, index: start.value + offset })))
const tail = computed(() => complete.value ? 0 : Math.max(0, totalLines.value - (groups.value[groups.value.length - 1]?.endLine || 1)) * 24)
const scale = computed(() => { void revision.value; return Math.min(1, 8000000 / Math.max(1, heights.prefix(groups.value.length) + tail.value)) })
const top = computed(() => { void revision.value; return heights.prefix(start.value) * scale.value })
const bottom = computed(() => { void revision.value; return Math.max(0, heights.prefix(groups.value.length) + tail.value - heights.prefix(end.value)) * scale.value })
function updateWindow() {
  const el = root.value
  if (!el) return
  start.value = heights.at(Math.max(0, el.scrollTop / scale.value - el.clientHeight))
  end.value = Math.min(groups.value.length, heights.at(el.scrollTop / scale.value + el.clientHeight * 2) + 1, start.value + 12)
}
const observed = new Map<number, Element>()
function observe(el: Element | null, index: number) {
  const previous = observed.get(index)
  if (previous && previous !== el) { resize?.unobserve(previous); observed.delete(index) }
  if (el) { (el as HTMLElement).dataset.group = String(index); observed.set(index, el); resize?.observe(el) }
}
function lineAt(top: number) {
  if (!complete.value && top > heights.prefix(groups.value.length)) return (groups.value.at(-1)?.endLine || 1) + (top - heights.prefix(groups.value.length)) / 24
  const i = heights.at(top), group = groups.value[i]
  if (!group) return 1
  return group.line + (group.endLine - group.line) * Math.max(0, Math.min(1, (top - heights.prefix(i)) / heights.heights[i]))
}
function onScroll() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0; updateWindow()
    if (expected) { expected = false; return }
    const line = lineAt((root.value?.scrollTop || 0) / scale.value)
    pendingLine = !complete.value && line > (groups.value.at(-1)?.endLine || 1) ? line : undefined
    emit('scroll-line', line)
  })
}
function syncScroll(line: number) {
  pendingLine = line
  const list = groups.value
  if (!root.value || !list.length) return
  let a = 0, b = list.length - 1
  while (a < b) { const mid = (a + b + 1) >>> 1; if (list[mid].line <= line) a = mid; else b = mid - 1 }
  if (line >= list[a].endLine && !complete.value) return
  const group = list[a]
  expected = true
  root.value.scrollTop = (heights.prefix(a) + heights.heights[a] * Math.max(0, Math.min(1, (line - group.line) / Math.max(1, group.endLine - group.line)))) * scale.value
  updateWindow()
}
watch(() => props.content, async source => {
  worker?.terminate(); resize?.disconnect()
  groups.value = []; heights = new HeightIndex(); references.value = {}; start.value = end.value = 0; complete.value = false; failure.value = ''
  if (!source) { complete.value = true; return }
  const task = new Worker(new URL('./preview/structure.worker.ts', import.meta.url), { type: 'module' })
  worker = task
  task.onmessage = async (event: MessageEvent<StructureBatch & { error?: string }>) => {
    if (disposed || task !== worker) return
    if (event.data.error) { failure.value = event.data.error; task.terminate(); return }
    const batch = event.data
    totalLines.value = batch.lines
    for (const group of batch.groups) heights.append(Math.max(28, (group.endLine - group.line) * 24))
    groups.value = groups.value.concat(batch.groups)
    complete.value = batch.complete
    if (batch.complete) { references.value = batch.references; task.terminate(); worker = undefined }
    revision.value++; updateWindow()
    await nextTick()
    if (pendingLine !== undefined) syncScroll(pendingLine)
  }
  task.onerror = () => { failure.value = '结构索引失败，请在源码侧继续编辑。'; task.terminate() }
  task.postMessage(source)
  await nextTick(); updateWindow()
}, { immediate: true })
onMounted(() => {
  resize = new ResizeObserver(entries => {
    const el = root.value
    if (!el) return
    const anchor = heights.at(el.scrollTop / scale.value), inset = el.scrollTop / scale.value - heights.prefix(anchor)
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.group)
      if (index < heights.heights.length) heights.update(index, Math.max(1, entry.target.getBoundingClientRect().height))
    }
    revision.value++
    expected = true; el.scrollTop = (heights.prefix(anchor) + inset) * scale.value
    updateWindow()
    for (const element of el.querySelectorAll('section[data-group]')) resize?.observe(element)
  })
  updateWindow()
  for (const element of root.value?.querySelectorAll('section[data-group]') || []) resize.observe(element)
})
onUnmounted(() => { disposed = true; worker?.terminate(); worker = undefined; resize?.disconnect(); cancelAnimationFrame(frame); groups.value = []; references.value = {}; observed.clear(); heights = new HeightIndex() })
defineExpose({ syncScroll })
</script>
<style scoped>
.split-preview-pane { flex: 1; min-width: 0; height: 100%; overflow: auto; overflow-anchor: none; background: var(--editor); }
.preview-progress, .preview-local-budget { padding: 16px; color: var(--muted); }
.preview-local-budget button { color: var(--accent); background: transparent; border: 0; cursor: pointer; }
</style>
