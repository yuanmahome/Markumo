<template>
  <span ref="host" class="document-stats">
    <button ref="trigger" class="stats-trigger" :aria-expanded="open" aria-haspopup="dialog" @click="open=!open">{{ failure || (busy ? '统计中…' : summary) }}</button>
    <Teleport to="body">
      <div v-if="open" ref="panel" class="stats-panel" role="dialog" aria-label="文档统计" :style="position" @keydown.esc.stop.prevent="close(true)">
        <select :value="kind" aria-label="状态栏统计类型" @change="emit('change',($event.target as HTMLSelectElement).value as StatisticKind)">
          <option v-for="(label,key) in labels" :key="key" :value="key">{{ label }}</option>
        </select>
        <p v-if="busy" role="status">正在计算当前版本…</p>
        <dl v-else><template v-for="row in rows" :key="row[0]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template></dl>
        <small>按源码统计，含 Markdown 标记。字符按 Unicode 字素计；字数为汉字数与其他语言词数之和。每分钟 300 字。</small>
      </div>
    </Teleport>
  </span>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { Text } from '@codemirror/state'
import type { DocumentManager } from '../../editor/core/DocumentManager'
import { combine, type Counts, type StatisticKind } from './counts'
const props=defineProps<{manager:DocumentManager;id:string;kind:StatisticKind}>()
const emit=defineEmits<{(e:'change',kind:StatisticKind):void}>()
const labels={words:'字数',characters:'字符数',lines:'行数',english:'英文单词数',reading:'阅读时间'}
const trigger=ref<HTMLButtonElement>(),host=ref<HTMLElement>(),panel=ref<HTMLElement>(),open=ref(false),busy=ref(true),result=ref<Counts>(),selection=ref<Counts>(),lines=ref(1)
const failure=ref('')
const position=ref({right:'8px',bottom:'32px'})
const cache=new WeakMap<Text,Counts>()
let worker:Worker|undefined,generation=0,stop:(()=>void)|undefined,snapshot:Text|undefined,selected:Text|undefined,lastSelection='',timer:ReturnType<typeof setTimeout>|undefined
const number=(value:number|undefined)=>(value||0).toLocaleString()
const minutes=computed(()=>Math.ceil((result.value?.words||0)/300))
const summary=computed(()=>props.kind==='reading'?`${minutes.value} 分钟`:props.kind==='lines'?`${number(lines.value)} 行`:props.kind==='characters'?`${number(result.value?.characters)} 字符`:props.kind==='english'?`${number(result.value?.english)} 单词`:`${number(result.value?.words)} 字`)
const rows=computed(()=>[['字数',number(result.value?.words)],['字符（含空格）',number(result.value?.characters)],['字符（不含空白）',number(result.value?.nonSpace)],['中文汉字',number(result.value?.chinese)],['英文单词',number(result.value?.english)],['行数',number(lines.value)],['段落（非空行组）',number(result.value?.paragraphs)],['选区字数',number(selection.value?.words)],['选区字符',number(selection.value?.characters)],['阅读时间',`${minutes.value} 分钟`]])
function leaves(text:Text):Text[]{return text.children?text.children.flatMap(leaves):[text]}
function refresh(){
 const state=props.manager.getState(props.id);if(!state)return
 const range=state.selection.main,key=`${range.from}:${range.to}`
 if(state.doc===snapshot&&key===lastSelection)return
 snapshot=state.doc;lastSelection=key;selected=state.doc.slice(range.from,range.to);lines.value=state.doc.lines
 failure.value='';busy.value=true;worker?.terminate();if(timer)clearTimeout(timer)
 const revision=++generation,current=snapshot,chosen=selected
 timer=setTimeout(()=>{
  const all=leaves(current),selectionLeaves=leaves(chosen),jobs=[...new Set([...all,...selectionLeaves])].filter(leaf=>!cache.has(leaf))
  function done(){if(generation!==revision)return;result.value=combine(all.map(leaf=>cache.get(leaf)!));selection.value=combine(selectionLeaves.map(leaf=>cache.get(leaf)!));busy.value=false;worker?.terminate();worker=undefined}
  if(!jobs.length){done();return}
  worker=new Worker(new URL('./counts.worker.ts',import.meta.url),{type:'module'})
  let index=0
  worker.onerror=()=>{if(generation===revision){failure.value='统计失败';worker?.terminate();worker=undefined}}
  worker.onmessage=event=>{if(event.data.generation!==generation)return;cache.set(jobs[event.data.index],event.data.counts);index++;if(index===jobs.length)done();else worker?.postMessage({generation:revision,index,text:jobs[index].toString()})}
  worker.postMessage({generation:revision,index,text:jobs[0].toString()})
 },150)
}
function close(focus=false){open.value=false;if(focus)trigger.value?.focus()}
function outside(event:PointerEvent){if(!host.value?.contains(event.target as Node)&&!panel.value?.contains(event.target as Node))close()}
function escape(event:KeyboardEvent){if(event.key==='Escape'&&open.value){event.preventDefault();close(true)}}
watch(open,async value=>{if(value){const box=trigger.value?.getBoundingClientRect();if(box)position.value={right:`${Math.max(8,innerWidth-box.right)}px`,bottom:`${innerHeight-box.top+8}px`};await nextTick();panel.value?.querySelector('select')?.focus()}})
watch(()=>props.id,()=>{close();snapshot=undefined;refresh()})
onMounted(()=>{stop=props.manager.subscribe(refresh);refresh();document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape)})
onUnmounted(()=>{stop?.();generation++;worker?.terminate();if(timer)clearTimeout(timer);snapshot=selected=undefined;document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)})
</script>
<style scoped>
.stats-trigger { border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 4px; }
.stats-trigger:hover { background:var(--hover); }
.stats-panel { position:fixed;z-index:1000;box-sizing:border-box;width:min(290px,calc(100vw - 16px));max-height:calc(100vh - 64px);overflow:auto;padding:14px;background:var(--bar);color:var(--ink);border:1px solid var(--line);border-radius:6px;box-shadow:0 4px 20px #0003;font-size:13px; }
dl { display:grid;grid-template-columns:1fr auto;gap:8px;margin:14px 0; }dd { margin:0; }small {color:var(--muted);line-height:1.6;}select {width:100%;color:inherit;background:var(--editor);border:1px solid var(--line);padding:4px;}
</style>
