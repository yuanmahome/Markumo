<template>
  <Teleport to="body">
    <div class="global-search-backdrop" :class="{pinned:workspace.searchWindow.pinned}" @pointerdown.self="close">
      <section ref="dialog" class="global-search-dialog" role="dialog" :aria-modal="!workspace.searchWindow.pinned" aria-label="全局搜索与替换" :style="geometry" @keydown="keydown">
        <header class="global-search-title" @pointerdown="beginGeometry($event,'move')">
          <strong>{{workspace.replaceExpanded?'在文件中替换':'在文件中查找'}}</strong><span class="global-search-stat" role="status">{{statistics}}</span>
          <button class="ib" :aria-pressed="workspace.searchWindow.pinned" :title="workspace.searchWindow.pinned?'取消固定搜索窗口':'固定搜索窗口，允许编辑器获取焦点'" aria-label="固定搜索窗口" @pointerdown.stop @click="workspace.searchWindow.pinned=!workspace.searchWindow.pinned;workspace.persistSearchMetadata()"><Icon name="pin" /></button>
          <button class="ib" aria-label="关闭全局搜索" title="关闭 (Esc)" @pointerdown.stop @click="close"><Icon name="close" /></button>
        </header>
        <div class="global-search-inputs">
          <div class="global-query-row">
            <button class="ib" :disabled="workspace.replaceApplying" :aria-expanded="workspace.replaceExpanded" aria-label="切换替换模式" @click="workspace.replaceExpanded=!workspace.replaceExpanded"><Icon :name="workspace.replaceExpanded?'chevron-down':'chevron-right'" /></button>
            <Icon name="search" size="small" />
            <input ref="queryInput" v-model="workspace.searchQuery" class="global-query-input" aria-label="全局搜索文本" placeholder="搜索文本" :disabled="workspace.replaceApplying" autocomplete="off" spellcheck="false" @input="changed" @keydown="queryKey" @compositionstart="startComposition" @compositionend="endComposition(true)" />
            <button class="ib" aria-label="清空搜索" :disabled="workspace.replaceApplying||!workspace.searchQuery" @click="workspace.searchQuery='';changed()"><Icon name="close" size="small" /></button>
            <button class="query-option" :aria-pressed="workspace.isCaseSensitive" :disabled="workspace.replaceApplying" title="区分大小写" @click="workspace.isCaseSensitive=!workspace.isCaseSensitive;changed()">Aa</button>
            <button class="query-option" :aria-pressed="workspace.isWholeWord" :disabled="workspace.replaceApplying" title="全词匹配" @click="workspace.isWholeWord=!workspace.isWholeWord;changed()">W</button>
            <button class="query-option" :aria-pressed="workspace.isRegex" :disabled="workspace.replaceApplying" title="正则表达式（Rust regex，按行匹配，不支持跨行正则）" @click="workspace.isRegex=!workspace.isRegex;changed()">.*</button>
            <details class="search-history"><summary aria-label="搜索历史">历史</summary><div class="search-history-popup"><button v-for="query in workspace.searchHistory" :key="query" :title="query" @click="useHistory(query,false,$event)">{{query}}</button><span v-if="!workspace.searchHistory.length">暂无历史</span><button @click="workspace.clearSearchHistory()">清空搜索历史</button></div></details>
          </div>
          <div class="global-query-notice" :class="{error:workspace.searchStatus==='error'}" role="status">{{workspace.searchMessage || (workspace.isRegex?'按行匹配；不支持跨行正则。捕获组替换支持 $1、${name}。':'')}}</div>
          <div v-if="workspace.replaceExpanded" class="global-query-row replace-row">
            <span>替换为</span><input ref="replaceInput" v-model="workspace.replacementText" aria-label="全局替换文本" placeholder="留空则删除匹配文本" :disabled="workspace.replaceApplying" autocomplete="off" spellcheck="false" @input="replaceChanged" @compositionstart="startComposition" @compositionend="endComposition(false)" />
            <button class="ib" aria-label="清空替换" :disabled="workspace.replaceApplying||!workspace.replacementText" @click="workspace.replacementText='';replaceChanged()"><Icon name="close" size="small" /></button>
            <details class="search-history"><summary aria-label="替换历史">历史</summary><div class="search-history-popup"><button v-for="value in workspace.replacementHistory" :key="value" :title="value" @click="useHistory(value,true,$event)">{{value}}</button><span v-if="!workspace.replacementHistory.length">暂无历史</span><button @click="workspace.clearSearchHistory(true)">清空替换历史</button></div></details>
          </div>
          <div class="global-search-scope">
            <label>范围 <select v-model="workspace.searchScope" aria-label="搜索范围" :disabled="workspace.replaceApplying" @change="changed"><option value="workspace" :disabled="!workspace.roots.length">全部工作区（{{workspace.roots.length}}）</option><option value="directory" :disabled="!workspace.roots.length">指定目录</option><option value="opened">已打开文件</option></select></label>
            <template v-if="workspace.searchScope==='directory'"><input v-model="workspace.searchDirectory" aria-label="搜索目录" placeholder="已授权工作区内的目录" :disabled="workspace.replaceApplying" @input="changed" @keydown="queryKey" /><button :disabled="workspace.replaceApplying" @click="workspace.chooseSearchDirectory()">选择目录…</button></template>
            <button :aria-expanded="filters" @click="filters=!filters">高级过滤</button>
            <span v-if="workspace.searchIncludeIgnored" class="search-ignored-note">包含忽略文件；替换仍遵守安全忽略规则</span>
          </div>
          <div v-if="filters" class="global-search-filters">
            <label>包含文件<input v-model="workspace.searchInclude" aria-label="包含文件" placeholder="*.md, *.vue, src/**/*.ts" :disabled="workspace.replaceApplying" @input="changed" /></label>
            <label>排除文件<input v-model="workspace.searchExclude" aria-label="排除文件" placeholder="node_modules/**, dist/**, *.min.js" :disabled="workspace.replaceApplying" @input="changed" /></label>
            <label><input type="checkbox" v-model="workspace.searchIncludeIgnored" :disabled="workspace.replaceApplying" @change="changed" />搜索被忽略文件</label>
            <small>逗号分隔标准 Glob：无 / 匹配文件名，有 / 匹配根目录相对路径；** 递归目录。Windows 忽略大小写。不会跟随符号链接。</small>
          </div>
        </div>
        <div class="global-result-tools"><label>排序 <select v-model="workspace.searchSort" aria-label="结果排序"><option value="path">文件路径</option><option value="name">文件名</option><option value="count">匹配数量</option></select></label><button @click="workspace.setSearchExpanded(true)">全部展开</button><button @click="workspace.setSearchExpanded(false)">全部折叠</button><button :disabled="!workspace.searchTotal" @click="copyResults">复制结果</button><button v-if="workspace.searching" @click="workspace.cancelSearch()">取消搜索</button><button v-else :disabled="!workspace.searchQuery||workspace.replaceApplying" @click="runNow">重新搜索</button></div>
        <div ref="body" class="global-search-body">
          <div class="global-results-pane" :style="{flex:workspace.searchWindow.split}">
            <SearchResultList v-if="workspace.searchResults.length" :groups="workspace.searchResults" :sort="workspace.searchSort" :active-id="workspace.selectedMatchId" :replacement="workspace.replaceExpanded" :selected="workspace.selectedMatches" @select="selectMatch" @open="openMatch" @context="resultContext" @toggle="workspace.toggleSearchSelection($event)" @select-file="selectFile" />
            <div v-else class="global-search-empty"><Icon name="search" /><p>{{emptyMessage}}</p><button v-if="!workspace.roots.length" @click="workspace.openWorkspaceDialog()">打开文件夹…</button></div>
          </div>
          <div class="global-preview-resizer" role="separator" aria-label="调整结果与预览高度" aria-orientation="horizontal" tabindex="0" :aria-valuenow="Math.round(workspace.searchWindow.split*100)" @pointerdown="beginSplit" @keydown.up.prevent="resizeSplit(-.05)" @keydown.down.prevent="resizeSplit(.05)"></div>
          <div class="global-preview-pane" :style="{flex:1-workspace.searchWindow.split}">
            <div class="global-preview-head"><span :title="activeMatch?.path">{{showDiff?'替换 Diff 预览':activeMatch?.relative_path||'源码预览'}}</span><button v-if="showDiff" @click="showDiff=false">返回源码预览</button><button v-else :disabled="!workspace.searchPreview" @click="copyPreview">复制预览</button></div>
            <SearchReplacePreview v-if="showDiff" :workspace="workspace" />
            <div v-show="!showDiff" class="global-source-pane" :aria-busy="workspace.searchPreviewLoading">
              <SearchCodePreview v-if="previewStarted" :preview="workspace.searchPreview" @open="activeMatch&&openMatch(activeMatch,'pinned')" />
              <div v-if="workspace.searchPreviewLoading||workspace.searchPreviewError||!workspace.searchPreview" class="global-preview-message" role="status">{{workspace.searchPreviewLoading?'正在读取源码预览…':workspace.searchPreviewError||'单击结果预览源码；双击或 Enter 打开文件'}}</div>
              <div v-if="workspace.searchPreview?.truncated" class="global-preview-budget">预览达到 256 KiB 预算；请打开文件查看完整内容</div>
            </div>
          </div>
        </div>
        <details v-if="workspace.replacementReport.length" class="global-replacement-report"><summary>上次替换报告</summary><p v-for="(entry,index) in workspace.replacementReport" :key="index">{{entry}}</p></details>
        <footer class="global-search-footer"><button :disabled="!activeMatch" @click="activeMatch&&openMatch(activeMatch,'pinned')">在新标签中打开</button><span>{{workspace.selectedMatches.size?`已选 ${workspace.selectedMatches.size} 处`:`${workspace.searchTotal} 处匹配`}}{{workspace.searchSkipped?` · 跳过 ${workspace.searchSkipped} 项`:''}}</span><template v-if="workspace.replaceExpanded"><button :disabled="workspace.replaceBusy||workspace.searching||!activeMatch" @click="previewFile">替换当前文件…</button><button :disabled="workspace.replaceBusy||workspace.searching||!workspace.selectedMatches.size" @click="previewSelected">替换选中…</button><button :disabled="!canReplaceAll" title="先核对 Diff 预览，再应用替换" @click="previewAll">预览替换 / 替换全部…</button></template></footer>
        <div class="global-resize-edge east" @pointerdown="beginGeometry($event,'e')"></div><div class="global-resize-edge south" @pointerdown="beginGeometry($event,'s')"></div><div class="global-resize-edge corner" @pointerdown="beginGeometry($event,'se')"></div>
        <ContextMenu ref="contextMenu" />
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import {computed,defineAsyncComponent,nextTick,onMounted,onUnmounted,ref,watch} from 'vue'
import type {WorkspaceController,FileSearchGroup} from '../../features/workspace/WorkspaceController'
import type {SearchMatch} from '../../features/workspace/contracts'
import {searchMatchId} from '../../features/workspace/searchModel'
import {textClipboard} from '../../features/shell/clipboard'
import {CommandRegistry,menuCommand as cmd,separator} from '../../features/shell/menuModel'
import {eventShortcut} from '../../features/shell/editorSettings'
import {matchingCommand} from '../../features/shell/keybindings'
import SearchResultList from './SearchResultList.vue'
import SearchReplacePreview from './SearchReplacePreview.vue'
import Icon from '../common/Icon.vue'
import ContextMenu from '../common/ContextMenu.vue'
const SearchCodePreview=defineAsyncComponent(()=>import('./SearchCodePreview.vue'))
const props=defineProps<{workspace:WorkspaceController;shortcuts:Record<string,string>}>()
const workspace=props.workspace,dialog=ref<HTMLElement>(),queryInput=ref<HTMLInputElement>(),replaceInput=ref<HTMLInputElement>(),body=ref<HTMLElement>(),contextMenu=ref<InstanceType<typeof ContextMenu>>()
const filters=ref(false),showDiff=ref(false),previewStarted=ref(false),composing=ref(false),viewport=ref({width:window.innerWidth,height:window.innerHeight})
const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
const activeMatch=computed(()=>workspace.searchResults.flatMap(group=>group.matches).find(match=>searchMatchId(match)===workspace.selectedMatchId))
const canReplaceAll=computed(()=>!workspace.replaceBusy&&!workspace.searching&&workspace.searchTotal>0&&workspace.searchStatus==='complete')
const statistics=computed(()=>workspace.searchStatus==='searching'?`正在搜索 · ${workspace.searchTotal} 处`:`在 ${workspace.searchResults.length} 个文件中找到 ${workspace.searchTotal} 处匹配${['limited','partial','canceled','error'].includes(workspace.searchStatus)?'（结果不完整）':''}`)
const emptyMessage=computed(()=>workspace.searchStatus==='error'?workspace.searchMessage:workspace.searching?'正在搜索…':workspace.searchStatus==='empty'?'未找到匹配':workspace.searchStatus==='canceled'?'搜索已取消':!workspace.searchQuery?'输入文本开始搜索':workspace.searchScope==='opened'&&!workspace.textSearchDocuments().length?'没有已打开的文本文件':'等待搜索…')
const geometry=computed(()=>({left:`${workspace.searchWindow.x??Math.max(16,(viewport.value.width-820)/2)}px`,top:`${workspace.searchWindow.y??Math.max(16,viewport.value.height*.08)}px`,width:`${workspace.searchWindow.width}px`,height:`${workspace.searchWindow.height??viewport.value.height*.7}px`}))
function clampGeometry(){
  viewport.value={width:window.innerWidth,height:window.innerHeight}
  const state=workspace.searchWindow,maxWidth=Math.max(240,viewport.value.width-32),maxHeight=Math.max(240,viewport.value.height*.85)
  state.width=Math.max(Math.min(560,maxWidth),Math.min(maxWidth,state.width));state.height=Math.max(Math.min(360,maxHeight),Math.min(maxHeight,state.height??viewport.value.height*.7))
  state.x=Math.max(16,Math.min(viewport.value.width-state.width-16,state.x??(viewport.value.width-state.width)/2));state.y=Math.max(16,Math.min(viewport.value.height-state.height-16,state.y??(viewport.value.height-state.height)*.28));state.split=Math.max(.2,Math.min(.8,state.split))
}
function changed(){if(!composing.value)workspace.scheduleSearch()}
function replaceChanged(){if(!composing.value)workspace.invalidateReplace()}
function startComposition(){composing.value=true;workspace.setSearchComposition(true)}
function endComposition(search:boolean){composing.value=false;workspace.setSearchComposition(false);void nextTick(()=>search?changed():replaceChanged())}
function queryKey(event:KeyboardEvent){if(!event.isComposing&&!composing.value&&event.keyCode!==229&&event.key==='Enter'){event.preventDefault();event.stopPropagation();runNow()}}
function runNow(){if(!composing.value)void workspace.search(workspace.searchQuery)}
function close(){workspace.closeSearchDialog()}
async function focusInput(){await nextTick();(workspace.searchFocusReplace?replaceInput.value:queryInput.value)?.focus();(workspace.searchFocusReplace?replaceInput.value:queryInput.value)?.select()}
watch(()=>workspace.searchFocusRevision,()=>void focusInput())
watch(()=>workspace.selectedMatchId,id=>{if(id)previewStarted.value=true})
watch(()=>workspace.searchResults,()=>{if(workspace.selectedMatchId&&!activeMatch.value)workspace.clearSearchPreview()})
function selectMatch(match:SearchMatch){showDiff.value=false;previewStarted.value=true;void workspace.selectSearchMatch(match)}
function openMatch(match:SearchMatch,mode:'preview'|'pinned'|'split'){void workspace.locateMatch(match,mode)}
function selectFile(group:FileSearchGroup,checked:boolean){for(const match of group.matches){const id=searchMatchId(match);if(checked)workspace.selectedMatches.add(id);else workspace.selectedMatches.delete(id)}}
function useHistory(value:string,replacement:boolean,event:MouseEvent){if(replacement){workspace.replacementText=value;replaceChanged()}else{workspace.searchQuery=value;changed()}(event.target as HTMLElement).closest('details')?.removeAttribute('open');void focusInput()}
async function previewAll(){showDiff.value=true;await workspace.previewReplace()}
async function previewSelected(){showDiff.value=true;await workspace.previewSelectedMatches()}
async function previewFile(){if(activeMatch.value){showDiff.value=true;await workspace.previewReplace(activeMatch.value.path)}}
async function copy(value:string){try{await textClipboard.writeText(value)}catch(error){workspace.searchPreviewError='复制失败：'+String(error)}}
function copyPreview(){if(workspace.searchPreview)void copy(workspace.searchPreview.text)}
function copyResults(){void copy(workspace.searchResults.flatMap(group=>group.matches.filter(match=>!workspace.selectedMatches.size||workspace.selectedMatches.has(searchMatchId(match))).map(match=>`${match.relative_path}:${match.line_number}:${match.column_number}\t${match.line_text}`)).join('\n'))}
function resultContext(match:SearchMatch,event:MouseEvent){
  selectMatch(match)
  const directory=match.path.replace(/[\\/][^\\/]+$/,'')
  const registry=new CommandRegistry([
    {id:'search-open',title:'打开文件',enabled:true,run:()=>openMatch(match,'preview')},{id:'search-pin',title:'在新标签打开',enabled:true,run:()=>openMatch(match,'pinned')},{id:'search-split',title:'在右侧分栏打开',enabled:true,run:()=>openMatch(match,'split')},
    {id:'search-copy-match',title:'复制匹配文本',enabled:match.match_length<=256*1024,run:async()=>{await workspace.selectSearchMatch(match);if(workspace.searchPreview)await copy(workspace.searchPreview.text.slice(workspace.searchPreview.selection_from,workspace.searchPreview.selection_to))}},
    {id:'search-copy-path',title:'复制文件路径',enabled:!!match.path,run:()=>copy(match.path)},{id:'search-copy-relative',title:'复制相对路径',enabled:true,run:()=>copy(match.relative_path)},
    {id:'search-copy-location',title:'复制文件路径:行号:列号',enabled:true,run:()=>copy(`${match.path}:${match.line_number}:${match.column_number}`)},
    {id:'search-reveal',title:'在文件管理器中显示',enabled:workspace.canRevealSearchMatch(match),run:()=>workspace.revealSearchMatch(match)},
    {id:'search-directory',title:'仅在此目录搜索',enabled:!!workspace.rootForPath(match.path),run:()=>workspace.focusWorkspaceSearch(workspace.replaceExpanded,directory)},
  ])
  contextMenu.value?.open(event,[cmd('search-open'),cmd('search-pin'),cmd('search-split'),separator('search-copy'),cmd('search-copy-match'),cmd('search-copy-path'),cmd('search-copy-relative'),cmd('search-copy-location'),separator('search-location'),cmd('search-reveal'),cmd('search-directory')],registry,'搜索结果操作')
}
function keydown(event:KeyboardEvent){
  if(event.isComposing||composing.value||event.keyCode===229)return
  const command=matchingCommand(eventShortcut(event),props.shortcuts,'shell')
  if(command&&['workspace-search','workspace-replace'].includes(command.id)){event.preventDefault();event.stopPropagation();workspace.focusWorkspaceSearch(command.id==='workspace-replace');return}
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return}
  if(event.key==='Tab'&&!workspace.searchWindow.pinned&&dialog.value){
    const elements=[...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(el=>el.getClientRects().length)
    const index=elements.indexOf(document.activeElement as HTMLElement)
    if(event.shiftKey&&index<=0){elements.at(-1)?.focus();event.preventDefault()}else if(!event.shiftKey&&index===elements.length-1){elements[0]?.focus();event.preventDefault()}
  }
}
let drag:{x:number;y:number;left:number;top:number;width:number;height:number;kind:string}|undefined
function beginGeometry(event:PointerEvent,kind:string){if(event.button!==0||kind==='move'&&(event.target as Element).closest('button'))return;event.preventDefault();drag={x:event.clientX,y:event.clientY,left:workspace.searchWindow.x||16,top:workspace.searchWindow.y||16,width:workspace.searchWindow.width,height:workspace.searchWindow.height||500,kind};window.addEventListener('pointermove',moveGeometry);window.addEventListener('pointerup',stopGeometry,{once:true})}
function moveGeometry(event:PointerEvent){if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(drag.kind==='move'){workspace.searchWindow.x=drag.left+dx;workspace.searchWindow.y=drag.top+dy}else{if(drag.kind.includes('e'))workspace.searchWindow.width=drag.width+dx;if(drag.kind.includes('s'))workspace.searchWindow.height=drag.height+dy}clampGeometry()}
function stopGeometry(){drag=undefined;window.removeEventListener('pointermove',moveGeometry);window.removeEventListener('pointerup',stopGeometry);workspace.persistSearchMetadata()}
function resizeSplit(delta:number){workspace.searchWindow.split=Math.max(.2,Math.min(.8,workspace.searchWindow.split+delta));workspace.persistSearchMetadata()}
function beginSplit(event:PointerEvent){if(event.button!==0)return;event.preventDefault();window.addEventListener('pointermove',moveSplit);window.addEventListener('pointerup',stopSplit,{once:true})}
function moveSplit(event:PointerEvent){const rect=body.value?.getBoundingClientRect();if(rect)workspace.searchWindow.split=Math.max(.2,Math.min(.8,(event.clientY-rect.top)/rect.height))}
function stopSplit(){window.removeEventListener('pointermove',moveSplit);window.removeEventListener('pointerup',stopSplit);workspace.persistSearchMetadata()}
onMounted(()=>{clampGeometry();window.addEventListener('resize',clampGeometry);void focusInput()})
onUnmounted(()=>{stopGeometry();stopSplit();window.removeEventListener('resize',clampGeometry);if(workspace.searchRestoreFocus){if(previous?.isConnected)previous.focus({preventScroll:true});else if(workspace.documentManager.activeLiveEditor)workspace.documentManager.activeLiveEditor.focus();else workspace.documentManager.activeEditorView?.focus()}})
</script>
<style scoped>
.global-replacement-report{max-height:130px;overflow:auto;padding:4px 12px;font-size:var(--ui-small-font-size);color:var(--sub)}.global-replacement-report p{margin:3px 0;overflow-wrap:anywhere}

.global-search-backdrop{position:fixed;inset:0;z-index:850;background:color-mix(in srgb,#000 10%,transparent)}.global-search-backdrop.pinned{pointer-events:none;background:none}.global-search-dialog{position:absolute;pointer-events:auto;display:flex;flex-direction:column;max-width:calc(100vw - 32px);max-height:85vh;min-width:0;overflow:hidden;background:var(--editor);color:var(--ink);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 64px #0005;font-size:var(--ui-font-size);box-sizing:border-box}.global-search-title{display:flex;gap:8px;align-items:center;min-height:40px;padding:0 12px;cursor:move;user-select:none;background:var(--bar)}.global-search-title strong{font-weight:600;white-space:nowrap}.global-search-stat{flex:1;text-align:right;color:var(--sub);font-size:var(--ui-small-font-size);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.global-search-inputs{padding:8px 12px 4px}.global-query-row{display:flex;align-items:center;gap:5px;min-height:34px;border:1px solid var(--line);border-radius:6px;padding:0 5px}.global-query-row:focus-within{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.global-query-row input{min-width:0;flex:1;background:transparent;color:var(--ink);border:0;outline:none;font:inherit;padding:5px 2px}.query-option{padding:4px 6px;color:var(--sub);border-radius:3px;flex:none}.query-option[aria-pressed="true"]{background:var(--accentbg);color:var(--accent);box-shadow:inset 0 -2px var(--accent)}.global-query-notice{height:28px;font-size:var(--ui-small-font-size);overflow:auto;color:var(--sub);padding:2px 0;box-sizing:border-box}.global-query-notice.error{color:var(--red,#c95454)}.replace-row{margin-bottom:6px}.replace-row>span{font-size:var(--ui-small-font-size);color:var(--sub);padding:0 6px}.global-search-scope{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:var(--ui-small-font-size);padding:4px 0}.global-search-scope>input{min-width:100px;flex:1;width:100px}.global-search-scope select,.global-result-tools select{max-width:190px}.global-search-dialog select,.global-search-scope>input,.global-search-filters input:not([type="checkbox"]){background:var(--soft);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:4px;font:inherit}.global-search-filters{display:flex;flex-wrap:wrap;gap:6px;font-size:var(--ui-small-font-size);padding:5px 0}.global-search-filters>label{display:flex;align-items:center;gap:5px;min-width:0;flex:1}.global-search-filters input:not([type="checkbox"]){width:0;min-width:100px;flex:1}.global-search-filters small{width:100%;color:var(--sub);line-height:1.5}.search-ignored-note{color:var(--yellow);font-size:var(--ui-small-font-size)}.global-result-tools{display:flex;align-items:center;gap:8px;padding:4px 12px;border-bottom:1px solid var(--line);font-size:var(--ui-small-font-size);flex-wrap:wrap}.global-result-tools button{padding:3px 5px;color:var(--sub)}.global-search-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.global-results-pane,.global-preview-pane{min-height:0;overflow:hidden}.global-search-empty{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;color:var(--sub);gap:8px;font-size:var(--ui-small-font-size)}.global-preview-resizer{height:5px;background:var(--line);cursor:row-resize;flex:none}.global-preview-resizer:hover{background:var(--accent)}.global-preview-pane{display:flex;flex-direction:column}.global-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 12px;min-height:24px;background:var(--soft);font-size:var(--ui-small-font-size)}.global-preview-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.global-preview-head button{flex:none}.global-source-pane{position:relative;flex:1;min-height:0;overflow:hidden}.global-preview-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--editor);color:var(--sub);padding:16px;text-align:center;overflow:auto;font-size:var(--ui-small-font-size)}.global-preview-budget{position:absolute;bottom:0;right:8px;background:var(--soft);color:var(--yellow);font-size:var(--ui-small-font-size);padding:3px 6px}.global-search-footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-height:38px;padding:5px 12px;border-top:1px solid var(--line);font-size:var(--ui-small-font-size)}.global-search-footer>span{flex:1;color:var(--sub)}.global-search-footer button,.global-search-empty button{background:var(--soft);padding:5px 8px;border-radius:4px}.global-search-footer button:last-child:not(:first-child){background:var(--accentbg);color:var(--accent)}.search-history{position:relative;font-size:var(--ui-small-font-size);flex:none}.search-history summary{cursor:pointer;padding:5px;color:var(--sub)}.search-history-popup{position:absolute;right:0;top:100%;z-index:9;display:grid;background:var(--editor);box-shadow:0 5px 24px #0004;border:1px solid var(--line);border-radius:6px;min-width:200px;max-width:380px;max-height:220px;overflow:auto;padding:4px}.search-history-popup button{text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:6px}.search-history-popup button:hover{background:var(--hover)}.global-resize-edge{position:absolute;touch-action:none}.east{right:0;top:40px;bottom:10px;width:5px;cursor:ew-resize}.south{bottom:0;left:10px;right:10px;height:5px;cursor:ns-resize}.corner{bottom:0;right:0;width:13px;height:13px;cursor:nwse-resize}.global-search-dialog button:focus-visible,.global-search-dialog summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.global-search-dialog button:disabled{opacity:.45;cursor:default}@media(max-width:600px){.global-search-stat{display:none}.global-search-inputs{padding:6px}.global-query-row{gap:2px}.global-search-footer{gap:4px}.global-search-filters>label{flex-basis:100%}}
</style>
