// Real disk bytes through production Ctrl+S, Tauri codecs, version checks and
// atomic saves. All documents and profiles belong to this isolated test run.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn,execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { corpus,eolVariants } from './corpus.mjs'
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)||'p0-after'
assert(/^[\w-]+$/.test(label))
const batch=Number(process.argv.find(arg=>arg.startsWith('--batch='))?.slice(8)||0)
assert(batch===0||batch===1)
const base=path.resolve('test-results/phase042'),out=path.resolve('test-results/lossless/native-'+label+'-'+batch)
fs.mkdirSync(out,{recursive:true})
const config=JSON.parse(fs.readFileSync(path.join(base,`config-${label}.json`),'utf8')),profile=path.resolve(config.app.appDirectoriesOverride)
assert.equal(profile,path.join(base,'native-profile-'+label))
if(fs.existsSync(profile))fs.renameSync(profile,profile+'-lossless-backup-'+Date.now())
fs.mkdirSync(profile,{recursive:true})
const cases=eolVariants.map(item=>({...item,encoding:'UTF-8',bytes:Buffer.from(item.source)}))
const source=corpus.find(item=>item.name==='complex').source
cases.push({name:'large-source-budget',source:'# Large\n\n'+'a '.repeat(600000),encoding:'UTF-8'})
cases.push({name:'utf8-bom',source,encoding:'UTF-8',bytes:Buffer.concat([Buffer.from([239,187,191]),Buffer.from(source)])},
 {name:'mixed-eol',source:source.replace(/\n/g,(_,at)=>at%3===0?'\r':at%3===1?'\r\n':'\n'),encoding:'UTF-8'})
for(const encoding of ['UTF-16LE','UTF-16BE'])for(const bom of [false,true]){
 const text='# 标题\r\n\r\nLOCAL_EDIT_TARGET 中文 😀 é\r\n',bytes=Buffer.from(text,'utf16le');if(encoding==='UTF-16BE')bytes.swap16()
 cases.push({name:encoding+'-'+bom,source:text,encoding,bytes:bom?Buffer.concat([Buffer.from(encoding==='UTF-16LE'?[255,254]:[254,255]),bytes]):bytes})
}
for(const encoding of ['GB18030','windows-1252'])cases.push({name:encoding,source:encoding==='GB18030'?'# 标题\r\n\r\nLOCAL_EDIT_TARGET 中文\r\n':'# café €\r\n\r\nLOCAL_EDIT_TARGET\r\n',encoding,transcode:true})
const selected=cases.slice(batch*18,(batch+1)*18)
for(const item of cases){item.path=path.join(out,item.name+'.md');fs.writeFileSync(item.path,item.bytes||Buffer.from(item.source))}
fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:7,autoCheckUpdates:false,autoDownloadUpdates:false,externalFileMonitoring:false,showOutline:false,caretAnimation:'off'}))
const permitted=[...new Set([...selected,cases.find(item=>item.name==='complex'),cases.find(item=>item.name==='no-eof')])]
fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent:permitted.map(item=>({path:item.path,name:path.basename(item.path)})),layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))
fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const port=9699,results=[],errors=[]
const child=spawn(path.join(base,`markumo-${label}.exe`),[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
let browser,page
const persist=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({label,results,errors},null,2)+'\n')
try{
 const deadline=Date.now()+45000
 while(true){assert.equal(child.exitCode,null);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}assert(Date.now()<deadline);await wait(150)}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts().flatMap(c=>c.pages()).find(p=>!p.url().startsWith('devtools:'))
 page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000)
 await page.waitForFunction(()=>window.__nativeManager&&!document.querySelector('.startup-overlay'))
 async function open(item){
  await page.evaluate(async item=>{
   const invoke=window.__TAURI_INTERNALS__.invoke
   let file
   try{file=await invoke('open_recent',{path:item.path,encoding:item.transcode?'UTF-8':item.encoding})}catch(error){throw Error(item.name+' '+JSON.stringify(error))}
   if(item.transcode){await invoke('save_file',{token:file.token,text:item.source,expectedVersion:file.version,encoding:item.encoding,bom:false});await invoke('release_file',{token:file.token});file=await invoke('open_recent',{path:item.path,encoding:item.encoding})}
   const m=window.__nativeManager,id=m.openFile(file,false)
   if(item.source.length>1024*1024)m.setMarkdownMode(id,'source')
  },item)
  await page.waitForFunction(()=>{const m=window.__nativeManager;return m.getText(m.activeId).length>1024*1024||m.getMarkdownMode(m.activeId)!=='live'||m.activeLiveEditor?.bridge.source===m.getText(m.activeId)})
  assert.equal(await page.evaluate(()=>{const m=window.__nativeManager;return m.getText(m.activeId)}),item.source.replace(/\r\n?/g,'\n'))
 }
 async function close(){
  await page.waitForTimeout(100)
  await page.locator('.tab .tinyclose').first().click()
  await page.waitForFunction(()=>window.__nativeManager.openedDocuments.length===0)
 }
 async function save(){
  const previous=await page.evaluate(()=>{const m=window.__nativeManager;return m.metadata(m.activeId).lastDiskVersion})
  await page.evaluate(()=>{const m=window.__nativeManager;m.activeLiveEditor?.view.focus();m.activeEditorView?.focus()})
  await page.keyboard.press('Control+s')
  // Tauri's invoke is intentionally immutable. Observe the authoritative
  // native disk version acknowledged by FileController instead of wrapping IPC.
  await page.waitForFunction(previous=>{const m=window.__nativeManager,d=m.metadata(m.activeId);return d?.lastDiskVersion!==previous&&!d?.dirty},previous)
  await page.waitForTimeout(100)
 }
 for(const item of selected){
  await open(item);const original=fs.readFileSync(item.path),originalHash=sha(original)
  for(const mode of ['source','split','live']){
   await page.evaluate(mode=>{const m=window.__nativeManager;m.setMarkdownMode(m.activeId,mode)},mode)
   await page.waitForFunction(()=>{const m=window.__nativeManager;return m.getText(m.activeId).length>1024*1024||m.getMarkdownMode(m.activeId)!=='live'||m.activeLiveEditor?.bridge.source===m.getText(m.activeId)})
  }
  await save();assert.equal(sha(fs.readFileSync(item.path)),originalHash,'no-op '+item.name)
  await close();await open({...item,transcode:false});await save();await close()
  assert.equal(sha(fs.readFileSync(item.path)),originalHash,'reopen '+item.name)
  results.push({name:item.name,encoding:item.encoding,sha256:originalHash,bytes:original.length,kind:'no-op/save/reopen'});persist();console.log('PASS native byte round trip',item.name)
  if(!process.argv.includes('--no-local')&&item.source.includes('LOCAL_EDIT_TARGET')){
   await open({...item,transcode:false})
   await page.evaluate(()=>{
    const m=window.__nativeManager,e=m.activeLiveEditor;let at
    e.view.state.doc.descendants((node,pos)=>{if(at===undefined&&node.isText&&node.text.includes('LOCAL_EDIT_TARGET'))at=pos+node.text.indexOf('LOCAL_EDIT_TARGET')})
    if(at===undefined)throw Error('Missing localized target')
    e.view.dispatch(e.view.state.tr.insertText('EDIT_',at));e.view.focus()
   })
   const encode=text=>{const data=Buffer.from(text,item.encoding.startsWith('UTF-16')?'utf16le':'utf8');if(item.encoding==='UTF-16BE')data.swap16();return data}
   const offset=original.indexOf(encode('LOCAL_EDIT_TARGET'));assert(offset>=0)
   const expected=Buffer.concat([original.subarray(0,offset),encode('EDIT_'),original.subarray(offset)])
   await save();assert.deepEqual(fs.readFileSync(item.path),expected,'localized bytes '+item.name)
   await page.keyboard.press('Control+z');await save();assert.deepEqual(fs.readFileSync(item.path),original,'encoded undo '+item.name)
   await page.keyboard.press('Control+y');await save();assert.deepEqual(fs.readFileSync(item.path),expected,'encoded redo '+item.name)
   await page.keyboard.press('Control+z');await save();await close()
   results.push({name:item.name+' localized history',encoding:item.encoding,kind:'byte patch + undo/redo preserves encoding/BOM/EOL'});persist()
  }
 }
 if(!process.argv.includes('--no-local')){
 const edit=cases.find(item=>item.name==='complex');await open(edit)
 const original=fs.readFileSync(edit.path),originalHash=sha(original)
 await page.evaluate(()=>{
  const e=window.__nativeManager.activeLiveEditor;let at
  e.view.state.doc.descendants((node,pos)=>{if(node.type.name==='heading'&&node.textContent==='ATX 标题')at=pos+1})
  if(at===undefined)throw Error('Missing native heading target')
  e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.near(e.view.state.doc.resolve(at))));e.view.focus()
 })
 await page.keyboard.press('Control+3');await save()
 assert.deepEqual(fs.readFileSync(edit.path),Buffer.from(edit.source.replace('##   ATX 标题  ##','###   ATX 标题  ##')),'heading shortcut preserves raw marker spacing')
 await page.keyboard.press('Control+z');await save();assert.equal(sha(fs.readFileSync(edit.path)),originalHash,'heading Undo restores disk bytes')
 results.push({name:'heading shortcut/save/undo',kind:'production Ctrl+3 and Ctrl+S preserve source IDs and exact bytes'});persist()
 await page.evaluate(()=>{
  const m=window.__nativeManager,e=m.activeLiveEditor;let at=-1
  e.view.state.doc.descendants((node,pos)=>{if(at<0&&node.isText&&node.text.includes('LOCAL_EDIT_TARGET'))at=pos+node.text.indexOf('LOCAL_EDIT_TARGET')})
  e.view.dispatch(e.view.state.tr.insertText('新增',at));e.view.focus()
 })
 await save();assert.deepEqual(fs.readFileSync(edit.path),Buffer.from(edit.source.replace('LOCAL_EDIT_TARGET','新增LOCAL_EDIT_TARGET')))
 await page.keyboard.press('Control+z');await save();assert.equal(sha(fs.readFileSync(edit.path)),originalHash,'undo restores disk bytes')
 await page.keyboard.press('Control+y');await save();assert.deepEqual(fs.readFileSync(edit.path),Buffer.from(edit.source.replace('LOCAL_EDIT_TARGET','新增LOCAL_EDIT_TARGET')))
 await close();await open({...edit,source:edit.source.replace('LOCAL_EDIT_TARGET','新增LOCAL_EDIT_TARGET')});await close()
 results.push({name:'localized+undo+redo+reopen',kind:'real PM edit / production saves',sha256:sha(fs.readFileSync(edit.path))});persist()
 }
 // Conflict detection must leave independently modified disk bytes untouched.
 const conflict=cases.find(item=>item.name==='no-eof');await open(conflict)
 const external=Buffer.from(conflict.source+'\nEXTERNAL CHANGE');fs.writeFileSync(conflict.path,external)
 const rejected=await page.evaluate(async()=>{const m=window.__nativeManager,s=m.saveSnapshot(m.activeId);try{await window.__TAURI_INTERNALS__.invoke('save_file',{token:s.metadata.fileToken,text:s.text+'overwrite',expectedVersion:s.metadata.lastDiskVersion,encoding:s.metadata.encoding,bom:s.metadata.bom});return false}catch{return true}})
 assert.equal(rejected,true);assert.deepEqual(fs.readFileSync(conflict.path),external)
 results.push({name:'external conflict',kind:'native version-checked save rejected'});assert.deepEqual(errors,[]);persist()
 console.log(`PASS native lossless batch ${batch}: ${selected.length} byte-identical save/reopen cases; localized=${!process.argv.includes('--no-local')}; conflict rejected`)
}catch(error){errors.push(String(error));if(page)console.log('NATIVE FAILURE STATE',await page.evaluate(()=>({active:window.__nativeManager?.activeId,metadata:window.__nativeManager?.metadata(window.__nativeManager.activeId),pending:window.__losslessPending,saves:window.__losslessSaves,calls:window.__losslessCalls,keys:window.__losslessKeys,toast:document.querySelector('.toast')?.textContent,focused:document.activeElement?.outerHTML?.slice(0,150)})).catch(()=>null));persist();throw error}
finally{if(child.exitCode===null)execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await browser?.close().catch(()=>{})}
