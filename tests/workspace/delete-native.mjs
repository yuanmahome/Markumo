// Real filesystem deletion through the workspace command and real tab/window UI.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import {chromium} from 'playwright'
const base=path.resolve('test-results/phase042'),label='dnd-delete',out=path.resolve('test-results/workspace/delete-native')
fs.mkdirSync(out,{recursive:true})
const root=fs.mkdtempSync(path.join(out,'fixture-'))
assert(fs.realpathSync(root).startsWith(fs.realpathSync(out)+path.sep))
const folder=path.join(root,'remove'),other=path.join(root,'keep.txt'),a=path.join(folder,'a.md'),b=path.join(folder,'nested/b.txt'),remote=path.join(root,'remote.txt')
fs.mkdirSync(path.dirname(b),{recursive:true})
for(const file of[a,b,other,remote])fs.writeFileSync(file,file===a?'# Heading\n\noriginal\n':'original\n')
const config=JSON.parse(fs.readFileSync(path.join(base,`config-${label}.json`))),profile=path.resolve(config.app.appDirectoriesOverride)
assert.equal(profile,path.join(base,'native-profile-'+label))
if(fs.existsSync(profile))fs.renameSync(profile,profile+'-delete-backup-'+Date.now())
fs.mkdirSync(profile,{recursive:true})
fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:7,autoCheckUpdates:false,autoDownloadUpdates:false,externalFileMonitoring:false,showOutline:false}))
fs.writeFileSync(path.join(profile,'workspaces.json'),JSON.stringify({recent_workspaces:[root],active_roots:[]}))
fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))
const port=9698,wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[],errors=[]
const child=spawn(path.join(base,`markumo-${label}.exe`),[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
let browser,main
try{
 const deadline=Date.now()+45000
 while(true){assert.equal(child.exitCode,null);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}assert(Date.now()<deadline);await wait(150)}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
 main=browser.contexts().flatMap(c=>c.pages()).find(p=>!p.url().startsWith('devtools:'))
 main.on('pageerror',e=>errors.push(e.message));main.setDefaultTimeout(15000)
 await main.waitForFunction(()=>window.__nativeWorkspace&&window.__dndShell&&!document.querySelector('.startup-overlay'))
 assert(await main.evaluate(root=>window.__nativeWorkspace.openWorkspacePath(root,true),root))
 const open=async file=>main.evaluate(async path=>{
  const opened=await window.__TAURI_INTERNALS__.invoke('open_workspace_file',{path,encoding:null})
  window.__dndShell.files.accept(opened,false)
  return{id:window.__nativeManager.activeId,token:opened.token,version:opened.version}
 },file)
 const first=await open(a),second=await open(b),kept=await open(other)
 await main.evaluate(({first,kept})=>{
  const m=window.__nativeManager
  m.dispatch(first.id,{changes:{from:0,insert:'unsaved '}})
  m.dispatch(kept.id,{changes:{from:0,insert:'keep dirty '}})
  m.splitPane('right',m.activePane,first.id)
 },{first,kept})
 assert.equal(await main.locator('.tab .filename').filter({hasText:'a.md'}).count(),2)
 // Only a freshly created descendant fixture is passed to the recursive delete.
 assert(fs.realpathSync(folder).startsWith(fs.realpathSync(root)+path.sep))
 await main.evaluate(folder=>window.__nativeWorkspace.deleteNode({path:folder,isDirectory:true}),folder)
 assert.equal(fs.existsSync(folder),false)
 await main.waitForFunction(({first,second})=>!window.__nativeManager.metadata(first.id)&&!window.__nativeManager.metadata(second.id),{first,second})
 assert.equal(await main.locator('.tab .filename').filter({hasText:'a.md'}).count(),0)
 assert.equal(await main.evaluate(id=>window.__nativeManager.getText(id),kept.id),'keep dirty original\n')
 assert.equal(fs.readFileSync(other,'utf8'),'original\n')
 const stale=await main.evaluate(async file=>{try{await window.__TAURI_INTERNALS__.invoke('save_file',{token:file.token,text:'resurrect',expectedVersion:file.version,encoding:'UTF-8',bom:false});return false}catch{return true}},first)
 assert.equal(stale,true);assert.equal(fs.existsSync(folder),false)
 results.push('delete dirty open directory, close both pane copies, preserve sibling and reject stale save')
 // A failed root deletion keeps the dirty sibling tab and its actual file.
 await main.evaluate(root=>window.__nativeWorkspace.deleteNode({path:root,isDirectory:true}),root)
 assert.equal(await main.evaluate(id=>window.__nativeManager.getText(id),kept.id),'keep dirty original\n')
 assert.equal(fs.readFileSync(other,'utf8'),'original\n')
 results.push('native root-delete rejection leaves dirty tabs and disk contents intact')
 // The deleting window need not own the file: the committed event closes the
 // detached owner's tab too, and its revoked token cannot save the file back.
 await open(remote)
 await main.evaluate(()=>{const m=window.__nativeManager;m.dispatch(m.activeId,{changes:{from:0,insert:'remote dirty '}})})
 assert(await main.evaluate(()=>window.__dndShell.__detach({x:-4000,y:-4000,forceNew:true})))
 let detached
 for(let i=0;i<150&&!detached;i++){
  for(const page of browser.contexts().flatMap(c=>c.pages()))if(page!==main&&!page.isClosed())try{if(await page.evaluate(()=>window.__nativeManager?.openedDocuments.some(d=>d.name==='remote.txt')&&!document.querySelector('.startup-overlay')))detached=page}catch{}
  if(!detached)await wait(100)
 }
 assert(detached,'Detached receiver must adopt the dirty document')
 await main.evaluate(path=>window.__nativeWorkspace.deleteNode({path,isDirectory:false}),remote)
 assert.equal(fs.existsSync(remote),false)
 for(let i=0;i<150&&!detached.isClosed();i++){if(await detached.evaluate(()=>window.__nativeManager.openedDocuments.length===0).catch(()=>true))break;await wait(100)}
 assert(detached.isClosed()||await detached.evaluate(()=>window.__nativeManager.openedDocuments.length===0))
 results.push('deleting a file owned by another window closes its dirty tab')
 assert.deepEqual(errors,[])
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2)+'\n')
 for(const result of results)console.log('PASS',result)
 console.log('NATIVE DELETE 3/3 passed')
}finally{if(child.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}await browser?.close().catch(()=>{})}
