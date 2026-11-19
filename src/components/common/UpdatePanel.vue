<template>
  <section ref="panel" class="update-panel" role="dialog" aria-label="应用更新" @keydown.esc.stop="$emit('close')">
    <header>
      <strong aria-live="polite">{{ updateLabel(state) }}</strong>
      <button class="close" aria-label="关闭更新提示" @click="$emit('close')">×</button>
    </header>
    <template v-if="state.phase === 'downloading'">
      <progress :value="state.total ? state.received : undefined" :max="state.total || 1" aria-label="更新下载进度" />
      <p v-if="state.total">{{ Math.min(100, Math.floor(state.received / state.total * 100)) }}%</p>
    </template>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <a :href="releasePageUrl(state.version)" @click.prevent="$emit('release')">更新日志</a>
    <footer>
      <button v-if="canSkip" @click="$emit('skip')">跳过此版本</button>
      <button @click="$emit('close')">稍后更新</button>
      <button v-if="canSkip && !state.installSupported" class="primary" @click="$emit('release')">前往下载</button>
      <button v-else-if="canSkip || state.phase === 'awaiting-restart'" class="primary" @click="$emit('update')">{{ state.phase === 'awaiting-restart' ? '保存并重启' : state.phase === 'downloaded' ? '安装并重启' : '立即更新' }}</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { releasePageUrl } from '../../features/shell/AppUpdater'
import { updateLabel, type UpdateState } from '../../features/shell/updater/UpdateState'

const props = defineProps<{state: UpdateState}>()
const emit = defineEmits<{(e: 'close' | 'skip' | 'update' | 'release'): void}>()
const panel = ref<HTMLElement>()
const canSkip = computed(() => ['available', 'downloaded'].includes(props.state.phase))

function dismissOutside(event: PointerEvent) {
  if (panel.value && !event.composedPath().includes(panel.value)) emit('close')
}
onMounted(() => document.addEventListener('pointerdown', dismissOutside, true))
onUnmounted(() => document.removeEventListener('pointerdown', dismissOutside, true))
</script>

<style scoped>
.update-panel {
  position: fixed;
  right: 12px;
  bottom: calc(var(--ui-font-size) + 24px);
  z-index: 1200;
  box-sizing: border-box;
  width: min(350px, calc(100vw - 24px));
  max-height: calc(100vh - var(--ui-font-size) - 36px);
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--shadow);
  font-size: var(--ui-small-font-size);
  overflow-wrap: anywhere;
}
header, footer { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
header { justify-content: space-between; color: var(--bright); margin-bottom: 6px; }
footer { justify-content: flex-end; margin-top: 12px; }
button { padding: 5px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--editor); font: inherit; }
button:hover { background: var(--hover); }
button.close { padding: 0 5px; border-color: transparent; background: transparent; font-size: var(--ui-font-size); color: var(--muted); }
.primary { background: var(--accentbg); color: var(--accent); }
a { color: var(--accent); text-decoration: underline; }
p { margin: 6px 0; }
progress { width: 100%; accent-color: var(--accent); }
.error { color: var(--yellow); }
</style>
