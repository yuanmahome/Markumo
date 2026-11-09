import { createApp, h, ref } from 'vue'
import { DocumentManager } from '../../src/editor/core/DocumentManager'
import DocumentStats from '../../src/features/document-stats/DocumentStats.vue'
import { countText, combine, type StatisticKind } from '../../src/features/document-stats/counts'
import { Text } from '@codemirror/state'
import { settingsFrom } from '../../src/features/shell/editorSettings'
const manager = new DocumentManager([]);manager.setDefaultMarkdownMode('source')
const id=manager.openFile({token:'stats',name:'stats.md',path:'C:/stats.md',text:'中文 English 👩‍💻 é\n\n第二段',encoding:'UTF-8',bom:false,eol:'LF',readOnly:false,diskVersion:'fixture'})!
const kind=ref<StatisticKind>('words')
createApp({setup:()=>()=>h(DocumentStats,{manager,id,kind:kind.value,onChange:(value:StatisticKind)=>kind.value=value})}).mount('#app')
Object.assign(window,{stats:{manager,id,countText,combine,Text,settingsFrom}})
