<template>
  <div class="tabs">
    <div ref="tabs" class="tabs-scroll" @wheel="scrollTabs">
    <div class="tablist" role="tablist" aria-label="打开的文件">
      <div
        v-for="doc in docs"
        :key="doc.id"
        :data-document="doc.id"
        class="tab"
        draggable="false"
        @pointerdown="onTabPointerDown($event, doc)"
        @dragstart.prevent
        role="tab" tabindex="0" :aria-label="labels.get(doc.id) || doc.name" :aria-selected="doc.id === activeId"
        @keydown.enter.prevent="selectTab(doc.id)"
        @keydown.space.prevent="selectTab(doc.id)"
        @auxclick.middle.prevent="closeTab(doc.id)"
        :class="{
          active: doc.id === activeId,
          temp: !doc.pinned,
          pinned: doc.pinned,
          'drop-before': isDragInsertingBefore(doc.id),
          'drop-after': isDragInsertingAfter(doc.id),
          'is-dragging': tabDragService.isDragging.value && tabDragService.dragPayload.value?.kind!=='file' && tabDragService.dragPayload.value?.fromPaneId === pane && tabDragService.dragPayload.value?.documentId === doc.id
        }"
        :title="readablePath(doc.path) || doc.name"
        @click="selectTab(doc.id)"
        @dblclick="$emit('pin-tab', doc.id)"
        @contextmenu.prevent.stop="openMenu($event, doc)"
        @keydown.shift.f10.prevent.stop="openMenu($event, doc)"
      >
        <FileIcon :name="doc.name" />
        <button v-if="files?.external.state(doc.id)?.conflictValid" class="external-mark" aria-label="文件存在外部变化，查看处理选项" title="外部变化尚未处理" @pointerdown.stop @click.stop="files.external.keep(doc.id, false); $emit('select-tab', doc.id)">⚠</button>
        <span class="filename">{{ labels.get(doc.id) || doc.name }}</span>
        <span class="unsaved" :class="{ 'is-unsaved':doc.dirty || !doc.path }" :title="doc.dirty ? '未保存修改' : !doc.path ? '尚未保存' : undefined"></span>
        <button
          class="tinyclose"
          :title="`关闭 ${doc.name}`"
          :aria-label="`关闭 ${doc.name}`"
          @click.stop="closeTab(doc.id)"
        >
          ✕
        </button>
      </div>
    </div>
    </div>

    <button ref="openButton" class="newtab open-tabs-button" title="显示已打开文件（最近使用）" aria-label="显示已打开文件" :aria-expanded="!!menuAnchor" @click="menuAnchor=menuAnchor ? null : openButton!">⌄</button>

    <button
      class="newtab"
      title="新建草稿"
      @click="$emit('new-doc')"
    >
      <Icon name="plus" size="small" />
    </button>

    <ContextMenu ref="contextMenu" />
    <NavigationPopup v-if="menuAnchor" :anchor="menuAnchor" title="已打开文件 · 最近使用" filter-label="筛选已打开文件" :items="openItems" closable @select="selectFromMenu" @remove="closeTab" @close="closeFiles" />
  </div>
</template>

<script setup lang="ts">
import Icon from '../common/Icon.vue'
import FileIcon from '../common/FileIcon.vue'
import type { FileController } from '../../features/files/FileController'
import type { EditorDocument } from '../../types'
import { displayFilePath, readablePath } from '../../features/shell/pathDisplay'
import { computed, ref, shallowRef, watch, nextTick, onMounted, onUnmounted } from 'vue'
import NavigationPopup from '../common/NavigationPopup.vue'
import { tabLabels, type TabIdentity } from '../../features/tabs/tabLabels'
import ContextMenu from '../common/ContextMenu.vue'
import { CommandRegistry, menuCommand as cmd, separator, type MenuNode } from '../../features/shell/menuModel'
import { textClipboard } from '../../features/shell/clipboard'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import { tabDragService } from '../../editor/layout/TabDragService'
import { requestDetachToWindow, defaultDetachDropPoint } from '../../features/windows/tabDetach'

const props = withDefaults(defineProps<{
  files?: FileController
  docs: EditorDocument[]
  activeId: string | null
  pane?: string
  split?: boolean
  manager?: DocumentManager
  desktop?: boolean
  rootPath?: string | null
}>(), { pane: 'main', desktop: false })

const emit = defineEmits<{
  (e: 'select-tab', id: string): void
  (e: 'pin-tab', id: string): void
  (e: 'unpin-tab', id: string): void
  (e: 'close-tab', id: string): void
  (e: 'close-others', id: string): void
  (e: 'close-right', id: string): void
  (e: 'close-all'): void
  (e: 'new-doc'): void
  (e: 'split-tab', payload: { id: string; direction: 'left' | 'right' | 'top' | 'bottom'; duplicate?: boolean }): void
  (e: 'move-other', id: string): void
  (e: 'move-pane', payload: { id: string; toPane: string }): void
  (e: 'close-pane'): void
  (e: 'close-split'): void
  (e: 'merge-splits'): void
  (e: 'reveal-in-explorer', token: string): void
}>()

const contextMenu = ref<InstanceType<typeof ContextMenu> | null>(null)
const tabs = ref<HTMLElement | null>(null)
const openButton=ref<HTMLButtonElement>(),menuAnchor=shallowRef<HTMLElement|null>(null)
const identity=computed(()=>{
  props.docs
  return JSON.stringify((props.manager?.openedDocuments || props.docs).map(doc=>({id:doc.id,name:doc.name,path:doc.path})))
})
const labels=computed(()=>tabLabels(JSON.parse(identity.value) as TabIdentity[]))
const openItems=computed(()=>{
  const documents=new Map(props.docs.map(doc=>[doc.id,doc]))
  const ids=props.manager?.paneGroup(props.pane).recentDocumentIds || props.docs.map(doc=>doc.id)
  return ids.flatMap(id=>{const doc=documents.get(id);return doc ? [{id,label:labels.value.get(id)||doc.name,name:doc.name,detail:readablePath(doc.path),dirty:doc.dirty||!doc.path}] : []})
})
function closeFiles(restore:boolean){const anchor=menuAnchor.value;menuAnchor.value=null;if(restore&&anchor?.isConnected)anchor.focus()}
function selectTab(id:string){
  emit('select-tab',id)
  void nextTick(()=>{if(props.manager?.activePane===props.pane&&props.manager.activeId===id)props.manager.focusPane(props.pane)})
}
function selectFromMenu(id:string){closeFiles(false);selectTab(id)}
function closeTab(id:string){
  emit('close-tab',id)
  void nextTick(()=>{
    const m=props.manager
    if(m?.activePane===props.pane&&!m.paneGroup(props.pane).tabs.some(tab=>tab.documentId===id)&&document.activeElement===document.body&&!menuAnchor.value)m.focusPane(props.pane)
  })
}
let observer: ResizeObserver | undefined

const isDragInsertingBefore = (docId: string) => {
  const insert = tabDragService.activeTabInsert.value
  return !!(insert && insert.paneId === props.pane && insert.targetDocId === docId && insert.position === 'before')
}

const isDragInsertingAfter = (docId: string) => {
  const insert = tabDragService.activeTabInsert.value
  return !!(insert && insert.paneId === props.pane && insert.targetDocId === docId && insert.position === 'after')
}

function onTabPointerDown(event: PointerEvent, doc: EditorDocument) {
  if ((event.target as HTMLElement).closest('.tinyclose') || event.button !== 0) return
  tabDragService.startWatching(
    event,
    {
      documentId: doc.id,
      fromPaneId: props.pane,
      documentName: doc.name,
    },
    result => {
      const manager = props.manager
      if (!manager) return
      if(result.payload.kind==='file')return
      const { documentId, fromPaneId, isCopy } = result.payload
      let transferred = false
      // A release outside the window with no in-window target detaches the tab
      // into a new native window instead of dropping it nowhere.
      if (result.outside && !result.paneDrop && !result.tabInsert) {
        if(isCopy){window.dispatchEvent(new CustomEvent('editor-notice',{detail:'跨窗口请释放复制修饰键后移动标签；副本视图可在当前窗口分栏。'}));return}
        requestDetachToWindow(documentId, fromPaneId, result.outside)
        return
      }
      if (result.paneDrop) {
        const { paneId, zone } = result.paneDrop
        transferred = manager.transferTab(documentId, fromPaneId, paneId, {
          copy: isCopy,
          direction: zone === 'center' ? undefined : zone,
        })
      } else if (result.tabInsert) {
        const { paneId, targetDocId, position } = result.tabInsert
        const targetGroup = manager.layout.getPane(paneId)?.group
        let targetIdx = targetGroup ? targetGroup.tabs.findIndex(t => t.documentId === targetDocId) : -1
        if (targetIdx >= 0 && position === 'after') targetIdx += 1
        transferred = manager.transferTab(documentId, fromPaneId, paneId, {
          copy: isCopy,
          targetIndex: targetIdx >= 0 ? targetIdx : targetGroup?.tabs.length,
        })
      }
      if (transferred) void nextTick(() => manager.focusPane(manager.activePaneId))
    }
  )
}

async function revealActiveTab() {
  await nextTick()
  const container = tabs.value
  const active = Array.from(container?.querySelectorAll<HTMLElement>('.tab') || []).find(tab => tab.dataset.document === props.activeId)
  if (!container || !active) return
  const bounds = container.getBoundingClientRect(), rect = active.getBoundingClientRect()
  if (rect.left < bounds.left + 8) container.scrollLeft += rect.left - bounds.left - 8
  else if (rect.right > bounds.right - 8) container.scrollLeft += rect.right - bounds.right + 8
}

function scrollTabs(event: WheelEvent) {
  const container = tabs.value
  if (!container || event.ctrlKey || event.metaKey || event.deltaX || !event.deltaY || container.scrollWidth <= container.clientWidth) return
  const amount = event.deltaY * (event.deltaMode === 1 ? 26 : event.deltaMode === 2 ? container.clientWidth : 1)
  container.scrollLeft += amount
  event.preventDefault()
}

// Focus and cursor updates also refresh document metadata. Compare the values
// separately so those updates cannot scroll the old active tab under a click.
watch([() => props.activeId, () => props.docs.map(doc => doc.id).join('\n')], () => { void revealActiveTab() }, { immediate: true })

onMounted(() => {
  observer = new ResizeObserver(() => { void revealActiveTab() })
  if (tabs.value) observer.observe(tabs.value)
})
onUnmounted(() => { observer?.disconnect();menuAnchor.value=null;tabDragService.cancelForPane(props.pane) })

function openMenu(event: MouseEvent | KeyboardEvent, doc: EditorDocument) {
  const currentIndex = props.docs.findIndex(d => d.id === doc.id)
  const hasMultiple = props.docs.length > 1
  const hasRightTabs = currentIndex >= 0 && currentIndex < props.docs.length - 1
  const isSplit = !!props.split
  const otherPanes = props.manager ? props.manager.layout.getAllLeafIds().filter(id => id !== props.pane) : []

  const commands = [
    { id: 'tab-close', title: '关闭', enabled: true, run: () => closeTab(doc.id) },
    { id: 'tab-close-others', title: '关闭其他标签', enabled: hasMultiple, run: () => emit('close-others', doc.id) },
    { id: 'tab-close-right', title: '关闭右侧标签', enabled: hasRightTabs, run: () => emit('close-right', doc.id) },
    { id: 'tab-close-all', title: '关闭全部标签', enabled: props.docs.length > 0, run: () => emit('close-all') },

    doc.pinned
      ? { id: 'tab-unpin', title: '取消固定', enabled: !doc.dirty, run: () => emit('unpin-tab', doc.id) }
      : { id: 'tab-pin', title: '固定标签', enabled: true, run: () => emit('pin-tab', doc.id) },

    { id: 'tab-open-copy-right', title: '在右侧分栏打开副本', enabled: true, run: () => emit('split-tab', { id: doc.id, direction: 'right', duplicate: true }) },
    { id: 'tab-open-copy-down', title: '在下方分栏打开副本', enabled: true, run: () => emit('split-tab', { id: doc.id, direction: 'bottom', duplicate: true }) },
    { id: 'tab-move-right', title: '移动到右侧分栏', enabled: true, run: () => emit('split-tab', { id: doc.id, direction: 'right', duplicate: false }) },
    { id: 'tab-move-down', title: '移动到下方分栏', enabled: true, run: () => emit('split-tab', { id: doc.id, direction: 'bottom', duplicate: false }) },

    { id: 'tab-split-left', title: '向左拆分', enabled: true, run: () => emit('split-tab', { id: doc.id, direction: 'left', duplicate: false }) },
    { id: 'tab-split-up', title: '向上拆分', enabled: true, run: () => emit('split-tab', { id: doc.id, direction: 'top', duplicate: false }) },

    { id: 'tab-move-other', title: '移动到另一分栏', enabled: isSplit, run: () => emit('move-other', doc.id) },
    {
      id: 'tab-detach-window',
      title: '移动到新窗口',
      enabled: props.desktop,
      run: () => requestDetachToWindow(doc.id, props.pane, defaultDetachDropPoint()),
    },
    ...otherPanes.map(targetPaneId => ({
      id: `tab-move-to-${targetPaneId}`,
      title: `移动到分栏 (${targetPaneId})`,
      enabled: true,
      run: () => emit('move-pane', { id: doc.id, toPane: targetPaneId })
    })),

    { id: 'tab-close-pane', title: '关闭当前分栏', enabled: isSplit, run: () => emit('close-pane') },
    { id: 'tab-merge-splits', title: '合并全部分栏', enabled: isSplit, run: () => emit('merge-splits') },

    { id: 'tab-copy-path', title: '复制文件完整路径', enabled: !!doc.path, run: () => textClipboard.writeText(readablePath(doc.path)) },
    { id: 'tab-copy-relative', title: '复制文件相对路径', enabled: !!doc.path, run: () => {
      textClipboard.writeText(displayFilePath(doc.path,props.rootPath?{rootPath:props.rootPath,name:''}:null))
    }},
    { id: 'tab-reveal-explorer', title: '在系统文件管理器中显示', enabled: !!doc.fileToken && props.desktop, run: () => {
      if (doc.fileToken) emit('reveal-in-explorer', doc.fileToken)
    }},
  ]

  const registry = new CommandRegistry(commands)

  const otherSplits: MenuNode[] = [
    cmd('tab-split-left'),
    cmd('tab-split-up'),
  ]

  const menuNodes: MenuNode[] = [
    cmd('tab-close'),
    cmd('tab-close-others'),
    cmd('tab-close-right'),
    cmd('tab-close-all'),
    separator('tab-close-section'),
    cmd(doc.pinned ? 'tab-unpin' : 'tab-pin'),
    separator('tab-pin-section'),
    cmd('tab-open-copy-right'),
    cmd('tab-open-copy-down'),
    cmd('tab-move-right'),
    cmd('tab-move-down'),
    { type: 'submenu', id: 'tab-split-other-submenu', label: '其他方向拆分', children: otherSplits },
    ...(otherPanes.length > 1
      ? [{
          type: 'submenu' as const,
          id: 'tab-move-submenu',
          label: '移动到已有分栏',
          children: otherPanes.map(pid => cmd(`tab-move-to-${pid}`))
        }]
      : isSplit ? [cmd('tab-move-other')] : []),
    cmd('tab-close-pane'),
    cmd('tab-merge-splits'),
    separator('tab-layout-section'),
    cmd('tab-detach-window'),
    separator('tab-window-section'),
    cmd('tab-copy-path'),
    cmd('tab-copy-relative'),
    cmd('tab-reveal-explorer'),
  ]

  contextMenu.value?.open(event, menuNodes, registry, '标签操作')
}

</script>

<style scoped>
.external-mark{background:none;border:0;color:var(--yellow);padding:0 3px;cursor:pointer}.external-mark:focus-visible{outline:2px solid var(--accent)}
.tabs {
  height: calc(var(--ui-font-size) + 26px);
  background: var(--bar);
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--line);
  padding: 0 8px;
  min-width: 0;
  gap: 2px;
  flex: none;
  position: relative;
}
.tabs-scroll{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;height:100%;scrollbar-width:none}
.tabs-scroll::-webkit-scrollbar { display:none }

.tablist {
  width: max-content;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 100%;
  overflow: visible;
}

.tab {
  flex: none;
  touch-action: none;
  height: var(--ui-control-height);
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  color: var(--muted);
  font-size: var(--ui-font-size);
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.12s,color 0.12s,border-color 0.12s;
  white-space: nowrap;
  position: relative;
  user-select: none;
}

.tab:hover {
  background: var(--hover);
  color: var(--ink);
}

.tab.active {
  background: var(--editor);
  color: var(--bright);
  border-color: var(--line);
}

.tab.is-dragging {
  opacity: 0.4;
}

.tab.temp .filename {
  font-style: italic;
}

.tab.temp:has(.is-unsaved) .filename {
  font-style: normal;
}

.tab.drop-before::before {
  content: '';
  position: absolute;
  left: -2px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--accent);
  border-radius: 1px;
}

.tab.drop-after::after {
  content: '';
  position: absolute;
  right: -2px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--accent);
  border-radius: 1px;
}

.filename {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.unsaved {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--yellow);
  flex: none;
  visibility: hidden;
}
.unsaved.is-unsaved{visibility:visible}
.tab > .tinyclose{opacity:0}.tab:hover > .tinyclose,.tab.active > .tinyclose,.tab:focus-within > .tinyclose{opacity:1}

.tinyclose {
  width: var(--ui-row-height);
  height: var(--ui-row-height);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--ui-small-font-size);
  color: var(--muted);
  border: none;
  background: transparent;
  cursor: pointer;
}
.tinyclose:hover {
  background: var(--line);
  color: var(--bright);
}

.newtab {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  flex: none;
  margin-left: 2px;
}
.newtab:hover {
  background: var(--hover);
  color: var(--bright);
}

</style>
