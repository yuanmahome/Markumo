import {ref,nextTick,onUnmounted} from 'vue'
import {isTauri,invoke} from '@tauri-apps/api/core'
import {getCurrentWindow} from '@tauri-apps/api/window'
import {EditorView} from '@codemirror/view'
import {Transaction} from '@codemirror/state'
import type {DocumentManager} from '../../editor/core/DocumentManager'

type ScrollSnapshot={el:HTMLElement;top:number;left:number;view?:EditorView;effect?:ReturnType<EditorView['scrollSnapshot']>;doc?:EditorView['state']['doc'];range?:Range;inset?:number;caretVisible?:boolean;caret?:Range}
function captureScroll():ScrollSnapshot[]{
 const items:ScrollSnapshot[]=[]
 for(const el of document.querySelectorAll<HTMLElement>('.pane .cm-scroller,.pane .markdown-live')){
  const item:ScrollSnapshot={el,top:el.scrollTop,left:el.scrollLeft}
  const editor=el.closest<HTMLElement>('.cm-editor'),view=editor?EditorView.findFromDOM(editor):null
  if(view){
   item.view=view;item.effect=view.scrollSnapshot();item.doc=view.state.doc
   const caret=view.coordsAtPos(view.state.selection.main.head),bounds=el.getBoundingClientRect()
   item.caretVisible=!!caret&&caret.top>=bounds.top&&caret.bottom<=bounds.bottom
  }
  else if(el.getClientRects().length){
   const bounds=el.getBoundingClientRect(),prose=el.querySelector('.ProseMirror')?.getBoundingClientRect()
   const range=document.caretRangeFromPoint?.(Math.max(bounds.left+1,Math.min(bounds.right-1,(prose?.left??bounds.left)+20)),Math.min(bounds.bottom-1,bounds.top+24))
   if(range&&el.contains(range.startContainer)){const rect=range.getBoundingClientRect();if(rect.height){item.range=range;item.inset=rect.top-bounds.top}}
   const selection=getSelection()
   if(selection?.focusNode&&el.contains(selection.focusNode)){
    const caret=document.createRange();caret.setStart(selection.focusNode,selection.focusOffset);caret.collapse(true)
    const rect=caret.getBoundingClientRect();if(rect.height&&rect.top>=bounds.top&&rect.bottom<=bounds.bottom)item.caret=caret
   }
  }
  items.push(item)
 }
 return items
}
export function useMiniWindow(manager:DocumentManager,notify:(message:string)=>void){
 const miniActive=ref(false),miniPinned=ref(true),miniBusy=ref(false)
 let held=new Map<HTMLElement,ScrollSnapshot>(),disposed=false,frame=0,finishFrame:(()=>void)|undefined
 onUnmounted(()=>{disposed=true;cancelAnimationFrame(frame);finishFrame?.();held.clear()})
 async function toggleMini(){
  if(miniBusy.value)return
  if(!isTauri()){notify('Mini 模式需要 Markumo 桌面窗口');return}
  if(manager.isComposing){notify('请完成输入后切换 Mini 模式');return}
  miniBusy.value=true
  const entering=!miniActive.value,focus=document.activeElement instanceof HTMLElement?document.activeElement:null
  const scroll=captureScroll().map(item=>!entering&&!item.el.getClientRects().length?held.get(item.el)??item:item)
  try{
   await invoke('mini_window',{enabled:entering})
   if(disposed)return
   miniActive.value=entering;miniPinned.value=true
   if(entering)held=new Map(scroll.map(item=>[item.el,item]))
   await nextTick()
   await new Promise<void>(resolve=>{finishFrame=resolve;frame=requestAnimationFrame(()=>{
    if(disposed){resolve();return}
    if(focus?.isConnected&&focus.getClientRects().length)focus.focus({preventScroll:true})
    else (document.querySelector<HTMLElement>('.pane.active .ProseMirror,.pane.active .cm-content'))?.focus({preventScroll:true})
    for(const item of scroll){
     if(!item.el.isConnected||!item.el.getClientRects().length)continue
     // CM applies its own scroll anchoring after layout. Reuse its anchor effect,
     // on the existing view, without text/selection changes or an undo entry.
     if(item.view&&item.effect&&item.view.state.doc===item.doc)item.view.dispatch({effects:item.effect,annotations:Transaction.addToHistory.of(false)})
     else if(!item.view){item.el.scrollTop=item.range?item.el.scrollTop+item.range.getBoundingClientRect().top-item.el.getBoundingClientRect().top-(item.inset??0):item.top;item.el.scrollLeft=item.left}
    }
    frame=requestAnimationFrame(()=>{
     for(const item of scroll){
      if(!item.el.isConnected||!item.el.getClientRects().length)continue
      if(item.view&&item.effect&&item.view.state.doc===item.doc){
       item.view.dispatch({effects:item.caretVisible?EditorView.scrollIntoView(item.view.state.selection.main.head,{y:'nearest',yMargin:8}):item.effect,annotations:Transaction.addToHistory.of(false)})
      }else if(item.caret&&item.el.contains(item.caret.startContainer)){
       const rect=item.caret.getBoundingClientRect(),bounds=item.el.getBoundingClientRect()
       if(rect.top<bounds.top+8)item.el.scrollTop+=rect.top-bounds.top-8
       else if(rect.bottom>bounds.bottom-8)item.el.scrollTop+=rect.bottom-bounds.bottom+8
      }
     }
     frame=0;finishFrame=undefined;resolve()
    })
   })})
   if(!entering)held.clear()
  }catch(error){notify(String(error))}finally{miniBusy.value=false}
 }
 async function toggleMiniPin(){if(miniBusy.value)return;try{await invoke('mini_pin',{pinned:!miniPinned.value});miniPinned.value=!miniPinned.value}catch(error){notify('无法设置窗口置顶：'+String(error))}}
 async function dragMini(event:PointerEvent){if(event.button!==0||(event.target as Element).closest('button'))return;try{await getCurrentWindow().startDragging()}catch(error){notify('无法拖动窗口：'+String(error))}}
 async function resizeMini(direction:'North'|'South'|'East'|'West'|'NorthEast'|'NorthWest'|'SouthEast'|'SouthWest'){try{await getCurrentWindow().startResizeDragging(direction)}catch(error){notify('无法调整窗口尺寸：'+String(error))}}
 return {miniActive,miniPinned,miniBusy,toggleMini,toggleMiniPin,dragMini,resizeMini}
}
