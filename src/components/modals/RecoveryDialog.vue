<template>
  <div v-if="visible" class="recovery-overlay" @keydown.stop="onKeydown">
    <section ref="dialogRef" class="recovery-dialog" role="dialog" aria-modal="true" aria-label="未保存文档恢复">
      <header>
        <div>
          <h2>未保存文档恢复</h2>
          <p class="hint">这些文档在异常退出前未完成保存。打开后将载入未保存内容并保持编辑状态，核对后请按 Ctrl+S 及时保存。</p>
        </div>
        <button class="icon-close" type="button" aria-label="关闭恢复面板" :disabled="busy" @click="$emit('close')">×</button>
      </header>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="records.length" class="hint keep-hint">恢复备份将保留至您明确打开或删除为止；点击“稍后处理”仅关闭面板，不会丢失任何数据。</p>
      <p v-if="!records.length" class="empty">没有可恢复的未保存文档。</p>

      <ul v-else class="recovery-list">
        <li v-for="record in records" :key="record.id" class="recovery-row">
          <div class="row-main">
            <div class="title-row">
              <strong :title="record.name">{{ record.name }}</strong>
              <span class="status-badge" :class="statusInfo(record).statusClass">
                {{ statusInfo(record).statusText }}
              </span>
            </div>
            <span class="path" :title="displayPath(record.path)">{{ displayPath(record.path) }}</span>
            <div class="meta-row">
              <span class="meta-item">更新于 {{ formatTime(record.updatedAt) }}</span>
              <span class="meta-sep">·</span>
              <span class="meta-item">{{ record.charCount.toLocaleString() }} 字符</span>
              <template v-if="record.mode">
                <span class="meta-sep">·</span>
                <span class="meta-item">{{ modeLabel(record.mode) }}</span>
              </template>
              <template v-if="record.panes.length > 1">
                <span class="meta-sep">·</span>
                <span class="meta-item">{{ record.panes.length }} 个窗格</span>
              </template>
            </div>
            <div class="save-hint">
              <span class="hint-icon">ℹ</span>
              <span>{{ statusInfo(record).saveHint }}</span>
            </div>

            <!-- 删除恢复备份二次确认条 -->
            <div v-if="confirmDiscardId === record.id" class="discard-confirm-bar" role="alert">
              <span class="confirm-text">确认删除此恢复稿？此操作仅删除恢复备份，<strong>不会删除磁盘原文件</strong>。</span>
              <div class="confirm-actions">
                <button type="button" class="btn-danger-confirm" :disabled="busy" @click="confirmDiscard(record)">
                  确认删除备份
                </button>
                <button type="button" class="btn-cancel-confirm" :disabled="busy" @click="cancelDiscard">
                  取消
                </button>
              </div>
            </div>
          </div>

          <div v-if="confirmDiscardId !== record.id" class="row-actions">
            <button type="button" class="primary" :disabled="busy" @click="$emit('restore', record)">
              打开恢复稿
            </button>
            <button v-if="record.path" type="button" :disabled="busy" @click="$emit('diff', record)">
              查看差异
            </button>
            <button type="button" class="discard" :disabled="busy" @click="askDiscard(record)">
              删除恢复稿
            </button>
          </div>
        </li>
      </ul>

      <!-- 差异比对面板 -->
      <div v-if="diff" class="diff-panel">
        <div class="diff-head">
          <div class="diff-head-title">
            <strong>{{ diff.name }}</strong>
            <span v-if="diff.path" class="path">{{ displayPath(diff.path) }}</span>
          </div>
          <button type="button" class="icon-close" aria-label="关闭差异比对" :disabled="busy" @click="$emit('close-diff')">×</button>
        </div>

        <p v-if="diff.error" class="error">{{ diff.error }}</p>
        <p v-else-if="diff.diskText === null" class="empty">原文件在磁盘上不存在或为未命名草稿，恢复稿将作为独立文档打开。</p>
        <template v-else>
          <div class="diff-legend-bar">
            <p class="hint diff-hint">
              对比<strong>{{ diff.diffSource === 'session' ? '当前会话编辑内容' : '当前磁盘内容' }}</strong>与恢复稿：
              <span class="legend-add">+ 恢复稿新增</span>
              <span class="legend-remove">− 恢复稿删除</span>
            </p>
          </div>
          <div class="diff-lines" role="list">
            <div v-for="(line, index) in diffLines.lines" :key="index" class="diff-line" :class="line.type" role="listitem">
              <span class="sign">{{ line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ' }}</span>
              <span class="text">{{ line.text || ' ' }}</span>
            </div>
          </div>
          <p v-if="diffLines.truncated" class="hint">差异行数较多，仅展示前 400 行。</p>
        </template>
      </div>

      <div v-if="confirmDiscardAll" class="discard-confirm-bar" role="alert">
        <span class="confirm-text">确认丢弃当前列表中的 {{ records.length }} 个恢复稿？此操作不可撤销，<strong>不会删除磁盘原文件</strong>，也不会关闭当前已打开的文档。</span>
        <div class="confirm-actions">
          <button type="button" class="btn-danger-confirm" :disabled="busy || !records.length" @click="confirmDiscardAll = false; $emit('discard-all')">确认全部丢弃</button>
          <button ref="discardAllCancelRef" type="button" class="btn-cancel-confirm" :disabled="busy" @click="cancelDiscardAll">取消</button>
        </div>
      </div>

      <footer v-else>
        <button type="button" class="discard discard-all" :disabled="busy || !records.length" @click="askDiscardAll">
          全部丢弃
        </button>
        <button type="button" class="secondary" :disabled="busy" @click="$emit('close')">
          稍后处理
        </button>
        <button type="button" class="primary" :disabled="busy || !records.length" @click="$emit('restore-all')">
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
const discardAllCancelRef = ref<HTMLButtonElement | null>(null)

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
  if (value) {
    openModal()
    confirmDiscardId.value = null
  } else {
    closeModal()
    confirmDiscardId.value = null
  }
}, { immediate: true })

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (props.busy && event.key === 'Escape') { event.preventDefault(); return }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (confirmDiscardAll.value) { cancelDiscardAll(); return }
    if (confirmDiscardId.value) {
      confirmDiscardId.value = null
      return
    }
    if (props.diff) emit('close-diff')
    else emit('close')
    return
  }
  handleKeydown(event)
}

function displayPath(path: string | null): string {
  if (!path) return '未命名草稿（保存在恢复缓存中）'
  return readablePath(path)
}

function formatTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function modeLabel(mode: string) {
  return mode === 'live' ? '实时排版' : mode === 'split' ? '双栏' : '源码'
}

function statusInfo(record: RecoverySummary) {
  if (!record.path) {
    return {
      statusText: '未命名草稿',
      statusClass: 'draft',
      saveHint: '打开为独立草稿，可通过另存为 (Ctrl+S) 选择保存位置',
    }
  }
  if (!record.diskExists) {
    return {
      statusText: '原文件不存在或已删除',
      statusClass: 'missing',
      saveHint: '原文件缺失，打开为独立草稿，可通过另存为 (Ctrl+S) 重新保存',
    }
  }
  if (record.diskChanged) {
    return {
      statusText: '原文件已被外部修改 (磁盘内容已变化)',
      statusClass: 'changed',
      saveHint: '磁盘原文件已更新，打开为独立副本，避免不安全覆盖；可另存为新文件',
    }
  }
  return {
    statusText: '原文件完整且一致',
    statusClass: 'safe',
    saveHint: '可安全原位恢复，打开后按 Ctrl+S 直接保存至原文件',
  }
}

function askDiscard(record: RecoverySummary) {
  confirmDiscardAll.value = false
  confirmDiscardId.value = record.id
}

function askDiscardAll() {
  confirmDiscardId.value = null
  confirmDiscardAll.value = true
  void nextTick(() => discardAllCancelRef.value?.focus())
}

function cancelDiscardAll() {
  confirmDiscardAll.value = false
  void nextTick(() => dialogRef.value?.querySelector<HTMLButtonElement>('.discard-all')?.focus())
}

function cancelDiscard() {
  confirmDiscardId.value = null
}

function confirmDiscard(record: RecoverySummary) {
  confirmDiscardId.value = null
  emit('discard', record)
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
  width: min(780px, 100%);
  max-height: min(85vh, 760px);
  overflow-y: auto;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 24px;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 14px;
}
h2 {
  margin: 0 0 6px;
  font-size: calc(var(--ui-font-size) + 4px);
  color: var(--bright);
  font-weight: 600;
}
.hint, .empty {
  color: var(--muted);
  line-height: 1.55;
  margin: 0;
}
.hint {
  font-size: var(--ui-small-font-size);
}
.keep-hint {
  margin: 12px 0 6px;
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
  margin: 14px 0;
  display: grid;
  gap: 12px;
}
.recovery-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--editor);
}
.row-main {
  display: grid;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.title-row strong {
  color: var(--bright);
  font-size: calc(var(--ui-font-size) + 1px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-badge {
  font-size: var(--ui-small-font-size);
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  line-height: 1.3;
}
.status-badge.safe {
  background: rgba(63, 156, 98, .16);
  color: #3f9c62;
  border: 1px solid rgba(63, 156, 98, .3);
}
.status-badge.changed {
  background: rgba(201, 138, 44, .16);
  color: #c98a2c;
  border: 1px solid rgba(201, 138, 44, .3);
}
.status-badge.missing {
  background: rgba(217, 83, 79, .14);
  color: #d9534f;
  border: 1px solid rgba(217, 83, 79, .3);
}
.status-badge.draft {
  background: rgba(120, 140, 160, .16);
  color: var(--muted);
  border: 1px solid var(--line);
}
.path {
  color: var(--muted);
  font-size: var(--ui-small-font-size);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: var(--ui-small-font-size);
  flex-wrap: wrap;
}
.meta-sep {
  opacity: .5;
}
.save-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: var(--ui-small-font-size);
  color: var(--muted);
}
.hint-icon {
  font-weight: bold;
  color: var(--accent, #3b82f6);
}
.discard-confirm-bar {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(217, 83, 79, .12);
  border: 1px solid rgba(217, 83, 79, .35);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.confirm-text {
  font-size: var(--ui-small-font-size);
  color: var(--bright);
}
.confirm-actions {
  display: flex;
  gap: 8px;
}
.btn-danger-confirm {
  background: #d9534f !important;
  color: #ffffff !important;
  border-color: #d9534f !important;
  font-weight: 500;
}
.btn-cancel-confirm {
  background: var(--soft) !important;
  color: var(--ink) !important;
}
.row-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
}
button {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--soft);
  color: var(--ink);
  cursor: pointer;
  font-size: var(--ui-small-font-size);
  transition: all .15s ease;
}
button:hover:not(:disabled) {
  filter: brightness(1.08);
}
button.primary {
  background: var(--accentbg);
  color: var(--bright);
  border-color: var(--accentbg);
  font-weight: 500;
}
button.discard {
  color: #d9534f;
  background: transparent;
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
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--line);
  padding-top: 16px;
  margin-top: 14px;
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
}
.diff-legend-bar {
  margin: 6px 0 10px;
}
.diff-hint {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.legend-add {
  color: #48bb78;
  font-weight: 500;
}
.legend-remove {
  color: #f56565;
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
  color: #68d391;
}
.diff-line.remove {
  background: rgba(217, 83, 79, .18);
  color: #fc8181;
}
.diff-line .sign {
  width: 1.2ch;
  flex: none;
  font-weight: bold;
}
.diff-line .text {
  min-width: 0;
}

@media (max-width: 600px) {
  .recovery-row {
    flex-direction: column;
  }
  .row-actions {
    flex-direction: row;
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
