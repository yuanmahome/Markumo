<template>
  <div v-if="visible" class="recovery-overlay" @keydown.stop="onKeydown">
    <section ref="dialogRef" class="recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <h2 id="recovery-title" ref="titleRef" tabindex="-1">未保存文档恢复</h2>

      <div class="recovery-content">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="!records.length" class="empty">没有可恢复的文档。</p>

        <ul v-else class="recovery-list">
          <li v-for="record in records" :key="record.id" class="recovery-row" :data-record-id="record.id">
            <div class="record">
              <div class="record-info">
                <div class="title-row">
                  <strong :title="record.name">{{ record.name }}</strong>
                  <span v-if="record.path && (!record.diskExists || record.diskChanged)" class="record-warning">
                    {{ record.diskExists ? '原文件已修改' : '原文件缺失' }}
                  </span>
                </div>
                <span v-if="record.path" class="path" :title="readablePath(record.path)">{{ readablePath(record.path) }}</span>
                <time v-if="repeatedRecords.has(record.path ?? record.name)" class="record-time">{{ formatTime(record.updatedAt) }}</time>
              </div>
              <div v-if="confirmDiscardId !== record.id" class="row-actions">
                <button v-if="record.path" type="button" aria-label="查看差异" :disabled="busy" @click="$emit('diff', record)">对比</button>
                <button type="button" class="discard" aria-label="删除恢复稿" :disabled="busy" @click="askDiscard(record)">删除</button>
                <button type="button" :class="records.length === 1 ? 'primary' : 'secondary'" :disabled="busy" @click="$emit('restore', record)">打开</button>
              </div>
            </div>
            <div v-if="confirmDiscardId === record.id" class="discard-confirm row-confirm">
              <span role="alert">删除此恢复稿？</span>
              <div class="confirm-actions">
                <button type="button" class="confirm-cancel" :disabled="busy" @click="cancelDiscard">取消</button>
                <button type="button" class="discard" aria-label="确认删除备份" :disabled="busy" @click="confirmDiscard(record)">删除</button>
              </div>
            </div>
          </li>
        </ul>

        <!-- 差异比对面板 -->
        <div v-if="diff" ref="diffPanelRef" class="diff-panel">
          <div class="diff-head">
            <div class="diff-head-title">
              <strong>{{ diff.name }}</strong>
              <span v-if="diff.path" class="path" :title="readablePath(diff.path)">{{ readablePath(diff.path) }}</span>
            </div>
            <button type="button" class="icon-close" aria-label="关闭差异比对" :disabled="busy" @click="$emit('close-diff')">×</button>
          </div>

          <p v-if="diff.error" class="error">{{ diff.error }}</p>
          <p v-else-if="diff.diskText === null" class="empty">恢复稿将作为独立文档打开。</p>
          <template v-else>
            <div class="diff-legend hint">
              <span>{{ diff.diffSource === 'session' ? '会话内容' : '磁盘内容' }} ↔ 恢复稿</span>
              <span class="legend-add">+ 新增</span>
              <span class="legend-remove">− 删除</span>
            </div>
            <div class="diff-lines" role="list">
              <div v-for="(line, index) in diffLines.lines" :key="index" class="diff-line" :class="line.type" role="listitem">
                <span class="sign">{{ line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ' }}</span>
                <span class="text">{{ line.text || ' ' }}</span>
              </div>
            </div>
            <p v-if="diffLines.truncated" class="hint">仅显示前 400 行。</p>
          </template>
        </div>
      </div>

      <div v-if="confirmDiscardAll" class="discard-confirm">
        <span role="alert">丢弃这 {{ records.length }} 个恢复稿？</span>
        <div class="confirm-actions">
          <button ref="discardAllCancelRef" type="button" :disabled="busy" @click="cancelDiscardAll">取消</button>
          <button type="button" class="discard" aria-label="确认全部丢弃" :disabled="busy || !records.length" @click="discardAll">全部丢弃</button>
        </div>
      </div>

      <footer v-else>
        <button v-if="records.length > 1 || (records.length === 1 && bulkDiscardAttempted)" ref="discardAllRef" type="button" class="discard discard-all" :disabled="busy" @click="askDiscardAll">
          全部丢弃
        </button>
        <button ref="laterRef" type="button" :disabled="busy" @click="$emit('close')">
          {{ records.length ? '稍后' : '关闭' }}
        </button>
        <button v-if="records.length > 1" type="button" class="primary" :disabled="busy" @click="$emit('restore-all')">
          全部打开
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useModal } from '../../features/shell/useModal'
import { diffText } from '../../features/recovery/diff'
import { readablePath } from '../../features/shell/pathDisplay'
import type { RecoveryDiff, RecoverySummary } from '../../features/recovery/types'

const props = defineProps<{
  visible: boolean
  records: RecoverySummary[]
  busy: boolean
  diff: RecoveryDiff | null
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'restore', record: RecoverySummary): void
  (e: 'discard', record: RecoverySummary): void
  (e: 'restore-all'): void
  (e: 'discard-all'): void
  (e: 'diff', record: RecoverySummary): void
  (e: 'close-diff'): void
}>()

const { dialogRef, open: openModal, close: closeModal, handleKeydown } = useModal()
void dialogRef

const confirmDiscardId = ref<string | null>(null)
const confirmDiscardAll = ref(false)
const bulkDiscardAttempted = ref(false)
const titleRef = ref<HTMLHeadingElement | null>(null)
const laterRef = ref<HTMLButtonElement | null>(null)
const discardAllRef = ref<HTMLButtonElement | null>(null)
const discardAllCancelRef = ref<HTMLButtonElement | null>(null)
const diffPanelRef = ref<HTMLElement | null>(null)
const repeatedRecords = computed(() => {
  const seen = new Set<string>(), repeated = new Set<string>()
  for (const record of props.records) {
    const key = record.path ?? record.name
    if (seen.has(key)) repeated.add(key)
    seen.add(key)
  }
  return repeated
})

// 准确的比对顺序：以磁盘/会话已有内容为 before 基准，恢复稿为 after 新状态。
// 恢复稿相对于原文件新增的内容展示为 add (+)，删除的内容展示为 remove (−)。
const diffLines = computed(() => {
  if (!props.diff || props.diff.diskText === null) {
    return { lines: [], truncated: false }
  }
  return diffText(props.diff.diskText, props.diff.recoveryText)
})

watch(() => props.visible, value => {
  confirmDiscardAll.value = false
  confirmDiscardId.value = null
  bulkDiscardAttempted.value = false
  if (value) {
    openModal()
    void nextTick(() => laterRef.value?.focus())
  } else {
    closeModal()
  }
}, { immediate: true })

watch(() => props.diff, diff => {
  if (diff) void nextTick(() => diffPanelRef.value?.scrollIntoView({ block: 'nearest' }))
})

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (props.busy && event.key === 'Escape') { event.preventDefault(); return }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (confirmDiscardAll.value) { cancelDiscardAll(); return }
    if (confirmDiscardId.value) { cancelDiscard(); return }
    if (props.diff) emit('close-diff')
    else emit('close')
    return
  }
  handleKeydown(event)
}

function formatTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function askDiscard(record: RecoverySummary) {
  confirmDiscardAll.value = false
  confirmDiscardId.value = record.id
  void nextTick(() => dialogRef.value?.querySelector<HTMLButtonElement>('.row-confirm .confirm-cancel')?.focus())
}

function askDiscardAll() {
  confirmDiscardId.value = null
  confirmDiscardAll.value = true
  void nextTick(() => discardAllCancelRef.value?.focus())
}

function cancelDiscardAll() {
  confirmDiscardAll.value = false
  void nextTick(() => (discardAllRef.value ?? laterRef.value)?.focus())
}

function cancelDiscard() {
  const id = confirmDiscardId.value
  confirmDiscardId.value = null
  if (id) void nextTick(() => {
    const trigger = dialogRef.value?.querySelector<HTMLButtonElement>(`[data-record-id="${CSS.escape(id)}"] .row-actions .discard`)
    const target = trigger ?? laterRef.value
    target?.focus()
  })
}

function confirmDiscard(record: RecoverySummary) {
  confirmDiscardId.value = null
  titleRef.value?.focus({ preventScroll: true })
  emit('discard', record)
}

function discardAll() {
  confirmDiscardAll.value = false
  bulkDiscardAttempted.value = true
  titleRef.value?.focus({ preventScroll: true })
  emit('discard-all')
}
</script>

<style scoped>
.recovery-overlay {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, .48);
  backdrop-filter: blur(2px);
}
.recovery-dialog {
  width: min(640px, 100%);
  max-height: min(85vh, 760px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 22px;
}
.recovery-content {
  min-height: 0;
  overflow-y: auto;
}
h2, footer, .recovery-dialog > .discard-confirm { flex-shrink: 0; }
h2 {
  margin: 0 0 12px;
  font-size: calc(var(--ui-font-size) + 4px);
  color: var(--bright);
  font-weight: 600;
}
h2:focus { outline: none; }
.hint, .empty {
  color: var(--sub);
  line-height: 1.55;
  margin: 0;
}
.hint {
  font-size: var(--ui-small-font-size);
}
.error {
  color: #d9534f;
  white-space: pre-wrap;
  margin: 10px 0;
  padding: 8px 12px;
  background: rgba(217, 83, 79, .1);
  border: 1px solid rgba(217, 83, 79, .3);
  border-radius: 6px;
}
.icon-close {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 4px;
}
.icon-close:hover {
  color: var(--bright);
  background: var(--soft);
}
.recovery-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.recovery-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.record {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.record-info {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 3px;
  min-width: 0;
}
.title-row {
  display: flex;
  align-items: baseline;
  gap: 3px 8px;
  flex-wrap: wrap;
}
.title-row strong {
  color: var(--bright);
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.record-warning {
  color: var(--yellow);
  font-size: var(--ui-small-font-size);
}
.path, .record-time {
  color: var(--sub);
  font-size: var(--ui-small-font-size);
}
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.discard-confirm {
  margin-top: 10px;
  padding: 6px 10px;
  background: var(--soft);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.confirm-actions, .row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: none;
}
button {
  min-height: var(--ui-control-height);
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--ink);
}
button:hover:not(:disabled) {
  background: var(--hover);
}
button.secondary {
  background: var(--soft);
}
button.primary {
  background: var(--accentbg);
  color: var(--bright);
  font-weight: 600;
}
button.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accentbg), var(--accent) 15%);
}
button.discard {
  color: light-dark(#a6333a, #ff969d);
}
button.discard:hover:not(:disabled) {
  background: rgba(217, 83, 79, .1);
}
button:disabled {
  opacity: .5;
  cursor: default;
}
footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 12px;
}
.discard-all { margin-right: auto; }
.diff-panel {
  border-top: 1px solid var(--line);
  margin-top: 16px;
  padding-top: 14px;
}
.diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.diff-head-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.diff-head-title strong {
  color: var(--bright);
  overflow-wrap: anywhere;
}
.diff-legend {
  display: flex;
  margin: 6px 0 10px;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.legend-add {
  color: light-dark(#247a56, #68d391);
  font-weight: 500;
}
.legend-remove {
  color: light-dark(#a6333a, #ff969d);
  font-weight: 500;
}
.diff-lines {
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--editor);
  font-family: var(--font-mono, monospace);
  font-size: var(--ui-small-font-size);
  line-height: 1.45;
}
.diff-line {
  display: flex;
  gap: 8px;
  padding: 1px 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-line.add {
  background: rgba(63, 156, 98, .18);
  color: light-dark(#185d3f, #68d391);
}
.diff-line.remove {
  background: rgba(217, 83, 79, .18);
  color: light-dark(#a6333a, #ff969d);
}
.diff-line .sign {
  width: 1.2ch;
  flex: none;
  font-weight: bold;
}
.diff-line .text {
  min-width: 0;
}

@media (max-width: 500px) {
  .record {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .row-actions {
    justify-content: flex-end;
  }
}
</style>
