import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {chromium} from 'playwright'
const exec=promisify(execFile),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const label=process.argv.find(v=>v.startsWith('--label='))?.slice(8)||'dnd-after',baseline=label.endsWith('before')&&!process.argv.includes('--current-api')
assert(/^dnd-(before|after|final)$/.test(label))
const functional=process.argv.includes('--functional'),recordName=process.argv.find(v=>v.startsWith('--record='))?.slice(9)||(functional?'native-functional':label)
assert(/^[\w-]+$/.test(recordName))
const rounds=Number(process.argv.find(v=>v.startsWith('--rounds='))?.slice(9)||20)
assert(Number.isInteger(rounds)&&rounds>=1&&rounds<=120)
const root=path.resolve('test-results/phase042'),out=path.resolve('test-results/drag'),fixtures=path.join(out,'fixtures'),port=9684
fs.mkdirSync(fixtures,{recursive:true})
const config=JSON.parse(fs.readFileSync(path.join(root,`config-${label}.json`),'utf8')),profile=path.resolve(config.app.appDirectoriesOverride)
assert.equal(profile,path.join(root,`native-profile-${label}`))
if(fs.existsSync(profile))fs.renameSync(profile,path.join(root,`native-profile-${label}-backup-${Date.now()}`))
fs.mkdirSync(profile,{recursive:true})
const paragraph='A shared Markdown document with 中文 text, links and **bold** content. '.repeat(12)
let md='# Shared 100 KiB\n\n';for(let i=0;Buffer.byteLength(md)<100*1024;i++)md+=`## Section ${i}\n\n${paragraph}\n\n`
fs.writeFileSync(path.join(fixtures,'large.md'),md)
fs.writeFileSync(path.join(fixtures,'rich.md'),'# Rich\n\n![local](./pixel.png)\n\n$x^2+y^2$\n\n```ts\nconst value = 42\n```\n\n```mermaid\ngraph LR\nA-->B\n```\n')
fs.writeFileSync(path.join(fixtures,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'))
for(let i=0;i<50;i++)fs.writeFileSync(path.join(fixtures,`file-${i}.txt`),`Fixture ${i}\n`)
fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:6,autoCheckUpdates:false,autoDownloadUpdates:false,showOutline:false,externalFileMonitoring:false}))
fs.writeFileSync(path.join(profile,'workspaces.json'),JSON.stringify({recent_workspaces:[fixtures],active_roots:[]}))
fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent:['large.md','rich.md','pixel.png'].map(name=>({path:path.join(fixtures,name),name})),layout:{mode:'single',sidebarVisible:false,sidebarWidth:254}}))
fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:254}}))
const sampler=path.join(out,'sample-native.ps1')
fs.writeFileSync(sampler,`param([int]$RootPid)
$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add($RootPid)
$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name)
do{$added=$false;foreach($r in $rows){if($ids.Contains([int]$r.ParentProcessId)-and $ids.Add([int]$r.ProcessId)){$added=$true}}}while($added)
$p=Get-Process -Id $RootPid -ErrorAction Stop
$wv=@(Get-Process -Id @($ids) -ErrorAction SilentlyContinue|Where-Object ProcessName -eq 'msedgewebview2')
[pscustomobject]@{rustPrivate=$p.PrivateMemorySize64;rustWorking=$p.WorkingSet64;webviewPrivate=[long](($wv|Measure-Object PrivateMemorySize64 -Sum).Sum);webviewWorking=[long](($wv|Measure-Object WorkingSet64 -Sum).Sum);webviewProcesses=$wv.Count;processes=$ids.Count;webviewPids=@($wv|ForEach-Object Id)}|ConvertTo-Json -Compress`)
const results=[],errors=[],observations=[],closeLogs=[],windowCycles={requested:rounds,attempted:0,completed:0,durationMs:0};let child,browser,main,previous
const pages=()=>browser.contexts().flatMap(c=>c.pages()).filter(p=>!p.isClosed()&&!p.url().startsWith('devtools:'))
function observeClose(page){page.on('console',message=>{if(message.text().startsWith('[Markumo close]')){const entry={time:Date.now(),text:message.text()};closeLogs.push(entry);if(closeLogs.length>256)closeLogs.shift();void message.args()[1]?.jsonValue().then(data=>entry.data=data).catch(()=>{})}})}
async function sample(){
 await wait(1000)
 const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`& { ${fs.readFileSync(sampler,'utf8')} } -RootPid ${child.pid}`],{windowsHide:true})
 const native=JSON.parse(stdout),views=[]
 for(const p of pages()){
  try{const cdp=await p.context().newCDPSession(p);await cdp.send('Performance.enable');const metrics=(await cdp.send('Performance.getMetrics')).metrics;const counters=await cdp.send('Memory.getDOMCounters');await cdp.detach();views.push(await p.evaluate(({metrics,counters})=>{const m=window.__nativeManager;return {label:window.__TAURI_INTERNALS__.metadata.currentWindow.label,heap:metrics.find(x=>x.name==='JSHeapUsedSize')?.value,dom:counters,documents:m.openedDocuments.length,records:m.records.size,panes:m.layout.getAllPanes().length,cm:m.views.size,live:m.liveViews.size,probe:window.__markumoMemoryProbe?.editors,ghosts:document.querySelectorAll('.tab-drag-ghost').length}},{metrics,counters}))}catch{}
 }
 return {...native,windows:views.length,views,time:Date.now()}
}
async function checkpoint(name,operation,cleanup=async()=>{}){
 const before=previous||await sample();await operation();const after=await sample();await cleanup();const cleaned=await sample();previous=cleaned;results.push({name,before,after,cleaned});fs.writeFileSync(path.join(out,`${recordName}.json`),JSON.stringify({label,baseline,results,observations,errors,closeLogs,windowCycles},null,2));console.log('PASS',name,JSON.stringify({rust:after.rustPrivate,webview:after.webviewPrivate,windows:after.windows,views:after.views.map(v=>({cm:v.cm,live:v.live,panes:v.panes,records:v.records,created:v.probe.mainCM.created}))}))
}
async function open(name){await main.evaluate(async file=>window.__dndShell.files.accept(await window.__TAURI_INTERNALS__.invoke(window.__nativeWorkspace.roots.length?'open_workspace_file':'open_recent',{path:file,encoding:null}),false),path.join(fixtures,name));await wait(150)}
async function detach(source,targetPoint={x:-4000,y:-4000}){
 if(!baseline){
   const sourceLabel=await source.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)
   assert(await source.evaluate(point=>window.__dndShell.__detach({...point,forceNew:point.x===-4000}),targetPoint),'Production handoff failed')
   const started=await source.evaluate(()=>window.__dndLastDetach).catch(()=>null);if(started)return started
   const deadline=Date.now()+15000;while(Date.now()<deadline){for(const p of pages())if(p!==source)try{const label=await p.evaluate(()=>window.__TAURI_INTERNALS__?.metadata.currentWindow.label);if(label&&label!==sourceLabel)return {label}}catch{}await wait(50)}throw Error('Handoff target missing')
 }
 return source.evaluate(async point=>{const m=window.__nativeManager,doc=m.activeDocument,s=m.paneSnapshot(doc.id,m.activePane),payload={documentId:doc.id,name:doc.name,path:doc.path||null,fileToken:doc.fileToken||null,text:m.getText(doc.id),version:doc.lastDiskVersion,encoding:doc.encoding,bom:doc.bom,eol:doc.eol,readOnly:doc.readOnly,dirty:doc.dirty,markdownMode:s.mode,anchor:s.anchor,head:s.head,scrollTop:s.top,scrollLeft:s.left,pinned:true};return window.__TAURI_INTERNALS__.invoke('detach_tab_to_window',{payload,dropX:point.x,dropY:point.y})},targetPoint)
}
async function target(label){const deadline=Date.now()+15000;while(Date.now()<deadline){for(const p of pages())try{if(await p.evaluate(label=>window.__TAURI_INTERNALS__?.metadata.currentWindow.label===label&&!!window.__dndShell&&!document.querySelector('.startup-overlay'),label)){p.setDefaultTimeout(15000);return p}}catch{}await wait(100)}throw Error('Detached target startup timed out')}
async function returnTab(p){
 const geometry=async page=>page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke,label=window.__TAURI_INTERNALS__.metadata.currentWindow.label;return {position:await invoke('plugin:window|outer_position',{label}),size:await invoke('plugin:window|outer_size',{label})}})
 const mainRect=await geometry(main),sourceRect=await geometry(p),left=mainRect.position.x,top=mainRect.position.y,right=left+mainRect.size.width
 let destination=[[right-140,top+20],[left+80,top+20],[(left+right)/2,top+20],[right-20,top+mainRect.size.height/2]].find(([x,y])=>x<sourceRect.position.x||x>sourceRect.position.x+sourceRect.size.width||y<sourceRect.position.y||y>sourceRect.position.y+sourceRect.size.height)
 if(!destination){await p.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|minimize',{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label}));destination=[left+180,top+180]}
 const sourceOrigin=await p.evaluate(command=>window.__TAURI_INTERNALS__.invoke(command,{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label}),baseline?'plugin:window|outer_position':'plugin:window|inner_position'),scale=await p.evaluate(()=>devicePixelRatio)
 observations.push({returnGeometry:{mainRect,sourceRect,sourceOrigin,destination,scale}})
 await detach(p,{x:(destination[0]-sourceOrigin.x)/scale,y:(destination[1]-sourceOrigin.y)/scale})
 if(!baseline)await main.waitForFunction(()=>window.__nativeManager.openedDocuments.some(d=>d.name==='large.md'))
 const deadline=Date.now()+10000;while(!p.isClosed()&&Date.now()<deadline)await wait(100);assert(p.isClosed(),'Empty detached window should close after handoff');await wait(200)
 if(baseline&&!await main.evaluate(()=>!!window.__nativeManager.activeDocument))observations.push({scenario:'H',failedBehavior:'Returned document was incorrectly closed in receiving main window'})
}
try{
 const tmp=path.join(out,'tmp');fs.mkdirSync(tmp,{recursive:true});child=spawn(path.join(root,`markumo-${label}.exe`),[],{windowsHide:true,env:{...process.env,TEMP:tmp,TMP:tmp,WEBVIEW2_USER_DATA_FOLDER:path.join(profile,'wv'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
 const deadline=Date.now()+45000;while(true){assert(child.exitCode===null);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}assert(Date.now()<deadline,'WebView2 timeout');await wait(200)}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);browser.on('page',observeClose);main=pages()[0];observeClose(main);main.setDefaultTimeout(15000);main.on('pageerror',e=>errors.push(e.message));await main.waitForFunction(()=>window.__dndShell&&!document.querySelector('.startup-overlay'))
 if(process.argv.includes('--foreground')){const ready=path.join(out,'foreground-ready');if(fs.existsSync(ready))fs.unlinkSync(ready);console.log('WAITING FOR TEST WINDOW ACTIVATION',child.pid);while(!fs.existsSync(ready))await wait(200)}
 if(functional){await (await import('./native-functional-scenarios.mjs')).run({browser,main,open,detach,target,pages,fixtures,out,wait})}else{
 await checkpoint('A blank startup',async()=>{})
 await checkpoint('B open 100 KiB Markdown Live',()=>open('large.md'))
 await checkpoint('C same document in two panes',async()=>{await main.evaluate(()=>window.__nativeManager.splitPane('right'));await main.waitForFunction(()=>window.__nativeManager.liveViews.size===2);const shared=await main.evaluate(()=>{const m=window.__nativeManager,ids=m.layout.getAllPanes().map(p=>p.group.activeId);return ids.length===2&&new Set(ids).size===1&&m.records.size===1});assert(shared)},async()=>{await main.evaluate(()=>window.__nativeManager.mergeAllPanes())})
 await checkpoint('D reorder tabs 100 times',async()=>{await main.evaluate(()=>{const m=window.__nativeManager,id=m.activeId;m.setMarkdownMode(id,'source');window.__largeId=id;const other=m.createUntitled();m.pin(other);m.select(id);window.__sortStart=m.views.get(m.activePane)});await wait(100);const before=await main.evaluate(()=>window.__markumoMemoryProbe.editors.mainCM.created);await main.evaluate(()=>{const m=window.__nativeManager;for(let i=0;i<100;i++)m.transferTab(window.__largeId,m.activePane,m.activePane,{targetIndex:i%2?0:2})});const churn=await main.evaluate(()=>window.__markumoMemoryProbe.editors.mainCM.created);observations.push({sortPluginCreates:churn-before,editorDOMReused:await main.evaluate(()=>window.__sortStart===window.__nativeManager.views.get(window.__nativeManager.activePane))});if(!baseline)assert.equal(churn,before,'Reorder must not reset CM plugins')},async()=>{await main.evaluate(()=>{const m=window.__nativeManager;for(const d of m.openedDocuments)if(d.id!==window.__largeId)m.close(d.id,true);m.select(window.__largeId)})})
 await checkpoint('E split and merge 50 times',async()=>{for(let i=0;i<50;i++){await main.evaluate(()=>window.__nativeManager.splitPane('right'));await wait(20);await main.evaluate(()=>window.__nativeManager.mergeAllPanes());await wait(20)}assert.equal(await main.evaluate(()=>window.__nativeManager.views.size),1)})
 await checkpoint('F workspace open 50 dropped files',async()=>{assert(await main.evaluate(dir=>window.__nativeWorkspace.openWorkspacePath(dir,true),fixtures));for(let i=0;i<50;i++)assert((await main.evaluate(file=>window.__nativeWorkspace.openWorkspaceFileInPane({path:file,paneId:window.__nativeManager.activePane,pin:true}),path.join(fixtures,`file-${i}.txt`))).success);assert.equal(pages().length,1)},async()=>{await main.evaluate(()=>{const m=window.__nativeManager;for(const d of m.openedDocuments)if(d.id!==window.__largeId)m.close(d.id,true);m.select(window.__largeId)})})
 let detached
 await checkpoint('G create one detached window',async()=>{const started=await detach(main);detached=await target(started.label);await main.waitForFunction(()=>!window.__nativeManager.openedDocuments.some(d=>d.name==='large.md'));assert.equal(pages().length,2)})
 await checkpoint('H return document and close detached window',()=>returnTab(detached))
 await checkpoint(`I detach and return ${rounds} times`,async()=>{
  if(baseline&&!await main.evaluate(()=>!!window.__nativeManager.activeDocument)){observations.push({scenario:'I',unmeasured:'Baseline return handoff incorrectly closed the received source document; cannot continue repeated detach safely'});return}
  const startedAt=performance.now()
  try{for(let i=0;i<rounds;i++){
   windowCycles.attempted=i+1
   const started=await detach(main),p=await target(started.label)
   await main.waitForFunction(()=>!window.__nativeManager.openedDocuments.some(d=>d.name==='large.md'))
   await returnTab(p);windowCycles.completed=i+1
   if(i%5===4){observations.push({round:i+1,snapshot:await sample()});console.log('WINDOW CYCLES',windowCycles.completed,'/',rounds)}
  }assert.equal(pages().length,1)}finally{windowCycles.durationMs=performance.now()-startedAt}
 })
 await checkpoint('J open/close search and settings 20 times',async()=>{for(let i=0;i<20;i++){await main.evaluate(()=>window.__nativeWorkspace.focusWorkspaceSearch());await main.getByRole('dialog',{name:'全局搜索与替换'}).waitFor();await main.evaluate(()=>window.__nativeWorkspace.closeSearchDialog());await main.evaluate(()=>window.__dndShell.openSettings());await main.waitForTimeout(20);await main.keyboard.press('Escape')}assert.equal(pages().length,1)})
 await checkpoint('K Markdown code, local image, formula and diagram',()=>open('rich.md'),async()=>{await main.evaluate(()=>{const m=window.__nativeManager;m.close(m.activeId,true);m.select(window.__largeId)})})
 }
 assert.deepEqual(errors,[]);if(!functional)console.log(`NATIVE MEMORY ${label} ${results.length}/11 measured; observations=${JSON.stringify(observations.map(item=>({sortPluginCreates:item.sortPluginCreates,scenario:item.scenario,unmeasured:item.unmeasured})))}`)
 if(process.argv.includes('--hold')){const stop=path.join(out,'stop-native-host');if(fs.existsSync(stop))fs.unlinkSync(stop);console.log('NATIVE HOST READY',child.pid);while(!fs.existsSync(stop))await wait(500)}
}catch(error){console.error(await Promise.all(pages().map(p=>p.evaluate(()=>({label:window.__TAURI_INTERNALS__?.metadata.currentWindow.label,docs:window.__nativeManager?.openedDocuments.map(d=>({id:d.id,name:d.name,dirty:d.dirty})),busy:window.__dndShell?.files.workspaceBusy,started:window.__dndLastDetach,toast:document.querySelector('.toast')?.textContent,startup:document.querySelector('.startup-overlay')?.textContent})).catch(()=>null))));errors.push(String(error));fs.writeFileSync(path.join(out,`${recordName}.json`),JSON.stringify({label,baseline,results,observations,errors,closeLogs,windowCycles},null,2));throw error}finally{if(child?.exitCode===null)await exec('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});await browser?.close().catch(()=>{})}
