<template><div class="search-preview-wrapper"><div v-if="languageError" class="search-language-notice" role="status">语法高亮不可用，显示纯文本</div><div class="search-code-preview" ref="host" data-search-preview-editor @dblclick="$emit('open')"></div></div></template>
<script setup lang="ts">
import {onMounted,onUnmounted,ref,watch} from 'vue'
import {Compartment,EditorState} from '@codemirror/state'
import {Decoration,EditorView,lineNumbers,highlightActiveLine} from '@codemirror/view'
import {syntaxHighlighting,defaultHighlightStyle} from '@codemirror/language'
import {detectLanguage,loadLanguage} from '../../editor/languages'
import type {SearchSourcePreview} from '../../features/workspace/contracts'
const props=defineProps<{preview:SearchSourcePreview|null}>()
defineEmits<{(e:'open'):void}>()
const host=ref<HTMLElement>();let view:EditorView|undefined,epoch=0
const languageError=ref(false)
const language=new Compartment(),marks=new Compartment(),numbers=new Compartment()
async function update(){
  const current=++epoch
  if(!view)return
  const preview=props.preview
  languageError.value=false
  view.dispatch({effects:language.reconfigure([])})
  if(!preview){view.dispatch({changes:{from:0,to:view.state.doc.length,insert:''},effects:marks.reconfigure([])});return}
  const ranges=preview.hits.filter(hit=>hit.to>hit.from&&hit.to<=preview.text.length).map(hit=>Decoration.mark({class:'cm-global-search-hit'}).range(hit.from,hit.to))
  if(preview.selection_to>preview.selection_from)ranges.push(Decoration.mark({class:'cm-global-search-current'}).range(preview.selection_from,preview.selection_to))
  view.dispatch({changes:{from:0,to:view.state.doc.length,insert:preview.text},selection:{anchor:preview.selection_from,head:preview.selection_to},effects:[marks.reconfigure(EditorView.decorations.of(Decoration.set(ranges,true))),numbers.reconfigure(lineNumbers({formatNumber:number=>String(number+preview.start_line-1)})),EditorView.scrollIntoView(preview.selection_from,{y:'center'})]})
  try{const support=await loadLanguage(detectLanguage(preview.path),'fence');if(current===epoch&&view)view.dispatch({effects:language.reconfigure(support)})}
  catch{if(current===epoch)languageError.value=true}
}
onMounted(()=>{if(!host.value)return;view=new EditorView({parent:host.value,state:EditorState.create({extensions:[EditorState.readOnly.of(true),EditorView.editable.of(false),syntaxHighlighting(defaultHighlightStyle,{fallback:true}),highlightActiveLine(),language.of([]),marks.of([]),numbers.of([]),EditorView.contentAttributes.of({'aria-label':'搜索源码预览',spellcheck:'false',tabindex:'0'}),EditorView.theme({'&':{height:'100%',background:'var(--editor)',color:'var(--ink)'},'.cm-scroller':{fontFamily:'var(--font-mono)',fontSize:'var(--editor-font-size,13px)'},'.cm-content':{padding:'8px 0'},'.cm-gutters':{background:'var(--soft)',color:'var(--muted)',borderRight:'none'},'.cm-global-search-hit':{background:'color-mix(in srgb,var(--accent) 24%,transparent)',textDecoration:'underline'},'.cm-global-search-current':{fontWeight:'600',outline:'1px solid var(--accent)',outlineOffset:'-1px'},'.cm-selectionBackground':{background:'var(--accentbg) !important'}})]})});void update()})
watch(()=>props.preview,()=>void update())
onUnmounted(()=>{++epoch;view?.destroy();view=undefined})
</script>
<style scoped>.search-preview-wrapper{height:100%;display:flex;flex-direction:column}.search-language-notice{font-size:var(--ui-small-font-size);color:var(--sub);padding:3px 10px}.search-code-preview{flex:1;min-height:0;overflow:hidden}</style>
