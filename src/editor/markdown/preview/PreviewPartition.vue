<template>
  <div ref="paneRef" class="preview-partition-pane" :style="markdownTypographyStyle(settings, true)" :data-code-numbers="settings.codeLineNumbers" :data-code-wrap="settings.codeWrap" :data-image-border="(imageBorder ?? settings.imageBorder) !== false">
    <div
      ref="contentRef"
      class="split-preview-content markdown-body"
      role="region"
      aria-label="Markdown 只读预览"
      aria-readonly="true"
      v-html="renderedHtml"
      @click="onContentClick"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { LanguageSupport } from '@codemirror/language'
import { openMarkdownLink } from '../links'
import { createMarkdownRenderer, type PreviewEnvironment, type PreviewSlot } from '../rendering'
import { renderMath, renderDiagram } from '../wysiwyg/renderers'
import { attachMediaHoverTrigger, MediaPreview, type MediaHoverTriggerHandle } from '../wysiwyg/ImagePreview'
import { DISPLAY_HIGHLIGHT_MAX_CHARS } from '../wysiwyg/CodeBlockView'
import { defaultMarkdownTypography, type MarkdownTypography } from '../wysiwyg/contracts'
import { markdownTypographyStyle } from '../typography'
import { createMarkdownResources, mountMarkdownImage, type MarkdownResources } from '../images'
import { textClipboard } from '../../../features/shell/clipboard'
import { htmlForPreview, mountHtmlImages, type MountedImageHandle } from '../html/SafeHtmlRenderer'
import { parseFenceInfo, loadLanguage } from '../../languages'
import { syntaxSpans } from '../../core/syntaxSpans'
import { staticCodeLines } from '../staticCode'
import { createRenderTaskQueue } from '../renderTaskQueue'
import { observeRenderVisibility } from '../renderVisibility'

const escapePreviewCode = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

const splitHighlightQueue = createRenderTaskQueue(2, 128)

const props = defineProps<{
  content: string
  references?: Record<string, unknown>
  scrollRoot?: HTMLElement | null
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

const paneRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const mediaPreview = new MediaPreview()
let mediaHoverTrigger: MediaHoverTriggerHandle | undefined

onMounted(() => {
  if (!disposed && paneRef.value) {
    mediaHoverTrigger = attachMediaHoverTrigger(paneRef.value, {
      preview: mediaPreview,
      getResources: () => props.resources || fallbackResources,
      isAlive: () => !disposed,
    })
  }
})

const revision = ref(0)
let disposed = false
const md = createMarkdownRenderer(() => {
  if (!disposed) revision.value++
}, true)
const previewText = ref(props.content)
let timer: ReturnType<typeof setTimeout> | undefined
let deferredHiddenContent: string | null = null

const onDocumentVisibility = () => {
  if (disposed || typeof document === 'undefined' || document.hidden) return
  if (deferredHiddenContent !== null) {
    const next = deferredHiddenContent
    deferredHiddenContent = null
    previewText.value = next
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onDocumentVisibility)
}

watch(
  () => props.content,
  content => {
    if (timer) clearTimeout(timer)
    if (typeof document !== 'undefined' && document.hidden) {
      deferredHiddenContent = content
      return
    }
    deferredHiddenContent = null
    timer = setTimeout(() => {
      if (disposed) return
      if (typeof document !== 'undefined' && document.hidden) {
        deferredHiddenContent = content
        return
      }
      previewText.value = content
    }, 100)
  }
)

let mountedImages: ReturnType<typeof mountMarkdownImage>[] = []
let mountedHtmlImages: MountedImageHandle | undefined
let hydrateGeneration = 0
let hydrateAbort: AbortController | null = null
let visibilityCleanups: (() => void)[] = []
let themeObserver: MutationObserver | undefined
let refreshDiagrams = () => {}

if (typeof document !== 'undefined') {
  let isLight = document.body.classList.contains('light')
  themeObserver = new MutationObserver(() => {
    const nextLight = document.body.classList.contains('light')
    if (nextLight === isLight) return
    isLight = nextLight
    refreshDiagrams()
  })
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
}

function teardownHydration() {
  hydrateAbort?.abort()
  hydrateAbort = null
  for (const stop of visibilityCleanups) stop()
  visibilityCleanups = []
  refreshDiagrams = () => {}
  for (const image of mountedImages) image.destroy()
  mountedImages = []
  mountedHtmlImages?.destroy()
  mountedHtmlImages = undefined
}

let lastReferences: Record<string, unknown> | undefined
let lastParsedText = ''
let lastParsedRevision = -1
let lastRenderedResult: { html: string; slots: PreviewSlot[] } = { html: '', slots: [] }

onUnmounted(() => {
  disposed = true
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onDocumentVisibility)
  }
  themeObserver?.disconnect()
  themeObserver = undefined
  if (timer) clearTimeout(timer)
  teardownHydration()
  mediaHoverTrigger?.destroy()
  mediaHoverTrigger = undefined
  mediaPreview.destroy()
  contentRef.value?.replaceChildren()
  lastParsedText = ''
  lastRenderedResult = { html: '', slots: [] }
})

const rendered = computed(() => {
  const rev = revision.value
  const references = props.references
  const currentText = previewText.value || ''
  if (currentText === lastParsedText && references === lastReferences && rev === lastParsedRevision && lastRenderedResult.html) {
    return lastRenderedResult
  }
  const environment: PreviewEnvironment = { slots: [], references: { ...props.references } }
  const tokens = md.parse(currentText, environment)
  for (const token of tokens) {
    if (token.map && token.nesting === 1 && token.level === 0) {
      token.attrSet('data-source-line', String(token.map[0] + 1))
    }
  }
  const rawRendered = md.renderer.render(tokens, md.options, environment)
  lastReferences = references
  lastParsedText = currentText
  lastParsedRevision = rev
  lastRenderedResult = { html: htmlForPreview(rawRendered), slots: environment.slots || [] }
  return lastRenderedResult
})
const renderedHtml = computed(() => rendered.value.html)

const fallbackResources = createMarkdownResources(() => undefined)

watch(
  [renderedHtml, () => props.resources, () => props.resourceKey],
  async () => {
    const generation = ++hydrateGeneration
    const expectedResourceKey = props.resourceKey
    const snapshot = previewText.value
    teardownHydration()

    await nextTick()
    if (disposed || generation !== hydrateGeneration || props.resourceKey !== expectedResourceKey) return
    const scrollRoot = contentRef.value
    if (!scrollRoot) return

    const roundController = new AbortController()
    hydrateAbort = roundController

    const slots = new Map(rendered.value.slots.map(slot => [slot.id, slot]))
    for (const table of scrollRoot.querySelectorAll('table')) {
      if (table.parentElement?.classList.contains('md-table-scroll')) continue
      const wrapper = document.createElement('div')
      wrapper.className = 'md-table-scroll'
      table.replaceWith(wrapper)
      wrapper.append(table)
    }

    const isCurrentRound = () =>
      !disposed &&
      !roundController.signal.aborted &&
      generation === hydrateGeneration &&
      props.resourceKey === expectedResourceKey &&
      snapshot === previewText.value

    const diagramEntries: { triggerThemeRefresh: () => void }[] = []
    let diagramCount = 0

    for (const host of scrollRoot.querySelectorAll<HTMLElement>('[data-md-render]')) {
      const slot = slots.get(host.dataset.mdRender || '')
      if (!slot || slot.kind === 'image') continue

      if (slot.kind === 'task') {
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.disabled = true
        input.checked = slot.source === 'x'
        input.setAttribute('aria-label', input.checked ? '已完成任务' : '待办任务')
        host.replaceChildren(input)
        continue
      }

      if (slot.kind === 'code') {
        const codeEl = host.querySelector<HTMLElement>('pre > code')
        const { language } = parseFenceInfo(slot.info || '')
        const visibleCode = slot.source.slice(0, 128 * 1024).split('\n').slice(0, 5000).join('\n')
        if (!codeEl || !language || visibleCode.length > DISPLAY_HIGHLIGHT_MAX_CHARS) continue

        let highlighted = false
        let itemAbort: AbortController | null = null
        const stop = observeRenderVisibility(
          host,
          { root: props.scrollRoot || scrollRoot, rootMargin: '400px 0px 400px 0px' },
          state => {
            if (!isCurrentRound()) return
            if (state.visible) {
              if (highlighted || itemAbort) return
              const ctrl = new AbortController()
              itemAbort = ctrl
              const abortFromRound = () => ctrl.abort()
              roundController.signal.addEventListener('abort', abortFromRound, { once: true })
              void splitHighlightQueue(
                async () => {
                  const support = await loadLanguage(language.name, 'fence')
                  if (!isCurrentRound() || ctrl.signal.aborted || !(support instanceof LanguageSupport)) return null
                  return syntaxSpans(visibleCode, support)
                },
                { signal: ctrl.signal, priority: 'normal' }
              )
                .then(spans => {
                  if (!spans || !isCurrentRound() || ctrl.signal.aborted || !codeEl.isConnected) return
                  codeEl.innerHTML = staticCodeLines(visibleCode, spans, escapePreviewCode, false)
                  highlighted = true
                })
                .catch(() => {})
                .finally(() => {
                  roundController.signal.removeEventListener('abort', abortFromRound)
                  if (itemAbort === ctrl) itemAbort = null
                })
            } else {
              itemAbort?.abort()
              itemAbort = null
            }
          }
        )
        visibilityCleanups.push(() => {
          itemAbort?.abort()
          itemAbort = null
          stop()
        })
        continue
      }

      if (slot.kind === 'diagram') {
        const diagram = host.querySelector<HTMLElement>('.md-diagram')
        if (!diagram) continue
        diagramCount++
        if (diagramCount > 512) {
          diagram.classList.add('md-render-error')
          diagram.textContent = '单文档图表数量超过 512 个安全上限，已暂停后续图表预览；Markdown 源码仍完整保留。'
          continue
        }
        let diagramVisible = false
        let diagramDirty = true
        let itemAbort: AbortController | null = null
        const runDiagram = () => {
          if (!isCurrentRound() || !diagramVisible || !diagramDirty) return
          itemAbort?.abort()
          const ctrl = new AbortController()
          itemAbort = ctrl
          const abortFromRound = () => ctrl.abort()
          roundController.signal.addEventListener('abort', abortFromRound, { once: true })
          if (!diagram.querySelector('svg')) {
            diagram.classList.remove('md-render-error')
            diagram.textContent = '正在渲染图表…'
          }
          void renderDiagram(
            diagram,
            slot.source,
            () => isCurrentRound() && diagramVisible && !ctrl.signal.aborted,
            ctrl.signal
          )
            .then(() => {
              if (isCurrentRound() && !ctrl.signal.aborted && !!diagram.querySelector('svg')) {
                diagram.classList.remove('md-render-error')
                diagramDirty = false
                mediaHoverTrigger?.reposition()
              }
            })
            .catch(error => {
              if (diagram.isConnected && isCurrentRound() && !ctrl.signal.aborted) {
                diagram.classList.add('md-render-error')
                const message = error instanceof Error ? error.message : String(error)
                diagram.textContent = message
                diagramDirty = false
                mediaHoverTrigger?.reposition()
              }
            })
            .finally(() => {
              roundController.signal.removeEventListener('abort', abortFromRound)
              if (itemAbort === ctrl) itemAbort = null
            })
        }
        const stop = observeRenderVisibility(
          host,
          { root: props.scrollRoot || scrollRoot, rootMargin: '400px 0px 400px 0px' },
          state => {
            if (!isCurrentRound()) return
            diagramVisible = state.visible
            if (state.visible) {
              runDiagram()
            } else {
              itemAbort?.abort()
              itemAbort = null
            }
          }
        )
        diagramEntries.push({
          triggerThemeRefresh: () => {
            diagramDirty = true
            if (diagramVisible) runDiagram()
          },
        })
        visibilityCleanups.push(() => {
          itemAbort?.abort()
          itemAbort = null
          stop()
        })
        continue
      }

      // Math inline / math block
      const displayMode = slot.kind === 'math-block'
      let mathRendered = false
      let itemAbort: AbortController | null = null
      host.textContent = slot.source
      const stop = observeRenderVisibility(
        host,
        { root: props.scrollRoot || scrollRoot, rootMargin: '400px 0px 400px 0px' },
        state => {
          if (!isCurrentRound()) return
          if (state.visible) {
            if (mathRendered || itemAbort) return
            const ctrl = new AbortController()
            itemAbort = ctrl
            const abortFromRound = () => ctrl.abort()
            roundController.signal.addEventListener('abort', abortFromRound, { once: true })
            void renderMath(
              host,
              slot.source,
              displayMode,
              () => isCurrentRound() && !ctrl.signal.aborted,
              ctrl.signal
            )
              .then(() => {
                if (isCurrentRound() && !ctrl.signal.aborted && !!host.querySelector('.katex')) {
                  mathRendered = true
                }
              })
              .catch(error => {
                if (host.isConnected && isCurrentRound() && !ctrl.signal.aborted) {
                  host.classList.add('md-render-error')
                  host.textContent = String(error instanceof Error ? error.message : error)
                  mathRendered = true
                }
              })
              .finally(() => {
                roundController.signal.removeEventListener('abort', abortFromRound)
                if (itemAbort === ctrl) itemAbort = null
              })
          } else {
            itemAbort?.abort()
            itemAbort = null
          }
        }
      )
      visibilityCleanups.push(() => {
        itemAbort?.abort()
        itemAbort = null
        stop()
      })
    }

    refreshDiagrams = () => {
      for (const entry of diagramEntries) entry.triggerThemeRefresh()
    }

    // 绑定代码块复制按钮
    for (const button of Array.from(scrollRoot.querySelectorAll<HTMLButtonElement>('[data-md-copy]'))) {
      button.onmousedown = event => event.preventDefault()
      button.onclick = async () => {
        const fenceEl = button.closest('.md-preview-fence')
        const code =
          slots.get((fenceEl as HTMLElement | null)?.dataset.mdRender || '')?.source ??
          fenceEl?.querySelector('code')?.textContent ??
          ''
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

    // 挂载图片（使用真实预览容器作为视口观察 root）
    for (const host of Array.from(scrollRoot.querySelectorAll<HTMLElement>('.md-image-slot'))) {
      const slot = slots.get(host.dataset.mdRender || '')
      if (slot?.kind !== 'image') continue
      const source = slot.source
      const from = slot.from || 0
      const parentP = host.parentElement?.tagName === 'P' ? host.parentElement : null
      const isStandalone =
        !!parentP &&
        parentP.querySelectorAll('.md-image-slot').length === 1 &&
        [...parentP.childNodes].every(node => node === host || !node.textContent?.trim())
      host.classList.toggle('md-image-standalone', isStandalone)
      mountedImages.push(
        mountMarkdownImage(
          host,
          source,
          slot.alt || '',
          props.resources || fallbackResources,
          () => emit('edit-image', from, snapshot),
          () => {
            if (!disposed && generation === hydrateGeneration) {
              host.classList.toggle('md-image-ready', !!host.querySelector('img')?.naturalWidth)
              mediaHoverTrigger?.reposition()
            }
          }
        )
      )
    }

    // 挂载 HTML 内嵌图片 (如 <img src="...">)
    if (contentRef.value) {
      mountedHtmlImages = mountHtmlImages(contentRef.value, props.resources || fallbackResources)
    }
    mediaPreview.refresh()
    mediaHoverTrigger?.reposition()
  },
  { immediate: true, flush: 'post' }
)

function onContentClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
  if (anchor) {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      void openMarkdownLink(anchor.getAttribute('href') || '')
    }
  }
}

</script>

<style scoped>
.preview-partition-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--editor);
  overflow: visible;
  height: auto;
  position: relative;
}

.split-preview-content {
  flex: 1;
  overflow: visible;
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
  margin: var(--md-code-block-spacing, 15px) 0;
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
.preview-partition-pane[data-code-numbers="false"] :deep(.md-code-number) { display: none; }
.preview-partition-pane[data-code-numbers="false"] :deep(.md-code-line) { grid-template-columns: minmax(0, 1fr); }
.preview-partition-pane[data-code-wrap="true"] :deep(.md-preview-fence pre code) { width: 100%; min-width: 0; }
.preview-partition-pane[data-code-wrap="true"] :deep(.md-code-text) { white-space: pre-wrap; overflow-wrap: anywhere; }
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
