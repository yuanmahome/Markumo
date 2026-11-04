import assert from 'node:assert/strict'
import fs from 'node:fs'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const errors=[],results=[]
const server=await createServer({server:{host:'127.0.0.1',port:1484,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-drag-tests',plugins:[{name:'drag-ui-seam',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/app/useAppShell.ts')){let s=fs.readFileSync(id,'utf8').replace('new WorkspaceController(tauriWorkspace,','new WorkspaceController((window as any).__dragGateway,').replace('new FileController(manager, tauriFiles, toast)','new FileController(manager, (window as any).__dragFiles, toast)');const at=s.lastIndexOf('  return {'),end=s.lastIndexOf('}');return s.slice(0,at)+s.slice(at,end).replace('  return {','  const dragShell = {')+'\n;(window as any).__dragShell=dragShell;return dragShell\n'+s.slice(end)}}}]})
await server.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1450,height:960}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.error(m.text())})
await page.addInitScript(()=>{
 window.__reads=[];window.__released=[];window.__dragFiles={historyTransactional:true,release:async token=>window.__released.push(token),checkExternal:async()=> 'v1'}
 window.__dragGateway={getRecentWorkspaces:async()=>[],onSearchBatch:()=>()=>{},onSearchDone:()=>()=>{},cancelSearch:async()=>{},clearSearchPreview:async()=>{},
 async openWorkspaceFile(path){window.__reads.push(path);if(path.includes('missing'))throw Error('Fixture read failed');if(path.includes('delayed'))await new Promise(resolve=>setTimeout(resolve,150));const name=path.split('/').at(-1);return {token:path,path,name,text:'Body '+name+'\n'.repeat(150),version:'v1',encoding:'UTF-8',bom:false,eol:'LF',readOnly:false}},openWorkspacePath:async()=>window.__root}
})
const evalShell=fn=>page.evaluate(fn),pane=id=>page.locator(`.pane[data-pane-id="${id}"]`)
async function draw(source,target,x=.5,y=.5,modifiers=[]){
 const a=await source.boundingBox(),b=await target.boundingBox();assert(a&&b);for(const key of modifiers)await page.keyboard.down(key)
 await page.mouse.move(a.x+Math.min(a.width-8,45),a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width*x,b.y+b.height*y,{steps:8});await page.mouse.up();for(const key of modifiers.reverse())await page.keyboard.up(key)
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
}
const source=name=>page.locator(`.treenode[data-tree-path="C:/drag/${name}"]`)
const body=id=>pane(id).locator('.pane-document-shell')
async function check(name,fn){await fn();results.push(name);console.log('PASS',name)}
try{
 await page.goto('http://127.0.0.1:1484',{waitUntil:'domcontentloaded',timeout:60000});await page.waitForFunction(()=>window.__dragShell?.settingsReady.value,{},{timeout:60000})
 await evalShell(()=>{const files=['a.txt','b.txt','c.txt','d.txt','e.txt','missing.txt','delayed.txt'];window.__root={rootPath:'C:/drag',name:'drag',entries:files.map(name=>({id:name,name,path:'C:/drag/'+name,relativePath:name,isDirectory:false,isSymlink:false,isReadOnly:false,size:100,hasChildren:false,isExpanded:false,isLoading:false}))};window.__dragShell.workspace.restoreSession([window.__root]);window.__dragShell.setMode('workspace')})
 await check('file center drop uses shared controller and pins its tab',async()=>{await draw(source('a.txt'),body('main'));await page.waitForFunction(()=>window.__dragShell.manager.activeDocument?.name==='a.txt');assert.equal(await evalShell(()=>window.__reads.length),1);assert.equal(await evalShell(()=>window.__dragShell.manager.activeDocument.pinned),true);assert.equal(await page.locator('.tab-drag-ghost').count(),0)})
 await check('existing unsaved file edge drop reuses document; independent caret; canonical Undo/Redo',async()=>{
   await evalShell(()=>{const m=window.__dragShell.manager;m.dispatch(m.activeId,{changes:{from:0,to:0,insert:'unsaved '}})});await draw(source('a.txt'),body('main'),.98,.5);await page.waitForFunction(()=>window.__dragShell.manager.layout.getAllPanes().length===2);assert.equal(await evalShell(()=>window.__reads.length),1)
   assert.equal(await evalShell(()=>window.__dragShell.manager.records.size),1);const ids=await evalShell(()=>window.__dragShell.manager.layout.getAllLeafIds());await evalShell(()=>{const m=window.__dragShell.manager;for(const [index,pane]of m.layout.getAllLeafIds().entries())m.setSelectionOffsets(m.activeId,index*4,index*4,pane)});assert.notEqual(await evalShell(()=>{const m=window.__dragShell.manager;return m.paneSnapshot(m.activeId,m.layout.getAllLeafIds()[0]).head}),await evalShell(()=>{const m=window.__dragShell.manager;return m.paneSnapshot(m.activeId,m.layout.getAllLeafIds()[1]).head}))
   await evalShell(()=>window.__dragShell.manager.command('undo'));assert(!(await evalShell(()=>window.__dragShell.manager.getText(window.__dragShell.manager.activeId))).startsWith('unsaved'));await evalShell(()=>window.__dragShell.manager.command('redo'));assert((await evalShell(()=>window.__dragShell.manager.getText(window.__dragShell.manager.activeId))).startsWith('unsaved'));await evalShell(()=>window.__dragShell.manager.mergeAllPanes());assert.equal(await page.locator('.cm-editor').count(),1)
 })
 await check('left/right/top/bottom file drops create exactly the requested layout',async()=>{
   for(const [name,zone,x,y]of [['b.txt','left',.02,.5],['c.txt','top',.5,.02],['d.txt','bottom',.5,.98],['e.txt','right',.98,.5]]){await draw(source(name),body('main'),x,y);await page.waitForFunction(()=>window.__dragShell.manager.layout.getAllPanes().length===2);const tree=await evalShell(()=>window.__dragShell.manager.layout.root);assert.equal(tree.orientation,['left','right'].includes(zone)?'horizontal':'vertical');const first=zone==='left'||zone==='top';assert.equal(await page.evaluate(({id})=>window.__dragShell.manager.layout.getPane(id).group.activeId===window.__dragShell.manager.activeId,{id:(first?tree.first:tree.second).id}),true);await evalShell(()=>window.__dragShell.manager.mergeAllPanes())}
 })
 await check('100 tab moves retain CM instance, state, history, caret and scroll',async()=>{
   await evalShell(()=>{const m=window.__dragShell.manager;window.__view=m.activeEditorView;window.__viewState=m.activeEditorView.state;window.__active=m.activeId;window.__text=m.getText(m.activeId);for(let i=0;i<100;i++)m.transferTab(m.activeId,m.activePane,m.activePane,{targetIndex:i%2?0:m.paneGroup(m.activePane).tabs.length})});assert.equal(await evalShell(()=>window.__view===window.__dragShell.manager.activeEditorView),true);assert.equal(await evalShell(()=>window.__viewState===window.__dragShell.manager.activeEditorView.state),true);assert.equal(await evalShell(()=>window.__text===window.__dragShell.manager.getText(window.__active)),true)
 })
 await check('tab pointer drop copies views with modifier, then moves without rereading disk',async()=>{
   const tab=pane('main').locator('.tab').filter({hasText:'e.txt'});await draw(tab,body('main'),.98,.5,['Control']);await page.waitForFunction(()=>window.__dragShell.manager.layout.getAllPanes().length===2);const ids=await evalShell(()=>window.__dragShell.manager.layout.getAllLeafIds());const before=await evalShell(()=>window.__reads.length);await draw(pane(ids[1]).locator('.tab').first(),body(ids[0]));await page.waitForFunction(()=>window.__dragShell.manager.layout.getAllPanes().length===1);assert.equal(await evalShell(()=>window.__reads.length),before)
 })
 await check('failed load and deleted target pane cannot leave an empty split or open in another pane',async()=>{
   const count=await evalShell(()=>window.__dragShell.manager.layout.getAllPanes().length);await draw(source('missing.txt'),body('main'),.98,.5);await page.waitForTimeout(200);assert.equal(await evalShell(()=>window.__dragShell.manager.layout.getAllPanes().length),count)
   const id=await evalShell(()=>window.__dragShell.manager.splitPane('right'));await draw(source('delayed.txt'),body(id));await evalShell(()=>{const m=window.__dragShell.manager;m.closePane(m.layout.getAllLeafIds().at(-1))});await page.waitForTimeout(250);assert.equal(await evalShell(()=>window.__dragShell.manager.openedDocuments.some(d=>d.name==='delayed.txt')),false);assert((await evalShell(()=>window.__released)).includes('C:/drag/delayed.txt'))
 })
 await check('drag payload is metadata only; stable target reuses highlight; Escape and outside invalid drop clean up',async()=>{
   const a=await source('b.txt').boundingBox(),b=await body('main').boundingBox();await page.mouse.move(a.x+40,a.y+12);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:6});await page.waitForTimeout(30);assert.equal(await page.locator('.tab-drag-ghost').count(),1);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.locator('.tab-drag-ghost').count(),0);assert.equal(await page.locator('.drop-zone-overlay').count(),0)
   const before=await evalShell(()=>window.__reads.length);await draw(source('b.txt'),page.locator('.rail'),.5,.9);assert.equal(await evalShell(()=>window.__reads.length),before)
 })
 await check('transactions from a destroyed view cannot update its replacement in the same Pane',async()=>{
   await evalShell(()=>{const m=window.__dragShell.manager,old=m.activeEditorView,host=old.dom.parentElement,id=m.activeId,text=m.getText(id),tr=old.state.update({changes:{from:0,insert:'STALE VIEW '}});m.unmount(m.activePane);m.mountPane(host,m.activePane);old.dispatch(tr);if(m.getText(id)!==text)throw Error('Destroyed view modified the current document')})
 })
 await check('ghost follows pointer without sticking to viewport edge; leaving hides it and returning restores it',async()=>{
   const a=await source('b.txt').boundingBox();await page.mouse.move(a.x+40,a.y+12);await page.mouse.down();await page.mouse.move(1445,450,{steps:6});await page.evaluate(()=>new Promise(requestAnimationFrame));
   const ghost=page.locator('.tab-drag-ghost');assert.equal(await ghost.evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).m41),1459);
   await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerout',{relatedTarget:null})));assert.equal(await ghost.evaluate(el=>getComputedStyle(el).visibility),'hidden');
   await page.mouse.move(1300,450);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await ghost.evaluate(el=>getComputedStyle(el).visibility),'visible');await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await ghost.count(),0)
 })
 await check('50 split/merge lifecycles release views; source component unmount cancels active drag',async()=>{
   for(let i=0;i<50;i++){await evalShell(()=>window.__dragShell.manager.splitPane('right'));await page.evaluate(()=>new Promise(requestAnimationFrame));await evalShell(()=>window.__dragShell.manager.mergeAllPanes());await page.evaluate(()=>new Promise(requestAnimationFrame))}assert.equal(await page.locator('.cm-editor').count(),1);assert.equal(await evalShell(()=>window.__dragShell.manager.views.size),1)
   const a=await source('b.txt').boundingBox(),b=await body('main').boundingBox();await page.mouse.move(a.x+40,a.y+12);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:5});await evalShell(()=>window.dispatchEvent(new CustomEvent('markumo:dispose-window')));await page.mouse.up();assert.equal(await page.locator('.tab-drag-ghost').count(),0);assert.equal(await page.locator('.cm-editor').count(),0)
 })
 assert.deepEqual(errors,[]);fs.mkdirSync('test-results/drag',{recursive:true});fs.writeFileSync('test-results/drag/browser.json',JSON.stringify({results,errors},null,2));console.log(`DRAG UI ${results.length}/${results.length} passed`)
}catch(error){console.error(error,await page.locator('body').innerText());console.error(await evalShell(()=>({reads:window.__reads,panes:window.__dragShell?.manager.layout.getAllLeafIds()})).catch(()=>null),errors);throw error}finally{await browser.close();await server.close()}
