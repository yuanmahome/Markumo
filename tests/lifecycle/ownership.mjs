import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
const baseline=process.argv.includes('--baseline'),results=[]
const server=await createServer({server:{host:'127.0.0.1',port:1502,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-ownership'})
await server.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage()
async function check(name,run){try{const details=await run();results.push({name,ok:true,...details});console.log('PASS',name)}catch(error){results.push({name,ok:false,error:String(error)});console.log('FAIL',name,String(error).slice(0,400))}}
try{
 await page.goto('http://127.0.0.1:1502/tests/markdown-links/fixture.html');await page.waitForFunction(()=>!!window.f)
 await check('120 recovery discard cycles release per-document bookkeeping',async()=>{
  const result=await page.evaluate(async()=>{
   window.f.reset('baseline');const m=window.f.manager
   const {RecoveryController}=await import('/src/features/recovery/RecoveryController.ts')
   const gateway={list:async()=>({records:[],warnings:[]}),remove:async()=>{},save:async input=>({record:{id:'record-'+(++gateway.sequence),name:input.name,path:input.path,updatedAt:Date.now(),charCount:input.text.length,sizeBytes:input.text.length,panes:[]},version:'v1',warnings:[]}),sequence:0}
   const recovery=new RecoveryController(m,{},gateway,()=>{}, {debounceMs:100000});await recovery.start()
   for(let i=0;i<120;i++){
    const id=m.createRecoveredDocument({id:'ownership-'+i,name:'draft.txt',text:'draft '+i+' 中文'.repeat(1000),encoding:'UTF-8',eol:'LF'})
    await recovery.flushForClose();m.close(id,true);await recovery.discardDocument(id)
   }
   const beforeDispose={lastSaved:recovery.lastSaved.size,summaries:recovery.savedSummaries.size,generations:recovery.generations instanceof Map?recovery.generations.size:null,pending:recovery.pending.size,claims:recovery.claims.size}
   recovery.dispose();return beforeDispose
  });assert.equal(result.summaries,0);assert.equal(result.lastSaved,0);assert.equal(result.pending,0);assert.equal(result.claims,0);assert(result.generations===null||result.generations===0);return result
 })
 await check('disposed recovery ignores a late write without erasing durable data',async()=>{
  const result=await page.evaluate(async()=>{
   window.f.reset('baseline');const m=window.f.manager,{RecoveryController}=await import('/src/features/recovery/RecoveryController.ts')
   let resolve,started;const began=new Promise(r=>started=r),stored=new Set()
   const gateway={list:async()=>({records:[],warnings:[]}),remove:async id=>stored.delete(id),save:input=>{started();return new Promise(r=>resolve=()=>{stored.add('late-record');r({record:{id:'late-record',name:input.name,path:null,updatedAt:Date.now(),charCount:input.text.length,sizeBytes:input.text.length,panes:[]},version:'v1',warnings:[]})})}}
   const recovery=new RecoveryController(m,{},gateway,()=>{}, {debounceMs:100000});await recovery.start()
   m.createRecoveredDocument({id:'late-draft',name:'late.txt',text:'unsaved content',encoding:'UTF-8',eol:'LF'})
   const flushing=recovery.flushForClose();await began;recovery.dispose();resolve();await flushing
   return{claims:recovery.claims.size,lastSaved:recovery.lastSaved.size,pending:recovery.pending.size,summaries:recovery.savedSummaries.size,durable:stored.size}
  });assert.equal(result.claims,0);assert.equal(result.lastSaved,0);assert.equal(result.pending,0);assert.equal(result.summaries,0);assert.equal(result.durable,1);return result
 })
 await check('120 resolved workspace pane opens leave no navigation tombstones',async()=>{
  const result=await page.evaluate(async()=>{
   window.f.reset('baseline');const m=window.f.manager,{WorkspaceController}=await import('/src/features/workspace/WorkspaceController.ts')
   const gateway={openWorkspaceFile:async path=>({token:path,path,name:'pane.txt',text:'pane content',encoding:'UTF-8',bom:false,eol:'LF',readOnly:false,version:'1'})}
   const files={accept:(file,preview,pane,focus)=>!!m.openFile(file,preview,pane,focus)}
   const workspace=new WorkspaceController(gateway,m,files,()=>{},false)
   const held=m.splitPane('right','main',m.activeId);m.focusPane('main')
   for(let i=0;i<120;i++){
    const pane=m.splitPane('right','main',m.activeId);m.focusPane(pane)
    await workspace.openFile({path:'C:/ownership/pane.txt',name:'pane.txt',isDirectory:false,isSymlink:false},false)
    for(const tab of [...m.layout.getPane(pane).group.tabs])m.close(tab.documentId,true,pane)
    m.focusPane('main')
   }
   for(const tab of [...m.layout.getPane(held).group.tabs])m.close(tab.documentId,true,held)
   m.focusPane('main')
   const result={navigation:workspace.latestPaneSeq.size,inFlight:workspace.inFlightOpens.size,pending:workspace.pendingReads.size,panes:m.layout.getAllPanes().length}
   workspace.destroy();return result
  });assert.equal(result.navigation,0,JSON.stringify(result));assert.equal(result.inFlight,0);assert.equal(result.pending,0);assert.equal(result.panes,1);return result
 })
 await check('visibility subscriptions share observers and release the final group',async()=>{
  const result=await page.evaluate(async()=>{
   const {observeRenderVisibility}=await import('/src/editor/markdown/renderVisibility.ts')
   const Native=window.IntersectionObserver,observers=[]
   class Observer{constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();this.disconnected=false;observers.push(this)}observe(target){this.targets.add(target)}unobserve(target){this.targets.delete(target)}disconnect(){this.targets.clear();this.disconnected=true}}
   window.IntersectionObserver=Observer
   const host=document.createElement('section');document.body.append(host)
   const targets=Array.from({length:200},()=>{const el=document.createElement('div');host.append(el);return el}),events=targets.map(()=>[])
   const stops=targets.map((el,i)=>observeRenderVisibility(el,{root:host},state=>events[i].push(state.visible)))
   for(const observer of observers)observer.callback([...observer.targets].map(target=>({target,isIntersecting:true})))
   stops[0]();for(const observer of observers)observer.callback([...observer.targets].map(target=>({target,isIntersecting:false})))
   const beforeDispose=events[0].length,active=observers.length
   stops.forEach(stop=>stop());for(const observer of observers)observer.callback([...targets].map(target=>({target,isIntersecting:true})))
   host.remove();window.IntersectionObserver=Native
   return{created:active,allDelivered:events.every((e,i)=>i===0||e.join(',')==='true,false'),stoppedUnchanged:events[0].length===beforeDispose,disconnected:observers.every(o=>o.disconnected),registrations:observers.reduce((sum,o)=>sum+o.targets.size,0)}
  });assert.equal(result.created,1);assert.equal(result.allDelivered,true);assert.equal(result.stoppedUnchanged,true);assert.equal(result.disconnected,true);assert.equal(result.registrations,0);return result
 })
 if(!baseline)await check('empty detached closure follows settled ownership, not only commit events',async()=>{
  const result=await page.evaluate(async()=>{
   const {EmptyDetachedWindow}=await import('/src/features/shell/EmptyDetachedWindow.ts')
   const state={detached:true,ready:true,documents:0,busy:false};let closed=0,resolve
   const closer=new EmptyDetachedWindow(()=>({...state}),()=>{closed++;return new Promise(r=>resolve=r)})
   closer.refresh();await Promise.resolve();if(closed)throw Error('Initial empty window closed')
   state.documents=1;closer.refresh();state.documents=0;state.busy=true;closer.refresh();await Promise.resolve()
   if(closed)throw Error('Busy handoff window closed')
   state.busy=false;closer.refresh();closer.refresh();await Promise.resolve();if(closed!==1)throw Error('Settled empty ownership must close exactly once')
   resolve();await Promise.resolve();closer.dispose();closer.refresh();return{closed}
  });assert.equal(result.closed,1);return result
 })
 fs.mkdirSync('test-results/lifecycle',{recursive:true});fs.writeFileSync(`test-results/lifecycle/ownership-${baseline?'before':'after'}.json`,JSON.stringify(results,null,2)+'\n')
 const failed=results.filter(result=>!result.ok);console.log(`OWNERSHIP ${baseline?'before':'after'}: ${results.length-failed.length}/${results.length}`)
 if(!baseline)assert.equal(failed.length,0,failed.map(f=>f.name).join('\n'))
}finally{await browser.close();await server.close()}
