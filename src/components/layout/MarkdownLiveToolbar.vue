<template>
  <div v-if="state" ref="root" class="md-live-toolbar-shell" :class="{ collapsed }">
    <button
      v-if="collapsed"
      type="button"
      class="md-toolbar-reveal"
      aria-label="展开 Markdown 工具栏"
      title="展开 Markdown 工具栏"
      @mousedown.prevent
      @click="expandToolbar"
    >
      <MarkdownToolbarIcon name="chevron-down" :size="14" />
    </button>

    <div v-else ref="toolbar" class="md-live-toolbar" :class="{
      'compact-lists': overflowLevel >= 1, 'compact-insert': overflowLevel >= 2,
      'compact-utilities': overflowLevel >= 3, 'compact-heading': overflowLevel >= 4,
      'compact-format': overflowLevel >= 5,
    }" role="toolbar" aria-label="Markdown 格式工具栏" @keydown="toolbarKeydown">
      <div class="md-toolbar-group md-toolbar-heading-group" data-priority="4">
        <div class="md-toolbar-anchor">
          <button
            ref="headingButton"
            type="button"
            class="md-toolbar-btn md-toolbar-heading-btn"
            :class="{ active: state.heading > 0 }"
            :disabled="formattingDisabled"
            aria-label="段落样式"
            aria-haspopup="menu"
            :aria-expanded="headingOpen"
            :title="headingLabel"
            @mousedown.prevent
            @click="toggleHeading"
          >
            <span>{{ headingLabel }}</span>
            <MarkdownToolbarIcon name="chevron-down" :size="12" />
          </button>
          <Teleport to="body">
          <div v-if="headingOpen" ref="headingMenu" :style="popoverStyle" class="md-toolbar-popover md-heading-menu" role="menu" aria-label="段落样式" @keydown="popoverKeydown">
            <button
              v-for="option in headingOptions"
              :key="option.value"
              type="button"
              role="menuitemradio"
              :aria-checked="state.heading === option.value"
              :class="{ active: state.heading === option.value }"
              @mousedown.prevent
              @click="setHeading(option.value)"
            >
              <span>{{ option.label }}</span>
              <MarkdownToolbarIcon v-if="state.heading === option.value" name="check" :size="14" />
            </button>
          </div>
          </Teleport>
        </div>
      </div>

      <span class="md-toolbar-divider md-toolbar-heading-divider" data-priority="4" aria-hidden="true"></span>

      <div class="md-toolbar-group md-toolbar-format" data-priority="5">
        <button
          v-for="item in textActions"
          :key="item.format"
          type="button"
          class="md-toolbar-btn"
          :class="{ active: isActive(item.format) }"
          :disabled="formattingDisabled"
          :aria-label="item.label"
          :aria-pressed="isActive(item.format)"
          :title="tooltip(item.label, item.shortcut)"
          @mousedown.prevent
          @click="apply(item.format)"
        ><MarkdownToolbarIcon :name="item.icon" /></button>
      </div>

      <span class="md-toolbar-divider md-toolbar-lists-divider" data-priority="1" aria-hidden="true"></span>
      <div class="md-toolbar-group md-toolbar-lists" data-priority="1">
        <button
          v-for="item in listActions"
          :key="item.format"
          type="button"
          class="md-toolbar-btn"
          :class="{ active: isActive(item.format) }"
          :disabled="formattingDisabled"
          :aria-label="item.label"
          :aria-pressed="isActive(item.format)"
          :title="item.label"
          @mousedown.prevent
          @click="apply(item.format)"
        ><MarkdownToolbarIcon :name="item.icon" /></button>
      </div>

      <span class="md-toolbar-divider md-toolbar-insert-divider" data-priority="2" aria-hidden="true"></span>
      <div class="md-toolbar-group md-toolbar-insert" data-priority="2">
        <button
          type="button"
          class="md-toolbar-btn"
          :class="{ active: state.link }"
          :disabled="formattingDisabled"
          aria-label="插入链接"
          :aria-pressed="state.link"
          :title="tooltip('插入链接', 'Mod+K')"
          @mousedown.prevent
          @click="apply('link')"
        ><MarkdownToolbarIcon name="link" /></button>
        <button
          type="button"
          class="md-toolbar-btn"
          :disabled="formattingDisabled"
          aria-label="插入图片"
          :title="tooltip('插入图片', 'Mod+Shift+I')"
          @mousedown.prevent
          @click="apply('image')"
        ><MarkdownToolbarIcon name="image" /></button>

        <div class="md-toolbar-anchor">
          <button
            ref="tableButton"
            type="button"
            class="md-toolbar-btn"
            :class="{ active: tableOpen }"
            :disabled="formattingDisabled"
            aria-label="插入表格"
            aria-haspopup="dialog"
            :aria-expanded="tableOpen"
            title="插入表格"
            @mousedown.prevent
            @click="toggleTable"
          ><MarkdownToolbarIcon name="table" /></button>
          <Teleport to="body">
          <div v-if="tableOpen" ref="tableMenu" :style="popoverStyle" class="md-toolbar-popover md-table-picker" role="dialog" aria-label="选择表格尺寸" @keydown="popoverKeydown">
            <div class="md-table-picker-head"><span>表格</span><strong>{{ previewRows }} × {{ previewColumns }}</strong></div>
            <div class="md-table-picker-grid">
              <button
                v-for="cell in tableCells"
                :key="`${cell.row}:${cell.column}`"
                type="button"
                class="md-table-picker-cell"
                :class="{ active: cell.row <= previewRows && cell.column <= previewColumns }"
                :aria-label="`插入 ${cell.row} 行 ${cell.column} 列表格`"
                @mouseenter="previewRows = cell.row; previewColumns = cell.column"
                @focus="previewRows = cell.row; previewColumns = cell.column"
                @click="insertTable(cell.row, cell.column)"
              ></button>
            </div>
          </div>
          </Teleport>
        </div>

        <button
          type="button"
          class="md-toolbar-btn"
          :class="{ active: state.codeBlock }"
          :disabled="formattingDisabled"
          aria-label="插入代码块"
          :aria-pressed="state.codeBlock"
          :title="tooltip('代码块', 'Mod+Shift+K')"
          @mousedown.prevent
          @click="apply('code-block')"
        ><MarkdownToolbarIcon name="code-block" /></button>

        <div class="md-toolbar-anchor">
          <button
            ref="mathButton"
            type="button"
            class="md-toolbar-btn"
            :class="{ active: mathOpen }"
            :disabled="formattingDisabled || !state.live"
            aria-label="插入数学公式"
            aria-haspopup="menu"
            :aria-expanded="mathOpen"
            :title="state.live ? '插入数学公式' : '数学公式块仅在实时模式下可插入'"
            @mousedown.prevent
            @click="toggleMath"
          ><MarkdownToolbarIcon name="sigma" /></button>
          <Teleport to="body">
          <div v-if="mathOpen" ref="mathMenu" :style="popoverStyle" class="md-toolbar-popover md-math-menu" role="menu" aria-label="插入数学公式" @keydown="popoverKeydown">
            <button type="button" role="menuitem" @mousedown.prevent @click="insertMath">
              <span>公式块</span><small>$$…$$</small>
            </button>
          </div>
          </Teleport>
        </div>
      </div>

      <div class="md-toolbar-group md-toolbar-more-group">
        <div class="md-toolbar-anchor">
          <button
            ref="moreButton"
            type="button"
            class="md-toolbar-btn"
            :class="{ active: moreOpen }"
            aria-label="更多 Markdown 操作"
            aria-haspopup="menu"
            :aria-expanded="moreOpen"
            title="更多 Markdown 操作"
            @mousedown.prevent
            @click="toggleMore"
          ><MarkdownToolbarIcon name="more" /></button>
          <Teleport to="body">
          <div v-if="moreOpen" ref="moreMenu" :style="popoverStyle" class="md-toolbar-popover md-more-menu" role="menu" aria-label="更多 Markdown 操作" @keydown="popoverKeydown">
            <div class="md-menu-section-label">段落</div>
            <div class="md-more-heading-grid">
              <button
                v-for="option in headingOptions"
                :key="`more-heading-${option.value}`"
                type="button"
                role="menuitemradio"
                :aria-checked="state.heading === option.value"
                :class="{ active: state.heading === option.value }"
                :disabled="formattingDisabled"
                @mousedown.prevent
                @click="setHeading(option.value)"
              >{{ option.label }}</button>
            </div>
            <div class="md-menu-separator" role="separator"></div>
            <div class="md-menu-section-label">格式</div>
            <div class="md-more-grid md-more-format-grid">
              <button
                v-for="item in moreFormatActions"
                :key="`more-${item.format}`"
                type="button"
                role="menuitem"
                :disabled="formattingDisabled"
                :title="item.label"
                @mousedown.prevent
                @click="moreFormat(item.format)"
              ><MarkdownToolbarIcon :name="item.icon" :size="16" /><span>{{ item.label }}</span></button>
            </div>
            <div class="md-menu-separator" role="separator"></div>
            <div class="md-menu-section-label">插入与块级</div>
            <div class="md-more-grid md-more-insert-grid">
              <button
                v-for="item in moreInsertActions"
                :key="`more-insert-${item.command}`"
                type="button"
                role="menuitem"
                :disabled="moreInsertDisabled || (item.command === 'yaml' && state.hasYaml)"
                :title="item.label"
                @mousedown.prevent
                @click="moreInsert(item.command)"
              ><MarkdownToolbarIcon :name="item.icon" :size="16" /><span>{{ item.label }}</span><small v-if="!state.live">实时</small></button>
            </div>
            <div class="md-menu-separator" role="separator"></div>
            <div class="md-menu-section-label">视图与内容宽度</div>
            <div class="md-more-grid md-more-view-grid">
              <button type="button" role="menuitem" :disabled="!state || state.composing" title="搜索与替换" @mousedown.prevent @click="openSearch">
                <MarkdownToolbarIcon name="search" :size="16" /><span>搜索与替换</span>
              </button>
              <button type="button" role="menuitem" :disabled="!state || state.composing" :title="outlineVisible ? '隐藏大纲' : '显示大纲'" @mousedown.prevent @click="toggleOutlineFromMenu">
                <MarkdownToolbarIcon name="outline" :size="16" /><span>{{ outlineVisible ? '隐藏大纲' : '显示大纲' }}</span>
              </button>
            </div>
            <div v-if="mode !== 'split'" class="md-more-widths">
              <button v-for="preset in widthPresets" :key="preset" type="button" :class="{ active: markdownWidth === preset }" :disabled="state.composing" @mousedown.prevent @click="setWidthPreset(preset)">{{ preset }}</button>
            </div>
          </div>
          </Teleport>
        </div>
      </div>

      <span class="md-toolbar-spacer" aria-hidden="true"></span>

      <div class="md-toolbar-utilities">
        <button type="button" class="md-toolbar-btn md-toolbar-search" data-priority="3" :disabled="state.composing" aria-label="搜索与替换" title="搜索与替换 (Mod+F)" @mousedown.prevent @click="openSearch">
          <MarkdownToolbarIcon name="search" :size="18" />
        </button>
        <div v-if="mode !== 'split'" class="md-toolbar-anchor md-toolbar-width" data-priority="3">
          <button
            ref="widthButton"
            type="button"
            class="md-toolbar-btn md-toolbar-width-btn"
            :class="{ active: widthOpen }"
            :disabled="state.composing"
            aria-label="内容宽度"
            aria-haspopup="dialog"
            :aria-expanded="widthOpen"
            :title="`内容宽度 ${markdownWidth}px`"
            @mousedown.prevent
            @click="toggleWidth"
          >
            <MarkdownToolbarIcon name="width" :size="16" /><span>{{ markdownWidth }}</span>
          </button>
          <Teleport to="body">
          <div v-if="widthOpen" ref="widthMenu" :style="popoverStyle" class="md-toolbar-popover md-width-popover" role="dialog" aria-label="内容宽度" @keydown="popoverKeydown">
            <div class="md-width-head"><strong>内容宽度</strong><span>{{ markdownWidth }}px</span></div>
            <input ref="widthInput" type="range" min="480" max="1400" step="20" :value="markdownWidth" :disabled="state.composing" aria-label="内容宽度" @input="onWidthInput" @change="flushWidth" @blur="flushWidth" />
            <div class="md-width-presets">
              <button v-for="preset in widthPresets" :key="`width-${preset}`" type="button" :class="{ active: markdownWidth === preset }" @mousedown.prevent @click="setWidthPreset(preset)">{{ preset }}</button>
            </div>
          </div>
          </Teleport>
        </div>
        <MarkdownModeSwitcher class="md-toolbar-mode" :mode="mode" :disabled="state.composing" @change="changeMode" />
        <button type="button" class="md-toolbar-btn md-toolbar-outline" data-priority="3" :class="{ active: outlineVisible }" :disabled="state.composing" :aria-label="outlineVisible ? '隐藏大纲' : '显示大纲'" :aria-pressed="outlineVisible" :title="outlineVisible ? '隐藏大纲' : '显示大纲'" @mousedown.prevent @click="toggleOutline">
          <MarkdownToolbarIcon name="outline" :size="18" />
        </button>
        <button type="button" class="md-toolbar-btn md-toolbar-collapse" aria-label="折叠 Markdown 工具栏" title="折叠 Markdown 工具栏" @mousedown.prevent @click="collapseToolbar">
          <MarkdownToolbarIcon name="chevron-up" :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import type { MarkdownFormat } from '../../editor/markdown/formatCommands'
import type { MarkdownToolbarCommand } from '../../editor/markdown/wysiwyg/contracts'
import type { MarkdownMode } from '../../types'
import { shortcutLabel } from '../../features/shell/editorSettings'
import MarkdownModeSwitcher from './MarkdownModeSwitcher.vue'
import MarkdownToolbarIcon from './MarkdownToolbarIcon.vue'

const props = defineProps<{
  manager: DocumentManager
  pane: string
  revision: number
  mode: MarkdownMode
  outlineVisible?: boolean
  markdownWidth?: number
}>()
const emit = defineEmits<{
  (e: 'change-mode', mode: MarkdownMode): void
  (e: 'toggle-outline'): void
  (e: 'update:markdown-width', width: number): void
}>()

const state = computed(() => { props.revision; return props.manager.markdownToolbarState(props.pane) })
const formattingDisabled = computed(() => !state.value || state.value.readOnly || state.value.composing || state.value.inCodeBlock)
const moreInsertDisabled = computed(() => formattingDisabled.value || !state.value?.live)
const markdownWidth = ref(props.markdownWidth ?? 860)
watch(() => props.markdownWidth, value => { if (pendingWidth === null) markdownWidth.value = value ?? 860 })
const outlineVisible = computed(() => props.outlineVisible === true)

const headingOptions = [
  { value: 0, label: '正文' },
  { value: 1, label: 'H1' }, { value: 2, label: 'H2' }, { value: 3, label: 'H3' },
  { value: 4, label: 'H4' }, { value: 5, label: 'H5' }, { value: 6, label: 'H6' },
]
const textActions = [
  { format: 'bold' as MarkdownFormat, icon: 'bold', label: '加粗', shortcut: 'Mod+B' },
  { format: 'italic' as MarkdownFormat, icon: 'italic', label: '斜体', shortcut: 'Mod+I' },
  { format: 'strike' as MarkdownFormat, icon: 'strike', label: '删除线', shortcut: 'Mod+Shift+X' },
  { format: 'inline-code' as MarkdownFormat, icon: 'inline-code', label: '行内代码', shortcut: 'Mod+`' },
]
const listActions = [
  { format: 'ordered' as MarkdownFormat, icon: 'list-ordered', label: '有序列表' },
  { format: 'bullet' as MarkdownFormat, icon: 'list-bullet', label: '无序列表' },
  { format: 'task' as MarkdownFormat, icon: 'list-task', label: '任务列表' },
  { format: 'quote' as MarkdownFormat, icon: 'quote', label: '引用' },
]
const moreFormatActions = [
  ...textActions,
  ...listActions,
  { format: 'link' as MarkdownFormat, icon: 'link', label: '链接' },
  { format: 'image' as MarkdownFormat, icon: 'image', label: '图片' },
  { format: 'table' as MarkdownFormat, icon: 'table', label: '表格（2 × 2）' },
  { format: 'code-block' as MarkdownFormat, icon: 'code-block', label: '代码块' },
  { format: 'rule' as MarkdownFormat, icon: 'quote', label: '水平分隔线' },
]
const moreInsertActions = [
  { command: 'footnote' as MarkdownToolbarCommand, icon: 'quote', label: '脚注' },
  { command: 'link-reference' as MarkdownToolbarCommand, icon: 'link', label: '链接引用' },
  { command: 'math' as MarkdownToolbarCommand, icon: 'sigma', label: '公式块' },
  { command: 'toc' as MarkdownToolbarCommand, icon: 'outline', label: '内容目录' },
  { command: 'callout' as MarkdownToolbarCommand, icon: 'quote', label: '提示块 (Callout)' },
  { command: 'yaml' as MarkdownToolbarCommand, icon: 'heading', label: 'YAML Front Matter' },
]
const widthPresets = [640, 760, 860, 1020, 1200]
const tableRows = [1, 2, 3, 4, 5]
const tableColumns = [1, 2, 3, 4, 5, 6]
const tableCells = tableRows.flatMap(row => tableColumns.map(column => ({ row, column })))
const headingLabel = computed(() => headingOptions.find(option => option.value === state.value?.heading)?.label || '正文')

const headingOpen = ref(false)
const tableOpen = ref(false)
const mathOpen = ref(false)
const moreOpen = ref(false)
const widthOpen = ref(false)
const collapsed = ref(false)
const previewRows = ref(3), previewColumns = ref(3)
const root = ref<HTMLElement | null>(null)
const toolbar = ref<HTMLElement | null>(null)
const headingButton = ref<HTMLButtonElement | null>(null)
const tableButton = ref<HTMLButtonElement | null>(null)
const mathButton = ref<HTMLButtonElement | null>(null)
const moreButton = ref<HTMLButtonElement | null>(null)
const widthButton = ref<HTMLButtonElement | null>(null)
const headingMenu = ref<HTMLElement | null>(null)
const moreMenu = ref<HTMLElement | null>(null)
const mathMenu = ref<HTMLElement | null>(null)
const tableMenu = ref<HTMLElement | null>(null)
const widthMenu = ref<HTMLElement | null>(null)
const widthInput = ref<HTMLInputElement | null>(null)
let lastTrigger: HTMLElement | null = null
const popoverStyle = ref<CSSProperties>({ visibility: 'hidden' })
const overflowLevel = ref(0)
let pendingWidth: number | null = null
let widthFrame = 0
let resizeObserver: ResizeObserver | undefined
const measuredWidths = new WeakMap<Element, number>()

function isActive(format: MarkdownFormat) {
  const current = state.value
  if (!current) return false
  return format === 'bold' ? current.bold
    : format === 'italic' ? current.italic
      : format === 'strike' ? current.strike
        : format === 'inline-code' ? current.inlineCode
          : format === 'link' ? current.link
            : format === 'quote' ? current.quote
              : format === 'bullet' ? current.bullet
                : format === 'ordered' ? current.ordered
                  : format === 'task' ? current.task
                    : format === 'code-block' ? current.codeBlock
                      : false
}

function tooltip(label: string, shortcut?: string) {
  return shortcut ? `${label} (${shortcutLabel(shortcut)})` : label
}

function closePopovers(focusTrigger = false) {
  flushWidth()
  headingOpen.value = tableOpen.value = mathOpen.value = moreOpen.value = widthOpen.value = false
  popoverStyle.value = { visibility: 'hidden' }
  if (focusTrigger) void nextTick(() => lastTrigger?.focus())
}

function focusEditor() {
  props.manager.focusPane(props.pane, true)
}

function apply(format: MarkdownFormat) {
  closePopovers()
  if (formattingDisabled.value) return
  props.manager.formatMarkdown(format, props.pane)
  focusEditor()
}

function setHeading(level: number) {
  closePopovers()
  if (formattingDisabled.value) return
  props.manager.formatMarkdown(`heading-${level}` as MarkdownFormat, props.pane)
  focusEditor()
}

function moreFormat(format: MarkdownFormat) {
  closePopovers()
  if (formattingDisabled.value) return
  props.manager.formatMarkdown(format, props.pane)
  focusEditor()
}

function moreInsert(command: MarkdownToolbarCommand) {
  closePopovers()
  if (moreInsertDisabled.value) return
  props.manager.insertMarkdown(command, props.pane)
  focusEditor()
}

function insertMath() {
  closePopovers()
  if (formattingDisabled.value || !state.value?.live) return
  props.manager.insertMarkdown('math', props.pane)
  focusEditor()
}

function openSearch() {
  closePopovers()
  if (state.value?.composing) return
  props.manager.markdownFind(props.pane)
}

function toggleOutline() {
  closePopovers()
  if (state.value?.composing) return
  emit('toggle-outline')
}

function toggleOutlineFromMenu() {
  toggleOutline()
}

function changeMode(mode: MarkdownMode) {
  closePopovers()
  if (state.value?.composing) return
  emit('change-mode', mode)
}

function onWidthInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value) || state.value?.composing) return
  pendingWidth = markdownWidth.value = Math.max(480, Math.min(1400, value))
  if (!widthFrame) widthFrame = requestAnimationFrame(flushWidth)
}

watch(() => props.mode, mode => {
  if (mode === 'split') {
    closePopovers(true)
  }
})

function flushWidth() {
  if (widthFrame) cancelAnimationFrame(widthFrame)
  widthFrame = 0
  if (pendingWidth === null) return
  const width = pendingWidth
  pendingWidth = null
  // App preferences own the single manager update and serialized persistence.
  if (props.mode !== 'split' && width !== props.markdownWidth) emit('update:markdown-width', width)
}

function setWidthPreset(value: number) {
  if (props.mode === 'split' || state.value?.composing) return
  pendingWidth = markdownWidth.value = value
  closePopovers()
  focusEditor()
}

function openAt(trigger: HTMLElement | null, open: () => void) {
  lastTrigger = trigger
  closePopovers()
  open()
  void nextTick(async () => {
    positionPopover()
    const menu = currentPopover()
    await nextTick() // Apply visible fixed coordinates before moving keyboard focus.
    if (!menu || currentPopover() !== menu) return
    if (widthOpen.value) widthInput.value?.focus({ preventScroll: true })
    else focusPopoverItem(menu.querySelector<HTMLButtonElement>('button:not(:disabled)'))
  })
}

function toggleHeading() {
  if (headingOpen.value) return closePopovers(true)
  openAt(headingButton.value, () => { headingOpen.value = true })
}

function toggleTable() {
  if (tableOpen.value) return closePopovers(true)
  previewRows.value = 3; previewColumns.value = 3
  openAt(tableButton.value, () => { tableOpen.value = true })
}

function insertTable(rows: number, columns: number) {
  closePopovers()
  if (formattingDisabled.value) return
  props.manager.insertMarkdownTable(rows, columns, props.pane)
  focusEditor()
}

function toggleMath() {
  if (mathOpen.value) return closePopovers(true)
  openAt(mathButton.value, () => { mathOpen.value = true })
}

function toggleMore() {
  if (moreOpen.value) return closePopovers(true)
  openAt(moreButton.value, () => { moreOpen.value = true })
}

function toggleWidth() {
  if (props.mode === 'split') return
  if (widthOpen.value) return closePopovers(true)
  openAt(widthButton.value, () => { widthOpen.value = true })
}

function collapseToolbar() {
  closePopovers()
  collapsed.value = true
  focusEditor()
}

function expandToolbar() {
  overflowLevel.value = 0
  collapsed.value = false
  focusEditor()
}

function escape(event: KeyboardEvent) {
  if (!headingOpen.value && !tableOpen.value && !mathOpen.value && !moreOpen.value && !widthOpen.value) return
  event.preventDefault()
  closePopovers(true)
}

function outside(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node) && !currentPopover()?.contains(event.target as Node)) closePopovers(false)
}

function onWindowChange() { closePopovers(false) }

function currentPopover() {
  return headingOpen.value ? headingMenu.value : tableOpen.value ? tableMenu.value
    : mathOpen.value ? mathMenu.value : moreOpen.value ? moreMenu.value : widthOpen.value ? widthMenu.value : null
}

function positionPopover() {
  const menu = currentPopover(), trigger = lastTrigger
  if (!menu || !trigger) return
  const rect = trigger.getBoundingClientRect()
  const width = menu.getBoundingClientRect().width, height = menu.getBoundingClientRect().height
  const left = Math.max(8, Math.min(widthOpen.value ? rect.right - width : rect.left, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(rect.bottom + 7, window.innerHeight - height - 8))
  popoverStyle.value = { left: `${left}px`, top: `${top}px`, visibility: 'visible' }
}

function toolbarKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') return escape(event)
  const trigger = event.target as HTMLButtonElement
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !trigger.matches('button[aria-haspopup]') || trigger.disabled) return
  event.preventDefault()
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  void nextTick(async () => {
    await nextTick()
    const items = currentPopover()?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    if (items?.length) focusPopoverItem(items[event.key === 'ArrowUp' ? items.length - 1 : 0])
  })
}

function focusPopoverItem(item: HTMLElement | null) {
  const menu = currentPopover()
  if (!item || !menu) return
  item.focus({ preventScroll: true })
  const rect = item.getBoundingClientRect(), bounds = menu.getBoundingClientRect()
  // Reveal keyboard focus inside the menu without scrolling the editor/page.
  if (rect.top < bounds.top + 6) menu.scrollTop += rect.top - bounds.top - 6
  else if (rect.bottom > bounds.bottom - 6) menu.scrollTop += rect.bottom - bounds.bottom + 6
}

function popoverKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Escape') { event.stopPropagation(); return escape(event) }
  if (event.key === 'Tab') {
    event.preventDefault()
    const buttons = [...(toolbar.value?.querySelectorAll<HTMLElement>('button:not(:disabled)') || [])].filter(button => button.getClientRects().length)
    const at = buttons.indexOf(lastTrigger!) + (event.shiftKey ? -1 : 1)
    closePopovers()
    void nextTick(() => (buttons[at] || lastTrigger)?.focus({ preventScroll: true }))
    return
  }
  if ((event.target as HTMLElement).matches('input')) return // Native range keyboard behavior.
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const items = [...(currentPopover()?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  if (!items.length) return
  event.preventDefault()
  const step = tableOpen.value && ['ArrowDown', 'ArrowUp'].includes(event.key) ? 6 : 1
  const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -step : step
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (items.indexOf(document.activeElement as HTMLButtonElement) + delta + items.length) % items.length
  focusPopoverItem(items[index])
}

// Measure the actual flex items (including fonts, labels and utility widths).
// Cache hidden items' intrinsic widths; hiding never changes the measuring box.
function measureToolbar() {
  const row = toolbar.value
  if (!row) return
  const widthOf = (item: HTMLElement) => {
    const style = getComputedStyle(item)
    if (style.display !== 'none') measuredWidths.set(item, item.classList.contains('md-toolbar-spacer') ? 8
      : item.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight))
    return measuredWidths.get(item) || 0
  }
  const items = [...row.children] as HTMLElement[]
  const utilities = [...row.querySelector('.md-toolbar-utilities')!.children] as HTMLElement[]
  items.forEach(widthOf); utilities.forEach(widthOf)
  const visible = (item: HTMLElement, level: number) => !item.dataset.priority || Number(item.dataset.priority) > level
  const style = getComputedStyle(row), gap = parseFloat(style.columnGap)
  const required = (level: number) => {
    const shown = items.filter(item => visible(item, level))
    const tools = utilities.filter(item => visible(item, level))
    return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + gap * (shown.length - 1)
      + shown.reduce((total, item) => total + (item.classList.contains('md-toolbar-utilities')
        ? tools.reduce((sum, tool) => sum + widthOf(tool), 0) + gap * (tools.length - 1) : widthOf(item)), 0)
  }
  let level = 0
  while (level < 5 && required(level) > row.clientWidth) level++
  // Small hysteresis avoids repeated collapse/expand near a rounding boundary.
  if (level < overflowLevel.value && required(level) + 12 > row.clientWidth) return
  if (level !== overflowLevel.value) { closePopovers(); overflowLevel.value = level }
}

watch([collapsed, () => props.markdownWidth, headingLabel], () => void nextTick(measureToolbar))
function onScroll(event: Event) {
  if (!(event.target instanceof Node) || !currentPopover()?.contains(event.target)) closePopovers()
}

onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('blur', onWindowChange)
  window.addEventListener('resize', onWindowChange)
  window.addEventListener('scroll', onScroll, true)
  let lastWidth = root.value?.clientWidth
  resizeObserver = new ResizeObserver(() => {
    if (lastWidth !== root.value?.clientWidth) { closePopovers(); lastWidth = root.value?.clientWidth }
    measureToolbar()
  })
  if (root.value) resizeObserver.observe(root.value)
  measureToolbar()
})
onBeforeUnmount(() => {
  flushWidth()
  resizeObserver?.disconnect()
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('blur', onWindowChange)
  window.removeEventListener('resize', onWindowChange)
  window.removeEventListener('scroll', onScroll, true)
})
</script>

<style scoped>
.md-live-toolbar-shell {
  position: relative;
  flex: none;
  min-width: 0;
  height: 44px;
}
.md-live-toolbar-shell.collapsed { height: 0; }
.md-live-toolbar {
  display: flex;
  align-items: center;
  width: 100%;
  height: 44px;
  min-width: 0;
  gap: 4px;
  padding: 5px 16px;
  box-sizing: border-box;
  background: var(--bar);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  color: var(--sub);
  font: var(--ui-small-font-size)/1 var(--font-sans);
  user-select: none;
  -webkit-user-select: none;
  overflow: visible;
}
.md-toolbar-group,
.md-toolbar-utilities {
  display: flex;
  align-items: center;
  flex: none;
  gap: 4px;
  min-width: 0;
}
.md-toolbar-anchor { position: relative; display: inline-grid; }
.md-toolbar-btn {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  min-width: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.md-toolbar-btn:hover:not(:disabled),
.md-toolbar-btn:focus-visible {
  background: var(--hover);
  border-color: var(--line);
  color: var(--ink);
}
.md-toolbar-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.md-toolbar-btn.active { background: var(--accentbg); border-color: color-mix(in srgb, var(--accent) 32%, var(--line)); color: var(--accent); }
.md-toolbar-btn:disabled { opacity: .4; cursor: default; }
.md-toolbar-heading-btn {
  display: inline-flex;
  width: auto;
  min-width: 76px;
  max-width: 92px;
  gap: 5px;
  padding: 0 6px 0 7px;
  font-size: var(--ui-small-font-size);
  font-weight: 600;
}
.md-toolbar-heading-btn span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-toolbar-divider { width: 1px; height: 20px; flex: none; margin: 0 2px; background: var(--line); }
.md-toolbar-spacer { flex: 1 1 auto; min-width: 8px; }
.md-toolbar-mode { flex: none; }
.md-toolbar-width-btn {
  display: inline-flex;
  width: auto;
  min-width: 32px;
  gap: 4px;
  padding: 0 6px;
  font: 600 11px/1 var(--font-mono);
}
.md-toolbar-collapse { color: var(--muted); }
.md-toolbar-reveal {
  position: absolute;
  top: 0;
  right: 16px;
  z-index: 70;
  display: grid;
  place-items: center;
  width: 36px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--line);
  border-top: 0;
  border-radius: 0 0 5px 5px;
  background: color-mix(in srgb, var(--bar) 96%, transparent);
  color: var(--sub);
  box-shadow: 0 2px 6px color-mix(in srgb, var(--ink) 10%, transparent);
  cursor: pointer;
}
.md-toolbar-reveal:hover,
.md-toolbar-reveal:focus-visible { background: var(--hover); color: var(--ink); outline: 2px solid var(--accent); outline-offset: -2px; }

.md-toolbar-popover {
  position: fixed;
  z-index: 200;
  min-width: 150px;
  max-width: min(320px, calc(100vw - 16px));
  max-height: min(680px, calc(100vh - 16px));
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 5px;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--paper);
  box-shadow: var(--shadow);
  color: var(--ink);
  font: var(--ui-small-font-size)/var(--ui-line-height) var(--font-sans);
  animation: md-toolbar-pop 120ms ease-out;
}
@keyframes md-toolbar-pop { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
.md-heading-menu { min-width: 148px; }
.md-math-menu { min-width: 168px; }
.md-more-menu { width: 300px; min-width: min(260px, calc(100vw - 16px)); }
.md-more-menu::-webkit-scrollbar { width: 8px; }
.md-more-menu::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
.md-more-menu { scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.md-width-popover { width: 224px; min-width: min(224px, calc(100vw - 16px)); padding: 10px; }
.md-more-menu button,
.md-heading-menu button,
.md-math-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.md-more-menu button:hover:not(:disabled),
.md-more-menu button:focus-visible,
.md-heading-menu button:hover,
.md-heading-menu button:focus-visible,
.md-math-menu button:hover,
.md-math-menu button:focus-visible { background: var(--hover); color: var(--ink); outline: none; }
.md-more-menu button.active,
.md-heading-menu button.active { background: var(--accentbg); color: var(--accent); }
.md-more-menu button:disabled { opacity: .42; cursor: default; }
.md-more-menu button span,
.md-heading-menu button span,
.md-math-menu button span { flex: 1; }
.md-more-menu button small,
.md-math-menu button small { color: var(--muted); font: 11px var(--font-mono); }
.md-heading-menu button { justify-content: space-between; }
.md-menu-section-label { padding: 5px 8px 3px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.md-menu-separator { height: 1px; margin: 4px 5px; background: var(--line); }
.md-more-heading-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; }
.md-more-heading-grid button { justify-content: center; min-height: 28px; }
.md-more-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; }
.md-more-grid button { min-width: 0; }
.md-more-grid button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-more-grid button small { flex: none; font-size: 10px; color: var(--muted); }
.md-more-insert-grid { grid-template-columns: 1fr; }
.md-more-widths { display: flex; gap: 4px; padding: 3px 5px; }
.md-more-widths button { width: auto; min-width: 0; flex: 1; justify-content: center; min-height: 28px; font: 11px var(--font-mono); }
.md-more-widths button.active { background: var(--accentbg); color: var(--accent); }
.md-width-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; }
.md-width-head strong { color: var(--ink); font-size: var(--ui-small-font-size); }
.md-width-head span { color: var(--accent); font: 600 11px var(--font-mono); }
.md-width-popover input { width: 100%; height: 4px; margin: 10px 0 8px; border: 0; border-radius: 2px; background: var(--line); accent-color: var(--accent); cursor: pointer; -webkit-appearance: none; appearance: none; }
.md-width-popover input::-webkit-slider-thumb { width: 14px; height: 14px; border: 2px solid var(--paper); border-radius: 50%; background: var(--accent); box-shadow: 0 1px 3px color-mix(in srgb, var(--ink) 22%, transparent); cursor: pointer; -webkit-appearance: none; }
.md-width-popover input::-moz-range-thumb { width: 12px; height: 12px; border: 2px solid var(--paper); border-radius: 50%; background: var(--accent); cursor: pointer; }
.md-width-presets { display: flex; gap: 4px; margin-top: 8px; }
.md-width-presets button { flex: 1; min-width: 0; min-height: 26px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--editor); color: var(--sub); font: 10px var(--font-mono); cursor: pointer; }
.md-width-presets button:hover { background: var(--hover); color: var(--ink); }
.md-width-presets button.active { border-color: var(--accent); background: var(--accentbg); color: var(--accent); }
.md-table-picker { width: max-content; min-width: 0; padding: 10px; }
.md-table-picker-head { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 8px; color: var(--muted); font-size: var(--ui-small-font-size); font-weight: 700; }
.md-table-picker-head strong { color: var(--accent); font: 600 12px var(--font-mono); }
.md-table-picker-grid { display: grid; grid-template-columns: repeat(6, 30px); gap: 4px; }
.md-table-picker-cell { width: 30px; height: 26px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--editor); cursor: pointer; transition: background 100ms ease, border-color 100ms ease; }
.md-table-picker-cell:hover,
.md-table-picker-cell:focus-visible,
.md-table-picker-cell.active { border-color: var(--accent); background: var(--accentbg); }
.md-table-picker-cell:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.md-toolbar-icon { display: block; flex: none; }

.compact-lists .md-toolbar-lists, .compact-lists .md-toolbar-lists-divider,
.compact-insert .md-toolbar-insert, .compact-insert .md-toolbar-insert-divider,
.compact-utilities .md-toolbar-search, .compact-utilities .md-toolbar-width, .compact-utilities .md-toolbar-outline,
.compact-heading .md-toolbar-heading-group, .compact-heading .md-toolbar-heading-divider,
.compact-format .md-toolbar-format { display: none; }
@media (prefers-reduced-motion: reduce) {
  .md-toolbar-btn, .md-toolbar-popover { transition: none; animation: none; }
}
</style>
