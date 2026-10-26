<template>
  <aside class="pdf-navigation" role="navigation" aria-label="PDF 导航">
    <div class="pdf-nav-tabs" role="tablist">
      <button
        type="button"
        class="pdf-nav-tab"
        :class="{ active: mode === 'thumbnails' }"
        role="tab"
        :aria-selected="mode === 'thumbnails'"
        aria-label="页面缩略图"
        title="页面缩略图"
        @click="$emit('update:mode', 'thumbnails')"
      >
        <ViewerIcon name="thumbnails" />
        <span>页面</span>
      </button>
      <button
        type="button"
        class="pdf-nav-tab"
        :class="{ active: mode === 'outline' }"
        role="tab"
        :aria-selected="mode === 'outline'"
        aria-label="文档大纲"
        title="文档大纲"
        @click="$emit('update:mode', 'outline')"
      >
        <ViewerIcon name="outline" />
        <span>目录</span>
      </button>
    </div>

    <!-- 1. 缩略图列表 -->
    <div
      v-show="mode === 'thumbnails'"
      ref="thumbnailsContainer"
      class="pdf-nav-content pdf-thumbnails-container"
      tabindex="-1"
    >
      <div v-if="total > 0" class="pdf-thumbnails-list">
        <PdfThumbnail
          v-for="pageNumber in total"
          :key="pageNumber"
          :page-number="pageNumber"
          :is-active="pageNumber === currentPage"
          :data-url="thumbnailUrls.get(pageNumber) || null"
          :loading="loadingPages.has(pageNumber)"
          :error="errorPages.has(pageNumber)"
          :aspect-ratio="pageRatio(pageNumber)"
          @select="handleSelectPage(pageNumber)"
        />
      </div>
      <div v-else class="pdf-nav-empty">无页面</div>
    </div>

    <!-- 2. 文档大纲 / 书签 -->
    <div
      v-show="mode === 'outline'"
      class="pdf-nav-content pdf-outline-container"
      tabindex="-1"
    >
      <div v-if="outlineLoading" class="pdf-outline-status">
        <span class="loading-spin">⟳</span> 正在读取目录…
      </div>
      <div v-else-if="!outlineItems || outlineItems.length === 0" class="pdf-outline-empty">
        此 PDF 不包含文档目录
      </div>
      <div v-else class="pdf-outline-list" role="tree" aria-label="文档目录">
        <PdfOutlineItemView
          v-for="item in outlineItems"
          :key="item.id"
          :item="item"
          :active-id="activeOutlineId"
          @select="handleSelectOutline"
        />
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type * as PDFJS from 'pdfjs-dist'
import ViewerIcon from './ViewerIcon.vue'
import PdfThumbnail from './PdfThumbnail.vue'
import PdfOutlineItemView, { type OutlineNode } from './PdfOutlineItemView.vue'

const props = withDefaults(defineProps<{
  pdf?: PDFJS.PDFDocumentProxy
  total: number
  currentPage: number
  rotation?: number
  mode?: 'thumbnails' | 'outline'
  explicitJumpSeq?: number
  sizes?: Map<number, { width: number; height: number }>
  fallbackSize?: { width: number; height: number }
}>(), {
  rotation: 0,
  mode: 'thumbnails',
  explicitJumpSeq: 0,
  fallbackSize: () => ({ width: 612, height: 792 }),
})

const emit = defineEmits<{
  (e: 'update:mode', mode: 'thumbnails' | 'outline'): void
  (e: 'jump', page: number): void
  (e: 'navigate-dest', dest: any): void
  (e: 'open-url', url: string): void
}>()

const thumbnailsContainer = ref<HTMLElement>()

// 页面比例
function pageRatio(pageNumber: number): number {
  const size = props.sizes?.get(pageNumber) || props.fallbackSize
  const rot = (props.rotation || 0) % 360
  if (rot % 180 !== 0) {
    return size.height / size.width
  }
  return size.width / size.height
}

// ----------------------------------------------------
// 缩略图有界 LRU 缓存与懒加载管理器
// ----------------------------------------------------
const MAX_LRU_ENTRIES = 48
const MAX_CONCURRENT_RENDERS = 2

const thumbnailUrls = reactive(new Map<number, string>())
const loadingPages = reactive(new Set<number>())
const errorPages = reactive(new Set<number>())

// LRU 缓存队列记录使用顺序
const lruList: number[] = []

interface QueueItem {
  pageNumber: number
  rotation: number
  task?: PDFJS.RenderTask
  canceled?: boolean
}

let activeRenderCount = 0
const pendingQueue: QueueItem[] = []
let intersectionObserver: IntersectionObserver | null = null
let disposed = false

function touchLru(pageNumber: number) {
  const idx = lruList.indexOf(pageNumber)
  if (idx !== -1) lruList.splice(idx, 1)
  lruList.push(pageNumber)

  // 驱逐超出容量的最早缓存项
  while (lruList.length > MAX_LRU_ENTRIES) {
    const oldest = lruList.shift()
    if (oldest !== undefined) {
      thumbnailUrls.delete(oldest)
    }
  }
}

function processQueue() {
  if (disposed || !props.pdf) return
  while (activeRenderCount < MAX_CONCURRENT_RENDERS && pendingQueue.length > 0) {
    const item = pendingQueue.shift()!
    if (item.canceled) continue

    // 检查是否已经在缓存中
    if (thumbnailUrls.has(item.pageNumber)) {
      touchLru(item.pageNumber)
      continue
    }

    activeRenderCount++
    loadingPages.add(item.pageNumber)
    errorPages.delete(item.pageNumber)

    void renderThumbnail(item)
  }
}

async function renderThumbnail(item: QueueItem) {
  const doc = props.pdf
  if (!doc || disposed || item.canceled) {
    activeRenderCount = Math.max(0, activeRenderCount - 1)
    loadingPages.delete(item.pageNumber)
    processQueue()
    return
  }

  let pageProxy: PDFJS.PDFPageProxy | null = null
  let canvas: HTMLCanvasElement | null = null

  try {
    pageProxy = await doc.getPage(item.pageNumber)
    if (disposed || item.canceled) {
      pageProxy.cleanup()
      return
    }

    const targetRotation = (pageProxy.rotate + item.rotation) % 360
    const unscaledViewport = pageProxy.getViewport({ scale: 1, rotation: targetRotation })

    // 低分辨率紧凑缩放：目标宽度约 120px，高度自适应
    const targetW = 120
    const scale = Math.min(1, Math.max(0.1, targetW / unscaledViewport.width))
    const viewport = pageProxy.getViewport({ scale, rotation: targetRotation })

    canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))

    const renderTask = pageProxy.render({ canvas, viewport })
    item.task = renderTask

    await renderTask.promise
    if (disposed || item.canceled) return

    // 转换为 JPEG DataURL 后立即清空 Canvas 像素，释放 Backing Store 内存
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
    canvas.width = 0
    canvas.height = 0

    thumbnailUrls.set(item.pageNumber, dataUrl)
    touchLru(item.pageNumber)
  } catch (err: any) {
    if (!item.canceled && !disposed && err?.name !== 'RenderingCancelledException') {
      errorPages.add(item.pageNumber)
    }
  } finally {
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
    if (pageProxy) {
      try { pageProxy.cleanup() } catch { /* Ignore */ }
    }
    loadingPages.delete(item.pageNumber)
    activeRenderCount = Math.max(0, activeRenderCount - 1)
    processQueue()
  }
}

function requestPageThumbnail(pageNumber: number) {
  if (thumbnailUrls.has(pageNumber)) {
    touchLru(pageNumber)
    return
  }
  if (loadingPages.has(pageNumber)) return
  if (pendingQueue.some(item => item.pageNumber === pageNumber && !item.canceled)) return

  pendingQueue.push({
    pageNumber,
    rotation: props.rotation || 0,
  })
  processQueue()
}

function cancelPageThumbnail(pageNumber: number) {
  for (const item of pendingQueue) {
    if (item.pageNumber === pageNumber) {
      item.canceled = true
    }
  }
}

function clearThumbnails() {
  for (const item of pendingQueue) {
    item.canceled = true
    item.task?.cancel()
  }
  pendingQueue.length = 0
  activeRenderCount = 0
  lruList.length = 0
  thumbnailUrls.clear()
  loadingPages.clear()
  errorPages.clear()
}

// 旋转变化时需要重绘缩略图
watch(() => props.rotation, () => {
  clearThumbnails()
  void nextTick(() => observeThumbnails())
})

// 观察可见缩略图
function setupObserver() {
  if (intersectionObserver) intersectionObserver.disconnect()
  intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pageNumStr = entry.target.getAttribute('data-page-number')
      if (!pageNumStr) continue
      const pageNum = Number(pageNumStr)
      if (entry.isIntersecting) {
        requestPageThumbnail(pageNum)
      } else {
        cancelPageThumbnail(pageNum)
      }
    }
  }, {
    root: thumbnailsContainer.value,
    rootMargin: '100px 0px 100px 0px', // 上下适量预取
    threshold: 0.01,
  })
}

function observeThumbnails() {
  if (!intersectionObserver || !thumbnailsContainer.value) return
  intersectionObserver.disconnect()
  const items = thumbnailsContainer.value.querySelectorAll('.pdf-thumbnail-item')
  items.forEach(item => intersectionObserver?.observe(item))
}

watch(() => [props.pdf, props.total], () => {
  clearThumbnails()
  void nextTick(() => {
    observeThumbnails()
    // 默认请求当前页以及邻近页缩略图
    if (props.currentPage >= 1 && props.currentPage <= props.total) {
      requestPageThumbnail(props.currentPage)
    }
  })
}, { immediate: true })

watch(() => props.mode, (mode) => {
  if (mode === 'thumbnails') {
    void nextTick(() => observeThumbnails())
  }
})

// ----------------------------------------------------
// 页面点击与滚动同步
// ----------------------------------------------------
function handleSelectPage(pageNumber: number) {
  emit('jump', pageNumber)
}

// 仅在明确跳页（explicitJumpSeq 变化）时滚动缩略图到可见区域
watch(() => props.explicitJumpSeq, () => {
  if (props.mode !== 'thumbnails') return
  scrollToCurrentThumbnail()
})

function scrollToCurrentThumbnail() {
  void nextTick(() => {
    const container = thumbnailsContainer.value
    if (!container) return
    const el = container.querySelector(`[data-page-number="${props.currentPage}"]`) as HTMLElement | null
    if (!el) return
    const cTop = container.scrollTop
    const cBottom = cTop + container.clientHeight
    const eTop = el.offsetTop
    const eBottom = eTop + el.offsetHeight
    if (eTop < cTop || eBottom > cBottom) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  })
}

// ----------------------------------------------------
// PDF 文档大纲 / 书签解析
// ----------------------------------------------------
const outlineLoading = ref(false)
const outlineItems = shallowRef<OutlineNode[]>([])
const activeOutlineId = ref<string | null>(null)

let outlineCounter = 0

async function parseOutline() {
  const doc = props.pdf
  if (!doc) {
    outlineItems.value = []
    return
  }

  outlineLoading.value = true
  outlineCounter = 0

  try {
    const raw = await doc.getOutline()
    if (disposed) return
    if (!raw || !raw.length) {
      outlineItems.value = []
      return
    }

    async function transformNode(item: any): Promise<OutlineNode> {
      const id = 'outline-' + (++outlineCounter)
      let pageNumber: number | undefined

      // 尝试解析目标页码
      if (item.dest) {
        try {
          let explicitDest = item.dest
          if (typeof explicitDest === 'string') {
            explicitDest = await doc!.getDestination(explicitDest)
          }
          if (Array.isArray(explicitDest) && explicitDest.length > 0) {
            const pageRef = explicitDest[0]
            if (typeof pageRef === 'number') {
              pageNumber = pageRef + 1
            } else if (pageRef && typeof pageRef === 'object') {
              const pIndex = await doc!.getPageIndex(pageRef)
              if (pIndex >= 0) pageNumber = pIndex + 1
            }
          }
        } catch {
          // Dest resolution failure is graceful
        }
      }

      let children: OutlineNode[] | undefined
      if (item.items && item.items.length > 0) {
        children = await Promise.all(item.items.map(transformNode))
      }

      return {
        id,
        title: item.title || '书签',
        dest: item.dest,
        url: item.url || item.unsafeUrl,
        items: children,
        pageNumber,
      }
    }

    outlineItems.value = await Promise.all(raw.map(transformNode))
  } catch (e) {
    console.warn('Failed to parse PDF outline', e)
    outlineItems.value = []
  } finally {
    outlineLoading.value = false
  }
}

watch(() => props.pdf, () => {
  void parseOutline()
}, { immediate: true })

function handleSelectOutline(item: OutlineNode) {
  activeOutlineId.value = item.id
  if (item.dest) {
    emit('navigate-dest', item.dest)
  } else if (item.url) {
    const rawUrl = item.url
    if (/^https?:\/\//i.test(rawUrl)) {
      emit('open-url', rawUrl)
    }
  }
}

onMounted(() => {
  setupObserver()
  observeThumbnails()
})

onBeforeUnmount(() => {
  disposed = true
  intersectionObserver?.disconnect()
  if (thumbnailsContainer.value) {
    for (const img of thumbnailsContainer.value.querySelectorAll('img')) {
      img.onload = img.onerror = null
      img.removeAttribute('src')
      img.remove()
    }
  }
  clearThumbnails()
})
</script>

<style scoped>
.pdf-navigation {
  display: flex;
  flex-direction: column;
  height: 100%;
  flex: none;
  background: var(--editor);
  border-right: 1px solid var(--line);
  user-select: none;
  position: relative;
  overflow: hidden;
  font-size: var(--ui-font-size);
  box-sizing: border-box;
}

.pdf-nav-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--line);
  padding: 4px 6px;
  gap: 4px;
  background: var(--bar);
  flex: none;
  box-sizing: border-box;
}

.pdf-nav-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--sub);
  font: inherit;
  font-size: var(--ui-small-font-size);
  cursor: pointer;
  transition: background-color 0.1s ease, color 0.1s ease;
  white-space: nowrap;
}

.pdf-nav-tab:hover {
  background: var(--hover);
  color: var(--bright);
}

.pdf-nav-tab:focus-visible {
  outline: 1px solid var(--accent);
}

.pdf-nav-tab.active {
  background: var(--accentbg);
  color: var(--accent);
  font-weight: 500;
}

.pdf-nav-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  position: relative;
  box-sizing: border-box;
}

.pdf-thumbnails-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 6px;
  gap: 12px;
}

.pdf-nav-empty,
.pdf-outline-empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--muted);
  font-size: var(--ui-small-font-size);
  line-height: 1.5;
}

.pdf-outline-status {
  padding: 24px 16px;
  text-align: center;
  color: var(--muted);
  font-size: var(--ui-small-font-size);
}

.pdf-outline-list {
  padding: 6px 4px;
}

.loading-spin {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
