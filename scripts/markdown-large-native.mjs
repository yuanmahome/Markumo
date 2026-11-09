import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {connectRawCDP} from './p01-raw-cdp.mjs'
const exec=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms)),sha=b=>createHash('sha256').update(b).digest('hex')
const label=process.argv[2],rounds=Number(process.argv[3]||3),scenes=(process.argv[4]||'950k').split(',')
if(!/^[\w-]+$/.test(label))throw Error('invalid label')
const build=JSON.parse(fs.readFileSync(`test-results/phase042/build-${label}.json`))
if(sha(fs.readFileSync(build.binary))!==build.sha256)throw Error('build hash mismatch')
if(process.env.INSTALLED_BINARY){
 const plain=fs.readFileSync(build.binary),installed=fs.readFileSync(process.env.INSTALLED_BINARY),diff=[]
 if(plain.length!==installed.length)throw Error('Installed binary size mismatch')
 for(let i=0;i<plain.length;i++)if(plain[i]!==installed[i])diff.push(i)
 if(diff.length&&!(diff.length===3&&diff[2]===diff[0]+2&&plain.subarray(diff[0],diff[0]+3).toString()==='UNK'&&installed.subarray(diff[0],diff[0]+3).toString()==='NSS'))throw Error('Unexpected installed binary difference')
 build.unbundledSha256=build.sha256;build.bundleMarkerOffsets=diff;build.binary=path.resolve(process.env.INSTALLED_BINARY);build.sha256=sha(installed);build.installed=true
}

const profile=JSON.parse(fs.readFileSync(`test-results/phase042/config-${label}.json`)).app.appDirectoriesOverride
const fixtures=JSON.parse(fs.readFileSync('test-results/markdown-large/fixtures.json'))
const campaign=Date.now().toString()
const out=path.resolve(`test-results/markdown-large/native-${label}-${scenes.join('-')}.json`)
const report={label,build,splitOnly:!!process.env.SPLIT_ONLY,hardware:{cpu:os.cpus()[0].model,memory:os.totalmem(),os:os.version()},runtime:null,startedAt:new Date().toISOString(),samples:[]}
const persist=()=>fs.writeFileSync(out,JSON.stringify(report,null,2))
let child,browser,page,cdp
async function frames(){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
async function memory(){return {js:await cdp.send('Runtime.getHeapUsage'),dom:await cdp.send('Memory.getDOMCounters'),connected:await page.evaluate(()=>({nodes:document.querySelectorAll('*').length,workers:window.__markumoMemoryProbe?.workers,editors:window.__markumoMemoryProbe?.editors})),native:JSON.parse((await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/p01-process-tree.ps1'),'-RootPid',String(child.pid)],{windowsHide:true})).stdout)}}
for(let round=1;round<=rounds;round++)for(const scene of scenes){
 const fixture=fixtures.find(f=>f.name===scene),sample={round,scene,fixture};report.samples.push(sample);persist()
 try{
  const folder=path.resolve(`test-results/markdown-large/${label}-${campaign}-${round}-${scene}`);fs.mkdirSync(folder,{recursive:true})
  const file=path.join(folder,path.basename(fixture.file));fs.copyFileSync(fixture.file,file)
  fs.mkdirSync(profile,{recursive:true})
  fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:6,autoCheckUpdates:false,autoDownloadUpdates:false,defaultMdMode:'source',showOutline:false,theme:'dark'}))
  fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent:[{path:file,name:path.basename(file)}],layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))
  fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r))
  child=spawn(build.binary,[],{windowsHide:true,stdio:'pipe',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(folder,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
  for(const deadline=Date.now()+60000;;){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}if(Date.now()>deadline)throw Error('CDP timeout');await wait(100)}
  browser=await connectRawCDP(`http://127.0.0.1:${port}`);report.runtime=browser.version();page=browser.contexts()[0].pages()[0]
  page.on('pageerror',e=>{sample.errors??=[];sample.errors.push(e.message)})
  await page.waitForFunction(()=>window.__nativeManager&&!document.querySelector('.startup-overlay'),null,{timeout:60000})
  cdp=await page.context().newCDPSession(page);await frames();sample.cold=await memory();persist()
  const began=performance.now()
  sample.open=await page.evaluate(async file=>{const m=window.__nativeManager;m.setDefaultMarkdownMode('source');const t=performance.now();const f=await window.__TAURI_INTERNALS__.invoke('open_recent',{path:file,encoding:null}).catch(e=>{throw Error(JSON.stringify(e))});const readIPC=performance.now()-t;const cm=performance.now();const id=m.openFile(f,false,m.activePane,true);window.__largeId=id;return {readDecodeIPC:readIPC,stateMount:performance.now()-cm}},file)
  await page.waitForFunction(()=>document.querySelector('.editor-host .cm-content[contenteditable="true"]'));await frames();sample.sourceReadableEditableMs=performance.now()-began
  sample.source=await memory();persist()
  if(!process.env.SPLIT_ONLY){
  const live=performance.now();await page.evaluate(()=>window.__nativeManager.setMarkdownMode(window.__largeId,'live'))
  await page.waitForFunction(()=>document.querySelector('.markdown-live .ProseMirror[contenteditable="true"]'),null,{timeout:60000});await frames();sample.liveSwitchMs=performance.now()-live
  sample.live=await memory();persist()
  sample.input=[]
  await page.evaluate(()=>{const m=window.__nativeManager;m.revealPosition(window.__largeId,1,1);const live=m.liveViews.get(m.activePane);live.editor.view.focus()})
  for(let i=0;i<10;i++){const t=performance.now();await cdp.send('Input.insertText',{text:'验'});await frames();sample.input.push(performance.now()-t)}
  await page.evaluate(()=>{const m=window.__nativeManager;for(let i=0;i<10;i++)m.command('undo')});await frames()
  sample.afterUndoSHA=sha(await page.evaluate(()=>window.__nativeManager.getText(window.__largeId)))
  sample.fidelity=sample.afterUndoSHA===fixture.sha256
  } else {sample.fidelity=sha(await page.evaluate(()=>window.__nativeManager.getText(window.__largeId)))===fixture.sha256}
  const split=performance.now();await page.evaluate(()=>window.__nativeManager.setMarkdownMode(window.__largeId,'split'))
  await page.waitForFunction(()=>document.querySelector('.split-preview-content h1'),null,{timeout:60000});await frames();sample.splitReadableMs=performance.now()-split
  await page.waitForFunction(()=>!document.querySelector('.preview-progress'),null,{timeout:60000});sample.splitIndexedMs=performance.now()-split
  sample.split=await memory();persist()
  const end=performance.now();await page.evaluate(()=>{const r=document.querySelector('.split-preview-pane');r.scrollTop=r.scrollHeight})
  await page.waitForFunction(()=>document.querySelector('.split-preview-pane')?.textContent.includes('DOCUMENT_END'),null,{timeout:15000});await frames();sample.endJumpMs=performance.now()-end
  sample.scrolling=await page.evaluate(async()=>{const root=document.querySelector('.split-preview-pane'),times=[];let prev=performance.now();for(let i=0;i<60;i++){root.scrollTop=root.scrollHeight*i/60;await new Promise(r=>requestAnimationFrame(r));const now=performance.now();times.push(now-prev);prev=now}return times})
  sample.splitEnd=await memory()
  await page.evaluate(()=>{const m=window.__nativeManager;for(const doc of [...m.openedDocuments])m.close(doc.id,true)})
  await wait(1500);await frames();sample.closed=await memory();sample.passed=sample.fidelity
  console.log(label,round,scene,{source:sample.sourceReadableEditableMs,live:sample.liveSwitchMs,split:sample.splitReadableMs,fidelity:sample.fidelity})
 }catch(e){sample.failure=String(e);console.log('FAILED',label,round,scene,String(e))}
 finally{persist();await browser?.close().catch(()=>{});if(child)await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});child=browser=page=cdp=undefined}
}
report.completedAt=new Date().toISOString();persist()

