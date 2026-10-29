// Invasive diagnostic runs are isolated from all natural benchmarks.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {connectRawCDP} from './p01-raw-cdp.mjs'
const arg=n=>process.argv.find(v=>v.startsWith(`--${n}=`))?.slice(n.length+3),label=arg('label'),nomo=label==='nomo',fixture=arg('fixture')||'4mb.txt'
assert(/^[\w-]+$/.test(label));assert(/^[\w.-]+$/.test(fixture))
const root=path.resolve('test-results/p03'),out=path.join(root,`heap-${label}-${fixture}-${Date.now()}`),file=path.join(root,'fixtures',fixture),exec=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms))
fs.mkdirSync(out,{recursive:true});const build=JSON.parse(fs.readFileSync(nomo?path.join(root,'nomo-build.json'):path.resolve(`test-results/phase042/build-${label}.json`))),profile=nomo?build.profile:JSON.parse(fs.readFileSync(path.resolve(`test-results/phase042/config-${label}.json`))).app.appDirectoriesOverride
assert.equal(path.resolve(profile),nomo?path.join(process.env.APPDATA,'com.nomo.p03-benchmark'):path.resolve(`test-results/phase042/native-profile-${label}`))
if(fs.existsSync(profile))fs.renameSync(profile,`${profile}-heap-${Date.now()}`);fs.mkdirSync(profile,{recursive:true})
if(!nomo){fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:6,autoCheckUpdates:false,autoDownloadUpdates:false}));fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent:[{path:file,name:fixture}],layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))}
else{const settings=Object.fromEntries(Object.entries({firstRunSampleDocumentOpened:true,softwareUpdateAutoCheckEnabled:false,themeMode:'dark',appearanceThemeModelV1:true,colorThemeId:'nomo-default',documentStyleId:'nomo-modern'}).map(([key,value])=>[key,{key,value_json:JSON.stringify(value),updated_at:Date.now()}]));fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({app:{settings}}))}
const report={label,fixture,build,invasive:true,stages:[],snapshots:[],startedAt:new Date().toISOString()},persist=()=>fs.writeFileSync(path.join(out,'metadata.json'),JSON.stringify(report,null,2))
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r))
const child=spawn(build.binary,[],{windowsHide:true,stdio:'pipe',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(out,'udf'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});let browser,page,cdp
async function point(stage){const usage=await cdp.send('Runtime.getHeapUsage'),dom=await cdp.send('Memory.getDOMCounters'),native=JSON.parse((await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/p01-process-tree.ps1'),'-RootPid',String(child.pid)],{windowsHide:true})).stdout);report.stages.push({stage,usage,dom,native,time:Date.now()});persist()}
async function snapshot(stage){await point(stage+'-before-snapshot');const target=path.join(out,stage+'.heapsnapshot'),fd=fs.openSync(target,'wx'),hash=createHash('sha256');const onChunk=({chunk})=>{fs.writeSync(fd,chunk);hash.update(chunk)};cdp.on('HeapProfiler.addHeapSnapshotChunk',onChunk);try{await cdp.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false})}finally{cdp.off('HeapProfiler.addHeapSnapshotChunk',onChunk);fs.closeSync(fd)}report.snapshots.push({stage,file:target,sha256:hash.digest('hex')});await point(stage+'-after-snapshot')}
try{
 for(const deadline=Date.now()+60000;;){try{if((await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500)})).ok)break}catch{}assert(Date.now()<deadline);await wait(100)}
 browser=await connectRawCDP(`http://127.0.0.1:${port}`);page=browser.contexts()[0].pages()[0];cdp=await page.context().newCDPSession(page);report.runtime=browser.version()
 await page.waitForFunction(nomo=>nomo?!!window.__p03?.ready:!!window.__nativeManager,nomo);if(nomo)await page.evaluate(()=>window.__p03.close());await wait(2000)
 await point('cold-natural');await snapshot('cold')
 await page.evaluate(async({nomo,file})=>{if(nomo){await window.__p03.open(file);return}const f=await window.__TAURI_INTERNALS__.invoke('open_recent',{path:file,encoding:null}).catch(e=>{throw Error(JSON.stringify(e))});window.__nativeManager.openFile(f)}, {nomo,file})
 await wait(1500);await point('loaded-before-diagnostic-gc');await cdp.send('HeapProfiler.collectGarbage');await snapshot('loaded')
 await page.evaluate(async nomo=>{if(nomo){await window.__p03.close();return}const m=window.__nativeManager;for(const d of [...m.openedDocuments])m.close(d.id,true)},nomo)
 await wait(1500);await point('closed-before-diagnostic-gc');await cdp.send('HeapProfiler.collectGarbage');await snapshot('closed');report.completedAt=new Date().toISOString();persist()
}finally{await exec('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});await browser?.close().catch(()=>{});persist()}
console.log(path.join(out,'metadata.json'))
