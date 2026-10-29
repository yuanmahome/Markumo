// Natural Windows Release measurements. Never enables Network/Debugger/GC.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {connectRawCDP} from './p01-raw-cdp.mjs'
assert.equal(process.platform,'win32')
const arg=n=>process.argv.find(v=>v.startsWith(`--${n}=`))?.slice(n.length+3)
const label=arg('label'), nomo=label==='nomo', rounds=Number(arg('rounds')||3)
const controlled=process.argv.includes('--controlled')
assert(label&&/^[\w-]+$/.test(label));assert(rounds>0&&rounds<=5)
const root=path.resolve('test-results/p03'), dir=path.join(root,`${label}-${Date.now()}`), fixtures=path.join(root,'fixtures')
fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(fixtures,{recursive:true})
const sha=b=>createHash('sha256').update(b).digest('hex'), wait=ms=>new Promise(r=>setTimeout(r,ms)), exec=promisify(execFile)
const sizes={'1kb':1024,'100kb':100*1024,'1mb':1024**2,'4mb':4*1024**2,'16mb':16*1024**2,'50mb':50*1024**2,'100mb':100*1024**2,'json10mb':10*1024**2}
const manifest={}
for(const [name,size] of Object.entries(sizes)){
 const file=path.join(fixtures,`${name}.${name.startsWith('json')?'json':'txt'}`)
 {const seed=Buffer.from('2026-10-29 INFO Text benchmark: 0123456789 abcdefghijklmnopqrstuvwxyz'.padEnd(255,'.')+'\n');const data=Buffer.alloc(size);for(let at=0;at<size;at+=seed.length)seed.copy(data,at,0,Math.min(seed.length,size-at));if(name.startsWith('json')){data.fill(120);Buffer.from('{"value":"').copy(data);data[size-2]=34;data[size-1]=125}fs.writeFileSync(file,data)}
 manifest[name]={file,bytes:size,sha256:sha(fs.readFileSync(file))}
}
if(controlled)for(const [name,base,ext] of [['log100kb','100kb','log'],['50mblog','50mb','log']]){const file=path.join(fixtures,`${name}.${ext}`);fs.copyFileSync(manifest[base].file,file);manifest[name]={file,bytes:manifest[base].bytes,sha256:manifest[base].sha256}}
const build=JSON.parse(fs.readFileSync(nomo?path.join(root,'nomo-build.json'):path.resolve(`test-results/phase042/build-${label}.json`)))
assert.equal(sha(fs.readFileSync(build.binary)),build.sha256)
const profile=nomo?build.profile:JSON.parse(fs.readFileSync(path.resolve(`test-results/phase042/config-${label}.json`))).app.appDirectoriesOverride
assert.equal(path.resolve(profile),nomo?path.join(process.env.APPDATA,'com.nomo.p03-benchmark'):path.resolve(`test-results/phase042/native-profile-${label}`),'Only the explicitly named benchmark profile may be moved')
const scenes=(arg('scenes')||'blank,1kb,100kb,1mb,4mb,16mb,50mb,100mb,json10mb,tabs20,panes'+(controlled?',log100kb,50mblog':'')).split(',')
const report={label,build,rounds,cohort:arg('cohort')||null,controlledPreferences:controlled,runnerSha256:sha(fs.readFileSync(new URL(import.meta.url))),startedAt:new Date().toISOString(),transport:'raw-CDP without Network/Debugger/GC',os:{release:os.release(),version:os.version(),arch:os.arch()},hardware:{cpu:os.cpus()[0].model,cores:os.cpus().length,memory:os.totalmem()},fixtures:manifest,samples:[],errors:[]}
const persist=()=>fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(report,null,2))
let child,browser,page,cdp,current,monitor=false,monitorTask,fast
async function native(){return JSON.parse((await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/p01-process-tree.ps1'),'-RootPid',String(child.pid)],{windowsHide:true})).stdout)}
async function sample(stage){const metrics=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));const js=await page.evaluate(nomo=>{
 if(nomo){const c=window.__p03core?.deref();return{tabs:window.__p03.tabs.length,visibleChars:c&&!c.destroyed?c.view.state.doc.length:0,windowBytes:c&&!c.destroyed?c.mapping.endByte-c.mapping.startByte:0,cacheBytes:c&&!c.destroyed?c.viewport.cache.byteSize:0,cmViews:document.querySelectorAll('.cm-editor').length}}
 const m=window.__nativeManager;return{tabs:m.openedDocuments.length,records:m.records.size,views:m.views.size,liveViews:m.liveViews.size,textChars:[...m.records.values()].reduce((n,r)=>n+r.state.doc.length,0),endingEntries:[...m.records.values()].reduce((n,r)=>n+r.state.field(r.endings.field).size,0),canonicalContentsEqual:[...m.views.values()].every(v=>[...m.records.values()].some(r=>r.state.doc.eq(v.state.doc))),distinctTextRoots:new Set([...m.records.values()].map(r=>r.state.doc).concat([...m.views.values()].map(v=>v.state.doc))).size}
 },nomo);const point={stage,time:Date.now(),heapUsed:metrics.JSHeapUsedSize,heapTotal:metrics.JSHeapTotalSize,dom:await cdp.send('Memory.getDOMCounters'),js,native:await native()};current.points.push(point);persist();return point}
async function frames(){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
async function start(run,scene){
 if(fs.existsSync(profile))fs.renameSync(profile,`${profile}-p03-${Date.now()}`)
 fs.mkdirSync(profile,{recursive:true})
 const copyDir=path.join(dir,`files-${run}-${scene}`);fs.mkdirSync(copyDir)
 // Existing Markumo recent-file capability, with no previous session/documents.
 const selected=manifest[scene]||manifest['100kb']
 const recent=[{path:path.join(copyDir,path.basename(selected.file)),name:path.basename(selected.file)}]
 if(scene==='tabs20')for(let i=1;i<20;i++)recent.push({path:path.join(copyDir,`tab-${i}.txt`),name:`tab-${i}.txt`})
 if(!nomo){fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:6,autoCheckUpdates:false,autoDownloadUpdates:false}));fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent,layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}));fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))}
 if(nomo&&controlled){const settings=Object.fromEntries(Object.entries({firstRunSampleDocumentOpened:true,softwareUpdateAutoCheckEnabled:false,themeMode:'dark',appearanceThemeModelV1:true,colorThemeId:'nomo-default',documentStyleId:'nomo-modern'}).map(([key,value])=>[key,{key,value_json:JSON.stringify(value),updated_at:Date.now()}]));fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({app:{settings}}))}
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r))
 const udf=path.join(dir,`webview-${run}-${scene}`),began=performance.now()
 child=spawn(build.binary,[],{windowsHide:true,stdio:'pipe',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:udf,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
 current={run,scene,pid:child.pid,port,udf,copyDir,points:[],operations:[],peaks:[]};report.samples.push(current);persist()
 let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-3000);current.stderr=stderr})
 for(const deadline=Date.now()+60000;;){assert.equal(child.exitCode,null,stderr);try{if((await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500)})).ok)break}catch{}assert(Date.now()<deadline,'CDP startup timeout');await wait(100)}
 browser=await connectRawCDP(`http://127.0.0.1:${port}`);assert(!report.runtime||report.runtime===browser.version());report.runtime=browser.version()
 page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>current.pageErrors=(current.pageErrors||[]).concat(String(e)))
 try{await page.waitForFunction(({nomo,controlled})=>nomo?!!window.__p03&&(!controlled||window.__p03.ready):!!(window.__nativeManager&&document.querySelector('.app:not([inert])')&&!document.querySelector('.startup-overlay')),{nomo,controlled},{timeout:60000})}catch(e){current.startupDiagnostic=await page.evaluate(()=>({url:location.href,title:document.title,body:document.body.innerText.slice(0,3000),ready:document.readyState,p03:!!window.__p03,tauri:!!window.__TAURI_INTERNALS__}));throw e}
 if(nomo&&controlled){current.preferences=await page.evaluate(()=>window.__p03.preferences);assert.equal(current.preferences.themeMode,'dark');assert.equal(current.preferences.softwareUpdateAutoCheckEnabled,false)}
 if(nomo)await page.evaluate(()=>window.__p03.close()) // remove first-run sample using normal close logic
 cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable')
 current.startupMs=performance.now()-began;current.display=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screen:[screen.width,screen.height]}))
 await wait(2000);await sample('cold')
}
async function peakLoop(){while(monitor){const at=Date.now(),stage=current.operation;try{const n=controlled?undefined:await native();current.peaks.push({stage,time:at,...(n?{native:n}:{}),heap:await cdp.send('Runtime.getHeapUsage')})}catch(e){current.monitorError=String(e)}await wait(controlled?250:100)}}
async function startFast(){
 const file=path.join(dir,`${current.run}-${current.scene}-native.jsonl.gz`),stop=path.join(dir,`${current.run}-${current.scene}.stop`),ready=stop+'.ready'
 const sampler=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/p03-fast-sample.ps1'),'-RootPid',String(child.pid),'-Output',file,'-StopFile',stop,'-ReadyFile',ready],{windowsHide:true,stdio:'pipe'})
 fast={sampler,file,stop,ready,closed:new Promise(resolve=>sampler.once('exit',resolve))};let error='';sampler.stderr.on('data',b=>error+=b)
 current.fastSampling={file,pid:sampler.pid,requestedPeriodMs:20,treeRefreshMs:1000};persist()
 for(const deadline=Date.now()+10000;!fs.existsSync(ready);){if(sampler.exitCode!==null)throw Error('Native sampler failed: '+error);assert(Date.now()<deadline,'Native sampler startup timeout');await wait(20)}
}
async function stopFast(){
 if(!fast)return
 const f=fast;fast=undefined;fs.writeFileSync(f.stop,'stop');let timer
 const exitCode=await Promise.race([f.closed,new Promise(resolve=>timer=setTimeout(()=>{f.sampler.kill();resolve('terminated')},10000))]);clearTimeout(timer)
 current.fastSampling.exitCode=exitCode
 if(exitCode!==0){current.fastSampling.error='Sampler did not close normally';return}
 const data=fs.readFileSync(f.file),rows=gunzipSync(data).toString('utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line)),intervals=rows.slice(1).map((r,i)=>r.time-rows[i].time).sort((a,b)=>a-b)
 const total=row=>row.processes.reduce((n,p)=>n+p.private,0)
 const peak=items=>{if(!items.length)return{sampleCount:0,unavailable:true};const highest=items.reduce((a,b)=>total(a)>total(b)?a:b);return{sampleCount:items.length,totalPrivate:total(highest),at:highest.time,processes:highest.processes,rustPrivateMax:Math.max(...items.map(r=>r.processes.filter(p=>p.role==='Rust').reduce((n,p)=>n+p.private,0)))}}
 Object.assign(current.fastSampling,{sha256:sha(data),rows:rows.length,firstAt:rows[0]?.time,lastAt:rows.at(-1)?.time,intervalMs:{min:intervals[0],median:intervals[Math.floor(intervals.length/2)],max:intervals.at(-1)},wholeRunPeak:peak(rows),operations:current.operations.map(o=>({name:o.name,startedAt:o.startedAt,endedAt:o.endedAt,...peak(rows.filter(r=>r.time>=o.startedAt&&r.time<=o.endedAt))}))});persist()
}
async function operation(name,fn){current.operation=name;const began=performance.now(),startedAt=Date.now();try{const value=await fn();current.operations.push({name,startedAt,endedAt:Date.now(),ms:performance.now()-began,ok:true,value});persist();return value}catch(e){current.operations.push({name,startedAt,endedAt:Date.now(),ms:performance.now()-began,ok:false,error:String(e)});persist();throw e}finally{current.operation='idle'}}
async function open(file){return operation('open',async()=>{const result=await page.evaluate(async({file,nomo,controlled})=>{if(nomo){await window.__p03.open(file);if(!window.__p03.tabs.some(t=>t.name===file.split(/[\\/]/).pop()))throw Error('Nomo did not open requested file');if(controlled){const deadline=performance.now()+60000;for(;;){const c=window.__p03core?.deref();if(c&&!c.destroyed&&c.view.dom.isConnected&&!c.getMetadata().readonly)break;if(performance.now()>deadline)throw Error('Nomo validation did not unlock editing');await new Promise(r=>setTimeout(r,10))}}return}const f=await window.__TAURI_INTERNALS__.invoke('open_recent',{path:file,encoding:null}).catch(e=>{throw Error(JSON.stringify(e))});const m=window.__nativeManager,id=m.openFile(f,false,m.activePane,true);if(!id)throw Error('Open rejected');return id},{file,nomo,controlled});await frames();return result})}
async function close(){await operation('close',()=>page.evaluate(async nomo=>{if(nomo){await window.__p03.close();return}const m=window.__nativeManager;m.mergeAllPanes();for(const d of [...m.openedDocuments])if(!m.close(d.id,true))throw Error('Close rejected')},nomo));await frames()}
async function exercise(scene){
 if(scene==='blank'){await wait(1000);await sample('loaded');return}
 const fixture=manifest[scene]||manifest['100kb'];let file=path.join(current.copyDir,path.basename(fixture.file));fs.copyFileSync(fixture.file,file)
 await open(file);await wait(1000)
 if(scene==='tabs20'){for(let i=1;i<20;i++){const f=path.join(current.copyDir,`tab-${i}.txt`);fs.copyFileSync(fixture.file,f);await open(f);file=f}}
 if(scene==='panes'){if(nomo){current.unsupported='Nomo segmented workspace has no equivalent multi-pane action';await sample('loaded');return}await operation('split',()=>page.evaluate(()=>{const m=window.__nativeManager;for(let i=0;i<3;i++)m.splitPane('right')}));await frames()}
 await sample('loaded')
 await operation('input',()=>page.evaluate(async nomo=>{const c=nomo?window.__p03core.deref():null,m=nomo?null:window.__nativeManager,v=nomo?c.view:m.activeEditorView;v.focus();const latencies=[];for(let i=0;i<30;i++){const start=performance.now();v.dispatch({changes:{from:Math.min(5,v.state.doc.length),insert:'中😀'},userEvent:'input.type'});await new Promise(r=>requestAnimationFrame(r));latencies.push(performance.now()-start)}if(nomo)await c.flushEdits();return{latencies,chars:v.state.doc.length}},nomo))
 await sample('edited')
 await operation('search',()=>page.evaluate(async({nomo,controlled})=>{
  if(nomo&&controlled){const c=window.__p03core.deref();await c.flushEdits();window.__p03.openSearch();await new Promise(r=>requestAnimationFrame(r));const input=document.querySelector('#document-search-query');if(!input)throw Error('Nomo search panel did not mount');input.value='中😀';input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));let unlisten,timer;try{return await new Promise(async(resolve,reject)=>{timer=setTimeout(()=>reject(Error('UI search task timeout')),30000);try{unlisten=await c.port.listenTaskProgress(c.options.session.sessionId,p=>{if(p.kind==='search'&&p.state==='completed'){window.__p03.closeSearch();resolve({count:p.matchCount,processedBytes:p.processedBytes,ui:true})}if(p.kind==='search'&&p.state==='failed')reject(Error(p.message||'Search failed'))});document.querySelector('.search-replace-panel .primary-action').click()}catch(e){reject(e)}})}finally{clearTimeout(timer);unlisten?.()}}
  if(nomo){const c=window.__p03core.deref();await c.flushEdits();let unlisten,timer;try{return await new Promise(async(resolve,reject)=>{timer=setTimeout(()=>reject(Error('Search task timeout')),30000);try{unlisten=await c.port.listenTaskProgress(c.options.session.sessionId,p=>{if(p.kind==='search'&&p.state==='completed')resolve({count:p.matchCount,processedBytes:p.processedBytes});if(p.kind==='search'&&p.state==='failed')reject(Error(p.message||'Search failed'))});await c.port.startTask({sessionId:c.options.session.sessionId,baseRevision:c.revision,task:{type:'search',query:'中😀',caseSensitive:true,wholeWord:false}})}catch(e){reject(e)}})}finally{clearTimeout(timer);unlisten?.()}}
  const m=window.__nativeManager;m.command('find');const input=m.activeEditorView.dom.querySelector('input[name=search]');input.value='中😀';input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,100));const status=m.activeEditorView.dom.querySelector('.search-count')?.textContent;m.activeEditorView.dom.querySelector('button[name=close]')?.click();return{status,limit:1500}
 },{nomo,controlled}))
 await operation('undo-redo',()=>page.evaluate(async nomo=>{if(nomo){const c=window.__p03core.deref();await c.undo();await c.redo()}else{window.__nativeManager.command('undo');window.__nativeManager.command('redo')}},nomo))
 await operation('jump-scroll',()=>page.evaluate(async nomo=>{if(nomo){const c=window.__p03core.deref();await c.loadWindow(Math.floor(c.byteLength*.8))}else{const m=window.__nativeManager,v=m.activeEditorView;v.dispatch({selection:{anchor:Math.floor(v.state.doc.length*.8)},scrollIntoView:true})}await new Promise(r=>requestAnimationFrame(r))},nomo))
 if(nomo){await operation('save',()=>page.evaluate(async()=>{if(!await window.__p03.save())throw Error('Save rejected')}))}
 else {try{await operation('save',async()=>{await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:2});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:2});await page.waitForFunction(()=>!window.__nativeManager.activeDocument?.dirty||!!document.querySelector('.toast'));const status=await page.evaluate(()=>({dirty:window.__nativeManager.activeDocument?.dirty,message:document.querySelector('.toast')?.textContent}));if(status.dirty)throw Error(status.message||'Save remains dirty')})}catch(e){current.saveRejected=String(e);await sample('save-rejected');await close();await sample('closed-rejected');current.accepted=false;return}}
 await sample('saved');current.savedDisk={bytes:fs.statSync(file).size,sha256:sha(fs.readFileSync(file))};assert.notEqual(current.savedDisk.sha256,fixture.sha256,'No edit was saved')
 await close();const began=Date.now();for(const ms of [0,1000,5000,15000]){await wait(Math.max(0,began+ms-Date.now()));await sample(`closed-${ms}`)}
 await open(file);await sample('reopened');await close()
}
async function stop(){monitor=false;await monitorTask;monitorTask=undefined;await stopFast();if(browser)current.protocol=browser.protocolCommandCounts();if(child?.exitCode===null)await exec('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});await browser?.close().catch(()=>{});child=browser=page=cdp=undefined;persist();await wait(400)}
try{for(let run=1;run<=rounds;run++)for(const scene of scenes){console.log(label,run,scene);try{await start(run,scene);if(controlled)await startFast();monitor=true;monitorTask=peakLoop();await exercise(scene);current.passed=true}catch(e){current.failure=String(e);report.errors.push({run,scene,error:String(e)});console.log('FAILED',String(e).slice(0,200))}finally{await stop()}}report.completedAt=new Date().toISOString();persist()}finally{await stop()}
console.log(path.join(dir,'results.json'))
