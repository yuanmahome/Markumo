<template>
  <header class="topbar" @mousedown="dragWindow" @dblclick="maximizeFromHeader">
    <div class="brandarea">
      <div class="app-brand"><img class="logo" src="/logo.png" alt="Markumo 标志" width="26" height="26" /><span class="brand">Markumo</span></div>
      <AppMenu :groups="menuGroups" :registry="commandRegistry" @execute="$emit('execute-command',$event)" />
    </div>

    <button
      class="quickbtn"
      :title="`${shortcutLabel(quickShortcut)} 或双击 Shift 快速搜索文件`"
      @click="$emit('open-palette', 'file')"
    >
      <Icon name="search" />
      <span class="quick-label">文件和命令…</span>
      <span class="kbd">{{ shortcutLabel(quickShortcut) }}</span>
    </button>

    <div class="topright">
      <button
        class="ib"
        :title="theme === 'dark' ? '深色 · 切换浅色主题' : theme === 'light' ? '浅色 · 切换跟随系统' : '跟随系统 · 切换深色主题'"
        @click="$emit('toggle-theme')"
      >
        <Icon :name="theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'system'" />
      </button>

      <button
        class="ib"
        title="设置"
        @click="$emit('open-settings')"
      >
        <Icon name="gear" />
      </button>
      <button v-if="desktop" class="ib mini-entry" aria-label="进入 Mini 模式" title="Mini 悬浮小窗" :disabled="!canMini" @click="$emit('toggle-mini')"><Icon name="mini-window" /></button>
      <div v-if="desktop" class="window-controls" @mousedown.stop @dblclick.stop>
        <button aria-label="最小化窗口" title="最小化" @click="windowAction('minimize')">—</button>
        <button aria-label="最大化或还原窗口" title="最大化 / 还原" @click="windowAction('maximize')">□</button>
        <button class="window-close" aria-label="关闭窗口" title="关闭" @click="windowAction('close')">×</button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import Icon from '../common/Icon.vue'
import AppMenu from './AppMenu.vue'
import type { AppMode, ThemePreference } from '../../types'
import type { MenuGroup, CommandRegistry } from '../../features/shell/menuModel'
import { shortcutLabel } from '../../features/shell/editorSettings'

const props = defineProps<{
  appMode: AppMode
  theme: ThemePreference
  focusMode: boolean
  desktop: boolean
  fileBusy: boolean
  canMini: boolean
  menuGroups: MenuGroup[]
  commandRegistry: CommandRegistry
  quickShortcut: string
}>()

async function windowAction(action: 'minimize' | 'maximize' | 'close') {
  if (!props.desktop) return
  if (action === 'close') { emit('request-close'); return }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const window = getCurrentWindow()
    if (action === 'minimize') await window.minimize()
    else if (action === 'maximize') await window.toggleMaximize()
  } catch { globalThis.window.dispatchEvent(new CustomEvent('editor-notice', { detail: '窗口操作失败，请重试。' })) }
}
async function dragWindow(event: MouseEvent) {
  if (!props.desktop || event.button !== 0 || !(event.target instanceof Element) || event.target.closest('button,input,select,[role=menu]')) return
  try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().startDragging() } catch {}
}
function maximizeFromHeader(event: MouseEvent) {
  if (event.target instanceof Element && !event.target.closest('button,input,select,[role=menu]')) void windowAction('maximize')
}

const emit = defineEmits<{
  (e: 'request-close'): void
  (e: 'set-mode', mode: AppMode): void
  (e: 'toggle-theme'): void
  (e: 'toggle-focus'): void
  (e: 'toggle-mini'): void
  (e: 'open-settings'): void
  (e: 'open-file'): void
  (e: 'save-file'): void
  (e: 'open-palette', category: 'action' | 'file' | 'all'): void
  (e:'execute-command',id:string):void
}>()

</script>

<style scoped>
.topbar {
  height: calc(var(--ui-font-size) + 34px);
  flex: none;
  display: grid;
  grid-template-columns: auto minmax(110px, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 0 8px;
  background: var(--bar);
  border-bottom: 1px solid var(--line);
}

.brandarea {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.logo {
  width: 26px;
  height: 26px;
  display: block;
  flex: none;
  object-fit: contain;
}
.app-brand { display:flex;align-items:center;gap:9px;flex:none }

.brand {
  font-size: var(--ui-font-size);
  font-weight: 700;
  color: var(--bright);
  letter-spacing: -0.3px;
}


.quickbtn {
  width: 100%;
  max-width: 390px;
  justify-self: center;
  min-width: 0;
  height: var(--ui-control-height);
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--editor);
  padding: 0 11px;
  display: flex;
  gap: 9px;
  align-items: center;
  text-align: left;
  color: var(--muted);
  font-size: var(--ui-font-size);
  transition: background 0.15s, border-color 0.15s;
}

.quickbtn:hover {
  background: var(--hover);
  border-color: var(--muted);
}

.quickbtn span {
  flex: 1;
}

.quick-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quickbtn .kbd { flex: none; }

@media (max-width: 1100px) {
  .brand { display: none; }
  .topbar { gap: 8px; }
}
@media (max-width: 900px) {
  .quickbtn .kbd,.quick-label { display: none; }
  .topbar { grid-template-columns: auto 32px auto; gap:6px;justify-content:space-between }
  .quickbtn { padding:0;justify-content:center }
  .topright > .ib:not(.mini-entry):not([title='设置']) { display:none }
}

.topright {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}
.mini-entry{margin-left:2px}
.mini-entry:disabled{opacity:.35;cursor:default}
.window-controls { display:flex;align-self:stretch;margin-right:-8px;margin-left:4px }
.window-controls button { width:36px;height:calc(var(--ui-font-size) + 33px);border-radius:0;font-size: calc(var(--ui-font-size) + 2px);color:var(--sub) }
.window-controls button:hover { background:var(--hover);color:var(--bright) }
.window-controls .window-close:hover { background:#c94048;color:#fff }

</style>
