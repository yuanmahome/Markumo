<template>
  <div class="split-preview-pane" :style="markdownTypographyStyle(settings, true)" :data-code-numbers="settings.codeLineNumbers" :data-code-wrap="settings.codeWrap" :data-image-border="(imageBorder ?? settings.imageBorder) !== false">
    <div
      ref="contentRef"
      class="split-preview-content markdown-body"
      role="region"
      aria-label="Markdown 只读预览"
      aria-readonly="true"
      v-html="renderedHtml"
      @click="onContentClick"
      @scroll="onScroll"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import { openMarkdownLink } from './links'
import { createMarkdownRenderer, type PreviewEnvironment } from './rendering'
import { renderMath, renderDiagram } from './wysiwyg/renderers'
import { defaultMarkdownTypography, type MarkdownTypography } from './wysiwyg/contracts'
import { markdownTypographyStyle } from './typography'
import { createMarkdownResources, mountMarkdownImage, type MarkdownResources } from './images'
import { textClipboard } from '../../features/shell/clipboard'
import { htmlForPreview, mountHtmlImages, type MountedImageHandle } from './html/SafeHtmlRenderer'

const props = defineProps<{
  content: string
  tooLarge?: boolean
  resources?: MarkdownResources
  resourceKey?: string
  imageBorder?: boolean
  typography?: MarkdownTypography
}>()
const defaults = defaultMarkdownTypography()
const settings = computed(() => props.typography || defaults)
const emit = defineEmits<{
  (e: 'scroll-line', line: number): void
  (e: 'edit-image', from: number, snapshot: string): void
}>()

const contentRef = ref<HTMLElement | null>(null)

const revision = ref(0)
let disposed = false
const md = createMarkdownRenderer(() => {
  if (!disposed) revision.value++
}, true)
const previewText = ref(props.content)
let timer: ReturnType<typeof setTimeout> | undefined

watch(() => props.content, content => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { previewText.value = content }, 100)
})

let mountedImages: ReturnType<typeof mountMarkdownImage>[] = []
let mountedHtmlImages: MountedImageHandle | undefined
let hydrateGeneration = 0
let themeObserver: MutationObserver | undefined
let refreshDiagrams = () => {}
if (typeof document !== 'undefined') {
  themeObserver = new MutationObserver(() => refreshDiagrams())
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
}

onUnmounted(() => {
  disposed = true
  themeObserver?.disconnect()
  if (timer) clearTimeout(timer)
  for (const image of mountedImages) image.destroy()
  mountedImages = []
  mountedHtmlImages?.destroy()
  mountedHtmlImages = undefined
})

let lastParsedText = ''
let lastParsedRevision = -1
let lastRenderedResult = { html: '', slots: [] as any[] }

const rendered = computed(() => {
  const rev = revision.value
  if (props.tooLarge || previewText.value.length > 1024 * 1024) {
    return { html: '<p>文档较大，已暂停只读预览；源码仍可编辑。</p>', slots: [] }
  }
  const currentText = previewText.value || ''
  if (currentText === lastParsedText && rev === lastParsedRevision && lastRenderedResult.html) {
    return lastRenderedResult
  }
  const environment: PreviewEnvironment = { slots: [] }
  const tokens = md.parse(currentText, environment)
  for (const token of tokens) {
    if (token.map && token.nesting === 1 && token.level === 0) {
      token.attrSet('data-source-line', String(token.map[0] + 1))
    }
  }
  const rawRendered = md.renderer.render(tokens, md.options, environment)
  lastParsedText = currentText
  lastParsedRevision = rev
  lastRenderedResult = { html: htmlForPreview(rawRendered), slots: environment.slots || [] }
  return lastRenderedResult
})
const renderedHtml = computed(() => rendered.value.html)

const fallbackResources = createMarkdownResources(() => undefined)

watch([renderedHtml, () => props.resources, () => props.resourceKey], async () => {
  const generation = ++hydrateGeneration
  const snapshot = previewText.value
  for (const image of mountedImages) image.destroy()
  mountedImages = []

  await nextTick()
  if (disposed || generation !== hydrateGeneration) return

  const slots = new Map(rendered.value.slots.map(slot => [slot.id, slot]))
  // Raw HTML tables have already been sanitized; give them the same local
  // scroll boundary as Markdown tables without changing document source.
  for (const table of contentRef.value?.querySelectorAll('table') || []) {
    if (table.parentElement?.classList.contains('md-table-scroll')) continue
    const wrapper = document.createElement('div'); wrapper.className = 'md-table-scroll'
    table.replaceWith(wrapper); wrapper.append(table)
  }
  const diagrams: { host: HTMLElement; source: string }[] = []
  for (const host of contentRef.value?.querySelectorAll<HTMLElement>('[data-md-render]') || []) {
    const slot = slots.get(host.dataset.mdRender || '')
    if (!slot) continue
    if (slot.kind === 'code' || slot.kind === 'image') continue
    if (slot.kind === 'task') {
      const input = document.createElement('input')
      input.type = 'checkbox'; input.disabled = true; input.checked = slot.source === 'x'; input.setAttribute('aria-label', input.checked ? '已完成任务' : '待办任务')
      host.replaceChildren(input); continue
    }
    if (slot.kind === 'diagram') { const diagram = host.querySelector<HTMLElement>('.md-diagram'); if (diagram) diagrams.push({ host: diagram, source: slot.source }); continue }
    const current = () => !disposed && generation === hydrateGeneration && snapshot === props.content
    void renderMath(host, slot.source, slot.kind === 'math-block', current).catch(error => {
      if (host.isConnected && current()) { host.classList.add('md-render-error'); host.textContent = String(error instanceof Error ? error.message : error) }
    })
  }
  let diagramGeneration = 0
  refreshDiagrams = () => {
    const version = ++diagramGeneration
    for (const { host, source } of diagrams.slice(0, 16)) {
      const current = () => !disposed && generation === hydrateGeneration && version === diagramGeneration && snapshot === props.content
      void renderDiagram(host, source, current).catch(error => {
        if (host.isConnected && current()) { host.classList.add('md-render-error'); host.textContent = `${error instanceof Error ? error.message : error}\n${source}` }
      })
    }
    for (const { host } of diagrams.slice(16)) host.textContent = '图表达到每次预览 16 个的预算。'
  }
  refreshDiagrams()

  // 绑定代码块复制按钮
  for (const button of Array.from(contentRef.value?.querySelectorAll<HTMLButtonElement>('[data-md-copy]') || [])) {
    button.onmousedown = event => event.preventDefault()
    button.onclick = async () => {
      const fenceEl = button.closest('.md-preview-fence')
      const code = slots.get((fenceEl as HTMLElement | null)?.dataset.mdRender || '')?.source ?? fenceEl?.querySelector('code')?.textContent ?? ''
      try {
        await textClipboard.writeText(code)
        const originalHtml = button.innerHTML
        const checkIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m5 12 4 4L19 6"/></svg>`
        button.innerHTML = checkIcon
        button.title = '已复制'
        setTimeout(() => {
          if (button.isConnected) {
            button.innerHTML = originalHtml
            button.title = '复制代码'
          }
        }, 1500)
      } catch {
        window.dispatchEvent(new CustomEvent('editor-notice', { detail: '复制失败，请选中后复制' }))
      }
    }
  }

  // 挂载图片
  for (const host of Array.from(contentRef.value?.querySelectorAll<HTMLElement>('.md-image-slot') || []).slice(0, 64)) {
    const slot = slots.get(host.dataset.mdRender || '')
    if (slot?.kind !== 'image') continue
    const source = slot.source
    const from = slot.from || 0
    const parentP = host.parentElement?.tagName === 'P' ? host.parentElement : null
    const isStandalone = !!parentP
      && parentP.querySelectorAll('.md-image-slot').length === 1
      && [...parentP.childNodes].every(node => node === host || !node.textContent?.trim())
    host.classList.toggle('md-image-standalone', isStandalone)
    mountedImages.push(
      mountMarkdownImage(
        host,
        source,
        slot.alt || '',
        props.resources || fallbackResources,
        () => emit('edit-image', from, snapshot),
        () => {
          // 图片尺寸测量完毕后，重新校准滚动锚点
          if (!disposed && generation === hydrateGeneration) {
            host.classList.toggle('md-image-ready', !!host.querySelector('img')?.naturalWidth)
          }
        }
      )
    )
  }

  // 挂载 HTML 内嵌图片 (如 <img src="...">)
  mountedHtmlImages?.destroy()
  if (contentRef.value) {
    mountedHtmlImages = mountHtmlImages(contentRef.value, props.resources || fallbackResources)
  }
}, { immediate: true, flush: 'post' })

function onContentClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
  if (anchor) {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      void openMarkdownLink(anchor.getAttribute('href') || '')
    }
  }
}

let expectedTop: number | null = null
let isScrolling = false

function onScroll() {
  if (isScrolling) return
  const element = contentRef.value
  if (!element) return
  if (expectedTop !== null && Math.abs(element.scrollTop - expectedTop) <= 2) {
    expectedTop = null
    return
  }
  expectedTop = null

  const items = anchors()
  const y = element.scrollTop
  let index = 0
  while (index + 1 < items.length && items[index + 1].top <= y) index++
  const start = items[index]
  const end = items[index + 1]
  if (start) {
    const line = end && end.top > start.top
      ? start.line + (end.line - start.line) * Math.max(0, (y - start.top) / (end.top - start.top))
      : start.line
    emit('scroll-line', line)
  }
}

function anchors() {
  const element = contentRef.value
  if (!element) return []
  const top = element.getBoundingClientRect().top
  const items = Array.from(element.querySelectorAll<HTMLElement>('[data-source-line]')).map(node => ({
    line: Number(node.dataset.sourceLine),
    top: node.getBoundingClientRect().top - top + element.scrollTop,
  }))
  items.push({ line: previewText.value.split('\n').length + 1, top: element.scrollHeight })
  return items
}

function syncScroll(line: number) {
  const element = contentRef.value
  const items = anchors()
  if (!element || !items.length) return
  let index = 0
  while (index + 1 < items.length && items[index + 1].line <= line) index++
  const start = items[index]
  const end = items[index + 1]
  const next = start.top + (end && end.line > start.line ? (end.top - start.top) * Math.max(0, (line - start.line) / (end.line - start.line)) : 0)
  if (Math.abs(element.scrollTop - next) > 2) {
    isScrolling = true
    element.scrollTop = next
    expectedTop = next
    setTimeout(() => { isScrolling = false }, 50)
  }
}

defineExpose({ syncScroll })
</script>

<style scoped>
.split-preview-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--editor);
  overflow: hidden;
  height: 100%;
  position: relative;
}

.split-preview-content {
  flex: 1;
  overflow-y: auto;
  box-sizing: border-box;
}
:deep(.md-math-output) { margin: 1em 0; max-width: 100%; overflow-x: auto; text-align: center; }
:deep(.md-math-output .katex-display) { margin: 0; }
:deep(.md-math-output .katex-display > .katex) { white-space: nowrap; }
:deep(.md-inline-math) { display: inline; }
:deep(.md-render-error) { color: var(--pink); white-space: pre-wrap; overflow-wrap: anywhere; }

/* 代码块：无两层边框，无大语言条，单层细边框与淡灰底色 */
:deep(.md-preview-fence) {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  background: var(--md-code-bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
  margin: 1.2em 0;
}

:deep(.md-preview-fence pre) {
  margin: 0;
  padding: 10px 30px 6px 0;
  background: transparent;
  border: none;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--md-code-font-size);
  line-height: var(--md-code-line-height);
  color: var(--text);
}

:deep(.md-preview-fence pre code) {
  padding: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  display: block;
  width: max-content;
  min-width: 100%;
}
:deep(.md-code-line) { display: grid; grid-template-columns: max-content minmax(0, 1fr); line-height: inherit; }
:deep(.md-code-number) { position: sticky; left: 0; padding: 0 5px 0 4px; color: var(--muted); background: var(--md-code-bg); font-size: 12px; line-height: inherit; white-space: pre; user-select: none; }
:deep(.md-code-text) { padding: 0 14px; white-space: pre; min-width: 0; }
:deep(.md-code-text:empty)::before { content: '\200b'; }
.split-preview-pane[data-code-numbers="false"] :deep(.md-code-number) { display: none; }
.split-preview-pane[data-code-numbers="false"] :deep(.md-code-line) { grid-template-columns: minmax(0, 1fr); }
.split-preview-pane[data-code-wrap="true"] :deep(.md-preview-fence pre code) { width: 100%; min-width: 0; }
.split-preview-pane[data-code-wrap="true"] :deep(.md-code-text) { white-space: pre-wrap; overflow-wrap: anywhere; }
:deep(.md-diagram) { padding: 16px; overflow: auto; max-height: 600px; text-align: center; }
:deep(.md-diagram svg) { max-width: 100%; height: auto; }

/* 复制按钮：右上角 14px 图标，hover 时显现 */
:deep(.md-preview-fence .md-code-copy) {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 5;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, background 0.15s ease;
  background: var(--bar);
  border: 1px solid var(--line);
  color: var(--muted);
  width: 24px;
  height: 24px;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
}

:deep(.md-preview-fence:hover .md-code-copy) {
  opacity: 0.95;
  pointer-events: auto;
}
:deep(.md-preview-fence:focus-within .md-code-copy) { opacity: 1; pointer-events: auto; }

:deep(.md-preview-fence .md-code-copy:hover) {
  opacity: 1;
  color: var(--bright);
  background: var(--hover);
}
</style>
