import { sourceTextPosition } from '../../src/editor/markdown/wysiwyg/patchSourceBlock'
import { EditorState } from 'prosemirror-state'
import { DocumentManager } from '../../src/editor/core/DocumentManager'
import { MarkdownEditorController } from '../../src/editor/markdown/wysiwyg/MarkdownEditorController'
import { MarkdownSourceBridge } from '../../src/editor/markdown/wysiwyg/MarkdownSourceBridge'
import { LiveTableToolbar } from '../../src/editor/markdown/wysiwyg/LiveTableToolbar'
import { EditorView } from 'prosemirror-view'
import '../../src/styles/reset.css'
import '../../src/styles/variables.css'
import '../../src/editor/markdown/styles.css'
import '../../src/editor/markdown/presentation.css'
const times: Record<string, {calls:number;ms:number;max:number}> = {}
for(const [ctor,names] of [[MarkdownEditorController,['dispatch','updateTools','reveal','focus']], [MarkdownSourceBridge,['prepare','sourcePosition','documentPosition']], [LiveTableToolbar,['update']], [EditorView,['updateState','focus']]] as const) {
 for(const name of names) {
  const original=(ctor.prototype as any)[name]
  if(!original)continue
  ;(ctor.prototype as any)[name]=function(...args:unknown[]){const key=`${ctor.name}.${name}`,start=performance.now();try{return original.apply(this,args)}finally{const ms=performance.now()-start;const entry=times[key]??={calls:0,ms:0,max:0};entry.calls++;entry.ms+=ms;entry.max=Math.max(entry.max,ms)}}
 }
}
let manager = new DocumentManager([]);manager.setDefaultMarkdownMode('live');manager.setCaretAnimation('off')
Object.assign(window,{liveLarge:{sourceTextPosition,Bridge:MarkdownSourceBridge,EditorState,manager,times,id:'',reset(source:string){manager.dispose();document.querySelector('#app')!.replaceChildren();manager=new DocumentManager([]);manager.setDefaultMarkdownMode('live');manager.setCaretAnimation('off');this.manager=manager;return this.open(source)},open(source:string){const start=performance.now();this.id=manager.openFile({token:'large',path:'C:/large.md',name:'large.md',text:source,encoding:'UTF-8',bom:false,eol:'LF',readOnly:false,version:'fixture'})!;manager.mountPane(document.querySelector('#app') as HTMLElement,'main');return performance.now()-start},live(){return manager.liveViews.get(manager.activePane)?.editor}}})
