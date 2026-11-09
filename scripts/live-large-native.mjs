import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import os from 'node:os'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {connectRawCDP} from './p01-raw-cdp.mjs'
const exec=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms)),sha=b=>createHash('sha256').update(b).digest('hex')
const label=process.argv[2],rounds=Number(process.argv[3]||3),scenes=(process.argv[4]||'950k').split(','),campaign=Date.now()
const root=path.resolve('test-results/live-large'),build=JSON.parse(fs.readFileSync(`test-results/phase042/build-${label}.json`)),config=JSON.parse(fs.readFileSync(`test-results/phase042/config-${label}.json`))
const original=fs.readFileSync(build.binary);if(sha(original)!==build.sha256)throw Error('Build hash mismatch')
if(process.env.INSTALLED_BINARY){const installed=fs.readFileSync(process.env.INSTALLED_BINARY),diff=[];if(installed.length!==original.length)throw Error('Installed binary length');for(let i=0;i<original.length;i++)if(installed[i]!==original[i])diff.push(i);if(diff.length&&!(diff.length===3&&diff[2]===diff[0]+2&&original.subarray(diff[0],diff[0]+3).toString()==='UNK'&&installed.subarray(diff[0],diff[0]+3).toString()==='NSS'))throw Error('Unexpected installer payload');build.unbundledSha=build.sha256;build.sha256=sha(installed);build.binary=process.env.INSTALLED_BINARY;build.installed=true}
fs.mkdirSync(root,{recursive:true});const report={label,build,campaign,runnerSha:sha(fs.readFileSync(new URL(import.meta.url))),hardware:{cpu:os.cpus()[0].model,memory:os.totalmem(),os:os.version()},samples:[]}
fs.copyFileSync(new URL(import.meta.url),path.join(root,`runner-${campaign}.mjs`))
const output=path.join(root,`native-${label}-${campaign}.json`),persist=()=>fs.writeFileSync(output,JSON.stringify(report,null,2))
const fixtures=JSON.parse(fs.readFileSync('test-results/markdown-large/fixtures.json'))
const profile=config.app.appDirectoriesOverride
let child,browser,page,cdp,sample,trace,traceComplete
async function deadline(name,fn,ms=30000){sample.phase=name;persist();let timer;const t=performance.now();try{const v=await Promise.race([fn(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(`${name} timeout after ${ms}ms`)),ms))]);sample[name+'Ms']=performance.now()-t;persist();return v}finally{clearTimeout(timer)}}
async function frames(){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
async function memory(){return {heap:await cdp.send('Runtime.getHeapUsage'),dom:await page.evaluate(()=>({connected:document.querySelectorAll('*').length,tableTools:document.querySelectorAll('.md-table-tools').length,workers:window.__markumoMemoryProbe?.workers,editors:window.__markumoMemoryProbe?.editors,cmRecords:window.__nativeManager.records.size,liveViews:window.__nativeManager.liveViews.size})),native:JSON.parse((await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/p01-process-tree.ps1'),'-RootPid',String(child.pid)],{windowsHide:true})).stdout)}}
for(let round=1;round<=rounds;round++)for(const scene of scenes){sample={round,scene};report.samples.push(sample);persist();try{
 const fixture=fixtures.find(f=>f.name===scene),raw=fs.readFileSync(fixture.file),hasBom=raw[0]===239&&raw[1]===187&&raw[2]===191,storageEOL=raw.includes(Buffer.from('\r\n'))?'\r\n':'\n',source=raw.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'),folder=path.join(root,`${label}-${campaign}-${round}-${scene}`);fs.mkdirSync(folder);const file=path.join(folder,`${scene}.md`);fs.copyFileSync(fixture.file,file);sample.fixture={...fixture,file}
 fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:6,autoCheckUpdates:false,autoDownloadUpdates:false,defaultMdMode:'live',showOutline:false,theme:'dark'}));fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent:[{path:file,name:path.basename(file)}],layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}));fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));child=spawn(build.binary,[],{windowsHide:true,stdio:'pipe',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(folder,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
 await deadline('startup',async()=>{for(const until=Date.now()+60000;;){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}if(Date.now()>until)throw Error('CDP startup');await wait(100)}browser=await connectRawCDP(`http://127.0.0.1:${port}`);report.runtime=browser.version();page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>(sample.errors??=[]).push(e.message));cdp=await page.context().newCDPSession(page);await page.waitForFunction(()=>window.__nativeManager&&!document.querySelector('.startup-overlay'));await frames()},65000)
 sample.cold=await memory();persist();const began=performance.now()
 await deadline('openLive',async()=>{sample.io=await page.evaluate(async file=>{const m=window.__nativeManager;m.setDefaultMarkdownMode('live');const t=performance.now();const f=await window.__TAURI_INTERNALS__.invoke('open_recent',{path:file,encoding:null}).catch(e=>{throw Error(JSON.stringify(e))});const io=performance.now()-t;window.__liveId=m.openFile(f,false,m.activePane,true);return io},file);await page.waitForFunction(()=>document.querySelector('.markdown-live .ProseMirror[contenteditable="true"]'));await frames()},60000)
 sample.firstReadableMs=performance.now()-began;persist();if(label.endsWith('before')){sample.loaded=await memory();persist()}
 const selection=await deadline('focus',()=>page.evaluate(()=>{const m=window.__nativeManager;m.focusPane(m.activePane,true);return m.liveViews.get(m.activePane).editor.selection}))
 await deadline('firstInput',async()=>{await cdp.send('Input.insertText',{text:'验'});await frames()});sample.firstInputFromOpenMs=performance.now()-began
 if(!sample.loaded)sample.loaded=await memory();persist();let expected=source.slice(0,selection.anchor)+'验'+source.slice(selection.head);if(sha(await page.evaluate(()=>window.__nativeManager.getText(window.__liveId)))!==sha(expected))throw Error('First native input did not reach canonical document')
 sample.input=[]
 if(process.env.PROFILE_INPUT==='1'){
  await page.evaluate(()=>{
   const m=window.__nativeManager,l=m.liveViews.get(m.activePane).editor
   window.__inputTimings={}
   const wrap=(object,name,label)=>{const original=object[name];if(typeof original!=='function')return;object[name]=function(...args){const start=performance.now();try{return original.apply(this,args)}finally{const row=window.__inputTimings[label]??={calls:0,ms:0,max:0};const elapsed=performance.now()-start;row.calls++;row.ms+=elapsed;row.max=Math.max(row.max,elapsed)}}}
   for(const name of ['dispatch','updateTools','releaseIdleCodeEditors'])wrap(Object.getPrototypeOf(l),name,'Live.'+name)
   wrap(Object.getPrototypeOf(l.bridge),'prepare','Bridge.prepare')
   wrap(Object.getPrototypeOf(l.view),'updateState','PM.updateState')
   wrap(Object.getPrototypeOf(l.view.state),'applyTransaction','PM.applyTransaction')
  });await cdp.send('Performance.enable');sample.performanceBefore=await cdp.send('Performance.getMetrics');await cdp.send('Profiler.enable');await cdp.send('Profiler.start')
 }
 if(process.env.PROFILE_TRACE==='1'){
  trace=await browser.newBrowserCDPSession();traceComplete=new Promise(resolve=>trace.once('Tracing.tracingComplete',resolve));
  await trace.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'})
 }
 for(let i=0;i<20;i++){const t=performance.now();await deadline('input'+i,async()=>{await cdp.send('Input.insertText',{text:'中'});await frames()});sample.input.push(performance.now()-t)}
 if(process.env.PROFILE_INPUT==='1'){
  const {profile}=await cdp.send('Profiler.stop');sample.cpuProfile=path.join(root,`native-input-${campaign}-${round}-${scene}.cpuprofile`);fs.writeFileSync(sample.cpuProfile,JSON.stringify(profile));sample.inputTimings=await page.evaluate(()=>window.__inputTimings);sample.performanceAfter=await cdp.send('Performance.getMetrics');persist()
 }
 if(process.env.PROFILE_TRACE==='1'){
  await trace.send('Tracing.end');const {stream}=await traceComplete;const chunks=[];
  for(;;){const part=await trace.send('IO.read',{handle:stream});chunks.push(Buffer.from(part.data,part.base64Encoded?'base64':'utf8'));if(part.eof)break}
  await trace.send('IO.close',{handle:stream});sample.trace=path.join(root,`native-trace-${campaign}-${round}-${scene}.json`);fs.writeFileSync(sample.trace,Buffer.concat(chunks));persist()
 }
 const body=await page.evaluate(()=>window.__nativeManager.getText(window.__liveId));expected=source.slice(0,selection.anchor)+'验'+'中'.repeat(20)+source.slice(selection.head);if(sha(body)!==sha(expected))throw Error('Continuous typing changed unrelated source');sample.typingSHA=sha(body)
 await deadline('undo',()=>page.evaluate(original=>{const m=window.__nativeManager;for(let i=0;i<25&&m.getText(window.__liveId)!==original;i++)m.command('undo');if(m.getText(window.__liveId)!==original)throw Error('Undo mismatch')},source));sample.undoSHA=sha(await page.evaluate(()=>window.__nativeManager.getText(window.__liveId)))
 await deadline('redo',()=>page.evaluate(typed=>{const m=window.__nativeManager;for(let i=0;i<25&&m.getText(window.__liveId)!==typed;i++)m.command('redo');if(m.getText(window.__liveId)!==typed)throw Error('Redo mismatch')},expected));
 await deadline('restoreOriginal',()=>page.evaluate(original=>{const m=window.__nativeManager;for(let i=0;i<25&&m.getText(window.__liveId)!==original;i++)m.command('undo');if(m.getText(window.__liveId)!==original)throw Error('Restore mismatch')},source));
 await deadline('saveOriginal',()=>page.evaluate(async()=>{const m=window.__nativeManager,s=m.saveSnapshot(window.__liveId);const f=await window.__TAURI_INTERNALS__.invoke('save_file',{token:s.metadata.fileToken,text:s.text,expectedVersion:s.metadata.lastDiskVersion,encoding:s.metadata.encoding,bom:s.metadata.bom}).catch(e=>{throw Error(JSON.stringify(e))});if(!s.complete(f))throw Error('save completion')}));sample.savedOriginalSHA=sha(fs.readFileSync(file));if(sample.savedOriginalSHA!==fixture.sha256)throw Error('Saved unmodified bytes changed')
 const editSelection=await page.evaluate(()=>{const m=window.__nativeManager;m.revealPosition(window.__liveId,1,1);m.focusPane(m.activePane,true);return m.liveViews.get(m.activePane).editor.selection});await deadline('editedInput',async()=>{await cdp.send('Input.insertText',{text:'验😀'});await frames()});expected=source.slice(0,editSelection.anchor)+'验😀'+source.slice(editSelection.head)
 await deadline('saveEdited',()=>page.evaluate(async()=>{const m=window.__nativeManager,s=m.saveSnapshot(window.__liveId);const f=await window.__TAURI_INTERNALS__.invoke('save_file',{token:s.metadata.fileToken,text:s.text,expectedVersion:s.metadata.lastDiskVersion,encoding:s.metadata.encoding,bom:s.metadata.bom}).catch(e=>{throw Error(JSON.stringify(e))});s.complete(f)}));sample.savedEditedSHA=sha(fs.readFileSync(file));sample.expectedEditedSHA=sha(Buffer.concat([hasBom?Buffer.from([239,187,191]):Buffer.alloc(0),Buffer.from(expected.replace(/\n/g,storageEOL))]));if(sample.savedEditedSHA!==sample.expectedEditedSHA)throw Error('Edited file bytes mismatch')
 await deadline('reopen',()=>page.evaluate(async file=>{const m=window.__nativeManager;m.close(window.__liveId,true);const f=await window.__TAURI_INTERNALS__.invoke('open_recent',{path:file,encoding:null});window.__liveId=m.openFile(f,false,m.activePane,true)},file));await page.waitForFunction(()=>window.__nativeManager.liveViews.size>0);if(sha(await page.evaluate(()=>window.__nativeManager.getText(window.__liveId)))!==sha(expected))throw Error('Reopen mismatch')
 sample.edited=await memory();
 await deadline('sourceMode',async()=>{await page.evaluate(()=>window.__nativeManager.setMarkdownMode(window.__liveId,'source'));await page.waitForFunction(()=>document.querySelector('.editor-host .cm-content[contenteditable="true"]'));await frames()});
 await deadline('splitMode',async()=>{await page.evaluate(()=>window.__nativeManager.setMarkdownMode(window.__liveId,'split'));await page.waitForFunction(()=>document.querySelector('.split-preview-content h1'));await frames()});
 await deadline('splitIndex',()=>page.waitForFunction(()=>!document.querySelector('.preview-progress')));
 await deadline('liveMode',async()=>{await page.evaluate(()=>window.__nativeManager.setMarkdownMode(window.__liveId,'live'));await page.waitForFunction(()=>window.__nativeManager.liveViews.size>0);await frames()});
 if(sha(await page.evaluate(()=>window.__nativeManager.getText(window.__liveId)))!==sha(expected))throw Error('Mode round trip changed source');
 await deadline('close',()=>page.evaluate(()=>{const m=window.__nativeManager;for(const d of [...m.openedDocuments])m.close(d.id,true)}));await wait(1500);sample.closed=await memory();
 // Natural reclamation is recorded separately from optional diagnostic GC.
 if(process.env.CLOSE_CURVE==='1'){
  sample.closeCurve=[];let elapsed=1500
  for(const at of [10000,30000]){await wait(at-elapsed);sample.closeCurve.push({afterMs:at,...await memory()});elapsed=at;persist()}
 }
 if(process.env.DIAGNOSTIC_GC==='1'){await cdp.send('HeapProfiler.collectGarbage');await frames();sample.closedDiagnosticGC=await memory()}
 sample.passed=true;console.log(label,round,scene,'PASS',sample.firstReadableMs,sample.firstInputMs)
 }catch(e){sample.failure=String(e);console.log(label,round,scene,'FAIL',sample.phase,sample.failure)}finally{persist();await browser?.close().catch(()=>{});if(child)await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});child=browser=page=cdp=undefined}}
report.completedAt=new Date().toISOString();persist();console.log(output);process.exitCode=report.samples.some(s=>!s.passed)?1:0
