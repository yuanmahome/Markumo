<template>
  <section class="media-viewer image-viewer" aria-label="图片查看器">
    <div class="image-toolbar" role="toolbar" aria-label="图片工具栏">
      <div class="image-tools">
        <button aria-label="缩小" title="缩小 (−)" :disabled="!ready" @click="zoom(1/1.25)"><ViewerIcon name="zoom-out" /></button>
        <select :value="view.scale" aria-label="图片缩放比例" :disabled="!ready" @change="setScale(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="scale in zoomOptions" :key="scale" :value="scale">{{ Math.round(scale*100) }}%</option>
        </select>
        <button aria-label="放大" title="放大 (+)" :disabled="!ready" @click="zoom(1.25)"><ViewerIcon name="zoom-in" /></button>
        <span class="tool-divider" />
        <button aria-label="原始尺寸 100%" title="原始尺寸 (100%)" :class="{ selected: view.fit==='manual' && view.scale===1 }" :disabled="!ready" @click="original"><span class="actual-size">1:1</span></button>
        <button aria-label="适应窗口" title="适应窗口 (F)" :aria-pressed="view.fit==='page'" :disabled="!ready" @click="fit('page')"><ViewerIcon name="fit" /></button>
        <button aria-label="适应宽度" title="适应宽度" :aria-pressed="view.fit==='width'" :disabled="!ready" @click="fit('width')"><ViewerIcon name="width" /></button>
        <span class="tool-divider" />
        <button aria-label="旋转 90°" title="顺时针旋转 90° (R)" :disabled="!ready" @click="rotate"><ViewerIcon name="rotate" /></button>
        <button aria-label="重置图片视图" title="重置视图 (0)" :disabled="!ready" @click="reset"><ViewerIcon name="reset" /></button>
        <span class="tool-divider" />
        <button aria-label="重新加载图片" title="重新读取磁盘文件" @click="load"><ViewerIcon name="refresh" /></button>
        <button aria-label="使用系统默认程序打开图片" title="使用系统默认程序打开" @click="openDefault"><ViewerIcon name="external" /></button>
      </div>
      <span v-if="ready" class="image-details" :title="`${doc.name} · ${width} × ${height} · ${meta?.format} · ${mediaSize(meta?.byteLength || 0)}`">
        <span>{{ width }} × {{ height }}</span><span class="image-file-info">{{ meta?.format }} · {{ mediaSize(meta?.byteLength || 0) }}</span>
      </span>
    </div>
    <MediaEmpty v-if="!ready" :error="error" :token="doc.fileToken" @retry="load" />
    <div v-show="ready" ref="viewport" class="media-viewport image-viewport" :class="{ 'can-pan':canPan, dragging:!!drag }" tabindex="0" aria-label="图片预览，按加减号缩放，拖动平移" @scroll="saveScroll" @pointerdown="startPan" @pointermove="pan" @pointerup="endPan" @pointercancel="endPan" @wheel="wheel" @keydown="keydown" @dblclick="view.scale===1 ? fit('page') : original()">
      <div class="image-canvas" :style="{ width:`${rotatedWidth*view.scale+64}px`, height:`${rotatedHeight*view.scale+64}px` }">
        <div ref="stage" class="image-stage" :style="{ width:`${rotatedWidth*view.scale}px`, height:`${rotatedHeight*view.scale}px` }">
          <div class="image-surface" :style="{ width:`${width*view.scale}px`,height:`${height*view.scale}px`,transform:`translate(-50%,-50%) rotate(${view.rotation}deg)` }">
            <img v-if="url" :src="url" :alt="doc.name" decoding="async" draggable="false" />
          </div>
        </div>
      </div>
    </div>
    <div v-if="error && ready" class="image-notice" role="alert">{{ error }}</div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { EditorDocument } from '../../types'
import type { MediaMetadata } from '../../features/files/contracts'
import { MEDIA_CHUNK, mediaMetadata, mediaSize, openMediaDefault, readMediaChunk, type MediaViewState } from '../../features/files/media'
import { fileError } from '../../features/files/FileController'
import MediaEmpty from './MediaEmpty.vue'
import ViewerIcon from './ViewerIcon.vue'
import './viewer.css'
const props = defineProps<{ doc: EditorDocument; state: MediaViewState }>()
const emit = defineEmits<{ (e:'metadata', media:MediaMetadata, version:string):void }>()
const view = reactive(props.state), viewport = ref<HTMLElement>(), stage = ref<HTMLElement>(), width = ref(0), height = ref(0), url = ref(''), ready = ref(false), error = ref(''), meta = ref<MediaMetadata>()
const bounds = reactive({ width:0, height:0 })
const canPan = computed(()=>rotatedWidth.value*view.scale+64>bounds.width || rotatedHeight.value*view.scale+64>bounds.height)
const zoomOptions = computed(()=>[...new Set([.25,.5,.75,1,1.5,2,4,8,16,view.scale])].sort((a,b)=>a-b))
const rotatedWidth = computed(() => view.rotation % 180 ? height.value : width.value)
const rotatedHeight = computed(() => view.rotation % 180 ? width.value : height.value)
let generation = 0, disposed = false, observer: ResizeObserver | undefined, probe: HTMLImageElement | undefined
let cancelDecode: (()=>void) | undefined
const MAX_ENCODED = 128 * 1024 * 1024, MAX_PIXELS = 64 * 1024 * 1024
function release() { ready.value = false; cancelDecode?.();cancelDecode=undefined;if (probe) { probe.src = ''; probe = undefined }; if (url.value) URL.revokeObjectURL(url.value); url.value = '' }
async function load() {
  const current = ++generation; release(); error.value = ''
  try {
    const [metadata, version] = await mediaMetadata(props.doc.fileToken!)
    if (disposed || generation !== current) return
    meta.value = metadata
    emit('metadata',metadata,version)
    if(!metadata.mime.startsWith('image/'))throw new Error('文件已不再是图片，请关闭后重新打开。')
    if (metadata.byteLength > MAX_ENCODED) throw new Error('图片超过 128 MiB 读取预算，请使用系统图片程序。')
    if (metadata.width && metadata.height && (metadata.width>32768 || metadata.height>32768 || metadata.width*metadata.height>MAX_PIXELS)) throw new Error('图片分辨率超过 64M 像素或单边 32768 像素的预览预算，请使用系统图片程序。')
    const parts: BlobPart[] = []
    for (let offset=0; offset<metadata.byteLength; offset+=MEDIA_CHUNK) {
      const bytes = await readMediaChunk(props.doc.fileToken!, version, offset, Math.min(MEDIA_CHUNK, metadata.byteLength-offset))
      if (disposed || generation !== current) { parts.length = 0; release(); return }
      parts.push(bytes.buffer as ArrayBuffer)
    }
    const blob = new Blob(parts, { type:metadata.mime }); parts.length = 0
    const objectUrl = URL.createObjectURL(blob); url.value = objectUrl
    const image = new Image(); probe = image; image.decoding = 'async'; image.width=1;image.height=1
    // Intrinsic dimensions are available at load; decoding is delegated to the native decoder.
    await new Promise<void>((resolve,reject) => {
      const clear=()=>{image.onload=null;image.onerror=null;cancelDecode=undefined}
      cancelDecode=()=>{clear();reject(new DOMException('图片加载已取消','AbortError'))}
      image.onload=()=>{clear();resolve()}
      image.onerror=()=>{clear();reject(new Error(`当前 WebView 无法解码 ${metadata.format} 图片，文件可能损坏或格式不受支持。`))}
      image.src=objectUrl
    })
    if (disposed || generation !== current) return
    width.value=image.naturalWidth; height.value=image.naturalHeight
    if (!width.value || !height.value || width.value>32768 || height.value>32768 || width.value*height.value>MAX_PIXELS) throw new Error('图片分辨率超过 64M 像素或单边 32768 像素的预览预算，请使用系统图片程序。')
    ready.value=true; probe=undefined; await nextTick()
    if (view.fit !== 'manual') fit(view.fit)
    if (viewport.value) { viewport.value.scrollLeft=view.left; viewport.value.scrollTop=view.top }
  } catch (e) { if (!disposed && generation===current) { error.value=fileError(e); release() } }
}
function saveScroll() { if (viewport.value) { view.left=viewport.value.scrollLeft; view.top=viewport.value.scrollTop } }
function fit(mode: string) {
  view.fit=mode
  if (!viewport.value || !ready.value) return
  const w = Math.max(1,viewport.value.clientWidth-64)/rotatedWidth.value, h = Math.max(1,viewport.value.clientHeight-64)/rotatedHeight.value
  view.scale = Math.max(.01,Math.min(mode==='width' ? w : Math.min(1,w,h),16))
}
function setScale(scale:number, anchor?:{x:number;y:number}) {
  if(!ready.value||!viewport.value||!Number.isFinite(scale))return
  const box=viewport.value.getBoundingClientRect(),before=stage.value?.getBoundingClientRect()
  const point=anchor||{x:box.left+box.width/2,y:box.top+box.height/2}
  const relative=before?{x:(point.x-before.left)/before.width,y:(point.y-before.top)/before.height}:undefined
  view.fit='manual';view.scale=Math.max(.01,Math.min(16,scale))
  void nextTick(()=>{const after=stage.value?.getBoundingClientRect();if(after&&relative&&viewport.value){viewport.value.scrollLeft+=after.left+relative.x*after.width-point.x;viewport.value.scrollTop+=after.top+relative.y*after.height-point.y}})
}
function zoom(factor:number) { setScale(view.scale*factor) }
function original() { setScale(1) }
function rotate() { view.rotation=(view.rotation+90)%360; if(view.fit!=='manual')fit(view.fit) }
function reset() { view.rotation=0; view.left=0; view.top=0; fit('page'); viewport.value?.scrollTo(0,0) }
const drag=ref<{x:number;y:number;left:number;top:number}>()
function startPan(e:PointerEvent) { if(e.button!==0||!canPan.value||!viewport.value)return; viewport.value.focus();viewport.value.setPointerCapture(e.pointerId); drag.value={x:e.clientX,y:e.clientY,left:viewport.value.scrollLeft,top:viewport.value.scrollTop} }
function pan(e:PointerEvent) { const start=drag.value;if(start&&viewport.value) {viewport.value.scrollLeft=start.left+start.x-e.clientX;viewport.value.scrollTop=start.top+start.y-e.clientY} }
function endPan() { drag.value=undefined }
function wheel(e:WheelEvent) {if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();e.stopPropagation();setScale(view.scale*(e.deltaY<0?1.1:1/1.1),{x:e.clientX,y:e.clientY})}
function keydown(e:KeyboardEvent) {if(e.ctrlKey||e.metaKey||e.altKey)return;const key=e.key.toLowerCase();if(['+','=','-','0','f','r'].includes(key))e.preventDefault();if(key==='+'||key==='=')zoom(1.25);else if(key==='-')zoom(1/1.25);else if(key==='0')reset();else if(key==='f')fit('page');else if(key==='r')rotate()}
async function openDefault() {try{await openMediaDefault(props.doc.fileToken!)}catch(e){error.value=fileError(e)}}
onMounted(()=>{ observer=new ResizeObserver(()=>{bounds.width=viewport.value?.clientWidth||0;bounds.height=viewport.value?.clientHeight||0;if(view.fit!=='manual')fit(view.fit)}); if(viewport.value)observer.observe(viewport.value); void load() })
onBeforeUnmount(()=>{
  disposed=true;generation++;observer?.disconnect();saveScroll()
  if(stage.value){for(const img of stage.value.querySelectorAll('img')){img.onload=img.onerror=null;img.removeAttribute('src');img.remove()}}
  release();drag.value=undefined
})
</script>
<style scoped>
.image-viewer {container-type:inline-size;--image-canvas:color-mix(in srgb,var(--editor) 84%,var(--soft))}
.image-toolbar { display:flex;align-items:center;gap:16px;min-height:36px;padding:3px 10px;flex:none;border-bottom:1px solid var(--line);background:var(--editor) }
.image-tools {display:flex;align-items:center;gap:2px;flex:0 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
.image-toolbar button {display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--sub);cursor:pointer;flex:none}
.image-toolbar button:hover {background:var(--hover);color:var(--bright)}
.image-toolbar button[aria-pressed=true],.image-toolbar button.selected {background:var(--accentbg);color:var(--accent)}
.image-toolbar button:disabled {opacity:.35;cursor:default;background:transparent}
.image-toolbar button:focus-visible,.image-toolbar select:focus-visible {outline:1px solid var(--accent);outline-offset:1px}
.image-toolbar select {width:73px;height:26px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--ink);font:inherit;font-size:12px;text-align:center;cursor:pointer;font-variant-numeric:tabular-nums;flex:none}
.image-toolbar select:hover {background:var(--hover)}
.image-toolbar option {background:var(--bar);color:var(--ink)}
.tool-divider {height:16px;width:1px;background:var(--line);margin:0 6px;flex:none}
.actual-size {font-size:11px;letter-spacing:-.5px;font-weight:500}
.image-details {display:flex;align-items:center;justify-content:flex-end;gap:14px;margin-left:auto;min-width:0;overflow:hidden;white-space:nowrap;color:var(--sub);font-size:11px;font-variant-numeric:tabular-nums}
.image-file-info {color:var(--muted)}
.image-viewport {background:var(--image-canvas);touch-action:none;outline:none}
.image-viewport:focus-visible {box-shadow:inset 0 0 0 1px var(--accent)}
.can-pan {cursor:grab}.dragging {cursor:grabbing}
.image-canvas {min-width:100%;min-height:100%;box-sizing:border-box;display:grid;place-items:center;padding:32px}
.image-stage {position:relative;flex:none}
.image-surface {position:absolute;left:50%;top:50%;background:var(--editor);box-shadow:0 0 0 1px #8883,0 4px 16px #0000000d}
img {display:block;width:100%;height:100%;max-width:none;user-select:none;pointer-events:none}
.image-notice {padding:5px 12px;color:var(--ink);font-size:var(--ui-small-font-size)}
@media(max-width:900px) {.image-file-info{display:none}.image-toolbar{gap:8px}}
@container(max-width:650px) {.image-details{display:none}}
</style>
