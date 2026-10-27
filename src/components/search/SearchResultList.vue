<template>
  <div ref="list" class="global-search-results" role="listbox" aria-label="搜索结果" tabindex="0" :aria-activedescendant="visibleRows.some(row=>row.id===activeId) ? domId(activeId) : undefined" @scroll="scrollTop=($event.target as HTMLElement).scrollTop" @keydown="keydown">
    <div :style="{height:`${windowed.before}px`}" aria-hidden="true"></div>
    <div v-for="row in visibleRows" :key="row.id" class="search-result-row">
      <div v-if="row.kind==='file'" class="search-result-file" :title="row.group.path" @dblclick="$emit('open',row.group.matches[0],'pinned')">
        <input v-if="replacement" type="checkbox" :aria-label="`选择文件 ${row.group.relativePath}`" :checked="row.group.matches.every(match=>selected.has(searchMatchId(match)))" :indeterminate="row.group.matches.some(match=>selected.has(searchMatchId(match)))&&!row.group.matches.every(match=>selected.has(searchMatchId(match)))" @change="$emit('select-file',row.group,($event.target as HTMLInputElement).checked)" />
        <button class="search-file-toggle" :aria-expanded="row.group.isExpanded" @click="row.group.isExpanded=!row.group.isExpanded"><Icon :name="row.group.isExpanded?'chevron-down':'chevron-right'" size="small" /><FileIcon :name="basename(row.group.relativePath)" /><strong>{{basename(row.group.relativePath)}}</strong><span class="search-file-path">{{dirname(row.group.relativePath)}}</span><span class="search-file-count">{{row.group.matches.length}}</span></button>
      </div>
      <div v-else :id="domId(row.id)" role="option" :aria-selected="activeId===row.id" class="search-hit" :class="{selected:activeId===row.id}" :title="`${row.match.relative_path}:${row.match.line_number}:${row.match.column_number}`" @click="select(row.match)" @dblclick="$emit('open',row.match,'pinned')" @contextmenu.prevent="$emit('context',row.match,$event)">
        <input v-if="replacement" type="checkbox" :checked="selected.has(row.id)" :aria-label="`选择 ${row.match.relative_path}:${row.match.line_number}:${row.match.column_number}`" @click.stop @change="$emit('toggle',row.match)" />
        <span class="search-hit-line">{{row.match.line_number}}</span><code><span>{{parts(row.match)[0]}}</span><mark v-if="row.match.match_length">{{parts(row.match)[1]}}</mark><span v-else class="search-zero-match" aria-label="零宽匹配"></span><span>{{parts(row.match)[2]}}</span></code>
      </div>
    </div>
    <div :style="{height:`${windowed.after}px`}" aria-hidden="true"></div>
  </div>
</template>
<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue'
import type {FileSearchGroup} from '../../features/workspace/WorkspaceController'
import type {SearchMatch} from '../../features/workspace/contracts'
import {searchMatchId} from '../../features/workspace/searchModel'
import {treeWindow} from '../../features/workspace/virtualTree'
import Icon from '../common/Icon.vue'
import FileIcon from '../common/FileIcon.vue'
const props=defineProps<{groups:FileSearchGroup[];sort:'path'|'name'|'count';activeId:string;replacement:boolean;selected:Set<string>}>()
const emit=defineEmits<{
  (e:'select',match:SearchMatch):void;(e:'open',match:SearchMatch,mode:'preview'|'pinned'|'split'):void
  (e:'context',match:SearchMatch,event:MouseEvent):void;(e:'toggle',match:SearchMatch):void;(e:'select-file',group:FileSearchGroup,checked:boolean):void
}>()
const list=ref<HTMLElement>(),scrollTop=ref(0),height=ref(200)
const basename=(path:string)=>path.split(/[\\/]/).pop()||path
const dirname=(path:string)=>path.slice(0,-basename(path).length).replace(/[\\/]$/,'')
const groups=computed(()=>[...props.groups].sort((a,b)=>props.sort==='count'?b.matches.length-a.matches.length||a.relativePath.localeCompare(b.relativePath):props.sort==='name'?basename(a.relativePath).localeCompare(basename(b.relativePath))||a.relativePath.localeCompare(b.relativePath):a.relativePath.localeCompare(b.relativePath,undefined,{numeric:true})))
type Row={kind:'file';id:string;group:FileSearchGroup}|{kind:'hit';id:string;match:SearchMatch}
const rows=computed(()=>groups.value.flatMap<Row>(group=>[{kind:'file',id:'file:'+group.path,group},...group.isExpanded?[...group.matches].sort((a,b)=>a.line_number-b.line_number||a.column_number-b.column_number).map(match=>({kind:'hit' as const,id:searchMatchId(match),match})):[]]))
const windowed=computed(()=>treeWindow(rows.value.length,scrollTop.value,height.value,28))
const visibleRows=computed(()=>rows.value.slice(windowed.value.start,windowed.value.start+windowed.value.count))
function domId(id:string){return 'global-hit-'+encodeURIComponent(id)}
function parts(match:SearchMatch){const start=Math.min(match.line_text.length,match.snippet_column??match.column_number-1);return [match.line_text.slice(0,start),match.line_text.slice(start,start+match.match_length),match.line_text.slice(start+match.match_length)]}
function select(match:SearchMatch){list.value?.focus({preventScroll:true});emit('select',match)}
function keydown(event:KeyboardEvent){
  if(event.isComposing||event.keyCode===229||(event.target as HTMLElement).closest('button,input'))return
  const hits=rows.value.filter((row):row is Extract<Row,{kind:'hit'}>=>row.kind==='hit')
  const current=hits.findIndex(row=>row.id===props.activeId)
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?hits.length-1:Math.max(0,Math.min(hits.length-1,current+(event.key==='ArrowDown'?1:-1)))
    const hit=hits[index];if(!hit)return;emit('select',hit.match)
    const row=rows.value.findIndex(row=>row.id===hit.id),top=row*28
    if(list.value&&(top<list.value.scrollTop||top+28>list.value.scrollTop+height.value))list.value.scrollTop=Math.max(0,top-height.value/2)
  }else if(event.key==='Enter'&&current>=0){event.preventDefault();emit('open',hits[current].match,event.ctrlKey||event.metaKey?'pinned':'preview')}
}
let observer:ResizeObserver|undefined
onMounted(()=>{if(list.value){height.value=list.value.clientHeight;observer=new ResizeObserver(entries=>height.value=entries[0].contentRect.height);observer.observe(list.value)}})
onUnmounted(()=>observer?.disconnect())
</script>
<style scoped>
.global-search-results{height:100%;overflow:auto;outline:none;font-size:var(--ui-small-font-size);contain:strict}.global-search-results:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}.search-result-row,.search-result-file,.search-hit{height:28px;box-sizing:border-box}.search-result-file{display:flex;align-items:center;gap:5px;background:var(--soft);padding:0 10px}.search-file-toggle{display:flex;align-items:center;gap:7px;min-width:0;width:100%;height:100%;color:var(--ink);text-align:left}.search-file-toggle strong{flex:none;font-weight:600}.search-file-path{color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.search-file-count{color:var(--sub);padding:0 5px}.search-hit{display:flex;gap:7px;align-items:center;padding:0 12px;cursor:pointer}.search-hit:hover{background:var(--hover)}.search-hit.selected{background:var(--accentbg);box-shadow:inset 3px 0 var(--accent)}.search-hit-line{text-align:right;color:var(--muted);min-width:42px;font-variant-numeric:tabular-nums}.search-hit code{font-family:var(--font-mono);white-space:pre;overflow:hidden;text-overflow:ellipsis;min-width:0}.search-hit mark{color:inherit;background:color-mix(in srgb,var(--accent) 28%,transparent);text-decoration:underline;text-underline-offset:3px}.search-zero-match{display:inline-block;border-left:2px solid var(--accent);height:1em;vertical-align:text-bottom}
</style>
