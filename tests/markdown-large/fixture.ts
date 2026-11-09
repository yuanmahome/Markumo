import { structureBatches } from '../../src/editor/markdown/preview/structure'
import { HeightIndex } from '../../src/editor/markdown/preview/HeightIndex'
import { createApp, h, ref } from 'vue'
import SplitPreview from '../../src/editor/markdown/splitPreview.vue'
const content = ref(''), view = ref<any>()
createApp({setup:()=>()=>h(SplitPreview,{ref:view, content:content.value,style:'height:700px;width:800px'})}).mount('#app')
;(window as any).large = { structureBatches: (source:string) => [...structureBatches(source)], HeightIndex, set:(value:string)=>content.value=value, jump:(line:number)=>view.value.syncScroll(line) }
