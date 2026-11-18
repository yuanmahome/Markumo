import assert from 'node:assert/strict'
import fs from 'node:fs'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const errors=[],results=[]
const server=await createServer({server:{host:'127.0.0.1',port:1485,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-global-search',plugins:[{name:'search-ui-test-seam',enforce:'pre',load(id){
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
async function check(name,task){await task();results.push(name);console.log('PASS',name)}
try{
 await page.goto('http://127.0.0.1:1485/',{timeout:60000});await page.waitForFunction(()=>window.__searchShell?.settingsReady.value)
 for(const name of ['Example.java','Example.sql','Example.txt','Example.md']){
  await page.evaluate(name=>{const m=window.__searchShell.manager;window.__searchId=m.openFile({token:name,path:'C:/fixture/'+name,name,text:'needle first\nsecond needle\n中文 needle\n',version:'v1',encoding:'UTF-8',bom:false,eol:'LF',readOnly:false});if(name.endsWith('.md'))m.setMarkdownMode(window.__searchId,'source')},name)
  for(const mode of name.endsWith('.md')?['source','split','live']:['text']){
   if(mode!=='text')await page.evaluate(mode=>window.__searchShell.manager.setMarkdownMode(window.__searchId,mode),mode)
   await page.locator(mode==='live'?'.ProseMirror':'.editor-host .cm-content').last().waitFor()
   await page.locator(mode==='live'?'.ProseMirror':'.editor-host .cm-content').last().click();await page.keyboard.press('Control+f')
   const bar=page.locator('.fleet-search:visible').last();await bar.waitFor()
   await check(`${name}/${mode}: floating and container responsive at 900/600/400/280px`,async()=>{
    for(const width of [900,600,400,280]){
     await page.locator('.editor-container').evaluate((el,width)=>{el.style.width=width+'px';el.style.maxWidth=width+'px'},width)
     await page.waitForTimeout(80)
     const rect=await bar.boundingBox(),container=await page.locator('.editor-container').boundingBox();assert(rect.width<=440);assert(rect.x>=container.x);assert(rect.x+rect.width<=container.x+container.width);assert(rect.y+rect.height<=container.y+container.height)
     await bar.locator('input[name=search]').fill('needle');await page.waitForTimeout(100);assert.match(await bar.locator('.search-count').innerText(),/3/)
     assert.equal(await bar.evaluate(el=>getComputedStyle(el).position),'absolute')
     if(width<500){await bar.getByLabel('更多搜索选项').click();await bar.getByLabel('区分大小写',{exact:true}).check();await bar.getByLabel('区分大小写',{exact:true}).uncheck();await bar.getByLabel('更多搜索选项').click()}
    }
    await bar.getByRole('button',{name:'展开/收起文档搜索',exact:true}).click();assert.equal(await bar.locator('input[name=search]').isVisible(),false);await bar.getByRole('button',{name:'展开/收起文档搜索',exact:true}).click();assert.equal(await bar.locator('input[name=search]').inputValue(),'needle')
   })
   await check(`${name}/${mode}: replacement and Undo/Redo retain canonical document`,async()=>{
    await page.keyboard.press('Control+r');const input=bar.locator('input[name=replace]');await input.fill('changed');await bar.getByRole('button',{name:'全部替换',exact:true}).click();await page.waitForTimeout(150)
    assert.equal(await page.evaluate(()=>window.__searchShell.manager.getText(window.__searchId)),'changed first\nsecond changed\n中文 changed\n')
    await page.keyboard.press('Escape');await page.evaluate(()=>window.__searchShell.manager.command('undo'));assert.match(await page.evaluate(()=>window.__searchShell.manager.getText(window.__searchId)),/needle/)
    await page.evaluate(()=>window.__searchShell.manager.command('redo'));assert.match(await page.evaluate(()=>window.__searchShell.manager.getText(window.__searchId)),/changed/)
    await page.evaluate(()=>window.__searchShell.manager.command('undo'))
   })
   await page.locator('.editor-container').evaluate(el=>{el.style.width='';el.style.maxWidth=''})
  }
 }
 assert.deepEqual(errors,[]);fs.mkdirSync('test-results/search',{recursive:true});fs.writeFileSync('test-results/search/editor-toolbar.json',JSON.stringify({results,errors},null,2))
}finally{await browser.close();await server.close()}
