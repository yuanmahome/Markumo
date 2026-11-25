<template>
  <div v-if="visible" class="discard-overlay" @keydown.stop="handleKeydown">
    <div ref="dialogRef" class="discard-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-message">
      <h2 id="discard-title">{{ titles[request.kind] }}</h2>
      <p id="discard-message">
        <template v-if="request.kind === 'window'">当前窗口中 <strong>{{ request.count }} 个文档</strong>的修改尚未保存。</template>
        <template v-else><strong>{{ request.name }}</strong> 有未保存的修改。</template>
        放弃后，这些修改将丢失。
      </p>
      <div class="actions">
        <button type="button" class="secondary" :disabled="busy" @click="cancel">继续编辑</button>
        <button type="button" class="discard" :disabled="busy" @click="discard">放弃并{{ action }}</button>
        <button type="button" class="primary" :disabled="!canSave || busy" :title="canSave ? '' : '需要 Tauri 桌面版'" @click="$emit('save')">保存并{{ action }}</button>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useModal } from '../../features/shell/useModal'
type Request = { kind: 'document' | 'reopen'; name: string } | { kind: 'window'; count: number }
const titles = {
  document: '关闭前保存修改？',
  window: '关闭窗口前保存修改？',
  reopen: '重新打开前保存修改？',
}
const props = defineProps<{ canSave: boolean; busy: boolean }>()
const emit = defineEmits<{ (e: 'discard'): void; (e: 'save'): void; (e:'cancel'):void }>()
const { visible, dialogRef, open: openModal, close, handleKeydown: modalKeydown } = useModal()
void dialogRef // Bound by name in the template.
function cancel(){close();emit('cancel')}
function handleKeydown(event: KeyboardEvent) { if (event.isComposing) return; if (props.busy) { event.preventDefault(); return }; if(event.key==='Escape'){event.preventDefault();cancel()}else modalKeydown(event) }
const request = ref<Request>({ kind: 'document', name: '' })
const action = computed(() => request.value.kind === 'reopen' ? '重新打开' : '关闭')
function open(next: Request) { request.value = next; openModal() }
function discard() { close(); emit('discard') }
defineExpose({ open, close, visible })
</script>
<style scoped>
.discard-overlay { position: fixed; inset: 0; z-index: 1001; background: rgba(0,0,0,.45); display: grid; place-items: center; padding: 16px; }
.discard-dialog { width: min(440px, 100%); background: var(--paper); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 22px; }
h2 { font-size: calc(var(--ui-font-size) + 4px); color: var(--bright); margin: 0; }
p { margin: 10px 0 0; color: var(--ink); overflow-wrap: anywhere; }
p strong { color: var(--bright); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 20px; }
button { min-height: var(--ui-control-height); padding: 4px 12px; border-radius: 6px; }
button:hover:not(:disabled) { background: var(--hover); }
button:disabled { opacity: .5; cursor: default; }
.discard { color: light-dark(#a6333a, #ff969d); }
.secondary { background: var(--soft); }
.primary { background: var(--accentbg); color: var(--bright); font-weight: 600; }
.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accentbg), var(--accent) 15%); }
</style>
