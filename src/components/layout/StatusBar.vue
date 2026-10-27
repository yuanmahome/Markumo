<template>
  <footer class="status">
    <div class="stat-group left">
      <nav class="breadcrumb-trail" aria-label="文件路径层级">
        <template v-if="crumbs.length">
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <span v-if="index" class="crumb-separator" aria-hidden="true">›</span>
            <button
              v-if="crumb.directory"
              class="crumb-directory"
              :class="{ 'crumb-root': index === 0, 'crumb-parent': index === crumbs.length - 2 }"
              :title="readablePath(crumb.path)"
              :aria-label="`浏览目录 ${crumb.name}`"
              @click="openDirectory($event, crumb.path)"
            >{{ crumb.name }}</button>
            <span v-else class="crumb-file" :title="readablePath(doc?.path || '')">{{ crumb.name }}</span>
          </template>
        </template>
        <template v-else>
          <template v-for="(seg, index) in fallbackSegments" :key="index">
            <span v-if="index" class="crumb-separator" aria-hidden="true">›</span>
            <span :class="seg.directory ? 'crumb-segment' : 'crumb-file'" :title="readablePath(doc?.path || doc?.name || '')">{{ seg.name }}</span>
          </template>
        </template>
        <template v-for="symbol in symbolChain" :key="symbol.id">
          <span class="crumb-separator symbol-separator" aria-hidden="true">›</span>
          <button
            class="crumb-symbol"
            :title="`${symbol.kind === 'heading' ? '标题' : '代码符号'}：${symbol.name}`"
            @click="revealSymbol(symbol)"
          >
            <Icon :name="symbol.kind === 'heading' ? 'outline' : 'symbol-' + symbol.kind" size="small" />
            <span>{{ symbol.name }}{{ ['method', 'function', 'constructor'].includes(symbol.kind || '') ? '()' : '' }}</span>
          </button>
        </template>
      </nav>

      <span class="stat-item dirty-item" :class="{ dirty: isDirty }">
        {{ doc?.kind === 'javaClass' || isMedia(doc) ? '只读查看' : isDirty ? '● 未保存修改' : doc?.fileToken ? '已保存' : doc ? '未保存' : '' }}
      </span>
      <span v-if="doc?.readOnly && doc.kind !== 'javaClass' && !isMedia(doc)" class="stat-item readonly-tag" title="原路径不可写，可另存为">不可写</span>
    </div>

    <div class="stat-group right">
      <button
        v-if="recoveryCount > 0"
        class="stat-item recovery-btn"
        type="button"
        :title="`查看 ${recoveryCount} 个可恢复的未保存文档`"
        @click="$emit('open-recovery')"
      >可恢复 {{ recoveryCount }}</button>
      <template v-if="doc?.kind !== 'javaClass' && !isMedia(doc)">
        <span class="stat-item position">Ln {{ doc?.line || 1 }}, Col {{ doc?.column || 1 }}</span>
        <span class="stat-item optional">{{ useTabs ? 'Tabs' : 'Spaces' }}: {{ indentSize }}</span>
        <button
          class="stat-item encoding-btn"
          :class="{ clickable: !!doc }"
          :disabled="!doc"
          aria-label="选择编码操作"
          :title="encodingTitle"
          @click="openEncodingMenu($event)"
        >
          <span>{{ encodingDisplay }}</span>
          <span v-if="doc" class="encoding-arrow" aria-hidden="true">▾</span>
        </button>
        <span class="stat-item">{{ doc?.eol || 'LF' }}</span>
      </template>
      <span v-if="doc?.kind === 'javaClass'" class="stat-item">JVM ClassFile</span>
      <span v-else-if="isMedia(doc)" class="stat-item">{{ doc?.media?.format }} · {{ mediaSize(doc?.media?.byteLength || 0) }}</span>
      <select v-else class="stat-item lang-item" aria-label="语言模式" :disabled="!doc || doc.encoding === 'Hex'" :value="doc?.language || 'Plain Text'"
        @change="$emit('set-language', ($event.target as HTMLSelectElement).value as LanguageName)">
        <option v-for="language in languageNames" :key="language" :value="language">{{ language }}</option>
      </select>
      <span v-if="doc?.languageStatus === 'loading'" class="optional">加载中…</span>
      <span v-if="!isMedia(doc)" class="stat-item">{{ doc?.kind === 'javaClass' ? `${doc.classInfo?.byteLength.toLocaleString()} 字节` : `${charCount} 字符` }}</span>
    </div>
    <ContextMenu ref="encodingMenuRef" />
    <NavigationPopup
      v-if="menuAnchor"
      :key="menuPath"
      :anchor="menuAnchor"
      :title="readablePath(menuPath)"
      filter-label="筛选目录文件"
      :items="menuItems"
      :message="message"
      :parent-label="parentPath ? readablePath(parentPath) : undefined"
      action-label="在工作区文件树中定位当前文件"
      @select="choose"
      @parent="loadDirectory(parentPath!)"
      @action="revealTree"
      @close="closeMenu"
    />
  </footer>
</template>

<script setup lang="ts">
import { ref, computed, inject, shallowRef, watch, onUnmounted } from 'vue'
import { isMedia, mediaSize } from '../../features/files/media'
import type { EditorDocument } from '../../types'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import { languageNames, type LanguageName } from '../../editor/languages'
import { readablePath, displayFilePath } from '../../features/shell/pathDisplay'
import {
  workspaceNavigationKey,
  pathCrumbs,
  navigationDirectory,
  navigationParent,
} from '../../features/workspace/navigation'
import type { WorkspaceNode } from '../../features/workspace/contracts'
import NavigationPopup from '../common/NavigationPopup.vue'
import Icon from '../common/Icon.vue'
import { useDocumentOutline } from '../../editor/outline/useDocumentOutline'
import { useOutlineViewport } from '../../editor/outline/useOutlineViewport'
import type { OutlineItem } from '../../editor/outline/outlineService'
import ContextMenu from '../common/ContextMenu.vue'
import { CommandRegistry, menuCommand as cmd, separator, type MenuNode } from '../../features/shell/menuModel'
import type { Encoding, FileOpenEncoding } from '../../features/files/contracts'

const emit = defineEmits<{
  (e: 'set-language', language: LanguageName): void
  (e: 'reopen-encoding', encoding: FileOpenEncoding): void
  (e: 'convert-encoding', payload: { encoding: Encoding; bom: boolean }): void
  (e: 'save-as-encoding', encoding: Encoding): void
  (e: 'open-recovery'): void
}>()

const props = defineProps<{
  doc: EditorDocument | null
  indentSize: number
  useTabs: boolean
  recoveryCount: number
  root?: { rootPath: string; name: string } | null
  multiRoot?: boolean
  manager?: DocumentManager
  outlineEnabled?: boolean
}>()

const navigation = inject(workspaceNavigationKey, undefined)
const crumbs = computed(() => {
  if (props.doc?.path && navigation?.enabled()) {
    return pathCrumbs(props.doc.path, navigation.workspace.roots)
  }
  return []
})

const fallbackSegments = computed(() => {
  if (!props.doc) return [{ name: '未打开文件', directory: false }]
  const raw = displayFilePath(props.doc.path || props.doc.name, props.root, props.multiRoot)
  const parts = raw.split(/[\\/]/).filter(Boolean)
  if (!parts.length) return [{ name: props.doc.name || '未命名', directory: false }]
  return parts.map((name, index) => ({
    name,
    directory: index < parts.length - 1,
  }))
})

const structure = useDocumentOutline(() => props.manager, () => props.doc, () => !!props.manager && !!props.outlineEnabled)
const activeSymbol = useOutlineViewport(() => props.manager, () => props.doc?.id, () => structure.value.items)
const symbolChain = computed(() => {
  const items = structure.value.items, index = items.findIndex(item => item.id === activeSymbol.value)
  if (index < 0) return []
  const current = items[index], chain: OutlineItem[] = []
  if (current.kind === 'heading') {
    for (const item of items.slice(0, index + 1)) { while (chain.length && chain[chain.length - 1].level >= item.level) chain.pop(); chain.push(item) }
  } else {
    const byId = new Map(items.map(item => [item.id, item])); let item: OutlineItem | undefined = current
    while (item) { chain.unshift(item); item = item.parentId ? byId.get(item.parentId) : undefined }
  }
  return chain.slice(-2)
})

function revealSymbol(item: OutlineItem) {
  const m = props.manager
  if (!m || !props.doc) return
  m.revealOutline(props.doc.id, item)
}

const menuAnchor = shallowRef<HTMLElement | null>(null), menuPath = ref(''), nodes = shallowRef<WorkspaceNode[]>([]), message = ref('')
let epoch = 0
const menuItems = computed(() => nodes.value.map(node => ({ id: node.path, label: node.name, directory: node.isDirectory })))
const parentPath = computed(() => navigationParent(menuPath.value, navigation?.workspace.rootForPath(menuPath.value) || null))

function closeMenu(restore = false) {
  ++epoch
  const anchor = menuAnchor.value
  menuAnchor.value = null
  nodes.value = []
  if (restore && anchor?.isConnected) anchor.focus()
}

function openDirectory(event: MouseEvent, path: string) {
  closeMenu()
  menuAnchor.value = event.currentTarget as HTMLElement
  void loadDirectory(path)
}

async function loadDirectory(path: string) {
  if (!navigation?.enabled()) return closeMenu()
  const current = ++epoch
  menuPath.value = path
  nodes.value = []
  message.value = '正在加载目录…'
  try {
    const result = await navigationDirectory(navigation.workspace, path)
    if (current !== epoch) return
    nodes.value = result.nodes
    message.value = result.limited ? '目录较大，仅列出前 1000 项。' : result.nodes.length ? '' : '此目录没有可导航的文件。'
  } catch (error) {
    if (current === epoch) message.value = `无法加载目录：${String(error)}`
  }
}

async function choose(path: string) {
  const node = nodes.value.find(node => node.path === path)
  if (!node || !navigation?.enabled() || !navigation.workspace.rootForPath(path)) return
  if (node.isDirectory) return loadDirectory(path)
  closeMenu()
  await navigation.workspace.openFile(node)
}

async function revealTree() {
  const path = props.doc?.path, current = epoch
  if (!path || !navigation?.enabled()) return
  const found = await navigation.reveal(path)
  if (current !== epoch) return
  if (found) closeMenu()
  else message.value = '无法在当前工作区文件树中定位该文件。'
}

watch([() => props.doc?.id, () => props.doc?.path, () => navigation?.enabled(), () => navigation?.workspace.openRevision], () => closeMenu())
onUnmounted(() => {
  ++epoch
  menuAnchor.value = null
})

const encodingMenuRef = ref<InstanceType<typeof ContextMenu> | null>(null)

const isDirty = computed(() => {
  return props.doc?.dirty ?? false
})

const charCount = computed(() => {
  return props.doc?.charCount.toLocaleString() || '0'
})

const encodingDisplay = computed(() => {
  if (!props.doc) return 'UTF-8'
  if (props.doc.encoding === 'Hex') return 'HEX 字节'
  return `${props.doc.encoding || 'UTF-8'}${props.doc.bom ? ' BOM' : ''}`
})

const encodingTitle = computed(() => {
  if (!props.doc) return '未打开文档'
  if (props.doc.encoding === 'Hex') return '当前为十六进制字节模式，点击选择编码重新打开'
  return `当前编码：${props.doc.encoding || 'UTF-8'}${props.doc.bom ? ' (BOM)' : ''}，点击更改`
})

const TEXT_ENCODINGS: { label: string; id: Encoding }[] = [
  { label: 'UTF-8', id: 'UTF-8' },
  { label: 'GB18030 (兼容 GBK/GB2312)', id: 'GB18030' },
  { label: 'UTF-16LE', id: 'UTF-16LE' },
  { label: 'UTF-16BE', id: 'UTF-16BE' },
  { label: 'Windows-1252 (西欧)', id: 'windows-1252' },
]

function openEncodingMenu(event: MouseEvent | KeyboardEvent) {
  if (!props.doc) return
  const isHex = props.doc.encoding === 'Hex'
  const hasFile = !!props.doc.fileToken

  const commands = [
    // 1. 以指定编码重新打开
    ...TEXT_ENCODINGS.map(enc => ({
      id: `reopen-${enc.id}`,
      title: enc.label,
      enabled: hasFile,
      run: () => emit('reopen-encoding', enc.id),
    })),
    {
      id: 'reopen-Hex',
      title: '以字节方式打开 (HEX)',
      enabled: hasFile && !isHex,
      run: () => emit('reopen-encoding', 'Hex'),
    },

    // 2. 转换为指定编码并保存
    ...TEXT_ENCODINGS.map(enc => ({
      id: `convert-${enc.id}`,
      title: enc.label,
      enabled: hasFile && !isHex,
      run: () => emit('convert-encoding', { encoding: enc.id, bom: false }),
    })),
    {
      id: 'convert-UTF-8-BOM',
      title: 'UTF-8 带 BOM',
      enabled: hasFile && !isHex,
      run: () => emit('convert-encoding', { encoding: 'UTF-8', bom: true }),
    },

    // 3. 另存为指定编码…
    ...TEXT_ENCODINGS.map(enc => ({
      id: `saveas-${enc.id}`,
      title: enc.label,
      enabled: !isHex,
      run: () => emit('save-as-encoding', enc.id),
    })),
  ]

  const registry = new CommandRegistry(commands)

  const reopenChildren: MenuNode[] = [
    ...TEXT_ENCODINGS.map(enc => cmd(`reopen-${enc.id}`)),
    cmd('reopen-Hex'),
  ]

  const convertChildren: MenuNode[] = [
    ...TEXT_ENCODINGS.map(enc => cmd(`convert-${enc.id}`)),
    cmd('convert-UTF-8-BOM'),
  ]

  const saveAsChildren: MenuNode[] = [
    ...TEXT_ENCODINGS.map(enc => cmd(`saveas-${enc.id}`)),
  ]

  const menuNodes: MenuNode[] = [
    { type: 'submenu', id: 'reopen-submenu', label: '以指定编码重新打开', children: reopenChildren, enabled: hasFile },
    separator('sep-1'),
    { type: 'submenu', id: 'convert-submenu', label: '转换为指定编码并保存', children: convertChildren, enabled: hasFile && !isHex },
    separator('sep-2'),
    { type: 'submenu', id: 'saveas-submenu', label: '另存为指定编码…', children: saveAsChildren, enabled: !isHex },
  ]

  encodingMenuRef.value?.open(event, menuNodes, registry, '编码操作', true)
}
</script>

<style scoped>
.status {
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
  height: var(--ui-row-height);
  background: var(--bar);
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  font-size: var(--ui-font-size);
  color: var(--muted);
  flex: none;
}

@media (max-width: 950px) {
  .optional { display: none; }
  .stat-group { gap: 6px; }
}

.stat-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.stat-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.stat-group.left { min-width: 0; flex: 1; }
.stat-group.right { flex: none; }

.breadcrumb-trail {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  max-width: min(650px, 60vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumb-directory, .crumb-segment {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 3px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: inherit;
  cursor: pointer;
  transition: all .15s ease;
}

.crumb-directory:hover {
  background: var(--hover);
  color: var(--bright);
}

.crumb-separator {
  opacity: .5;
  flex: none;
  margin: 0 1px;
  color: var(--muted);
  font-size: var(--ui-small-font-size);
}

.crumb-file {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 20px;
  flex-shrink: 1;
  color: var(--bright);
  font-weight: 500;
}

.readonly-tag {
  color: #d9534f;
  font-weight: 500;
  font-size: var(--ui-small-font-size);
}

.crumb-symbol {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 3px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: inherit;
  cursor: pointer;
  transition: all .15s ease;
}

.crumb-symbol:hover {
  background: var(--hover);
  color: var(--bright);
}

.crumb-symbol :deep(.icon) {
  flex: none;
}

.dirty-item { flex: none; }

.dirty-item.dirty {
  color: var(--yellow);
}

.encoding-btn {
  background: transparent;
  border: none;
  font-size: inherit;
  color: var(--muted);
  cursor: default;
  padding: 1px 4px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.encoding-btn.clickable {
  cursor: pointer;
}

.encoding-btn.clickable:hover {
  background: var(--hover);
  color: var(--bright);
}

.encoding-arrow {
  font-size: var(--ui-small-font-size);
  opacity: 0.7;
}

.lang-item {
  background: var(--bar);
  border: 0;
  max-width: 120px;
  font-size: inherit;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 3px;
}
@media (max-width: 720px) { .dirty-item, .position { display: none; } .stat-group { gap: 6px; } }

.lang-item:hover {
  background: var(--hover);
  color: var(--bright);
}

.recovery-btn {
  border: 0;
  background: var(--accentbg);
  color: var(--accent);
  cursor: pointer;
  border-radius: 3px;
  padding: 0 6px;
  font: inherit;
}
.recovery-btn:hover { color: var(--bright); }
</style>
