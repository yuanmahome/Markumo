import assert from 'node:assert/strict'
import fs from 'node:fs'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const errors=[],results=[]
const server=await createServer({server:{host:'127.0.0.1',port:1483,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-global-search',plugins:[{name:'search-ui-test-seam',enforce:'pre',load(id){
  if(id.replaceAll('\\','/').endsWith('/app/useAppShell.ts')){
    let source=fs.readFileSync(id,'utf8').replace('new WorkspaceController(tauriWorkspace,','new WorkspaceController((window as any).__searchGateway,').replace('new FileController(manager, tauriFiles, toast)','new FileController(manager, (window as any).__searchFileGateway, toast)')
    source=source.replace('\n  return {','\n  const searchTestShell = {');const end=source.lastIndexOf('}');return source.slice(0,end)+'\n;(window as any).__searchShell=searchTestShell\nreturn searchTestShell\n'+source.slice(end)
  }
}}]})
await server.listen()
const browser=await chromium.launch({headless:true,...process.env.MARKUMO_CHROME?{executablePath:process.env.MARKUMO_CHROME}:{}})
const page=await browser.newPage({viewport:{width:1400,height:900}})
page.setDefaultTimeout(12000)
page.on('pageerror',error=>errors.push(error.message))
await page.addInitScript(()=>{
  window.__searchCalls=[];window.__searchBatch=[];window.__searchDone=[];window.__previewClears=0
  window.__searchFileGateway={historyTransactional:true,release:async()=>{},checkExternal:async()=> 'v1'}
  window.__searchGateway={getRecentWorkspaces:async()=>[],clearSearchPreview:async()=>{window.__previewClears++},onSearchBatch(listener){window.__searchBatch.push(listener);return()=>window.__searchBatch.splice(window.__searchBatch.indexOf(listener),1)},onSearchDone(listener){window.__searchDone.push(listener);return()=>window.__searchDone.splice(window.__searchDone.indexOf(listener),1)},cancelSearch:async()=>{},
    async searchWorkspace(query){
      window.__searchCalls.push(query)
      await new Promise(resolve=>setTimeout(resolve,query.query==='slow'?350:10))
      if(query.query==='['){window.__searchDone.forEach(fn=>fn({search_id:query.search_id,total:0,canceled:false,error:'正则表达式无效'}));return 0}
      const buffer=query.buffers[0]
      const count=query.query==='needle'?1000:query.query==='none'?0:3
      const hits=buffer?Array.from({length:count},(_,index)=>({search_id:query.search_id,id:`${query.search_id}:${buffer.document_id}:${index+1}:1`,document_id:buffer.document_id,path:buffer.path,relative_path:buffer.relative_path||'notes.txt',line_number:index+1,column_number:1,line_text:'needle '+index,match_length:6,snippet_column:0,version:'v1'})):[]
      window.__searchBatch.forEach(fn=>fn(hits));window.__searchDone.forEach(fn=>fn({search_id:query.search_id,total:hits.length,canceled:false,limited:hits.length===1000}));return hits.length
    },
    async previewReplace(query,replacement,targets){return {files:query.buffers.filter(buffer=>!targets.length||targets.includes(buffer.path)).map(buffer=>({path:buffer.path,document_id:buffer.document_id,version:'v1',buffer:true,edits:[{from:0,to:6,line:1,column:1,before:'needle',insert:replacement,context:'needle 0'}]})),skipped:[],limited:false,canceled:false}},applyReplace:async()=>{throw Error('Opened buffers must not be written to disk')},
  }
})
const shell=code=>page.evaluate(code)
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
const popup=page.getByRole('dialog',{name:'全局搜索与替换'})
const query=()=>page.getByRole('textbox',{name:'全局搜索文本'})
async function done(){await page.waitForFunction(()=>!window.__searchShell.workspace.searching&&['complete','empty','error','limited'].includes(window.__searchShell.workspace.searchStatus))}
async function check(name,task){await task();results.push(name);console.log('PASS',name)}
try{
  await page.goto('http://127.0.0.1:1483/');await page.waitForFunction(()=>window.__searchShell?.settingsReady.value)
  await shell(()=>{const m=window.__searchShell.manager;window.__searchId=m.openFile({token:'search-buffer',path:'C:/fixture/notes.txt',name:'notes.txt',text:Array.from({length:1200},(_,i)=>'needle '+i).join('\n'),version:'v1',encoding:'UTF-8',bom:false,eol:'LF',readOnly:false})})
  await page.locator('.cm-content').click()
  await check('keyboard open, unchanged single/sidebar state, empty query performs no scan',async()=>{
    await page.keyboard.press('Control+Shift+f');await popup.waitFor();assert.equal(await shell(()=>window.__searchShell.appMode.value),'single');assert.equal(await shell(()=>window.__searchCalls.length),0);assert.equal(await page.locator('.sidebar-wrapper').count(),0);assert.equal(await query().evaluate(el=>document.activeElement===el),true)
  })
  await check('debounce and late canceled batches, complete/empty/error/limited states',async()=>{
    await query().fill('slow');await page.waitForTimeout(270);await query().fill('fast');await query().press('Enter');await done();const id=await shell(()=>window.__searchShell.workspace.searchId);await page.waitForTimeout(400);assert.equal(await shell(()=>window.__searchShell.workspace.searchId),id);assert.equal(await shell(()=>window.__searchShell.workspace.searchTotal),3)
    await query().fill('none');await query().press('Enter');await done();assert.match(await popup.innerText(),/未找到匹配/)
    await query().fill('[');await query().press('Enter');await done();assert.match(await popup.innerText(),/正则表达式无效/)
    await query().fill('needle');await query().press('Enter');await done();assert.match(await popup.innerText(),/结果不完整/);assert((await page.locator('.search-hit').count())<35)
  })
  await check('single read-only preview reused on selection, no PM/media initialization',async()=>{
    await page.locator('.search-hit').first().click();await page.waitForSelector('[data-search-preview-editor] .cm-editor')
    await shell(()=>window.__samePreview=document.querySelector('[data-search-preview-editor] .cm-editor'))
    await page.locator('.search-hit').nth(1).click();await settle()
    assert.equal(await shell(()=>window.__samePreview===document.querySelector('[data-search-preview-editor] .cm-editor')),true);assert.equal(await popup.locator('.ProseMirror,img,.md-diagram,.katex').count(),0)
    const text=await shell(()=>window.__searchShell.manager.getText(window.__searchId));await page.getByLabel('搜索源码预览').click();await page.keyboard.type('MUTATION');assert.equal(await shell(()=>window.__searchShell.manager.getText(window.__searchId)),text)
  })
  await check('keyboard navigation belongs to result focus; query arrows remain text movement; group collapse and expand',async()=>{
    const list=page.getByRole('listbox',{name:'搜索结果'});await list.focus();await page.keyboard.press('Home');const first=await shell(()=>window.__searchShell.workspace.selectedMatchId);await page.keyboard.press('ArrowDown');assert.notEqual(await shell(()=>window.__searchShell.workspace.selectedMatchId),first);const selected=await shell(()=>window.__searchShell.workspace.selectedMatchId)
    await query().focus();await page.keyboard.press('ArrowLeft');assert.equal(await shell(()=>window.__searchShell.workspace.selectedMatchId),selected);await page.getByRole('button',{name:'全部折叠',exact:true}).click();assert.equal(await page.locator('.search-hit').count(),0);await page.getByRole('button',{name:'全部展开',exact:true}).click();assert((await page.locator('.search-hit').count())>0)
  })
  await check('replace mode keeps IDs/query, incomplete all protection and selective buffer Undo/Redo',async()=>{
    const id=await shell(()=>window.__searchShell.workspace.searchId);await query().focus();await page.keyboard.press('Control+Shift+r');await page.getByRole('textbox',{name:'全局替换文本'}).fill('changed');assert.equal(await query().inputValue(),'needle');assert.equal(await shell(()=>window.__searchShell.workspace.searchId),id);assert.equal(await page.getByRole('button',{name:'预览替换 / 替换全部…',exact:true}).isDisabled(),true)
    await page.locator('.search-hit input[type=checkbox]').first().check();await page.getByRole('button',{name:'替换选中…',exact:true}).click();await page.getByRole('button',{name:'应用预览中选择的替换',exact:true}).click();await page.waitForFunction(()=>window.__searchShell.manager.getText(window.__searchId).startsWith('changed'))
    await shell(()=>window.__searchShell.manager.command('undo'));assert((await shell(()=>window.__searchShell.manager.getText(window.__searchId))).startsWith('needle'));await shell(()=>window.__searchShell.manager.command('redo'));assert((await shell(()=>window.__searchShell.manager.getText(window.__searchId))).startsWith('changed'))
    await page.waitForFunction(()=>window.__searchShell.workspace.replacementReport.length===1)
  })
  await check('IME guard, advanced Glob values, scope and metadata histories',async()=>{
    await page.getByRole('button',{name:'返回源码预览',exact:true}).click();await query().dispatchEvent('compositionstart',{data:''});const count=await shell(()=>window.__searchCalls.length);await query().fill('composition');await page.waitForTimeout(300);assert.equal(await shell(()=>window.__searchCalls.length),count);await query().dispatchEvent('compositionend',{data:'composition'});await page.waitForTimeout(300);await done()
    await page.getByRole('button',{name:'高级过滤',exact:true}).click();await page.getByRole('textbox',{name:'包含文件',exact:true}).fill('*.{ts,vue}, *.md');await query().press('Enter');await done();assert.deepEqual(await shell(()=>window.__searchCalls.at(-1).include_globs),['*.{ts,vue}','*.md'])
    assert((await shell(()=>window.__searchShell.workspace.searchHistory)).includes('composition'));assert((await shell(()=>window.__searchShell.workspace.replacementHistory)).includes('changed'))
  })
  await check('drag/resize, pinned editor focus, bright/dark themes and bounds',async()=>{
    const header=popup.locator('.global-search-title');const rect=await header.boundingBox();await page.mouse.move(rect.x+80,rect.y+15);await page.mouse.down();await page.mouse.move(rect.x+120,rect.y+40);await page.mouse.up();const moved=await popup.boundingBox();assert(moved.x>=16&&moved.y>=16)
    const corner=await popup.locator('.corner').boundingBox();await page.mouse.move(corner.x+5,corner.y+5);await page.mouse.down();await page.mouse.move(corner.x-70,corner.y-40);await page.mouse.up();assert((await popup.boundingBox()).width>=560)
    await page.getByRole('button',{name:'固定搜索窗口',exact:true}).click();await page.locator('.editor-host .cm-content').click({position:{x:5,y:10}});assert.equal(await popup.isVisible(),true)
    for(const theme of ['dark','light']){await shell(()=>window.__searchShell.toggleTheme());await settle();assert((await popup.boundingBox()).width>0)}
    await page.setViewportSize({width:640,height:600});await settle();const bounded=await popup.boundingBox();assert(bounded.x>=15&&bounded.x+bounded.width<=641);assert(bounded.height<=511);await page.setViewportSize({width:1400,height:900})
  })
  await check('Escape restores focus and releases preview; repeated opening retains one subscription and no rescan',async()=>{
    await query().focus();await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});assert.equal(await page.locator('[data-search-preview-editor]').count(),0);const count=await shell(()=>window.__searchCalls.length)
    for(let i=0;i<12;i++){await page.keyboard.press('Control+Shift+f');await popup.waitFor();await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'})}
    assert.equal(await shell(()=>window.__searchCalls.length),count);assert.equal(await shell(()=>window.__searchBatch.length),1);assert.equal(await shell(()=>window.__searchDone.length),1);assert((await shell(()=>window.__previewClears))>=13)
  })
  await check('history and window metadata reload without document bodies or startup scans; history can be cleared',async()=>{
    const saved=await shell(()=>JSON.parse(localStorage.getItem('markumo.globalSearch.v1')));assert.deepEqual(Object.keys(saved).sort(),['queries','replacements','window']);assert(saved.queries.includes('composition'));assert(saved.replacements.includes('changed'))
    await page.reload();await page.waitForFunction(()=>window.__searchShell?.settingsReady.value);assert.equal(await shell(()=>window.__searchCalls.length),0);assert((await shell(()=>window.__searchShell.workspace.searchHistory)).includes('composition'));assert.equal(await shell(()=>window.__searchShell.workspace.searchWindow.width),saved.window.width)
    await page.keyboard.press('Control+Shift+f');await popup.waitFor();await page.getByLabel('搜索历史',{exact:true}).click();await page.getByRole('button',{name:'清空搜索历史',exact:true}).click();assert.deepEqual(await shell(()=>window.__searchShell.workspace.searchHistory),[])
  })
  assert.deepEqual(errors,[]);fs.mkdirSync('test-results/search',{recursive:true});fs.writeFileSync('test-results/search/browser.json',JSON.stringify({results,errors},null,2));console.log(`GLOBAL SEARCH UI ${results.length}/${results.length} passed`)
}catch(error){console.error(await shell(()=>({message:window.__searchShell?.workspace.replaceMessage,files:window.__searchShell?.workspace.replaceFiles,status:window.__searchShell?.workspace.searchStatus})).catch(()=>null),errors);throw error}finally{await browser.close();await server.close()}
