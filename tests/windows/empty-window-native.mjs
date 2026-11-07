import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import {chromium} from 'playwright'
const out=path.resolve('test-results/empty-window'),profile=path.resolve('test-results/phase042/native-profile-dnd-empty'),install=path.join(out,'installed'),port=9693
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(install,{recursive:true})
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version
const installer=path.resolve(`src-tauri/target/release/bundle/nsis/Markumo Window Lifecycle Test_${version}_x64-setup.exe`)
if(!process.argv.includes('--skip-install'))execFileSync(installer,['/S',`/D=${install}`],{windowsHide:true,timeout:120000})
const exe=path.join(install,'markumo.exe');assert(fs.existsSync(exe))
function stopInstalled(){try{execFileSync('powershell.exe',['-NoProfile','-Command',`Get-Process markumo -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replaceAll("'","''")}' } | Stop-Process -Force`],{windowsHide:true,stdio:'ignore'})}catch{}}
stopInstalled()
const fixtures=path.join(out,'fixtures');fs.mkdirSync(fixtures,{recursive:true})
for(const name of ['a.md','b.txt','c.txt'])fs.writeFileSync(path.join(fixtures,name),`# ${name}\nOriginal 中文\n`)
const traces=[],disposals=[]
async function observeDisposal(p){const cdp=await p.context().newCDPSession(p);await cdp.send('Runtime.addBinding',{name:'__emptyDisposed'});cdp.on('Runtime.bindingCalled',e=>{if(e.name==='__emptyDisposed')disposals.push(JSON.parse(e.payload))});await p.evaluate(()=>window.addEventListener('markumo:dispose-window',()=>window.__emptyDisposed(JSON.stringify({records:window.__nativeManager.records.size,cm:window.__nativeManager.views.size,pm:window.__nativeManager.liveViews.size,workers:window.__markumoMemoryProbe.workers.live})),{once:true}))}
const wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[];let child,browser
const invoke=(p,cmd,args={})=>p.evaluate(({cmd,args})=>window.__TAURI_INTERNALS__.invoke(cmd,args),{cmd,args})
const pages=()=>browser.contexts().flatMap(c=>c.pages()).filter(p=>!p.isClosed()&&!p.url().startsWith('devtools:'))
async function until(fn,message,ms=25000){const end=Date.now()+ms;while(Date.now()<end){try{const r=await fn();if(r)return r}catch{}await wait(100)}throw Error(message)}
async function ready(p){p.on('console',m=>{if(m.text().includes('[Markumo close]')||m.text().includes('[test '))void Promise.all(m.args().map(a=>a.jsonValue())).then(args=>traces.push(args)).catch(()=>{})});await p.waitForFunction(()=>window.__dndShell&&window.__dndShell.startupLoading.value===false&&window.__nativeManager.openedDocuments.length>0);return p}
async function start(reset=true){
 if(reset){fs.mkdirSync(profile,{recursive:true});const recovery=path.join(profile,'recovery');if(fs.existsSync(recovery))fs.renameSync(recovery,path.join(profile,'recovery-before-case-'+Date.now()));
 fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:6,autoCheckUpdates:false,autoDownloadUpdates:false,showOutline:false,externalFileMonitoring:false}));
 fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent:['a.md','b.txt','c.txt'].map(name=>({path:path.join(fixtures,name),name})),layout:{mode:'single',sidebarVisible:false,sidebarWidth:254}}));
 fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[{path:path.toNamespacedPath(path.join(fixtures,'a.md')),encoding:'UTF-8'}],activePath:path.toNamespacedPath(path.join(fixtures,'a.md')),layout:{mode:'single',sidebarVisible:false,sidebarWidth:254}}));}
 child=spawn(exe,[],{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
 await until(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok}catch{return false}},'WebView2 startup')
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);return ready(pages()[0])
}
async function stop(){await browser?.close().catch(()=>{});if(child&&child.exitCode===null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}}stopInstalled();await wait(1000)}
async function open(p,name){await p.evaluate(async file=>window.__dndShell.files.accept(await window.__TAURI_INTERNALS__.invoke('open_recent',{path:file,encoding:null}),false),path.join(fixtures,name))}
async function fileWindow(){const before=pages().length;spawn(exe,[path.join(fixtures,'b.txt')],{windowsHide:true});return ready(await until(()=>pages().length>before&&pages().at(-1),'File window'))}
async function move(from,to){let point={x:-4000,y:-4000,forceNew:true};if(to){
 await invoke(to,'plugin:window|set_focus',{label:await to.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)})
 const b=await invoke(to,'plugin:window|inner_position',{label:await to.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)}),a=await invoke(from,'plugin:window|inner_position',{label:await from.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)}),scale=await from.evaluate(()=>devicePixelRatio);point={x:(b.x+200-a.x)/scale,y:(b.y+100-a.y)/scale,forceNew:false}}
 try{assert(await from.evaluate(point=>window.__dndShell.__detach(point),point))}catch(error){if(!from.isClosed())throw error}if(to)return to
 return ready(await until(()=>pages().find(p=>p!==from),'New detached window'))
}
const closed=p=>until(()=>p.isClosed(),'Source should be destroyed')
const count=p=>p.evaluate(()=>window.__nativeManager.openedDocuments.length)
const snapshot=p=>p.evaluate(()=>{const m=window.__nativeManager,d=m.activeDocument;return{text:m.getText(d.id),dirty:d.dirty}})
async function check(name,fn){if(process.env.CASE&&!name.includes(process.env.CASE))return;try{await fn();results.push({name,ok:true});console.log('PASS',name)}catch(e){results.push({name,ok:false,error:String(e)});console.log('FAIL',name,e.stack);console.log('CLOSE TRACE',JSON.stringify(traces.slice(-8)));for(const p of pages())console.log('STATE',await p.evaluate(()=>({label:window.__TAURI_INTERNALS__.metadata.currentWindow.label,docs:window.__nativeManager.openedDocuments.map(d=>d.name),text:document.body.innerText.slice(-700),busy:window.__dndShell.files.workspaceBusy,ready:window.__dndShell.startupLoading.value})).catch(()=>null))}finally{await stop();fs.writeFileSync(path.join(out,'native-results.json'),JSON.stringify({installer,exe,results,disposals,traces},null,2))}}
await check('main last document -> new detached window; dirty state, saving, new files and restart',async()=>{
 const a=await start();await observeDisposal(a);await a.evaluate(()=>{const m=window.__nativeManager;m.dispatch(m.activeId,{changes:{from:0,insert:'dirty 😀\n'}})})
 const before=await snapshot(a),b=await move(a);await closed(a);assert.deepEqual(disposals.at(-1),{records:0,cm:0,pm:0,workers:0});assert.deepEqual(await snapshot(b),before)
 assert(await b.evaluate(()=>window.__dndShell.files.save(window.__nativeManager.activeId)));assert.equal(fs.readFileSync(path.join(fixtures,'a.md'),'utf8'),before.text)
 await open(b,'c.txt');await b.getByRole('button',{name:'关闭窗口',exact:true}).click();await closed(b);await stop()
 const restored=await start(false);const names=await restored.evaluate(()=>window.__nativeManager.openedDocuments.map(d=>d.name));assert(names.includes('a.md')&&names.includes('c.txt'),JSON.stringify(names))
})
await check('main last document -> existing file window',async()=>{const a=await start(),b=await fileWindow();await move(a,b);await closed(a);assert.equal(await count(b),2);assert(await b.evaluate(()=>window.__dndShell.files.save(window.__nativeManager.activeId)));await open(b,'c.txt');assert.equal(await count(b),3)})
await check('file window last document -> main',async()=>{const a=await start(),b=await fileWindow();await move(b,a);await closed(b);assert.equal(await count(a),2)})
await check('detached window last document -> existing main',async()=>{const a=await start();await open(a,'c.txt');const b=await move(a);assert.equal(await count(a),1);await move(b,a);await closed(b);assert.equal(await count(a),2)})
await check('two documents: moving one retains source',async()=>{const a=await start();await open(a,'c.txt');const b=await move(a);await until(async()=>await count(a)===1,'Source removal');assert(!a.isClosed());assert.equal(await count(b),1)})
await check('moving one of two views of the same file retains source and both scoped grants',async()=>{
 const a=await start();await a.evaluate(()=>{const m=window.__nativeManager;m.dispatch(m.activeId,{changes:{from:0,insert:'Retained dirty view\n'}});m.splitPane('right')});const before=await snapshot(a);const b=await move(a);
 await until(()=>b.evaluate(()=>window.__nativeManager.openedDocuments.length===1&&!window.__dndShell.files.workspaceBusy),'Target adoption');
 assert(!a.isClosed());assert.equal(await count(a),1);assert.equal(await count(b),1);assert.deepEqual(await snapshot(a),before);assert.deepEqual(await snapshot(b),before);
 assert.equal(await a.evaluate(()=>window.__nativeManager.layout.getAllPanes().reduce((n,p)=>n+p.group.tabs.length,0)),1);
 const tokens=await Promise.all([a,b].map(p=>p.evaluate(()=>window.__nativeManager.activeDocument.fileToken)));assert.notEqual(...tokens);
 const protectedRecord=await b.evaluate(()=>{const d=window.__nativeManager.activeDocument;return window.__TAURI_INTERNALS__.invoke('recovery_save',{token:d.fileToken,input:{id:null,name:d.name,path:d.path,text:'protected active-window checkpoint',encoding:d.encoding,bom:d.bom,eol:d.eol,panes:[],diskVersion:d.lastDiskVersion,expectedVersion:null}})});
 const listed=await invoke(a,'recovery_list');assert(!listed.records.some(r=>r.id===protectedRecord.record.id));
 await assert.rejects(invoke(a,'recovery_delete',{id:protectedRecord.record.id}));await invoke(b,'recovery_delete',{id:protectedRecord.record.id});
 for(let i=0;i<2;i++){await invoke([a,b][i],'check_external_file',{token:tokens[i]});await assert.rejects(invoke([a,b][i],'check_external_file',{token:tokens[1-i]}))}
 await b.evaluate(()=>{const m=window.__nativeManager;m.dispatch(m.activeId,{changes:{from:0,insert:'Target view edit\n'}})});assert(await b.evaluate(()=>window.__dndShell.files.save(window.__nativeManager.activeId)));
 assert(!a.isClosed());assert.equal(await count(a),1)
})
await check('same-window split move and copy retain application window',async()=>{const a=await start();await a.evaluate(()=>{const m=window.__nativeManager,id=m.activeId,from=m.activePane;const to=m.splitPane('right');m.transferTab(id,from,to,{copy:true});m.transferTab(id,to,from,{copy:false})});assert.equal(await count(a),1);assert(!a.isClosed())})
await check('normal last tab close, workspace-only and last application window remain open',async()=>{const a=await start();await a.evaluate(()=>{const m=window.__nativeManager;m.close(m.activeId,true)});assert.equal(await count(a),0);assert(!a.isClosed());await a.evaluate(dir=>window.__nativeWorkspace.openWorkspacePath(dir,true),fixtures);assert(!a.isClosed())})
await check('receiver rejection preserves source and grant',async()=>{const a=await start(),b=await fileWindow();await b.evaluate(()=>window.__dndShell.files.workspaceBusy=true);await move(a,b);await until(()=>a.evaluate(()=>!window.__dndShell.files.handoffBusy),'Rollback');assert.equal(await count(a),1);assert(!a.isClosed())})
await check('committed notification loss resolves from native status',async()=>{const a=await start(),b=await fileWindow();await a.evaluate(()=>window.__dropCommit=true);await move(a,b);await b.waitForFunction(()=>window.__nativeManager.openedDocuments.length===2&&!window.__dndShell.files.workspaceBusy);for(const p of [a,b])await invoke(p,'plugin:window|minimize',{label:await p.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)});await closed(a);assert.equal(await count(b),2)})
for(const action of ['cancel','timeout'])await check(`handoff ${action} preserves source`,async()=>{const a=await start(),b=await fileWindow();await b.evaluate(()=>window.__holdIncoming=true);await move(a,b);const id=await until(()=>a.evaluate(()=>window.__dndLastDetach?.handoffId),'Handoff ID');if(action==='cancel')await invoke(a,'cancel_detach',{handoffId:id});await until(()=>a.evaluate(()=>!window.__dndShell.files.handoffBusy),'Settle cancellation/timeout');assert.equal(await count(a),1);assert(!a.isClosed())})
await check('two simultaneous outgoing transfers close source only after both settle',async()=>{const a=await start(),b=await fileWindow();await open(a,'c.txt');await a.evaluate(()=>{const m=window.__nativeManager;const docs=[...m.openedDocuments];for(const d of docs){m.select(d.id);void window.__dndShell.__detach({x:-4000,y:-4000,forceNew:true})}});await closed(a);assert.equal(pages().length,3)})
await check('source file task blocks auto close until operation settles',async()=>{const a=await start(),b=await fileWindow();await a.evaluate(()=>window.__dndShell.fileBusy.value=true);await move(a,b);await until(async()=>await count(a)===0,'Committed removal');assert(!a.isClosed());await a.evaluate(()=>window.__dndShell.fileBusy.value=false);await closed(a)})
await check('Control and Alt pointer copies keep the source tab and window',async()=>{
 const a=await start();await a.evaluate(()=>{const m=window.__nativeManager,id=m.activeId;window.__copyId=id;const pane=m.splitPane('right');m.createUntitled();m.close(id,true,pane);window.__dndDragService.configure(undefined)})
 for(const modifier of ['Control','Alt']){
  const panes=await a.evaluate(()=>window.__nativeManager.layout.getAllLeafIds()),from=a.locator('.pane[data-pane-id="'+panes[0]+'"] .tab').first(),to=a.locator('.pane[data-pane-id="'+panes[1]+'"] .pane-document-shell');
  const source=await from.boundingBox(),dest=await to.boundingBox();assert(source&&dest);
  await a.keyboard.down(modifier);await a.mouse.move(source.x+25,source.y+12);await a.mouse.down();await a.mouse.move(dest.x+dest.width/2,dest.y+dest.height/2,{steps:8});await a.mouse.up();await a.keyboard.up(modifier);
  assert.equal(await count(a),2);assert(!a.isClosed());assert.equal(await a.evaluate(()=>window.__nativeManager.layout.getAllPanes().filter(p=>p.group.tabs.some(t=>t.documentId===window.__copyId)).length),2);await a.evaluate(()=>{const m=window.__nativeManager;m.close(window.__copyId,true,m.layout.getAllLeafIds()[1])})
 }
})
await check('IME composition prevents outgoing handoff',async()=>{const a=await start(),b=await fileWindow();await a.evaluate(()=>{const m=window.__nativeManager;m.setMarkdownMode(m.activeId,'source')});await a.waitForFunction(()=>window.__nativeManager.paneView(window.__nativeManager.activePane));await a.evaluate(()=>window.__nativeManager.paneView(window.__nativeManager.activePane).inputState.composing=1);assert.equal(await a.evaluate(()=>window.__dndShell.__detach({x:-4000,y:-4000,forceNew:true})),false);assert(!a.isClosed());assert.equal(await count(a),1)})
await check('composition begun after native commit defers source removal',async()=>{const a=await start(),b=await fileWindow();await a.evaluate(()=>window.__nativeManager.setMarkdownMode(window.__nativeManager.activeId,'source'));await a.waitForFunction(()=>window.__nativeManager.paneView(window.__nativeManager.activePane));await a.evaluate(()=>window.__composeOnReceipt=true);await move(a,b);await until(()=>b.evaluate(()=>window.__nativeManager.openedDocuments.length===2),'Target commit');assert(!a.isClosed());assert.equal(await count(a),1);await a.evaluate(()=>{window.__composeOnReceipt=false;const m=window.__nativeManager;m.paneView(m.activePane).inputState.composing=-1;m.notify()});await closed(a)})
await check('session write failure keeps the source window',async()=>{const a=await start(),b=await fileWindow();const session=path.join(profile,'last-session.json'),backup=session+'.failure-backup';fs.renameSync(session,backup);fs.mkdirSync(session);try{await move(a,b);await until(async()=>await count(a)===0,'Committed removal');assert(!a.isClosed());assert.equal(await count(b),2)}finally{fs.rmdirSync(session);fs.renameSync(backup,session)}})
assert(results.every(r=>r.ok),JSON.stringify(results.filter(r=>!r.ok)))
