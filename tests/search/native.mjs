import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {chromium} from 'playwright'

const root=path.resolve('test-results/phase042'),output=path.resolve('test-results/search/native'),label=process.argv.find(v=>v.startsWith('--label='))?.slice(8)||'global-search',port=9683
assert(/^[\w-]+$/.test(label))
const config=JSON.parse(fs.readFileSync(path.join(root,`config-${label}.json`),'utf8'))
const profile=path.resolve(config.app.appDirectoriesOverride),binary=path.join(root,`markumo-${label}.exe`)
assert.equal(profile,path.join(root,`native-profile-${label}`))
if(fs.existsSync(profile))fs.renameSync(profile,path.join(root,`native-profile-${label}-backup-${Date.now()}`))
fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(output,{recursive:true})
const roots=['alpha','beta'].map(name=>path.join(output,name));for(const dir of roots)fs.mkdirSync(dir,{recursive:true})
const fixtures=new Map([
 ['alpha/open.txt','needle original\r\nsecond needle\r\n'],['alpha/closed.txt','needle disk\r\n'],
 ['alpha/preview.md','# Needle\n\nneedle\n\n![image](https://invalid.example/image.png)\n\n```mermaid\ngraph LR\n```\n'],
 ['alpha/src/Main.ts','const needle = 42\nneedle\n'],['alpha/src/Other.js','needle\n'],
 ['alpha/.gitignore','ignored.txt\n'],['alpha/ignored.txt','needle ignored\n'],['beta/中文.txt','你好 needle 世界\n'],
 ['alpha/huge.txt',Array.from({length:1400},(_,i)=>`needle ${i}`).join('\n')],
 ['beta/batch-a.txt','cancelneedle\n'],['beta/batch-b.txt','cancelneedle\n'],['beta/batch-c.txt','cancelneedle\n'],
])
for(const [name,text]of fixtures){const file=path.join(output,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
fs.writeFileSync(path.join(roots[1],'utf16.txt'),Buffer.concat([Buffer.from([255,254]),Buffer.from('needle 宽字符\r\n','utf16le')]))
for(let i=0;i<2100;i++)fs.writeFileSync(path.join(roots[1],`filler-${i}.txt`),`quiet file ${i}\n`)
fs.writeFileSync(path.join(profile,'editor-settings.json'),JSON.stringify({settingsVersion:6,autoCheckUpdates:false,autoDownloadUpdates:false,showOutline:false}))
fs.writeFileSync(path.join(profile,'workspaces.json'),JSON.stringify({recent_workspaces:roots,active_roots:[]}))
fs.writeFileSync(path.join(profile,'files.json'),JSON.stringify({recent:[...fixtures.keys()].map(name=>({path:path.join(output,name),name:path.basename(name)})),layout:{mode:'single',sidebarVisible:false,sidebarWidth:254}}))
fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:254}}))
const temp=path.resolve('test-results/search/tmp');fs.mkdirSync(temp,{recursive:true})
let child,browser,page
const errors=[],results=[],metrics={}
const state=()=>page.evaluate(()=>{const w=window.__nativeWorkspace;return {status:w.searchStatus,total:w.searchTotal,message:w.searchMessage,previewError:w.searchPreviewError,replaceMessage:w.replaceMessage,report:w.replacementReport,groups:w.searchResults.map(g=>({path:g.path,count:g.matches.length}))}})
const popup=()=>page.getByRole('dialog',{name:'全局搜索与替换'})
async function done(){await page.waitForFunction(()=>!window.__nativeWorkspace.searching&&!['idle','searching'].includes(window.__nativeWorkspace.searchStatus))}
async function search(text,options={}){
 await page.evaluate(async({text,options})=>{const w=window.__nativeWorkspace;Object.assign(w,options);await w.search(text)}, {text,options});await done();return state()
}
async function check(name,fn){await fn();results.push(name);console.log('PASS',name)}
async function open(name){return page.evaluate(async file=>{const f=await window.__TAURI_INTERNALS__.invoke('open_recent',{path:file,encoding:null});return window.__nativeManager.openFile(f,false)},path.join(output,name))}
try{
 child=spawn(binary,[],{windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp,WEBVIEW2_USER_DATA_FOLDER:path.join(output,`wv-${Date.now()}`),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
 const deadline=Date.now()+45000
 while(true){assert(child.exitCode===null,'Native application exited');try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}assert(Date.now()<deadline,'WebView2 startup timeout');await new Promise(resolve=>setTimeout(resolve,200))}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts().flatMap(c=>c.pages()).find(p=>!p.url().startsWith('devtools:'));page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
 await page.waitForFunction(()=>window.__nativeWorkspace&&window.__nativeManager&&!document.querySelector('.startup-overlay'))
 metrics.initialWebViews=browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.url().startsWith('devtools:')).length
 await check('existing current-file Ctrl+F and Ctrl+R remain separate from the global dialog',async()=>{
   await open('alpha/open.txt');await page.evaluate(()=>window.__nativeManager.activeEditorView.focus());await page.keyboard.press('Control+f');await page.locator('.cm-search').waitFor();assert.equal(await popup().count(),0);await page.keyboard.press('Escape');await page.keyboard.press('Control+r');await page.locator('.cm-search').waitFor();assert.equal(await popup().count(),0);await page.keyboard.press('Escape')
 })
 await check('single-file opened scope includes unsaved buffer and pathless draft; no workspace/layout mutation',async()=>{
   await open('alpha/open.txt');await page.evaluate(()=>{const m=window.__nativeManager;const d=m.activeDocument;m.dispatch(d.id,{changes:{from:0,to:6,insert:'unsaved'}});window.__searchDraft=m.createRecoveredDocument({id:'search-native-draft',name:'Draft.txt',text:'unsaved draft needle\n'})})
   await page.keyboard.press('Control+Shift+f');await popup().waitFor();const s=await search('unsaved');assert.equal(s.total,2);assert.equal(await page.evaluate(()=>window.__nativeWorkspace.roots.length),0);assert.equal(await page.evaluate(()=>window.__nativeSearchShell.appMode.value),'single')
   assert.equal(fs.readFileSync(path.join(output,'alpha/open.txt'),'utf8'),fixtures.get('alpha/open.txt'))
 })
 await check('opened draft replacement uses real Rust capture expansion and undoable canonical transactions',async()=>{
   await search('(unsaved) (draft)',{isRegex:true});await page.evaluate(async()=>{const w=window.__nativeWorkspace;w.replaceExpanded=true;w.replacementText='$2-$1';await w.previewReplace()})
   await page.evaluate(()=>window.__nativeWorkspace.applyReplacements());assert.equal(await page.evaluate(()=>window.__nativeManager.getText(window.__searchDraft)),'draft-unsaved needle\n')
   await page.evaluate(()=>window.__nativeManager.command('undo'));assert.equal(await page.evaluate(()=>window.__nativeManager.getText(window.__searchDraft)),'unsaved draft needle\n');await page.evaluate(()=>window.__nativeManager.command('redo'))
 })
 await check('multi-root workspace, standard include/exclude Glob, directory confinement, ignored visibility',async()=>{
   for(const dir of roots)assert.equal(await page.evaluate(dir=>window.__nativeWorkspace.openWorkspacePath(dir,true),dir),true)
   await search('needle',{searchScope:'workspace',isRegex:false,searchExclude:'huge.txt'});assert((await state()).groups.some(g=>g.path.endsWith('中文.txt')));assert(!(await state()).groups.some(g=>g.path.endsWith('ignored.txt')))
   let s=await search('needle',{searchInclude:'*.{ts,js}',searchExclude:'**/Other.js'});assert.equal(s.total,2);assert.equal(s.groups.length,1)
   s=await search('needle',{searchScope:'directory',searchDirectory:path.join(roots[0],'src'),searchInclude:'',searchExclude:''});assert.equal(s.total,3)
   s=await search('needle',{searchDirectory:output});assert.equal(s.status,'error');assert.match(s.message,/授权|工作区|范围/)
   s=await search('needle',{searchScope:'workspace',searchInclude:'ignored.txt',searchIncludeIgnored:true});assert.equal(s.total,1)
   await page.evaluate(async()=>{const w=window.__nativeWorkspace;w.replacementText='forbidden';await w.previewReplace()});assert.equal(await page.evaluate(()=>window.__nativeWorkspace.replaceFiles.length),0);assert.match((await state()).replaceMessage,/忽略/)
 })
 await check('Rust regex errors, rapid canceled searches, truthful limits and virtualized thousand-result list',async()=>{
   let s=await search('[',{isRegex:true,searchInclude:'',searchIncludeIgnored:false});assert.equal(s.status,'error');assert.match(s.message,/正则|regex|unclosed/i)
   s=await search('needle',{isRegex:false});assert.equal(s.status,'limited');assert.equal(s.total,1000);assert((await page.locator('.search-hit').count())<40)
   await page.evaluate(()=>{const w=window.__nativeWorkspace;void w.search('needle');w.cancelSearch()});await page.waitForTimeout(300);assert.equal((await state()).status,'canceled')
   await page.evaluate(async()=>{const w=window.__nativeWorkspace;void w.search('needle');await w.search('const')});await done();assert.equal((await state()).total,1)
 })
 await check('bounded disk preview, one reused CodeMirror, Markdown remains source and stale disk rejected',async()=>{
   await search('needle',{searchInclude:'preview.md',isCaseSensitive:false});await page.locator('.search-hit').first().click();await page.waitForSelector('[data-search-preview-editor] .cm-editor');await page.waitForFunction(()=>!!window.__nativeWorkspace.searchPreview)
   assert.equal(await popup().locator('.ProseMirror,img,.katex,svg.mermaid').count(),0);const before=browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.url().startsWith('devtools:')).length;assert.equal(before,metrics.initialWebViews,'Search must not create another WebView')
   await page.evaluate(()=>window.__searchPreviewElement=document.querySelector('[data-search-preview-editor] .cm-editor'));await page.locator('.search-hit').nth(1).click();await page.waitForFunction(()=>!window.__nativeWorkspace.searchPreviewLoading);assert.equal(await page.evaluate(()=>window.__searchPreviewElement===document.querySelector('[data-search-preview-editor] .cm-editor')),true)
   await search('needle',{searchInclude:'*.txt',searchExclude:'huge.txt'});const start=performance.now();const last=await page.evaluate(async()=>{const w=window.__nativeWorkspace,matches=w.searchResults.flatMap(g=>g.matches).filter(match=>!match.document_id);const sequence=Array.from({length:20},(_,index)=>matches[index%matches.length]);await Promise.all(sequence.map(match=>w.selectSearchMatch(match)));return sequence.at(-1).path});assert.equal(await page.evaluate(()=>window.__nativeWorkspace.searchPreview.path),last);metrics.preview20Ms=Math.round(performance.now()-start)
   await search('needle',{searchInclude:'closed.txt'});fs.appendFileSync(path.join(output,'alpha/closed.txt'),'external\r\n');await page.locator('.search-hit').first().click();await page.waitForFunction(()=>!!window.__nativeWorkspace.searchPreviewError);assert.match((await state()).previewError,/变化|版本|过期/)
 })
 await check('selected closed-file replacement validates version, preserves CRLF and UTF-16LE BOM',async()=>{
   for(const [name,replacement]of [['closed.txt','changed'],['utf16.txt','宽替换']]){
     await search('needle',{searchInclude:name});await page.evaluate(async replacement=>{const w=window.__nativeWorkspace;w.replacementText=replacement;await w.previewReplace()},replacement);assert.equal(await page.evaluate(()=>window.__nativeWorkspace.replaceFiles.length),1)
     await page.evaluate(()=>window.__nativeWorkspace.applyReplacements());assert.match((await state()).report[0],/已保存/)
   }
   assert.equal(fs.readFileSync(path.join(output,'alpha/closed.txt'),'utf8'),'changed disk\r\nexternal\r\n')
   assert.deepEqual(fs.readFileSync(path.join(roots[1],'utf16.txt')),Buffer.concat([Buffer.from([255,254]),Buffer.from('宽替换 宽字符\r\n','utf16le')]))
   await search('changed',{searchInclude:'closed.txt'});await page.evaluate(async()=>{const w=window.__nativeWorkspace;w.replacementText='bad';await w.previewReplace()});fs.appendFileSync(path.join(output,'alpha/closed.txt'),'conflict\r\n');await page.evaluate(()=>window.__nativeWorkspace.applyReplacements());assert.match((await state()).report[0],/失败/);assert(!fs.readFileSync(path.join(output,'alpha/closed.txt'),'utf8').includes('bad'))
 })
 await check('unsaved workspace buffer replacement remains undoable and does not write disk',async()=>{
   await search('unsaved',{searchInclude:'open.txt'});await page.evaluate(async()=>{const w=window.__nativeWorkspace;w.replacementText='buffer-edit';await w.previewReplace();await w.applyReplacements()});assert.match((await state()).report[0],/可撤销/)
   assert.equal(fs.readFileSync(path.join(output,'alpha/open.txt'),'utf8'),fixtures.get('alpha/open.txt'))
   await page.evaluate(()=>{const w=window.__nativeWorkspace,m=window.__nativeManager;w.closeSearchDialog(false);m.open(m.openedDocuments.find(doc=>doc.name==='open.txt').id,false);m.activeEditorView.focus()});await popup().waitFor({state:'hidden'});await page.keyboard.press('Control+z');assert((await page.evaluate(()=>window.__nativeManager.getText(window.__nativeManager.activeDocument.id))).startsWith('unsaved'));await page.keyboard.press('Control+y');assert((await page.evaluate(()=>window.__nativeManager.getText(window.__nativeManager.activeDocument.id))).startsWith('buffer-edit'));await page.evaluate(()=>window.__nativeWorkspace.focusWorkspaceSearch(true));await popup().waitFor()
 })
 await check('cancel replacement stops remaining files without claiming the first write was undone',async()=>{
   await search('cancelneedle',{searchInclude:'batch-*.txt'});await page.evaluate(async()=>{const w=window.__nativeWorkspace;w.replacementText='executed';await w.previewReplace();const apply=w.gateway.applyReplace;w.gateway.applyReplace=async request=>{const result=await apply(request);w.cancelReplace();return result};try{await w.applyReplacements()}finally{w.gateway.applyReplace=apply}})
   const report=(await state()).report;assert.equal(report.filter(item=>item.includes('已保存')).length,1);assert.equal(report.filter(item=>item.includes('未执行')).length,2)
   const contents=['a','b','c'].map(name=>fs.readFileSync(path.join(roots[1],`batch-${name}.txt`),'utf8'));assert.equal(contents.filter(text=>text==='executed\n').length,1);assert.equal(contents.filter(text=>text==='cancelneedle\n').length,2)
 })
 await check('closing search during a checked disk write allows the approved batch to complete',async()=>{
   await search('cancelneedle',{searchInclude:'batch-*.txt'});await page.evaluate(async()=>{const w=window.__nativeWorkspace;w.replacementText='executed';await w.previewReplace();const apply=w.gateway.applyReplace;w.gateway.applyReplace=async request=>{w.closeSearchDialog();return apply(request)};try{await w.applyReplacements()}finally{w.gateway.applyReplace=apply}})
   await popup().waitFor({state:'hidden'});assert.equal((await state()).report.filter(item=>item.includes('已保存')).length,2);for(const name of ['a','b','c'])assert.equal(fs.readFileSync(path.join(roots[1],`batch-${name}.txt`),'utf8'),'executed\n')
   await page.evaluate(()=>window.__nativeWorkspace.focusWorkspaceSearch());await popup().waitFor()
 })
 await check('result context menu copies native location and can restrict the same search to its directory',async()=>{
   await search('const',{searchInclude:'Main.ts'});await page.locator('.search-hit').first().click({button:'right'});await page.getByRole('menuitem',{name:'复制文件路径:行号:列号',exact:true}).click();const copied=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:clipboard-manager|read_text'));assert.match(copied,/Main\.ts:1:1$/)
   await page.locator('.search-hit').first().click({button:'right'});await page.getByRole('menuitem',{name:'仅在此目录搜索',exact:true}).click();await page.waitForFunction(()=>window.__nativeWorkspace.searchScope==='directory'&&!window.__nativeWorkspace.searching);assert.equal(await page.evaluate(()=>window.__nativeWorkspace.searchDirectory.replaceAll('\\','/')),path.join(roots[0],'src').replaceAll('\\','/'))
 })
 await check('preview navigation opens/pins correct document and right split uses existing Pane layout',async()=>{
   await search('const',{searchInclude:'Main.ts'});await page.evaluate(async()=>{const w=window.__nativeWorkspace;await w.locateMatch(w.searchResults[0].matches[0],'split')});await popup().waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.__nativeManager.layout.getAllPanes().length),2);assert.equal(await page.evaluate(()=>window.__nativeManager.activeDocument.name),'Main.ts')
 })
 await check('2100-file scope performance and repeated popup lifecycle release',async()=>{
   await page.evaluate(()=>window.__nativeWorkspace.focusWorkspaceSearch());await popup().waitFor();const start=performance.now();await search('quiet',{searchScope:'workspace',searchInclude:'filler-1?.txt'});metrics.search2100FilesMs=Math.round(performance.now()-start);assert.equal((await state()).total,10)
   const cdp=await browser.contexts()[0].newCDPSession(page);await cdp.send('Performance.enable');metrics.before=(await cdp.send('Performance.getMetrics')).metrics.filter(m=>['JSHeapUsedSize','Nodes','Documents'].includes(m.name))
   for(let i=0;i<15;i++){await page.evaluate(()=>window.__nativeWorkspace.closeSearchDialog());await popup().waitFor({state:'hidden'});assert.equal(await page.locator('[data-search-preview-editor]').count(),0);await page.evaluate(()=>window.__nativeWorkspace.focusWorkspaceSearch());await popup().waitFor()}
   await cdp.send('HeapProfiler.collectGarbage');metrics.after=(await cdp.send('Performance.getMetrics')).metrics.filter(m=>['JSHeapUsedSize','Nodes','Documents'].includes(m.name));await cdp.detach()
   await page.locator('.search-hit').first().click();await page.waitForFunction(()=>!!window.__nativeWorkspace.searchPreview);await page.screenshot({path:path.join(output,'global-search.png')})
 })
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,metrics,errors},null,2));console.log(`WINDOWS WEBVIEW2 GLOBAL SEARCH ${results.length}/${results.length} passed`,metrics)
}catch(error){console.error(await state().catch(()=>null),errors);throw error}finally{await browser?.close().catch(()=>{});if(child?.exitCode===null)child.kill()}
