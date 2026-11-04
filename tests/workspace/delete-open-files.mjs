import assert from 'node:assert/strict'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const server=await createServer({server:{host:'127.0.0.1',port:1504,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-delete-open'})
await server.listen()
const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[]
page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto('http://127.0.0.1:1504/tests/markdown-links/fixture.html');await page.waitForFunction(()=>!!window.f)
 const results=await page.evaluate(async()=>{
  const {WorkspaceController}=await import('/src/features/workspace/WorkspaceController.ts')
  const results=[]
  function setup(){
   window.f.reset('baseline');const m=window.f.manager;m.close(window.f.id,true)
   const released=[],discarded=[],notices=[],calls=[]
   m.onFileRelease(token=>released.push(token))
   const file=(path,token=path)=>({token,path,name:path.split('/').pop(),text:'original',encoding:'UTF-8',eol:'LF',bom:false,readOnly:false,version:'v1'})
   const gateway={deleteNode:async path=>{calls.push(path);return path},cancelSearch:async()=>{},openWorkspaceFile:async path=>file(path)}
   const files={workspaceBusy:false,activeOperationCount:0,saving:new Set(),gateway:{release:async token=>released.push(token)},accept:(f,preview,pane,focus)=>!!m.openFile(f,preview,pane,focus)}
   const w=new WorkspaceController(gateway,m,files,message=>notices.push(message),false)
   w.setDeletedDocumentHandler(async ids=>discarded.push(...ids))
   const open=path=>{const id=m.openFile(file(path),false);m.dispatch(id,{changes:{from:0,insert:'unsaved '}});return id}
   return{m,w,gateway,file,open,released,discarded,notices,calls}
  }
  const require=(value,message)=>{if(!value)throw Error(message)}
  {
   const s=setup(),id=s.open('C:/project/deleted/a.md'),child=s.open('C:/project/deleted/nested/b.txt'),keep=s.open('C:/project/deleted-other/keep.txt')
   s.m.splitPane('right',s.m.activePane,id)
   let finish;s.gateway.deleteNode=path=>{s.calls.push(path);return new Promise(resolve=>finish=resolve)}
   const deleting=s.w.deleteNode({path:'C:/project/deleted',isDirectory:true})
   require(s.m.metadata(id)?.dirty&&s.m.metadata(child)?.dirty,'Tabs must remain until native success')
   finish('deleted');await deleting
   require(!s.m.metadata(id)&&!s.m.metadata(child),'Directory deletion must close every matching document')
   require(s.m.layout.getAllPanes().every(p=>p.group.tabs.every(t=>t.documentId!==id&&t.documentId!==child)),'All pane copies must close')
   require(s.m.getText(keep)==='unsaved original'&&s.m.metadata(keep).dirty,'Sibling path and dirty contents must survive')
   require(s.released.length===2&&s.discarded.length===2&&s.notices.length===0,'Each file and owned recovery claim must release once')
   results.push('dirty directory documents and all pane copies close only after successful deletion');s.w.destroy()
  }
  {
   const s=setup(),id=s.open('C:/project/a.txt')
   s.gateway.deleteNode=async()=>{throw Error('disk failure')}
   await s.w.deleteNode({path:'C:/project/a.txt',isDirectory:false})
   require(s.m.getText(id)==='unsaved original'&&s.m.metadata(id).dirty,'Deletion failure must retain the exact dirty document')
   require(!s.released.length&&!s.discarded.length&&s.notices[0].includes('删除失败'),'Failure must not release tabs or recovery')
   results.push('failed deletion preserves dirty text, tabs, grants and recovery');s.w.destroy()
  }
  {
   const s=setup(),id=s.open('C:/project/a.txt'),keep=s.open('C:/project/b.txt')
   Object.defineProperty(s.m,'isComposing',{get:()=>true,configurable:true})
   require(s.m.close(id,true)==='composing','Normal close must still respect composition')
   await s.w.acceptDeletedPath('\\\\?\\C:\\project\\a.txt')
   require(!s.m.metadata(id)&&s.m.getText(keep)==='unsaved original','Committed remote deletion closes only its document')
   await s.w.acceptDeletedPath('C:/project/a.txt')
   require(s.discarded.length===1,'Duplicate delete notification must be idempotent')
   results.push('remote deletion handles path spelling, composition and duplicate notifications');s.w.destroy()
  }
  {
   const s=setup(),{RecoveryController}=await import('/src/features/recovery/RecoveryController.ts')
   let finish,started;const began=new Promise(resolve=>started=resolve),stored=new Set(['unclaimed-draft'])
   const recoveryGateway={list:async()=>({records:[],warnings:[]}),remove:async id=>stored.delete(id),save:input=>{started();return new Promise(resolve=>finish=()=>{stored.add('deleted-snapshot');resolve({record:{id:'deleted-snapshot',name:input.name,path:input.path,updatedAt:Date.now(),charCount:input.text.length,sizeBytes:input.text.length,panes:[]},version:'v1',warnings:[]})})}}
   const recovery=new RecoveryController(s.m,{},recoveryGateway,()=>{}, {debounceMs:100000});await recovery.start()
   s.w.setDeletedDocumentHandler(async ids=>{for(const id of ids)await recovery.discardDocument(id)})
   const id=s.open('C:/project/snapshot.txt'),flushing=recovery.flushForClose();await began
   const deleting=s.w.deleteNode({path:'C:/project/snapshot.txt',isDirectory:false})
   await Promise.resolve();finish();await flushing;await deleting
   require(!s.m.metadata(id),'Deletion must close the document while recovery writes settle')
   require(stored.size===1&&stored.has('unclaimed-draft'),'Deletion must remove its late recovery snapshot and preserve unrelated drafts')
   require(!recovery.claims.size&&!recovery.pending.size,'Deletion must release recovery ownership')
   recovery.dispose();s.w.destroy();results.push('deletion clears an in-flight owned recovery snapshot and preserves unrelated drafts')
  }
  {
   const s=setup();let finish
   s.gateway.openWorkspaceFile=path=>new Promise(resolve=>finish=()=>resolve(s.file(path,'late-token')))
   const opening=s.w.openWorkspaceFileInPane({path:'C:/project/late.txt',paneId:s.m.activePane})
   await s.w.acceptDeletedPath('C:/project/late.txt');finish()
   require(!(await opening).success,'A pending read must not reopen a deleted file')
   await Promise.resolve();require(s.released.includes('late-token'),'Late unadopted file grant must release')
   results.push('in-flight open cannot resurrect a deleted tab');s.w.destroy()
  }
  return results
 })
 assert.equal(results.length,5);assert.deepEqual(errors,[])
 for(const result of results)console.log('PASS',result)
 console.log('DELETE OPEN FILES 5/5 passed')
}finally{await browser.close();await server.close()}
