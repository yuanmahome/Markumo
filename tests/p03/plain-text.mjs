import assert from 'node:assert/strict'
import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createServer} from 'vite'
import {chromium} from 'playwright'
const reference=execFileSync('git',['show','4a94f0b:src/editor/core/lineEndings.ts'],{encoding:'utf8',windowsHide:true})
const results=[],errors=[]
const server=await createServer({server:{host:'127.0.0.1',port:1504,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-p03',plugins:[{name:'reference-eol',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/tests/p03/reference.ts'))return reference}}]})
await server.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage()
page.on('pageerror',e=>errors.push(String(e)))
async function check(name,fn){try{const details=await fn();results.push({name,ok:true,details});console.log('PASS',name)}catch(e){results.push({name,ok:false,error:String(e)});console.log('FAIL',name,String(e))}}
try{
 await page.goto('http://127.0.0.1:1504/tests/p03/fixture.html');await page.waitForFunction(()=>window.ready)
 await check('sparse endings match previous mixed-EOL edit/undo/redo semantics for 2000 operations',async()=>{
  const result=await page.evaluate(async()=>{
   const {EditorState,history,undo,redo,lineEndings}=await import('/tests/p03/api.ts'),{lineEndings:old}=await import('/tests/p03/reference.ts')
   let count=0,random=12345678
   for(const source of ['a\r\nb\nc\rd\r\ne','中文😀\nsecond\nthird','a\rb\rc','a\r\nb\r\nc','']){
    const current=lineEndings(source),previous=old(source)
    const create=e=>EditorState.create({doc:source,extensions:[history(),e.field,e.history]})
    let a=create(current),b=create(previous)
    for(let i=0;i<400;i++){
     random^=random<<13;random^=random>>>17;random^=random<<5
     if(i%9===0){const command=i%18?undo:redo;command({state:a,dispatch:tr=>a=tr.state});command({state:b,dispatch:tr=>b=tr.state})}
     else {const from=(random>>>0)%(a.doc.length+1),to=Math.min(a.doc.length,from+(i%5));const insert=['中😀','\n','one\ntwo','', 'e\u0301'][i%5];const spec={changes:{from,to,insert},userEvent:'input.type'};a=a.update(spec).state;b=b.update(spec).state}
     const actual=current.serialize(a),expected=previous.serialize(b)
     if(actual!==expected)throw Error(JSON.stringify({source,i,actual,expected}));count++
    }
   }
   return {count}
  });assert.equal(result.count,2000);return result
 })
 await check('100000 uniform LF/CRLF lines use zero exception entries',async()=>{
  const result=await page.evaluate(async()=>{const {EditorState,lineEndings}=await import('/tests/p03/api.ts');return ['\n','\r\n','\r'].map(eol=>{const source=('text'+eol).repeat(100000),endings=lineEndings(source),state=EditorState.create({doc:source,extensions:[endings.field,endings.history]});if(endings.serialize(state)!==source)throw Error('Byte separator changed');return{eol,entries:state.field(endings.field).size,chars:state.doc.length}})});assert(result.every(r=>r.entries===0));return result
 })
 await check('20 background documents keep one view; splits share text and undo',async()=>{
  const result=await page.evaluate(async()=>{
   const {DocumentManager,imageImportBookmarks}=await import('/tests/p03/api.ts');const m=new DocumentManager();m.mount(document.getElementById('app'));let id
   for(let i=0;i<20;i++)id=m.openFile({token:'plain'+i,path:'C:/p03/plain'+i+'.txt',name:'plain'+i+'.txt',kind:'text',text:'plain text\r\n中文😀\n',encoding:'UTF-8',bom:false,eol:'CRLF',version:'1',readOnly:false})
   await new Promise(r=>setTimeout(r,30));const backgroundViews=m.views.size,states=m.records.size
   for(const r of m.records.values())if(r.state.field(imageImportBookmarks,false)!==undefined)throw Error('Plain document has Markdown image import field')
   const original=m.getText(id)
   const pane=m.splitPane('right'),host=document.createElement('section');document.getElementById('app').append(host);m.mountPane(host,pane);m.dispatch(id,{changes:{from:0,insert:'edit'},userEvent:'input.type'});const shared=[...m.views.values()].every(v=>v.state.doc.eq(m.getState(id).doc));const visibleViews=m.views.size;m.command('undo');if(m.getText(id)!==original)throw Error('Shared undo lost state');m.mergeAllPanes();m.dispose();host.remove();return{backgroundViews,states,shared,visibleViews,domViews:document.querySelectorAll('.cm-editor').length}
  });assert.equal(result.backgroundViews,1);assert.equal(result.states,20);assert(result.shared);assert.equal(result.visibleViews,2);assert.equal(result.domViews,0);return result
 })
 await check('transactional save avoids baseline serialization; TXT↔MD retains undo and resource lifecycle',async()=>{
  const result=await page.evaluate(async()=>{
   const {DocumentManager,FileController,imageImportBookmarks}=await import('/tests/p03/api.ts');const m=new DocumentManager();m.mount(document.getElementById('app'))
   const file={token:'save',path:'C:/p03/save.txt',name:'save.txt',kind:'text',text:'original\r\n',encoding:'UTF-8',bom:false,eol:'CRLF',version:'1',readOnly:false};const id=m.openFile(file);let target='txt',savedText
   const gateway={historyTransactional:true,save:async(token,text)=>{savedText=text;return{...file,name:'save.'+target,path:'C:/p03/save.'+target,version:'2'}},release:async()=>{},checkExternal:async()=> '1'}
   const f=new FileController(m,gateway,()=>{});m.getBaselineText=()=>{throw Error('Unneeded serialization')}
   m.dispatch(id,{changes:{from:0,insert:'edit'},userEvent:'input.type'});target='md';if(!await f.save(id))throw Error('Save failed');await new Promise(r=>setTimeout(r,30))
   if(m.getState(id).field(imageImportBookmarks,false)===undefined)throw Error('MD rename missing bookmarks')
   m.setMarkdownMode(id,'source');target='txt';if(!await f.save(id))throw Error('Save back failed')
   if(m.getState(id).field(imageImportBookmarks,false)!==undefined)throw Error('TXT rename retained bookmarks')
   m.command('undo');const undoText=m.getText(id);f.dispose();m.dispose();return{savedText,undoText}
  });assert.equal(result.savedText,'editoriginal\r\n');assert.equal(result.undoText,'original\n');return result
 })
}finally{await browser.close();await server.close();fs.mkdirSync('test-results/p03',{recursive:true});fs.writeFileSync('test-results/p03/plain-text-tests.json',JSON.stringify({results,errors},null,2))}
assert.equal(errors.length,0,JSON.stringify(errors));assert(results.every(r=>r.ok),JSON.stringify(results.filter(r=>!r.ok)));console.log(`${results.length}/${results.length} passed`)
