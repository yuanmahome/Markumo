<template>
  <section class="media-viewer pdf-viewer" aria-label="PDF 查看器" @keydown="onKeydown">
    <div class="pdf-toolbar" role="toolbar" aria-label="PDF 工具栏">
      <div class="pdf-tools">
        <button class="pdf-nav-toggle" aria-label="显示/隐藏 PDF 导航" :title="view.pdfNavigationOpen ? '隐藏 PDF 导航' : '显示 PDF 导航'" :aria-pressed="!!view.pdfNavigationOpen" :disabled="!pdf" @click="toggleNavigation"><ViewerIcon name="sidebar" /></button>
        <span class="pdf-divider" />
        <button class="edge-nav" aria-label="首页" title="首页 (Home)" :disabled="!pdf || page<=1" @click="jump(1)"><ViewerIcon name="first" /></button>
        <button aria-label="上一页" title="上一页" :disabled="!pdf || page<=1" @click="jump(page-1)"><ViewerIcon name="previous" /></button>
        <form class="page-control" @submit.prevent="commitPage(true)">
          <input ref="pageInput" v-model="pageDraft" inputmode="numeric" aria-label="页码" :disabled="!pdf" :style="{width:`${Math.max(2,String(total).length)}ch`}" @focus="editPage" @blur="commitPage(false)" @keydown.esc.prevent.stop="cancelPage" />
          <span class="page-total">/ {{ total || '—' }}</span>
        </form>
        <button aria-label="下一页" title="下一页" :disabled="!pdf || page>=total" @click="jump(page+1)"><ViewerIcon name="next" /></button>
        <button class="edge-nav" aria-label="末页" title="末页 (End)" :disabled="!pdf || page>=total" @click="jump(total)"><ViewerIcon name="last" /></button>
        <span class="pdf-divider" />
        <button aria-label="缩小" title="缩小 (Ctrl+−)" :disabled="!pdf" @click="zoom(1/1.2)"><ViewerIcon name="zoom-out" /></button>
        <select :value="zoomValue" aria-label="PDF 缩放比例" :disabled="!pdf" @change="chooseZoom(($event.target as HTMLSelectElement).value)">
          <option value="width">适应宽度</option><option value="page">适应页面</option>
          <option v-for="value in zoomOptions" :key="value" :value="String(value)">{{ Math.round(value*100) }}%</option>
        </select>
        <button aria-label="放大" title="放大 (Ctrl++)" :disabled="!pdf" @click="zoom(1.2)"><ViewerIcon name="zoom-in" /></button>
        <span class="zoom-label">{{ Math.round(scale*100) }}%</span>
        <button class="secondary-action" aria-label="适应宽度" title="适应宽度" :aria-pressed="view.fit==='width'" :disabled="!pdf" @click="setFit('width')"><ViewerIcon name="width" /></button>
        <button class="secondary-action" aria-label="适应页面" title="适应页面" :aria-pressed="view.fit==='page'" :disabled="!pdf" @click="setFit('page')"><ViewerIcon name="fit" /></button>
        <span class="pdf-divider secondary-action" />
        <button class="secondary-action" aria-label="连续滚动" :title="view.continuous ? '连续滚动（点击切换单页）' : '单页浏览（点击切换连续滚动）'" :aria-pressed="view.continuous" :disabled="!pdf" @click="toggleContinuous"><ViewerIcon name="pages" /></button>
        <button class="secondary-action" aria-label="抓手工具" title="抓手工具（默认可选择文字，中键可临时拖动）" :aria-pressed="handMode" :disabled="!pdf" @click="handMode=!handMode"><ViewerIcon name="hand" /></button>
        <button class="secondary-action" aria-label="旋转 PDF" title="顺时针旋转 90°" :disabled="!pdf" @click="rotate"><ViewerIcon name="rotate" /></button>
        <span class="pdf-divider" />
        <button aria-label="搜索" title="查找 (Ctrl+F)" :aria-pressed="searchOpen" :disabled="!pdf" @click="focusSearch"><ViewerIcon name="search" /></button>
      </div>
      <details ref="moreMenu" class="pdf-more">
        <summary aria-label="更多 PDF 操作" title="更多操作"><ViewerIcon name="more" /></summary>
        <div class="pdf-menu">
          <button class="compact-only" :disabled="!pdf" @click="toggleNavigation();closeMenu()"><ViewerIcon name="sidebar" />{{ view.pdfNavigationOpen ? '隐藏 PDF 导航' : '显示 PDF 导航' }}</button>
          <button class="narrow-only" :disabled="!pdf" @click="jump(1);closeMenu()"><ViewerIcon name="first" />首页</button>
          <button class="narrow-only" :disabled="!pdf" @click="jump(total);closeMenu()"><ViewerIcon name="last" />末页</button>
          <button class="compact-only" :disabled="!pdf" @click="toggleContinuous();closeMenu()"><ViewerIcon name="pages" />{{ view.continuous ? '切换到单页浏览' : '切换到连续滚动' }}</button>
          <button class="compact-only" :disabled="!pdf" @click="handMode=!handMode;closeMenu()"><ViewerIcon name="hand" />{{ handMode ? '切换到文字选择' : '切换到抓手工具' }}</button>
          <button class="compact-only" :disabled="!pdf" @click="rotate();closeMenu()"><ViewerIcon name="rotate" />顺时针旋转 90°</button>
          <button @click="load();closeMenu()"><ViewerIcon name="refresh" />重新加载 PDF</button>
          <button @click="openDefault();closeMenu()"><ViewerIcon name="external" />使用系统默认程序打开</button>
        </div>
      </details>
      <span class="pdf-file-info" :title="doc.name">PDF · {{ mediaSize(meta?.byteLength || 0) }}</span>
    </div>
    <form v-if="searchOpen" class="pdf-search" role="search" @submit.prevent="findNext(1)" @keydown.esc.prevent.stop="closeSearch">
      <ViewerIcon name="search" />
      <input ref="searchInput" v-model="query" aria-label="搜索 PDF 文本" placeholder="在文档中查找" @keydown.shift.enter.prevent="findNext(-1)" />
      <span class="search-count" role="status">{{ matches.length ? `${matchIndex+1} / ${matches.length}${searching ? '+' : ''}` : searching ? '正在查找…' : query ? '无匹配项' : '' }}</span>
      <button type="button" aria-label="上一个" title="上一个结果 (Shift+Enter)" :disabled="!matches.length" @click="findNext(-1)"><ViewerIcon name="previous" /></button>
      <button type="submit" aria-label="下一个" title="下一个结果 (Enter)" :disabled="!matches.length"><ViewerIcon name="next" /></button>
      <span v-if="searching" class="search-progress">{{ scanned }} / {{ total }} 页</span>
      <span v-if="capped" class="search-progress">结果已截断</span>
      <button type="button" class="close-search" aria-label="关闭查找" title="关闭查找 (Esc)" @click="closeSearch"><ViewerIcon name="close" /></button>
      <span v-if="searchError" class="search-error">{{ searchError }}</span>
    </form>
    <div class="pdf-body">
      <PdfNavigation
        v-if="view.pdfNavigationOpen && pdf"
        :style="{ width: `${view.pdfNavigationWidth || 200}px` }"
        :pdf="pdf"
        :total="total"
        :current-page="page"
        :rotation="view.rotation"
        :mode="view.pdfNavigationMode || 'thumbnails'"
        :explicit-jump-seq="explicitJumpSeq"
        :sizes="sizes"
        :fallback-size="fallback"
        @update:mode="view.pdfNavigationMode = $event"
        @jump="jump($event)"
        @navigate-dest="handleNavigateDest"
        @open-url="openUrl"
      />
      <div
        v-if="view.pdfNavigationOpen && pdf"
        class="pdf-nav-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 PDF 导航栏宽度"
        @pointerdown="startResizeNav"
      />
      <div class="pdf-main-area">
        <div v-if="passwordNeeded" class="password-container">
          <form class="password-form" @submit.prevent="submitPassword">
            <strong>此 PDF 需要密码</strong><span>{{ doc.name }}</span>
            <label :for="`pdf-password-${pane}`">{{ passwordWrong ? '密码不正确，请重试' : '输入打开文档的密码' }}</label>
            <input :id="`pdf-password-${pane}`" ref="passwordInput" v-model="password" type="password" autocomplete="off" aria-label="PDF 密码" />
            <div><button type="button" @click="cancelPassword">取消</button><button class="primary" type="submit">打开</button></div>
          </form>
        </div>
        <MediaEmpty v-else-if="!pdf" :error="error" :token="doc.fileToken" @retry="load" />
        <div v-show="pdf" ref="viewport" class="media-viewport pdf-viewport" :class="{ 'hand-mode':handMode,dragging:!!drag }" tabindex="0" aria-label="PDF 阅读区域" @scroll.passive="onScroll" @wheel="onWheel" @pointerdown="startPan" @pointermove="pan" @pointerup="endPan" @pointercancel="endPan">
          <div class="pdf-pages" :style="{height:`${contentHeight}px`,width:`${contentWidth}px`}">
            <PdfPage
              v-for="number in visiblePages"
              :key="number"
              :pdf="pdf!"
              :api="api!"
              :number="number"
              :scale="scale"
              :rotation="view.rotation"
              :pixel-budget="Math.floor(64*1024*1024/4/Math.max(3,visiblePages.length)/2)"
              :query="searchOpen ? activeQuery : ''"
              :match="selected?.page===number ? selected.index : undefined"
              :match-request="matchRequest"
              :style="{top:`${pageTop(number)}px`,left:`${pageLeft(number)}px`}"
              @size="rememberSize"
              @match-location="revealMatch"
              @navigate-dest="handleNavigateDest"
              @open-url="openUrl"
              @action="handleNamedAction"
            />
          </div>
        </div>
        <div v-if="error && pdf" class="pdf-notice" role="alert">{{ error }} <button @click="load">重新加载</button></div>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { trackWindowRelease } from '../../features/shell/windowResources'
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type * as PDFJS from 'pdfjs-dist'
import type { EditorDocument } from '../../types'
import type { MediaMetadata } from '../../features/files/contracts'
import { MEDIA_CHUNK, mediaMetadata, mediaSize, openMediaDefault, readMediaChunk, type MediaViewState } from '../../features/files/media'
import { fileError } from '../../features/files/FileController'
import PdfPage from './PdfPage.vue'
import PdfNavigation from './PdfNavigation.vue'
import MediaEmpty from './MediaEmpty.vue'
import ViewerIcon from './ViewerIcon.vue'
import { resolvePdfDestination, computeTargetViewportCoords, openPdfExternalUrl } from './pdfLinkUtils'
import './viewer.css'

const props=defineProps<{doc:EditorDocument;pane:string;state:MediaViewState}>()
const emit=defineEmits<{(e:'metadata',media:MediaMetadata,version:string):void}>()
const view=reactive(props.state),pdf=shallowRef<PDFJS.PDFDocumentProxy>(),api=shallowRef<typeof PDFJS>(),meta=ref<MediaMetadata>()
if(view.pdfNavigationOpen===undefined)view.pdfNavigationOpen=true
if(!view.pdfNavigationWidth)view.pdfNavigationWidth=200
if(!view.pdfNavigationMode)view.pdfNavigationMode='thumbnails'
const viewport=ref<HTMLElement>(),error=ref(''),total=ref(0),page=ref(view.page),scale=ref(view.scale)
const viewportWidth=ref(0),viewportHeight=ref(800),handMode=ref(false),explicitJumpSeq=ref(0)
const pageInput=ref<HTMLInputElement>(),pageDraft=ref(String(view.page)),pageEditing=ref(false)
const moreMenu=ref<HTMLDetailsElement>()
const sizes=reactive(new Map<number,{width:number;height:number}>()),fallback=reactive({width:612,height:792})
const PADDING=24,GAP=16
const dimensions=(n:number)=>{const size=sizes.get(n)||fallback;return view.rotation%180?{width:size.height,height:size.width}:size}
const pageWidth=(n:number)=>dimensions(n).width*scale.value
const pageHeight=(n:number)=>dimensions(n).height*scale.value
const offsets=computed(()=>{const out=[PADDING];for(let n=1;n<=total.value;n++)out.push(out[n-1]+pageHeight(n)+GAP);return out})
const contentHeight=computed(()=>view.continuous?(offsets.value[total.value]||PADDING)+PADDING-GAP:pageHeight(page.value)+PADDING*2)
const contentWidth=computed(()=>{
  let width=dimensions(0).width
  for(const size of sizes.values())width=Math.max(width,view.rotation%180?size.height:size.width)
  return Math.max(viewportWidth.value,width*scale.value+PADDING*2)
})
const pageTop=(n:number)=>view.continuous?(offsets.value[n-1]||PADDING):PADDING
const pageLeft=(n:number)=>(contentWidth.value-pageWidth(n))/2
function pageAt(y:number){let lo=0,hi=Math.max(0,total.value-1);while(lo<hi){const mid=(lo+hi+1)>>1;if(offsets.value[mid]<=y)lo=mid;else hi=mid-1}return lo+1}
const visiblePages=computed(()=>{
  if(!pdf.value)return []
  if(!view.continuous)return [page.value]
  const first=pageAt(view.top),last=pageAt(view.top+viewportHeight.value),out=[page.value]
  for(let n=Math.max(1,first-1);n<=Math.min(total.value,last+1);n++)if(n!==page.value)out.push(n)
  return out
})
const zoomOptions=computed(()=>[...new Set([.25,.5,.75,1,1.25,1.5,2,3,4,5,scale.value])].sort((a,b)=>a-b))
const zoomValue=computed(()=>view.fit==='width'||view.fit==='page'?view.fit:String(scale.value))
const searchOpen=ref(!!view.pdfSearchOpen),query=ref(view.query),activeQuery=ref(''),searchInput=ref<HTMLInputElement>()
const searching=ref(false),searchError=ref(''),capped=ref(false),scanned=ref(0),matchRequest=ref(0)
const searchComplete=ref(false)
const matches=ref<{page:number;index:number}[]>([]),matchIndex=ref(0)
const selected=computed(()=>searchOpen.value?matches.value[matchIndex.value]:undefined)
const passwordNeeded=ref(false),passwordWrong=ref(false),password=ref(''),passwordInput=ref<HTMLInputElement>()
const drag=ref<{x:number;y:number;left:number;top:number}>()
interface ReaderAnchor {page:number;x:number;y:number;clientX:number;clientY:number}
let pendingAnchor:ReaderAnchor|undefined,positionEpoch=0,anchorFrame=0
let passwordCallback:((value:string)=>void)|undefined,generation=0,searchGeneration=0,disposed=false,navSequence=0
let loading:PDFJS.PDFDocumentLoadingTask|undefined,nativeWorker:Worker|undefined,worker:PDFJS.PDFWorker|undefined,transport:PDFJS.PDFDataRangeTransport|undefined
let resize:ResizeObserver|undefined,scrollFrame=0,searchTimer:ReturnType<typeof setTimeout>|undefined

function measureViewport(){viewportWidth.value=viewport.value?.clientWidth||0;viewportHeight.value=viewport.value?.clientHeight||800}
function captureAnchor(point?:{x:number;y:number}):ReaderAnchor|undefined{
  const host=viewport.value;if(!pdf.value||!host)return
  const clientX=point?.x??host.clientWidth/2,clientY=point?.y??host.clientHeight/2
  const number=view.continuous?pageAt(host.scrollTop+clientY):page.value
  return {page:number,x:(host.scrollLeft+clientX-pageLeft(number))/Math.max(1,pageWidth(number)),y:(host.scrollTop+clientY-pageTop(number))/Math.max(1,pageHeight(number)),clientX,clientY}
}
function savePosition(){
  const host=viewport.value;if(!pdf.value||!host)return
  view.top=host.scrollTop;view.left=host.scrollLeft;view.page=page.value
  const anchor=captureAnchor();if(anchor)view.pdfAnchor={page:anchor.page,x:anchor.x,y:anchor.y}
}
function syncPosition(){
  const host=viewport.value;if(!pdf.value||!host)return
  view.top=host.scrollTop;view.left=host.scrollLeft
  if(view.continuous){
    const first=pageAt(host.scrollTop),last=pageAt(host.scrollTop+host.clientHeight)
    let best=page.value,overlap=-1
    for(let n=first;n<=last;n++){
      const visible=Math.max(0,Math.min(host.scrollTop+host.clientHeight,pageTop(n)+pageHeight(n))-Math.max(host.scrollTop,pageTop(n)))
      if(visible>overlap){best=n;overlap=visible}
    }
    page.value=best
  }
  savePosition()
}
function restoreAnchor(anchor:ReaderAnchor){
  if(!pdf.value||!viewport.value)return
  const number=Math.max(1,Math.min(total.value,anchor.page))
  viewport.value.scrollTo({left:pageLeft(number)+anchor.x*pageWidth(number)-anchor.clientX,top:pageTop(number)+anchor.y*pageHeight(number)-anchor.clientY})
  syncPosition()
}
function positionAt(anchor:ReaderAnchor){
  const current=++positionEpoch;pendingAnchor=anchor;cancelAnimationFrame(anchorFrame)
  void nextTick(()=>{
    if(disposed||current!==positionEpoch)return
    restoreAnchor(anchor)
    anchorFrame=requestAnimationFrame(()=>{
      if(current!==positionEpoch||disposed)return
      restoreAnchor(anchor)
      // ResizeObserver runs after animation callbacks. Retain the anchor through
      // that delivery so scrollbar size changes cannot recenter the target.
      anchorFrame=requestAnimationFrame(()=>{if(current===positionEpoch)pendingAnchor=undefined})
    })
  })
}
function changeScale(value:number,anchor=pendingAnchor||captureAnchor()){
  if(!pdf.value||!Number.isFinite(value))return
  const next=Math.max(.05,Math.min(5,value))
  scale.value=next;view.scale=next
  if(anchor)positionAt(anchor)
}
function updateFit(anchor?:ReaderAnchor){
  const host=viewport.value;if(!pdf.value||!host?.clientWidth||view.fit==='manual')return
  const size=dimensions(page.value),width=(host.clientWidth-PADDING*2)/size.width,height=(host.clientHeight-PADDING*2)/size.height
  const next=Math.max(.05,Math.min(5,view.fit==='width'?width:view.fit==='height'?height:Math.min(width,height)))
  if(Math.abs(next-scale.value)>.001)changeScale(next,anchor||pendingAnchor||captureAnchor())
}
function setFit(mode:string){
  view.fit=mode
  const anchor=mode==='page'&&viewport.value?{page:page.value,x:.5,y:.5,clientX:viewport.value.clientWidth/2,clientY:viewport.value.clientHeight/2}:captureAnchor()
  updateFit(anchor);if(anchor)positionAt(anchor)
}
function zoom(factor:number,point?:{x:number;y:number}){const anchor=point?captureAnchor(point):pendingAnchor||captureAnchor();view.fit='manual';changeScale(scale.value*factor,anchor)}
function chooseZoom(value:string){if(value==='width'||value==='page')setFit(value);else{view.fit='manual';changeScale(Number(value))}}
function jump(value:number){
  if(!pdf.value||!Number.isFinite(value))return
  ++navSequence
  explicitJumpSeq.value++
  const number=Math.max(1,Math.min(total.value,Math.round(value))),anchor=captureAnchor()
  page.value=number;view.page=number
  positionAt({page:number,x:anchor?.x??.5,y:0,clientX:(viewport.value?.clientWidth||0)/2,clientY:PADDING})
  updateFit(pendingAnchor)
}
function toggleNavigation(){
  const anchor=captureAnchor()
  view.pdfNavigationOpen=!view.pdfNavigationOpen
  void nextTick(()=>{
    measureViewport()
    updateFit(anchor)
    if(anchor)positionAt(anchor)
  })
}
function startResizeNav(event:PointerEvent){
  event.preventDefault()
  const startX=event.clientX
  const startWidth=view.pdfNavigationWidth||200
  const anchor=captureAnchor()
  function onPointerMove(e:PointerEvent){
    const dx=e.clientX-startX
    const hostWidth=viewport.value?.parentElement?.clientWidth||800
    const maxAllowed=Math.min(320,hostWidth-180)
    const minAllowed=140
    view.pdfNavigationWidth=Math.max(minAllowed,Math.min(maxAllowed,startWidth+dx))
    measureViewport()
    updateFit(anchor)
    if(anchor)positionAt(anchor)
  }
  function onPointerUp(){
    window.removeEventListener('pointermove',onPointerMove)
    window.removeEventListener('pointerup',onPointerUp)
    void nextTick(()=>{
      measureViewport()
      updateFit(anchor)
      if(anchor)positionAt(anchor)
    })
  }
  window.addEventListener('pointermove',onPointerMove)
  window.addEventListener('pointerup',onPointerUp)
}
async function handleNavigateDest(dest:any){
  if(!pdf.value)return
  const documentProxy=pdf.value
  const currentNav=++navSequence
  ++positionEpoch;pendingAnchor=undefined;cancelAnimationFrame(anchorFrame)
  try{
    const target=await resolvePdfDestination(documentProxy,dest)
    if(disposed||currentNav!==navSequence||!target)return
    const targetPageProxy=await documentProxy.getPage(target.pageNumber)
    if(disposed||currentNav!==navSequence||pdf.value!==documentProxy)return
    const box=targetPageProxy.getViewport({scale:1})
    sizes.set(target.pageNumber,{width:box.width,height:box.height})
    const totalRotation=(targetPageProxy.rotate+view.rotation)%360
    const unitViewport=targetPageProxy.getViewport({scale:1,rotation:totalRotation})
    explicitJumpSeq.value++

    if(target.zoom!==undefined&&target.zoom>0){
      const safeZoom=Math.max(0.05,Math.min(5,target.zoom))
      view.fit='manual'
      scale.value=safeZoom
      view.scale=safeZoom
    }else if(target.fitMode&&viewport.value?.clientWidth){
      // Rect fitting is a one-off scale; resize must not fit the entire page.
      view.fit=target.fitMode==='rect'?'manual':target.fitMode
      const host=viewport.value
      let width=unitViewport.width,height=unitViewport.height
      if(target.fitMode==='rect'&&target.rawLeft!==undefined&&target.rawBottom!==undefined&&target.rawRight!==undefined&&target.rawTop!==undefined){
        const rect=[...unitViewport.convertToViewportPoint(target.rawLeft,target.rawBottom),...unitViewport.convertToViewportPoint(target.rawRight,target.rawTop)]
        width=Math.abs(rect[2]-rect[0]);height=Math.abs(rect[3]-rect[1])
      }
      const w=(host.clientWidth-PADDING*2)/width
      const h=(host.clientHeight-PADDING*2)/height
      const fit=target.fitMode==='width'?w:target.fitMode==='height'?h:Math.min(w,h)
      const next=Number.isFinite(fit)&&fit>0?Math.max(0.05,Math.min(5,fit)):scale.value
      scale.value=next
      view.scale=next
    }

    const vp=targetPageProxy.getViewport({scale:scale.value,rotation:totalRotation})
    const {vx,vy}=computeTargetViewportCoords(vp,target)

    page.value=target.pageNumber
    view.page=target.pageNumber

    const executeScroll=()=>{
      if(disposed||currentNav!==navSequence||!viewport.value)return
      const host=viewport.value
      const maxScrollY=Math.max(0,host.scrollHeight-host.clientHeight)
      const maxScrollX=Math.max(0,host.scrollWidth-host.clientWidth)

      let rawTargetY:number
      let rawTargetX:number

      if(view.continuous){
        rawTargetY=pageTop(target.pageNumber)+(vy??0)
        rawTargetX=pageLeft(target.pageNumber)+(vx??0)
      }else{
        rawTargetY=PADDING+(vy??0)
        rawTargetX=pageLeft(target.pageNumber)+(vx??0)
      }

      const clampedY=Math.max(0,Math.min(maxScrollY,Math.round(rawTargetY)))
      const clampedX=Math.max(0,Math.min(maxScrollX,Math.round(rawTargetX)))

      host.scrollTo({top:clampedY,left:clampedX})
      syncPosition()
      // Keep the destination as the resize anchor while new scrollbars/layout settle.
      positionAt({page:target.pageNumber,x:(vx??0)/pageWidth(target.pageNumber),y:(vy??0)/pageHeight(target.pageNumber),clientX:0,clientY:0})
    }

    // Scale, page size and virtual content bounds must reach the DOM first.
    await nextTick()
    executeScroll()
  }catch(e){console.warn('Failed to resolve destination',e)}
}
function handleNamedAction(action:string){
  if(!pdf.value||!total.value)return
  switch(action){
    case 'FirstPage':jump(1);break
    case 'LastPage':jump(total.value);break
    case 'NextPage':if(page.value<total.value)jump(page.value+1);break
    case 'PrevPage':if(page.value>1)jump(page.value-1);break
    default:break
  }
}
function openUrl(url:string){
  void openPdfExternalUrl(url)
}
function toggleContinuous(){const anchor=captureAnchor();view.continuous=!view.continuous;if(anchor){page.value=anchor.page;positionAt(anchor)}}
function rotate(){
  ++navSequence
  const anchor=captureAnchor();view.rotation=(view.rotation+90)%360
  if(anchor){const x=anchor.x;anchor.x=1-anchor.y;anchor.y=x;positionAt(anchor);updateFit(anchor)}
}
function onScroll(){if(scrollFrame||!pdf.value)return;scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;syncPosition()})}
function onWheel(event:WheelEvent){
  if(!event.ctrlKey&&!event.metaKey)return
  event.preventDefault();event.stopPropagation()
  const box=viewport.value?.getBoundingClientRect();if(box)zoom(Math.exp(Math.max(-.7,Math.min(.7,-event.deltaY*.002))),{x:event.clientX-box.left,y:event.clientY-box.top})
}
function rememberSize(value:{page:number;width:number;height:number}){
  const old=sizes.get(value.page);if(old?.width===value.width&&old.height===value.height)return
  const anchor=pendingAnchor||captureAnchor();sizes.set(value.page,{width:value.width,height:value.height})
  if(anchor)positionAt(anchor)
  if(value.page===page.value)updateFit(anchor)
}
watch(page,value=>{if(!pageEditing.value)pageDraft.value=String(value)})
function editPage(){pageEditing.value=true;pageInput.value?.select()}
function commitPage(focus:boolean){
  if(!pageEditing.value)return
  const valid=/^\d+$/.test(pageDraft.value.trim()),number=Number(pageDraft.value)
  pageEditing.value=false;if(valid)jump(number);pageDraft.value=String(page.value)
  if(focus)viewport.value?.focus({preventScroll:true})
}
function cancelPage(){pageEditing.value=false;pageDraft.value=String(page.value);viewport.value?.focus({preventScroll:true})}
function startPan(event:PointerEvent){
  const host=viewport.value;if(!host||(!handMode.value&&event.button!==1)||(event.button!==0&&event.button!==1))return
  event.preventDefault();host.focus({preventScroll:true});host.setPointerCapture(event.pointerId)
  drag.value={x:event.clientX,y:event.clientY,left:host.scrollLeft,top:host.scrollTop}
}
function pan(event:PointerEvent){const start=drag.value;if(start&&viewport.value){viewport.value.scrollLeft=start.left+start.x-event.clientX;viewport.value.scrollTop=start.top+start.y-event.clientY}}
function endPan(){drag.value=undefined}
function closeMenu(){if(moreMenu.value)moreMenu.value.open=false}
function dismissMenu(event:PointerEvent){if(event.target instanceof Node&&!moreMenu.value?.contains(event.target))closeMenu()}

async function focusSearch(){
  searchOpen.value=true;view.pdfSearchOpen=true;await nextTick();searchInput.value?.focus();searchInput.value?.select()
  if(query.value&&(!matches.value.length||!searchComplete.value)&&!searching.value)void search()
  else activeQuery.value=query.value
}
function closeSearch(){searchOpen.value=false;view.pdfSearchOpen=false;++searchGeneration;searching.value=false;activeQuery.value='';viewport.value?.focus({preventScroll:true})}
function showMatch(index:number){
  if(!matches.value.length)return
  matchIndex.value=index;matchRequest.value++
  const hit=matches.value[index]
  if(!visiblePages.value.includes(hit.page))jump(hit.page)
}
function revealMatch(hit:{page:number;index:number;top:number;left:number;width:number;height:number}){
  const host=viewport.value;if(!host||!searchOpen.value||selected.value?.page!==hit.page||selected.value.index!==hit.index)return
  const top=pageTop(hit.page)+hit.top,left=pageLeft(hit.page)+hit.left
  if(top<host.scrollTop+24||top+hit.height>host.scrollTop+host.clientHeight-24)host.scrollTop=top-host.clientHeight*.35
  if(left<host.scrollLeft||left+hit.width>host.scrollLeft+host.clientWidth)host.scrollLeft=left-host.clientWidth/2
  syncPosition()
}
async function search(){
  const current=++searchGeneration,documentProxy=pdf.value,term=query.value.toLocaleLowerCase(),start=page.value
  matches.value=[];matchIndex.value=0;searchError.value='';capped.value=false;scanned.value=0;activeQuery.value=query.value;searchComplete.value=false
  if(!documentProxy||!term||!searchOpen.value){searching.value=false;return}
  searching.value=true;let located=false
  try{
    for(let offset=0;offset<documentProxy.numPages;offset++){
      if(disposed||current!==searchGeneration)return
      const number=(start-1+offset)%documentProxy.numPages+1,p=await documentProxy.getPage(number),content=await p.getTextContent()
      if(disposed||current!==searchGeneration){if(!visiblePages.value.includes(number))p.cleanup();return}
      const text=content.items.map(item=>'str'in item?item.str:'').join('').toLocaleLowerCase();let index=0
      for(let pos=text.indexOf(term);pos>=0;pos=text.indexOf(term,pos+term.length)){
        if(matches.value.length>=10000){capped.value=true;break}
        matches.value.push({page:number,index:index++})
      }
      scanned.value=offset+1
      if(!located&&matches.value.length){located=true;showMatch(0)}
      if(!visiblePages.value.includes(number))p.cleanup()
      if(capped.value)break
      await new Promise<void>(resolve=>setTimeout(resolve,0))
    }
    if(current===searchGeneration){
      const chosen=matches.value[matchIndex.value];matches.value.sort((a,b)=>a.page-b.page||a.index-b.index)
      if(chosen)matchIndex.value=matches.value.indexOf(chosen)
      searchComplete.value=true
    }
  }catch(e){if(!disposed&&current===searchGeneration)searchError.value=fileError(e)}
  finally{if(current===searchGeneration)searching.value=false}
}
function findNext(direction:number){if(matches.value.length)showMatch((matchIndex.value+direction+matches.value.length)%matches.value.length)}
watch(query,()=>{
  view.query=query.value;++searchGeneration;matches.value=[];activeQuery.value='';searching.value=false;searchComplete.value=false
  if(searchTimer)clearTimeout(searchTimer)
  searchTimer=setTimeout(()=>void search(),200)
})
function command(event:Event){const detail=(event as CustomEvent).detail;if(detail.pane!==props.pane)return;if(detail.command==='find')void focusSearch();else{void focusSearch();findNext(detail.command==='find-next'?1:-1)}}
function onKeydown(event:KeyboardEvent){
  const modifier=event.ctrlKey||event.metaKey,key=event.key.toLowerCase()
  if(key==='escape'&&moreMenu.value?.open){event.preventDefault();event.stopPropagation();closeMenu();return}
  if(key==='escape'&&searchOpen.value){event.preventDefault();event.stopPropagation();closeSearch();return}
  if(modifier&&key==='f'){event.preventDefault();event.stopPropagation();void focusSearch();return}
  if(modifier&&key==='g'){event.preventDefault();event.stopPropagation();pageInput.value?.focus();pageInput.value?.select();return}
  if(key==='f3'){event.preventDefault();event.stopPropagation();void focusSearch();findNext(event.shiftKey?-1:1);return}
  const target=event.target instanceof Element?event.target:null
  if(target?.closest('input,select,button'))return
  if(!pdf.value||event.altKey)return
  if(modifier&&['+','=','-','0'].includes(key)){
    event.preventDefault();event.stopPropagation();if(key==='0')setFit('width');else zoom(key==='-'?1/1.2:1.2);return
  }
  if(modifier){if(key==='home'||key==='end'){event.preventDefault();event.stopPropagation();jump(key==='home'?1:total.value)}return}
  const host=viewport.value;if(!host)return
  if(['pagedown','pageup','home','end',' ','arrowdown','arrowup'].includes(key))event.preventDefault();else return
  if(key==='home')jump(1)
  else if(key==='end')jump(total.value)
  else if(!view.continuous&&['pagedown','pageup',' '].includes(key))jump(page.value+((key==='pageup'||event.shiftKey)?-1:1))
  else host.scrollBy({top:key==='arrowdown'?48:key==='arrowup'?-48:host.clientHeight*.9*((key==='pageup'||event.shiftKey)?-1:1)})
}

function teardown(){return trackWindowRelease(teardownResources())}
async function teardownResources(){
  ++searchGeneration;++navSequence;searching.value=false;passwordNeeded.value=false;passwordCallback=undefined;password.value=''
  ++positionEpoch;pendingAnchor=undefined;cancelAnimationFrame(anchorFrame);cancelAnimationFrame(scrollFrame);scrollFrame=0
  const oldLoading=loading,oldWorker=worker,oldNative=nativeWorker,oldTransport=transport,oldApi=api.value
  loading=undefined;pdf.value=undefined;worker=undefined;nativeWorker=undefined;transport=undefined;oldTransport?.abort()
  await nextTick()
  let timeout:ReturnType<typeof setTimeout>|undefined
  try{if(oldLoading)await Promise.race([oldLoading.destroy(),new Promise<void>(resolve=>{timeout=setTimeout(resolve,1000)})])}
  catch{/* Already destroyed during load. */}
  finally{
    if(timeout)clearTimeout(timeout)
    // PDF.js sends Terminate before clearing its font/TextLayer caches. Killing
    // the port first strands that handshake and leaves hidden measurement
    // canvases behind. Allow bounded graceful cleanup, then force termination.
    oldWorker?.destroy();oldNative?.terminate()
    oldApi?.TextLayer.cleanup()
  }
}
async function load(){
  savePosition()
  const saved={page:view.page,left:view.left,top:view.top,anchor:view.pdfAnchor&&{...view.pdfAnchor}},current=++generation
  error.value='';await teardown();if(disposed||generation!==current)return
  sizes.clear();matches.value=[];total.value=0
  try{
    const [metadata,version]=await mediaMetadata(props.doc.fileToken!),module=await import('pdfjs-dist')
    if(disposed||generation!==current)return
    api.value=module;meta.value=metadata;emit('metadata',metadata,version)
    if(metadata.mime!=='application/pdf')throw new Error('文件格式已改变，请关闭并重新打开。')
    nativeWorker=new Worker(new URL(`${import.meta.env.BASE_URL}pdfjs/pdf.worker.min.mjs`,document.baseURI),{type:'module'})
    nativeWorker.addEventListener('error',()=>{if(!disposed&&generation===current){error.value='PDF Worker 无法启动，请更新 WebView2 或使用系统默认程序。';void teardown()}},{once:true})
    worker=module.PDFWorker.create({port:nativeWorker})
    const first=await readMediaChunk(props.doc.fileToken!,version,0,Math.min(MEDIA_CHUNK,metadata.byteLength))
    if(disposed||generation!==current)return
    let stopped=false,queue:Promise<void>=Promise.resolve()
    class TokenRange extends module.PDFDataRangeTransport{
      requestDataRange(begin:number,end:number){
        queue=queue.then(async()=>{
          if(end-begin>32*1024*1024)throw new Error('PDF 单个数据范围超过 32 MiB 内存预算，请使用系统默认程序。')
          const data=new Uint8Array(end-begin)
          for(let offset=begin;offset<end;offset+=MEDIA_CHUNK){
            if(stopped||disposed||generation!==current)return
            const bytes=await readMediaChunk(props.doc.fileToken!,version,offset,Math.min(MEDIA_CHUNK,end-offset))
            if(stopped||disposed||generation!==current)return
            data.set(bytes,offset-begin)
          }
          if(!stopped)this.onDataRange(begin,data)
        }).catch(e=>{if(!stopped&&!disposed&&generation===current){error.value=fileError(e);stopped=true;void teardown()}})
      }
      abort(){stopped=true}
    }
    transport=new TokenRange(metadata.byteLength,first,true)
    loading=module.getDocument({range:transport,worker,rangeChunkSize:MEDIA_CHUNK,disableStream:true,disableAutoFetch:true,maxImageSize:32*1024*1024,canvasMaxAreaInBytes:32*1024*1024,
      wasmUrl:new URL(`${import.meta.env.BASE_URL}pdfjs/wasm/`,document.baseURI).href,
      cMapUrl:new URL(`${import.meta.env.BASE_URL}pdfjs/cmaps/`,document.baseURI).href,cMapPacked:true,standardFontDataUrl:new URL(`${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,document.baseURI).href})
    loading.onPassword=(callback:(value:string)=>void,reason:number)=>{
      if(disposed||generation!==current)return
      passwordCallback=callback;passwordWrong.value=reason===module.PasswordResponses.INCORRECT_PASSWORD;passwordNeeded.value=true
      void nextTick(()=>passwordInput.value?.focus())
    }
    const documentProxy=await loading.promise;if(disposed||generation!==current)return
    const firstPage=await documentProxy.getPage(1);if(disposed||generation!==current)return
    const box=firstPage.getViewport({scale:1});fallback.width=box.width;fallback.height=box.height;firstPage.cleanup()
    total.value=documentProxy.numPages;page.value=Math.min(Math.max(1,saved.page),total.value);pdf.value=markRaw(documentProxy)
    await nextTick();measureViewport();updateFit();await nextTick()
    if(saved.anchor)positionAt({...saved.anchor,page:Math.min(total.value,saved.anchor.page),clientX:viewportWidth.value/2,clientY:viewportHeight.value/2})
    else if(saved.top&&viewport.value){viewport.value.scrollTo({top:saved.top,left:saved.left});syncPosition()}
    else jump(page.value)
    if(searchOpen.value&&query.value)void search()
  }catch(e){if(!disposed&&generation===current){error.value=`PDF 加载失败：${fileError(e)}`;await teardown()}}
}
function submitPassword(){passwordCallback?.(password.value);password.value='';passwordNeeded.value=false}
function cancelPassword(){++generation;error.value='已取消输入密码。';void teardown()}
async function openDefault(){try{await openMediaDefault(props.doc.fileToken!)}catch(e){error.value=fileError(e)}}
onMounted(()=>{
  resize=new ResizeObserver(()=>{
    const anchor=pendingAnchor||captureAnchor({x:viewportWidth.value/2,y:viewportHeight.value/2})
    const pending=!!pendingAnchor;measureViewport()
    if(anchor&&!pending){anchor.clientX=viewportWidth.value/2;anchor.clientY=viewportHeight.value/2}
    updateFit(anchor);if(anchor)positionAt(anchor)
  })
  if(viewport.value)resize.observe(viewport.value)
  window.addEventListener('pdf-command',command);window.addEventListener('pointerdown',dismissMenu);void load()
})
onBeforeUnmount(()=>{
  savePosition();disposed=true;++generation;++searchGeneration;resize?.disconnect();window.removeEventListener('pdf-command',command);window.removeEventListener('pointerdown',dismissMenu)
  if(searchTimer)clearTimeout(searchTimer);endPan();matches.value=[];void teardown()
})
</script>
<style scoped>
.pdf-viewer {container-type:inline-size}
.pdf-toolbar {display:flex;align-items:center;gap:4px;padding:3px 8px;min-height:36px;flex:none;border-bottom:1px solid var(--line);background:var(--editor);position:relative;z-index:5}
.pdf-tools {display:flex;align-items:center;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none}
.pdf-toolbar button,.pdf-search button {width:28px;height:28px;display:grid;place-items:center;flex:none;padding:0;border:0;border-radius:4px;background:transparent;color:var(--sub);cursor:pointer}
.pdf-toolbar button:hover,.pdf-search button:hover {background:var(--hover);color:var(--bright)}
.pdf-toolbar button[aria-pressed=true] {color:var(--accent);background:var(--accentbg)}
.pdf-toolbar button:disabled,.pdf-search button:disabled {opacity:.35;cursor:default;background:transparent}
.pdf-toolbar :is(button,input,select):focus-visible,.pdf-search :is(button,input):focus-visible {outline:1px solid var(--accent);outline-offset:1px}
.pdf-divider {width:1px;height:16px;background:var(--line);margin:0 6px;flex:none}
.page-control {display:flex;align-items:center;gap:6px;padding:0 6px;font-size:12px;white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}
.page-control input {box-sizing:content-box;min-width:20px;height:23px;padding:0 5px;background:var(--bar);border:1px solid var(--line);border-radius:3px;color:var(--ink);font:inherit;text-align:center}
.page-total {color:var(--sub)}
.pdf-toolbar select {height:26px;width:99px;flex:none;background:var(--editor);color:var(--ink);border:1px solid transparent;border-radius:4px;font:inherit;font-size:12px;cursor:pointer}
.pdf-toolbar select:hover {background:var(--hover)}
.zoom-label {font-size:11px;color:var(--muted);width:40px;text-align:center;flex:none;font-variant-numeric:tabular-nums}
.pdf-file-info {margin-left:auto;white-space:nowrap;color:var(--muted);font-size:11px;flex:none}
.pdf-more {flex:none}.pdf-more summary {display:grid;place-items:center;width:28px;height:28px;list-style:none;cursor:pointer;color:var(--sub);border-radius:4px}
.pdf-more summary::-webkit-details-marker {display:none}
.pdf-more summary:hover,.pdf-more[open] summary {background:var(--hover);color:var(--bright)}
.pdf-menu {position:absolute;right:8px;top:calc(100% + 3px);min-width:210px;padding:5px;background:var(--bar);border:1px solid var(--line);border-radius:6px;box-shadow:0 6px 24px #0003}
.pdf-menu button {display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;height:32px;padding:0 9px;color:var(--ink);font-size:12px;white-space:nowrap}
.pdf-menu .compact-only,.pdf-menu .narrow-only {display:none}
.pdf-search {display:flex;align-items:center;gap:6px;flex:none;min-height:38px;padding:4px 12px;border-bottom:1px solid var(--line);background:var(--bar);font-size:12px;color:var(--sub)}
.pdf-search input {min-width:80px;width:220px;height:26px;padding:2px 7px;border:1px solid var(--line);border-radius:4px;background:var(--editor);color:var(--ink);font:inherit}
.search-count {min-width:56px;white-space:nowrap;font-variant-numeric:tabular-nums}
.search-progress {color:var(--muted);white-space:nowrap;font-size:11px}
.close-search {margin-left:auto}.search-error {color:var(--yellow)}
.pdf-viewport {background:color-mix(in srgb,var(--editor) 78%,var(--soft));scrollbar-gutter:stable;overflow-anchor:none;outline:none}
.pdf-viewport:focus-visible {box-shadow:inset 0 0 0 1px var(--accent)}
.pdf-pages {position:relative;min-height:100%}
.hand-mode {cursor:grab;user-select:none}.dragging {cursor:grabbing}
.hand-mode :deep(.textLayer span),.dragging :deep(.textLayer span) {cursor:inherit;user-select:none}
.password-container {display:grid;place-items:center;flex:1;padding:24px}
.password-form {display:flex;flex-direction:column;gap:12px;width:min(320px,100%);font-size:13px}
.password-form strong {font-size:16px;color:var(--bright)}
.password-form>span {color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.password-form input {background:var(--editor);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:8px}
.password-form>div {display:flex;justify-content:flex-end;gap:8px}
.password-form button {border:1px solid var(--line);border-radius:5px;background:var(--bar);color:var(--ink);padding:5px 14px;cursor:pointer}
.password-form .primary {background:var(--accentbg);color:var(--accent);border-color:var(--accent)}
.pdf-notice {padding:5px 12px;color:var(--ink);background:var(--bar);font-size:12px}
@container(max-width:850px) {.pdf-file-info,.zoom-label,.pdf-tools .secondary-action{display:none}.pdf-menu .compact-only{display:flex}}
@container(max-width:550px) {.pdf-tools .edge-nav{display:none}.pdf-menu .narrow-only{display:flex}.search-progress{display:none}.pdf-search input{width:140px}}
</style>
