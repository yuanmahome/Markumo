import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createDeterministicPdf} from '../../scripts/memory-fixtures.mjs'
export async function run({browser,main,open,detach,target,pages,fixtures,out,wait}){
 const results=[],disposals=[]
 const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS',name)}
 const invoke=(page,command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args})
 async function pointTo(from,to){
   const geometry=async p=>({position:await invoke(p,'plugin:window|outer_position',{label:await p.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)}),size:await invoke(p,'plugin:window|outer_size',{label:await p.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)})})
   const a=await geometry(from),b=await geometry(to),dest=[[b.position.x+80,b.position.y+20],[b.position.x+b.size.width-140,b.position.y+20],[b.position.x+b.size.width-20,b.position.y+b.size.height/2]].find(([x,y])=>x<a.position.x||x>a.position.x+a.size.width||y<a.position.y||y>a.position.y+a.size.height)
   assert(dest,'Test windows need an exposed destination point')
   const origin=await invoke(from,'plugin:window|inner_position',{label:await from.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)}),scale=await from.evaluate(()=>devicePixelRatio)
   return {x:(dest[0]-origin.x)/scale,y:(dest[1]-origin.y)/scale}
 }
 async function toWindow(from,to){const expected=await to.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label);const started=await detach(from,await pointTo(from,to));assert.equal(started.label,expected,'Drop must reuse the existing destination window');return started}
 await main.evaluate(dir=>window.__nativeWorkspace.openWorkspacePath(dir,true),fixtures)
 await open('large.md')
 const before=await main.evaluate(()=>{const m=window.__nativeManager;m.setMarkdownMode(m.activeId,'source');m.dispatch(m.activeId,{changes:{from:8,to:8,insert:'未保存 😀 '}});m.setSelectionOffsets(m.activeId,65,78);m.restoreScroll(m.activeId,500);return {text:m.saveSnapshot(m.activeId).text,token:m.activeDocument.fileToken}})
 await wait(200)
 const snapshot=await main.evaluate(()=>{const m=window.__nativeManager;return m.paneSnapshot(m.activeId,m.activePane)})
 let received
 await check('unsaved text, encoding, mode, selection, scroll and exclusive write grant transfer',async()=>{
   const started=await detach(main);received=await target(started.label);await main.waitForFunction(()=>window.__nativeManager.openedDocuments.length===0)
   const state=await received.evaluate(()=>{const m=window.__nativeManager,d=m.activeDocument;return {text:m.saveSnapshot(d.id).text,encoding:d.encoding,dirty:d.dirty,mode:m.getMarkdownMode(d.id),anchor:m.paneSnapshot(d.id).anchor,head:m.paneSnapshot(d.id).head,top:m.paneSnapshot(d.id).top}})
   assert.equal(state.text,before.text);assert.equal(state.encoding,'UTF-8');assert.equal(state.dirty,true);assert.equal(state.mode,'source');assert.equal(state.anchor,snapshot.anchor);assert.equal(state.head,snapshot.head);assert(Math.abs(state.top-snapshot.top)<5,JSON.stringify({state,snapshot}))
   assert.equal(await main.evaluate(async token=>{try{await window.__dndShell.files.gateway.checkExternal(token);return false}catch{return true}},before.token),true);await received.evaluate(token=>window.__dndShell.files.gateway.checkExternal(token),before.token)
 })
 await check('existing-window return retains the received document and closes only the empty detached owner',async()=>{
   await toWindow(received,main);await main.waitForFunction(()=>window.__nativeManager.activeDocument?.name==='large.md');const deadline=Date.now()+10000;while(!received.isClosed()&&Date.now()<deadline)await wait(100);assert(received.isClosed());assert.equal(await main.evaluate(()=>window.__nativeManager.saveSnapshot(window.__nativeManager.activeId).text),before.text);assert.equal(pages().length,1)
 })
 fs.copyFileSync(path.resolve('public/favicon.png'),path.join(fixtures,'native-image.png'))
 let image
 await check('image tab detaches with metadata and a real viewer, without creating a text editor',async()=>{
   await open('native-image.png');const started=await detach(main);image=await target(started.label);await image.waitForSelector('.image-viewer .image-details');assert.equal(await image.evaluate(()=>window.__nativeManager.activeDocument.kind),'image');assert.equal(await image.evaluate(()=>window.__nativeManager.views.size+window.__nativeManager.liveViews.size),0)
 })
 await check('receiver rejection rolls file grant back and preserves both window contents',async()=>{
   const doc=await main.evaluate(()=>window.__nativeManager.activeDocument);await image.evaluate(id=>window.__nativeManager.createRecoveredDocument({id,name:'Conflict.txt',text:'Receiver content must survive'}),doc.id)
   await toWindow(main,image);await main.waitForFunction(()=>!window.__dndShell.files.workspaceBusy);assert.equal(await main.evaluate(()=>window.__nativeManager.saveSnapshot(window.__nativeManager.activeId).text),before.text);assert.equal(await image.evaluate(id=>window.__nativeManager.getText(id),doc.id),'Receiver content must survive');await main.evaluate(token=>window.__dndShell.files.gateway.checkExternal(token),doc.fileToken)
   assert.equal(await main.evaluate(()=>window.__nativeManager.getState(window.__nativeManager.activeId).readOnly),false);await image.evaluate(id=>window.__nativeManager.close(id,true),doc.id)
 })
 await check('dirty close Cancel keeps document; Save and close destroys Vue views and releases resources',async()=>{
   const cdp=await image.context().newCDPSession(image);await cdp.send('Runtime.addBinding',{name:'__dndDisposed'});cdp.on('Runtime.bindingCalled',event=>{if(event.name==='__dndDisposed')disposals.push(JSON.parse(event.payload))})
   await image.evaluate(()=>window.addEventListener('markumo:dispose-window',()=>window.__dndDisposed(JSON.stringify({cm:window.__nativeManager.views.size,pm:window.__nativeManager.liveViews.size,records:window.__nativeManager.records.size,blobs:window.__markumoMemoryProbe.blobs.liveUrls})),{once:true}))
   await image.evaluate(()=>{const native=window.__TAURI_INTERNALS__,original=native.invoke.bind(native);let injected=false;native.invoke=async(command,args,options)=>{const result=await original(command,args,options);if(command==='commit_detach'&&!injected){injected=true;throw Error('Injected lost success response after native commit')}return result}})
   await toWindow(main,image);await image.waitForFunction(()=>window.__nativeManager.activeDocument?.name==='large.md'&&!window.__dndShell.files.workspaceBusy);assert.equal(await image.evaluate(()=>window.__nativeManager.saveSnapshot(window.__nativeManager.activeId).text),before.text);await image.getByRole('button',{name:'关闭窗口',exact:true}).click();await image.getByRole('dialog',{name:'未保存修改确认'}).waitFor();await image.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(image.isClosed(),false)
   await image.getByRole('button',{name:'关闭窗口',exact:true}).click();await image.getByRole('button',{name:'保存并关闭',exact:true}).click();const deadline=Date.now()+15000;while(!image.isClosed()&&Date.now()<deadline)await wait(100);assert(image.isClosed());assert.equal(fs.readFileSync(path.join(fixtures,'large.md'),'utf8'),before.text);await wait(150);assert(disposals.length);assert.deepEqual(disposals.at(-1),{cm:0,pm:0,records:0,blobs:0});assert.equal(pages().length,1)
 })
 await check('disk reopen after closed owner restores file grant and exact saved bytes',async()=>{await open('large.md');assert.equal(await main.evaluate(()=>window.__nativeManager.saveSnapshot(window.__nativeManager.activeId).text),before.text)})
 await check('PDF window uses the real viewer and releases its worker on return',async()=>{
   fs.writeFileSync(path.join(fixtures,'native-document.pdf'),createDeterministicPdf(2));await open('native-document.pdf');const started=await detach(main),pdf=await target(started.label);await pdf.waitForSelector('.pdf-page canvas');assert.equal(await pdf.evaluate(()=>window.__nativeManager.activeDocument.kind),'pdf');assert.equal(await pdf.evaluate(()=>window.__nativeManager.views.size+window.__nativeManager.liveViews.size),0);
   const cdp=await pdf.context().newCDPSession(pdf);await cdp.send('Runtime.addBinding',{name:'__pdfDisposed'});const samples=[];cdp.on('Runtime.bindingCalled',event=>{if(event.name==='__pdfDisposed')samples.push(JSON.parse(event.payload))});await pdf.evaluate(()=>window.addEventListener('markumo:dispose-window',()=>window.__pdfDisposed(JSON.stringify({workers:window.__markumoMemoryProbe.workers.live,records:window.__nativeManager.records.size})),{once:true}));
   await toWindow(pdf,main);await main.waitForSelector('.pdf-page canvas');const deadline=Date.now()+10000;while(!pdf.isClosed()&&Date.now()<deadline)await wait(100);assert(pdf.isClosed());assert.deepEqual(samples.at(-1),{workers:0,records:0});await main.evaluate(()=>window.__nativeManager.close(window.__nativeManager.activeId,true))
 })
 await check('CRLF survives unsaved editing and cross-window return without newline normalization',async()=>{
   fs.writeFileSync(path.join(fixtures,'native-crlf.txt'),'first\r\n中文\r\n\r\n');await open('native-crlf.txt');const expected=await main.evaluate(()=>{const m=window.__nativeManager;m.dispatch(m.activeId,{changes:{from:0,to:0,insert:'edited '}});return m.saveSnapshot(m.activeId).text});assert(expected.includes('\r\n'));const started=await detach(main),p=await target(started.label);assert.equal(await p.evaluate(()=>window.__nativeManager.saveSnapshot(window.__nativeManager.activeId).text),expected);await toWindow(p,main);await main.waitForFunction(()=>window.__nativeManager.activeDocument?.name==='native-crlf.txt');assert.equal(await main.evaluate(()=>window.__nativeManager.saveSnapshot(window.__nativeManager.activeId).text),expected);await main.evaluate(()=>window.__nativeManager.close(window.__nativeManager.activeId,true))
 })
 fs.writeFileSync(path.join(fixtures,'Pointer.txt'),'Native pointer release fixture\n')
 await open('Pointer.txt');await main.evaluate(()=>{window.__nativeManager.focusPane(window.__nativeManager.activePane);window.__dndNativeReleases=0})
 fs.writeFileSync(path.join(out,'functional.json'),JSON.stringify({results,disposals,errors:[]},null,2));console.log(`NATIVE DRAG FUNCTIONAL ${results.length}/${results.length} passed; Pointer.txt ready for physical drag validation`)
}
