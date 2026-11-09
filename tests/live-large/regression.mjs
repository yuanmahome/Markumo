import fs from 'node:fs'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
if(!fs.existsSync('test-results/markdown-large/fixtures/950k.md'))execFileSync(process.execPath,['scripts/markdown-large-fixtures.mjs'])
import {createServer} from 'vite'
import {chromium} from 'playwright'
const server=await createServer({server:{host:'127.0.0.1',port:1557,strictPort:true,hmr:false,watch:null}});await server.listen()
const browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto('http://127.0.0.1:1557/tests/live-large/fixture.html');await page.waitForFunction(()=>window.liveLarge)
 const result=await page.evaluate(()=>{
  const {Bridge,EditorState,sourceTextPosition}=window.liveLarge
  const corpora=['# 标题\n\n正文 **bold** 与 😀 é\n\n| A | B |\n| --- | --- |\n| 中文 | value |\n\n尾部\n','- item\n  - nested\n\n> quote\n>\n> next\n\n```js\nlet a=1\n```\n','---\ntitle: meta\n---\n\n[ref][id]\n\n[id]: https://example.com\n\n[^a]: note\n\nmath $x^2$\n','\n\n白 行\n\n\nend\n','a\r\n\r\nb\r\n']
  let cases=0,positions=0
  for(const source of corpora){
   const bridge=new Bridge(source)
   function legacySource(pos){let offset=0;for(const block of bridge.blocks){if(pos<offset+block.node.nodeSize)return Math.min(block.to,block.from+sourceTextPosition(block.node,block.raw,Math.max(0,pos-offset-1)));offset+=block.node.nodeSize}return source.length}
   for(let pos=0;pos<=bridge.doc.content.size;pos++){const mapped=bridge.sourcePosition(pos);if(mapped<0||mapped>source.length||mapped!==legacySource(pos))throw Error('source position range');positions++}
   for(let pos=0;pos<=source.length;pos++){const mapped=bridge.documentPosition(pos);if(mapped<0||mapped>bridge.doc.content.size)throw Error('document position range');positions++}
   bridge.doc.descendants((node,pos)=>{if(!node.isText)return;const state=EditorState.create({doc:bridge.doc});for(const insert of ['中','😀','<&>','word']){const tr=state.tr.insertText(insert,pos+Math.floor(node.nodeSize/2)),fast=bridge.prepare(tr.doc),full=bridge.prepareFull(tr.doc);if(fast.source!==full.source||JSON.stringify(fast.patch)!==JSON.stringify(full.patch))throw Error('fast/full source mismatch');if(!fast.bridge.doc.eq(full.bridge.doc))throw Error('fast/full PM mismatch');cases++}})
  }
  return {cases,positions}
 });assert(result.cases>50);assert(result.positions>200)
 await page.evaluate(()=>window.liveLarge.open(''));await page.waitForFunction(()=>window.liveLarge.live())
 const ime=await page.evaluate(async()=>{const l=window.liveLarge.live(),before=l.view.nodeDOM(0);l.view.dom.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));l.view.dispatch(l.view.state.tr.insertText('中',1));l.view.dom.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));await new Promise(r=>setTimeout(r,40));return {stable:before===l.view.nodeDOM(0),text:window.liveLarge.manager.getText(window.liveLarge.id)}})
 assert.deepEqual(ime,{stable:true,text:'中'},'first empty-document composition preserves its paragraph DOM')
 const source=fs.readFileSync('test-results/markdown-large/fixtures/950k.md','utf8');await page.evaluate(source=>window.liveLarge.reset(source),source);await page.waitForFunction(()=>window.liveLarge.live())
 assert.equal(await page.locator('.md-table-tools').count(),1,'one toolbar per Live pane')
 const counters=await page.evaluate(()=>{const l=window.liveLarge.live();let lookups=0;for(const code of l.codeViews){const original=code.getPos;code.getPos=()=>{lookups++;return original()}}const start=performance.now();for(let i=0;i<10;i++)l.view.dispatch(l.view.state.tr.setSelection(l.view.state.selection));return {ms:performance.now()-start,times:window.liveLarge.times,lookups}})
 assert.equal(counters.lookups,0,'selection must not enumerate all code positions when search is closed')
 await page.evaluate(()=>{const m=window.liveLarge.manager;const pane=m.splitPane('right');const host=document.createElement('div');host.style.height='780px';document.body.append(host);m.mountPane(host,pane)})
 await page.waitForFunction(()=>window.liveLarge.manager.liveViews.size===2)
 assert(await page.evaluate(()=>{const views=[...window.liveLarge.manager.liveViews.values()];return views[0].editor.bridge.blocks===views[1].editor.bridge.blocks}),'panes share initial immutable blocks')
 const id=await page.evaluate(()=>window.liveLarge.id)
 // The existing second-pane host contract is tested by the canonical regression suite.
 await page.evaluate(()=>{const l=window.liveLarge.live();l.view.dispatch(l.view.state.tr.insertText('验',1))})
 assert.equal(await page.evaluate(()=>window.liveLarge.manager.getText(window.liveLarge.id)),source.slice(0,2)+'验'+source.slice(2))
 assert(await page.evaluate(()=>[...window.liveLarge.manager.liveViews.values()].every(v=>v.editor.bridge.source===window.liveLarge.manager.getText(window.liveLarge.id))),'editing pane synchronizes siblings')
 await page.evaluate(()=>window.liveLarge.manager.command('undo'));assert.equal(await page.evaluate(()=>window.liveLarge.manager.getText(window.liveLarge.id)),source)
 await page.evaluate(()=>window.liveLarge.manager.command('redo'));assert.equal(await page.evaluate(()=>window.liveLarge.manager.getText(window.liveLarge.id)),source.slice(0,2)+'验'+source.slice(2))
 await page.evaluate(()=>window.liveLarge.manager.dispose());assert.equal(await page.locator('.md-table-tools').count(),0)
 assert.deepEqual(errors,[]);console.log('PASS',result,'950k real PM edit/undo/redo; stable toolbar; selection hot path; dispose',id)
}finally{await browser.close();await server.close()}
