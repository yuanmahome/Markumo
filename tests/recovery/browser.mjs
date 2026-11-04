import assert from 'node:assert/strict'
import fs from 'node:fs'
import {chromium} from 'playwright'
import {createServer} from 'vite'

const server=await createServer({server:{host:'127.0.0.1',port:1506,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-recovery'})
await server.listen()
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[],results=[]
page.on('pageerror',error=>errors.push(error.message))
async function check(name,run){try{await run();results.push({name,passed:true});console.log('PASS',name)}catch(error){results.push({name,passed:false,error:String(error)});console.log('FAIL',name,String(error))}}
try{
 await page.goto('http://127.0.0.1:1506/tests/markdown-links/fixture.html');await page.waitForFunction(()=>!!window.f)
 await page.evaluate(async()=>{
  const {RecoveryController,createApp,h,RecoveryDialog}=await import('/tests/recovery/fixture.ts')
  window.setupRecovery=async(count=0,debounceMs=100000)=>{
   window.r?.app.unmount();window.r?.recovery.dispose();window.f.reset('baseline')
   const m=window.f.manager;m.close(window.f.id,true)
   const stored=new Map(),calls={save:[],remove:[]},notices=[],failures=new Set()
   const summary=body=>({id:body.id,name:body.name,path:body.path,updatedAt:body.updatedAt,charCount:body.text.length,sizeBytes:body.text.length,mode:body.mode,panes:body.panes,diskExists:!!body.path,diskChanged:false})
   for(let i=0;i<count;i++)stored.set('old-'+i,{id:'old-'+i,name:'相同标题.md',path:null,text:i===count-1?'不同版本':'相同正文',encoding:'UTF-8',bom:false,eol:'LF',mode:'live',panes:[{pane:'main',mode:'live'}],updatedAt:1000+i,version:'old-version-'+i,diskVersion:null})
   const gateway={
    list:async()=>({records:[...stored.values()].map(summary),warnings:[]}),
    read:async id=>{if(!stored.has(id))throw Error('missing record');return structuredClone(stored.get(id))},
    save:async input=>{
     calls.save.push(structuredClone(input));const previous=stored.get(input.id)
     const id=previous&&previous.version===input.expectedVersion?input.id:'new-'+calls.save.length
     const body={...structuredClone(input),id,updatedAt:Date.now(),version:'version-'+calls.save.length}
     if(gateway.saveGate){const gate=gateway.saveGate;gateway.saveGate=null;await gate}
     stored.set(id,body);return{record:summary(body),version:body.version,warnings:[]}
    },
    remove:async id=>{calls.remove.push(id);if(gateway.removeGate)await gateway.removeGate;if(failures.has(id))throw Error('disk denied');stored.delete(id)},
   }
   const recovery=new RecoveryController(m,{saving:new Set(),workspaceBusy:false},gateway,text=>notices.push(text),{debounceMs});await recovery.start()
   let host=document.getElementById('recovery-test');if(!host){host=document.createElement('div');host.id='recovery-test';document.body.append(host)}
   const app=createApp({render:()=>h(RecoveryDialog,{visible:recovery.visible.value,records:recovery.records.value,busy:recovery.busy.value,diff:recovery.diff.value,error:recovery.lastError.value,onClose:()=>recovery.close(),onRestore:record=>recovery.restore(record),onDiscard:record=>recovery.discard(record),'onRestore-all':()=>recovery.restoreAll(),'onDiscard-all':()=>recovery.discardAll(),onDiff:record=>recovery.showDiff(record),'onClose-diff':()=>recovery.clearDiff()})});app.mount(host)
   window.r={m,recovery,gateway,stored,calls,notices,failures,app}
  }
 })
 await check('one document owns one snapshot across metadata reads, panes, flushes and edits',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery();const{m,recovery,calls,stored}=window.r,id=m.createRecoveredDocument({id:'one',name:'相同标题.md',text:'# 中文\n\n未保存正文',encoding:'UTF-8'})
   m.splitPane('right',m.activePane,id);await recovery.flushForClose()
   for(let i=0;i<5;i++){m.metadata(id);recovery.refresh();await recovery.flushForClose()}
   const initial={writes:calls.save.length,records:stored.size,claims:recovery.claims.size,pending:recovery.pending.size}
   m.dispatch(id,{changes:{from:0,insert:'新增'}});await recovery.flushForClose()
   const result={initial,writes:calls.save.length,records:stored.size,claim:recovery.claims.get(id),second:calls.save[1],texts:[...stored.values()].map(body=>body.text)}
   recovery.dispose();return result
  })
  assert.deepEqual(result.initial,{writes:1,records:1,claims:1,pending:0});assert.equal(result.writes,2);assert.equal(result.records,1)
  assert.equal(result.second.id,'new-1');assert.equal(result.second.expectedVersion,'version-1');assert.equal(result.claim.recordId,'new-1');assert.deepEqual(result.texts,['新增# 中文\n\n未保存正文'])
 })
 if(!process.argv.includes('--identity-only')){
 await check('debounced snapshot settles without a zero-delay rewrite loop',async()=>{
  await page.evaluate(async()=>{await window.setupRecovery(0,15);window.r.m.createRecoveredDocument({id:'timer',name:'timer.txt',text:'pending',encoding:'UTF-8'})})
  await page.waitForFunction(()=>window.r.calls.save.length>0);await page.waitForTimeout(150)
  const result=await page.evaluate(()=>{const{recovery,calls,stored}=window.r;const result={writes:calls.save.length,records:stored.size,pending:recovery.pending.size};recovery.dispose();return result})
  assert.deepEqual(result,{writes:1,records:1,pending:0})
 })
 await check('edits during a write retain the claim and update the same snapshot',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery();const{m,recovery,gateway,calls,stored}=window.r
   const id=m.createRecoveredDocument({id:'editing',name:'editing.txt',text:'before',encoding:'UTF-8'});let release
   gateway.saveGate=new Promise(resolve=>release=resolve);const flushing=recovery.flushForClose();await Promise.resolve();await Promise.resolve()
   m.dispatch(id,{changes:{from:0,insert:'after '}});release();await flushing;await recovery.flushForClose()
   const result={writes:calls.save.length,records:stored.size,text:[...stored.values()][0].text,second:calls.save[1]};recovery.dispose();return result
  });assert.equal(result.writes,2);assert.equal(result.records,1);assert.equal(result.text,'after before');assert.equal(result.second.id,'new-1')
 })
 await check('closing and reusing an id cannot adopt the old in-flight snapshot',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery();const{m,recovery,gateway,stored}=window.r;let release
   m.createRecoveredDocument({id:'reused',name:'same.txt',text:'old buffer',encoding:'UTF-8'});gateway.saveGate=new Promise(resolve=>release=resolve)
   const flushing=recovery.flushForClose();await Promise.resolve();await Promise.resolve();m.close('reused',true)
   const afterClose=recovery.generations.size
   m.createRecoveredDocument({id:'reused',name:'same.txt',text:'new buffer',encoding:'UTF-8'});release();await flushing
   const claimBefore=recovery.claims.has('reused');await recovery.flushForClose();await recovery.reload()
   const result={afterClose,claimBefore,texts:[...stored.values()].map(r=>r.text).sort(),listed:recovery.records.value.map(r=>r.id)};recovery.dispose();return result
  });assert.equal(result.afterClose,0);assert.equal(result.claimBefore,false);assert.deepEqual(result.texts,['new buffer','old buffer']);assert.deepEqual(result.listed,['new-1'])
 })
 await check('saving cleans only owned snapshots and leaves same-path earlier drafts intact',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery(1);const{m,recovery,stored}=window.r,old=stored.get('old-0');old.path='C:/draft/file.md'
   const file={token:'file',path:old.path,name:old.name,text:'disk',encoding:'UTF-8',bom:false,eol:'LF',readOnly:false,version:'disk-1'}
   const id=m.openFile(file,false);m.dispatch(id,{changes:{from:0,insert:'edit '}});await recovery.flushForClose()
   m.saveSnapshot(id).complete({...file,version:'disk-2'});await recovery.onSaved(id);await recovery.reload()
   const result={ids:[...stored.keys()],text:stored.get('old-0').text,claims:recovery.claims.size};recovery.dispose();return result
  });assert.deepEqual(result,{ids:['old-0'],text:'不同版本',claims:0})
 })
 await check('restoring a chosen draft reuses its record, including a repeated restore request',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery(1);const{m,recovery,stored,calls}=window.r,record=recovery.records.value[0]
   const first=await recovery.restore(record),second=await recovery.restore(record)
   const result={first,second,documents:m.openedDocuments.length,ids:[...stored.keys()],text:m.getText(m.activeId),listed:recovery.records.value.length,inputs:calls.save.map(input=>input.id)};recovery.dispose();return result
  });assert.deepEqual(result,{first:true,second:true,documents:1,ids:['old-0'],text:'不同版本',listed:0,inputs:['old-0','old-0']})
 })
 await check('reload checkpoint detaches a durable draft that a later normal save cannot erase',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery();const{m,recovery,stored}=window.r
   const file={token:'checkpoint',path:'C:/draft/checkpoint.txt',name:'checkpoint.txt',text:'disk',encoding:'UTF-8',bom:false,eol:'LF',readOnly:false,version:'disk-1'}
   const id=m.openFile(file,false);m.dispatch(id,{changes:{from:0,insert:'discarded '}})
   const checkpoint=await recovery.checkpointBeforeReload(id),claims=recovery.claims.size
   m.reloadFile(id,{...file,text:'external',version:'disk-2'},true);await recovery.onSaved(id)
   m.dispatch(id,{changes:{from:0,insert:'new '}});await recovery.flushForClose()
   const result={checkpoint,claims,texts:[...stored.values()].map(r=>r.text).sort(),claimed:recovery.claims.get(id)?.recordId,listed:recovery.records.value.map(r=>r.id)};recovery.dispose();return result
  });assert.deepEqual(result,{checkpoint:true,claims:0,texts:['discarded disk','new external'],claimed:'new-2',listed:['new-1']})
 })
 await check('bulk discard requires confirmation, supports cancel/Escape and removes 63 listed drafts only',async()=>{
  await page.evaluate(async()=>{
   await window.setupRecovery(63);const{m,recovery}=window.r
   m.createRecoveredDocument({id:'active',name:'active.txt',text:'active unsaved content',encoding:'UTF-8'});await recovery.flushForClose();await recovery.open()
  })
  const dialog=page.getByRole('dialog',{name:'未保存文档恢复'}),all=dialog.getByRole('button',{name:'全部丢弃',exact:true})
  await all.click();assert.equal(await page.evaluate(()=>window.r.calls.remove.length),0)
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.evaluate(()=>window.r.stored.size),64)
  await all.click();await page.keyboard.press('Escape');assert.equal(await dialog.getByRole('button',{name:'确认全部丢弃'}).count(),0);assert(await dialog.isVisible())
  await all.click();await dialog.getByRole('button',{name:'确认全部丢弃'}).click();await dialog.waitFor({state:'hidden'})
  const result=await page.evaluate(()=>({records:window.r.stored.size,removed:window.r.calls.remove.length,text:window.r.m.getText('active'),dirty:window.r.m.metadata('active').dirty,claimed:window.r.recovery.claims.get('active').recordId,ids:[...window.r.stored.keys()]}))
  assert.deepEqual(result,{records:1,removed:63,text:'active unsaved content',dirty:true,claimed:'new-1',ids:['new-1']})
 })
 await check('partial bulk failure stays visible and retry deletes only remaining drafts',async()=>{
  await page.evaluate(async()=>{await window.setupRecovery(3);const{gateway,failures}=window.r;failures.add('old-1');gateway.removeGate=new Promise(resolve=>window.releaseRemove=()=>{gateway.removeGate=null;resolve()})})
  const dialog=page.getByRole('dialog',{name:'未保存文档恢复'})
  await dialog.getByRole('button',{name:'全部丢弃',exact:true}).click();await dialog.getByRole('button',{name:'确认全部丢弃'}).click()
  await page.waitForFunction(()=>window.r.recovery.busy.value);assert.equal(await dialog.locator('button:not(:disabled)').count(),0)
  await page.evaluate(()=>{void window.r.recovery.discardAll();window.releaseRemove()})
  await page.waitForFunction(()=>!window.r.recovery.busy.value)
  assert(await dialog.isVisible());assert.equal(await dialog.locator('.recovery-row').count(),1);assert.match(await dialog.getByRole('alert').innerText(),/1.*失败/)
  assert.deepEqual(await page.evaluate(()=>window.r.calls.remove),['old-0','old-1','old-2'])
  await page.evaluate(()=>window.r.failures.clear());await dialog.getByRole('button',{name:'全部丢弃',exact:true}).click();await dialog.getByRole('button',{name:'确认全部丢弃'}).click();await dialog.waitFor({state:'hidden'})
  assert.deepEqual(await page.evaluate(()=>window.r.calls.remove),['old-0','old-1','old-2','old-1'])
 })
 await check('current-session discard remains separate from discarding listed recovery drafts',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery(2);const{m,recovery,stored}=window.r
   m.createRecoveredDocument({id:'current',name:'current.txt',text:'dirty',encoding:'UTF-8'});await recovery.flushForClose();await recovery.discardActive()
   const result={ids:[...stored.keys()],text:m.getText('current')};recovery.dispose();return result
  });assert.deepEqual(result,{ids:['old-0','old-1'],text:'dirty'})
 })
 await check('single discard keeps a failed record visible and supports retry',async()=>{
  await page.evaluate(async()=>{await window.setupRecovery(2);window.r.failures.add('old-0')})
  const dialog=page.getByRole('dialog',{name:'未保存文档恢复'}),row=dialog.locator('.recovery-row').first()
  await row.getByRole('button',{name:'删除恢复稿',exact:true}).click();await row.getByRole('button',{name:'确认删除备份'}).click()
  await page.waitForFunction(()=>!window.r.recovery.busy.value);assert.equal(await dialog.locator('.recovery-row').count(),2)
  await page.evaluate(()=>window.r.failures.clear());await row.getByRole('button',{name:'删除恢复稿',exact:true}).click();await row.getByRole('button',{name:'确认删除备份'}).click()
  await page.waitForFunction(()=>window.r.recovery.records.value.length===1);assert.deepEqual(await page.evaluate(()=>[...window.r.stored.keys()]),['old-1'])
 })
 await check('a draft adopted after listing is protected from bulk deletion',async()=>{
  const result=await page.evaluate(async()=>{
   await window.setupRecovery();const{m,recovery,gateway,stored,calls}=window.r
   m.createRecoveredDocument({id:'claimed',name:'claimed.txt',text:'do not delete',encoding:'UTF-8'});await recovery.flushForClose()
   recovery.records.value=(await gateway.list()).records;await recovery.discardAll()
   const result={ids:[...stored.keys()],removed:calls.remove,error:recovery.lastError.value};recovery.dispose();return result
  });assert.deepEqual(result.ids,['new-1']);assert.deepEqual(result.removed,[]);assert.match(result.error,/已被当前文档使用/)
 })
 }
 assert.deepEqual(errors,[])
 fs.mkdirSync('test-results/recovery',{recursive:true});fs.writeFileSync('test-results/recovery/browser.json',JSON.stringify({results,errors},null,2)+'\n')
 const failed=results.filter(r=>!r.passed);console.log(`RECOVERY ${results.length-failed.length}/${results.length} passed`);assert.equal(failed.length,0,failed.map(r=>r.name).join('\n'))
}finally{await page.evaluate(()=>{window.r?.app.unmount();window.r?.recovery.dispose()}).catch(()=>{});await browser.close();await server.close()}
