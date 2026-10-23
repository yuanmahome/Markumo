<template>
  <div class="tree-node-wrapper">
    <div
      class="treenode"
      :class="[
        node.isDirectory ? 'folder' : 'file',
        `depth-${depth}`,
        { 'active-file': isNodeActive, selected: isNodeSelected, 'locate-highlight': highlighted }
      ]"
      :style="{ paddingLeft: `${Math.min(depth, 10) * 12 + 10}px` }"
      :title="compactTitle"
      role="treeitem"
      :data-tree-path="node.path"
      :data-compact-paths="isCompact ? compactChain!.map(n => n.path).join(';') : undefined"
      :aria-level="depth + 1"
      :aria-selected="isNodeSelected"
      :aria-current="isNodeActive ? 'page' : undefined"
      :aria-label="compactAriaLabel"
      :aria-expanded="node.isDirectory ? isExpanded : undefined"
      :draggable="!node.isDirectory"
      @dragstart="handleDragStart"
      @dragend="handleDragEnd"
      :tabindex="tabStop ? 0 : -1"
      @focus.self="emit('locate-node', node)"
      @click="handleClick"
      @dblclick="handleDblClick"
      @contextmenu.prevent.stop="openMenu"
      @keydown.shift.f10.prevent.stop="openMenu"
    >
      <template v-if="node.isDirectory">
        <span class="twisty" @click.stop="handleTwistyClick" @dblclick.stop>
          <span v-if="isLoading" class="loading-spin">⟳</span>
          <span v-else>{{ isExpanded ? '▾' : '▸' }}</span>
        </span>
        <Icon name="folder" size="small" />
        <span v-if="isCompact" class="label compact-chain">
          <template v-for="(item, idx) in compactChain" :key="item.path">
            <span
              class="compact-segment"
              :class="{
                'segment-selected': isSegmentSelected(item.path)
              }"
              :data-segment-path="item.path"
              :title="`${item.name}\n${readablePath(item.path)}`"
              @click.stop="handleSegmentClick($event, item)"
              @dblclick.stop="handleSegmentDblClick($event, item)"
              @contextmenu.prevent.stop="openSegmentMenu($event, item)"
            >{{ item.name }}</span>
            <span v-if="idx < compactChain!.length - 1" class="compact-separator">/</span>
          </template>
        </span>
        <span v-else class="label">{{ node.name }}</span>
      </template>

      <template v-else>
        <span class="twisty" aria-hidden="true"></span><FileIcon :name="node.name" />
        <span class="label">{{ node.name }}</span>
        <span v-if="isDirty" class="dirty-dot">●</span>
      </template>
    </div>

    <!-- 子目录递归展开 -->
    <div v-if="!flat && node.isDirectory && isExpanded && (compactTail.children || node.children)">
      <TreeNodeItem
        v-for="child in (compactTail.children || node.children)"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :active-file-path="activeFilePath"
        :selected-tree-path="selectedTreePath"
        :tree-click-mode="treeClickMode"
        :dirty-paths="dirtyPaths"
        :desktop="desktop"
        @locate-node="$emit('locate-node', $event)"
        @open-file="$emit('open-file', $event)"
        @select-file="$emit('select-file', $event)"
        @pin-file="$emit('pin-file', $event)"
        @toggle-folder="$emit('toggle-folder', $event)"
        @toggle-compact="$emit('toggle-compact', $event)"
        @create-file="$emit('create-file', $event)"
        @rename-node="$emit('rename-node', $event)"
        @delete-node="$emit('delete-node', $event)"
        @move-node="$emit('move-node', $event)"
        @copy-path="$emit('copy-path', $event)"
        @reveal-node="$emit('reveal-node', $event)"
      />
    </div>
    <ContextMenu ref="contextMenu" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ContextMenu from '../common/ContextMenu.vue'
import { CommandRegistry, menuCommand as cmd, separator } from '../../features/shell/menuModel'
import Icon from '../common/Icon.vue'
import FileIcon from '../common/FileIcon.vue'
import type { WorkspaceNode } from '../../features/workspace/contracts'
import { readablePath, displayPathKey } from '../../features/shell/pathDisplay'

const props = withDefaults(defineProps<{
  node: WorkspaceNode
  depth: number
  compactChain?: WorkspaceNode[]
  activeFilePath?: string
  selectedTreePath?: string | null
  treeClickMode?: 'double' | 'single'
  dirtyPaths?: string[]
  flat?: boolean
  desktop?: boolean
  tabStop?: boolean
  highlighted?: boolean
}>(), {
  treeClickMode: 'single',
})

const emit = defineEmits<{
  (e: 'locate-node', node: WorkspaceNode): void
  (e: 'select-file', node: WorkspaceNode): void
  (e: 'open-file', node: WorkspaceNode): void
  (e: 'pin-file', node: WorkspaceNode): void
  (e: 'toggle-folder', node: WorkspaceNode): void
  (e: 'toggle-compact', chain: WorkspaceNode[]): void
  (e: 'create-file', parentDir: string): void
  (e: 'rename-node', node: WorkspaceNode): void
  (e: 'delete-node', node: WorkspaceNode): void
  (e: 'move-node', node: WorkspaceNode): void
  (e: 'copy-path', path: string): void
  (e: 'reveal-node', path: string): void
}>()

const isCompact = computed(() => !!(props.compactChain && props.compactChain.length > 1))
const compactTail = computed(() => isCompact.value ? props.compactChain![props.compactChain!.length - 1] : props.node)

const isExpanded = computed(() => {
  if (isCompact.value) {
    return props.compactChain!.some(item => item.isExpanded)
  }
  return !!props.node.isExpanded
})

const isLoading = computed(() => {
  if (isCompact.value) {
    return props.compactChain!.some(item => item.isLoading)
  }
  return !!props.node.isLoading
})

const compactTitle = computed(() => {
  if (isCompact.value) {
    const chainNames = props.compactChain!.map(n => n.name).join('/')
    return `${chainNames}\n${readablePath(compactTail.value.path)}`
  }
  return `${props.node.name}\n${readablePath(props.node.path)}`
})

const compactAriaLabel = computed(() => {
  if (isCompact.value) {
    return props.compactChain!.map(n => n.name).join('/')
  }
  return props.node.name
})

const isDirty = computed(() => {
  return props.dirtyPaths?.some(path => displayPathKey(path) === displayPathKey(props.node.path)) ?? false
})

const isNodeSelected = computed(() => {
  if (!props.selectedTreePath) return false
  const target = displayPathKey(props.selectedTreePath)
  if (displayPathKey(props.node.path) === target) return true
  if (props.compactChain?.some(item => displayPathKey(item.path) === target)) return true
  return false
})

function isSegmentSelected(path: string) {
  if (!props.selectedTreePath) return false
  return displayPathKey(props.selectedTreePath) === displayPathKey(path)
}

const isNodeActive = computed(() => !props.node.isDirectory && !!props.activeFilePath && displayPathKey(props.activeFilePath) === displayPathKey(props.node.path))

let dragOccurred = false

function handleDragStart(event: DragEvent) {
  if (props.node.isDirectory) {
    event.preventDefault()
    return
  }
  dragOccurred = true
  event.dataTransfer?.setData('application/x-markumo-file', JSON.stringify({ path: props.node.path, name: props.node.name }))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
}

function handleDragEnd() {
  setTimeout(() => {
    dragOccurred = false
  }, 100)
}

function handleClick(event: MouseEvent) {
  if (dragOccurred) {
    dragOccurred = false
    return
  }
  if (isCompact.value) {
    const segElement = (event.target as HTMLElement).closest<HTMLElement>('[data-segment-path]')
    if (segElement) return
    emit('locate-node', props.node)
    if (event.detail > 1) return
    if (props.treeClickMode === 'single') {
      emit('toggle-compact', props.compactChain!)
    }
    return
  }
  emit('locate-node', props.node)
  if (event.detail > 1) return
  if (props.node.isDirectory) {
    if (props.treeClickMode === 'single') {
      emit('toggle-folder', props.node)
    }
  } else {
    emit('select-file', props.node)
  }
}

function handleDblClick(event: MouseEvent) {
  if (dragOccurred) {
    dragOccurred = false
    return
  }
  if (isCompact.value) {
    const segElement = (event.target as HTMLElement).closest<HTMLElement>('[data-segment-path]')
    if (segElement) return
    emit('locate-node', props.node)
    if (props.treeClickMode === 'double') {
      emit('toggle-compact', props.compactChain!)
    }
    return
  }
  emit('locate-node', props.node)
  if (props.node.isDirectory) {
    if (props.treeClickMode === 'double') {
      emit('toggle-folder', props.node)
    }
  } else {
    emit('pin-file', props.node)
  }
}

function handleSegmentClick(_event: MouseEvent, item: WorkspaceNode) {
  emit('locate-node', item)
}

function handleSegmentDblClick(_event: MouseEvent, item: WorkspaceNode) {
  emit('locate-node', item)
  if (props.treeClickMode === 'double') {
    if (isCompact.value) {
      emit('toggle-compact', props.compactChain!)
    } else {
      emit('toggle-folder', item)
    }
  }
}

function handleTwistyClick(event: MouseEvent) {
  if (isCompact.value) {
    emit('locate-node', props.node)
    emit('toggle-compact', props.compactChain!)
    return
  }
  emit('locate-node', props.node)
  if (props.node.isDirectory && event.detail <= 1) {
    emit('toggle-folder', props.node)
  }
}

const contextMenu = ref<InstanceType<typeof ContextMenu> | null>(null)

function openSegmentMenu(event: MouseEvent | KeyboardEvent, item: WorkspaceNode) {
  emit('locate-node', item)
  openMenuForNode(event, item)
}

function openMenu(event: MouseEvent | KeyboardEvent) {
  if (isCompact.value) {
    const segElement = (event.target as HTMLElement).closest<HTMLElement>('[data-segment-path]')
    const segPath = segElement?.dataset.segmentPath
    let target: WorkspaceNode | undefined
    if (props.selectedTreePath) {
      target = props.compactChain!.find(n => displayPathKey(n.path) === displayPathKey(props.selectedTreePath!))
    }
    if (!target && segPath) {
      target = props.compactChain!.find(n => displayPathKey(n.path) === displayPathKey(segPath))
    }
    if (!target) target = compactTail.value
    emit('locate-node', target)
    openMenuForNode(event, target)
    return
  }
  emit('locate-node', props.node)
  openMenuForNode(event, props.node)
}

function openMenuForNode(event: MouseEvent | KeyboardEvent, target: WorkspaceNode) {
  const registry = new CommandRegistry([
    { id:'node-new-file',title:'新建文件…',enabled:target.isDirectory,run:()=>emit('create-file',target.path) },
    { id:'node-rename',title:'重命名…',enabled:true,run:()=>emit('rename-node',target) },
    { id:'node-move',title:'移动到…',enabled:true,run:()=>emit('move-node',target) },
    { id:'node-delete',title:'删除…',enabled:true,run:()=>emit('delete-node',target) },
    { id:'node-copy-path',title:'复制文件路径',enabled:true,run:()=>emit('copy-path',target.path) },
    { id:'node-reveal',title:'在文件管理器中显示',enabled:!!props.desktop,run:()=>emit('reveal-node',target.path) },
  ])
  contextMenu.value?.open(event,[...(target.isDirectory ? [cmd('node-new-file'),separator('node-create-section')] : []),cmd('node-rename'),cmd('node-move'),cmd('node-delete'),separator('node-path-section'),cmd('node-copy-path'),cmd('node-reveal')],registry,'文件与目录操作')
}
</script>

<style scoped>
.tree-node-wrapper {
  user-select: none;
}

.treenode {
  height: var(--ui-tree-row-height);
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--ink);
  transition: background 0.1s;
  position: relative;
  font-size: var(--ui-font-size);
}

.treenode:hover {
  background: var(--hover);
}

.treenode.selected {
  background: var(--accentbg);
  color: var(--bright);
}
.treenode.active-file::before { content:'';position:absolute;left:0;top:4px;bottom:4px;width:2px;border-radius:2px;background:var(--accent) }
.treenode.active-file { color:var(--bright) }
.treenode:focus-visible { outline:2px solid var(--accent);outline-offset:-2px }
.treenode.locate-highlight { animation:locate-pulse 1.2s ease-out }
@keyframes locate-pulse { from { box-shadow:inset 0 0 0 2px var(--accent);background:var(--accentbg) } to { box-shadow:inset 0 0 0 2px transparent } }
@media(prefers-reduced-motion:reduce) { .treenode { transition:none }.treenode.locate-highlight { animation:none;box-shadow:inset 0 0 0 2px var(--accent) } }

.twisty {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  border-radius: 3px;
  user-select: none;
  transition: color 0.1s, background-color 0.1s;
}

.treenode.folder .twisty {
  cursor: pointer;
}

.treenode.folder .twisty:hover {
  color: var(--bright);
  background: var(--hover);
}

.label {
  min-width: 0;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.compact-chain {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-segment {
  cursor: pointer;
  border-radius: 2px;
  padding: 0 2px;
  transition: background 0.1s, color 0.1s;
}

.compact-segment:hover {
  background: var(--hover);
  text-decoration: underline;
}

.compact-segment.segment-selected {
  background: var(--accentbg);
  color: var(--accent);
  font-weight: 600;
}

.compact-separator {
  color: var(--muted);
  margin: 0 1px;
  user-select: none;
}

.dirty-dot {
  font-size: var(--ui-small-font-size);
  color: var(--yellow);
  margin-right: 4px;
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
