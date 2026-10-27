<template>
  <nav class="rail">
    <button
      class="ib"
      :class="{ on: activePanel === 'files' && sidebarVisible }"
      title="文件资源管理器"
      @click="$emit('select-panel', 'files')"
    >
      <Icon name="files" />
    </button>

    <button
      class="ib"
      :class="{ on: activePanel === 'search' && sidebarVisible }"
      :title="`在文件中查找 (${shortcutLabel(searchShortcut || '')})`"
      @click="$emit('select-panel', 'search')"
    >
      <Icon name="search" />
    </button>

    <button
      class="ib"
      :class="{ on: outlineSupported && outlineVisible }"
      :aria-pressed="outlineSupported && outlineVisible"
      :disabled="!outlineSupported"
      :title="outlineSupported ? '文档大纲' : '当前文件不支持大纲'"
      @click="$emit('toggle-outline')"
    >
      <Icon name="outline" />
    </button>

    <div class="push"></div>

    <button
      class="ib"
      title="首选项设置"
      @click="$emit('open-settings')"
    >
      <Icon name="gear" />
    </button>
  </nav>
</template>

<script setup lang="ts">
import Icon from '../common/Icon.vue'
import type { SidebarPanel } from '../../types'
import {shortcutLabel} from '../../features/shell/editorSettings'

defineProps<{
  activePanel: SidebarPanel
  sidebarVisible: boolean
  outlineVisible?: boolean
  outlineSupported?: boolean
  searchShortcut?: string
}>()

defineEmits<{
  (e: 'select-panel', panel: SidebarPanel): void
  (e: 'open-settings'): void
  (e: 'toggle-outline'): void
}>()
</script>

<style scoped>
.rail {
  width: 44px;
  flex: none;
  background: var(--bar);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 6px;
}

.push {
  flex: 1;
}
</style>
