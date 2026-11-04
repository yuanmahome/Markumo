// Real CodeMirror + actual Rust laboratory process, using a test-only HTTP
// bridge. This is not a Windows WebView performance benchmark.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import {createHash} from 'node:crypto'
import {createServer} from 'vite'
import {chromium} from 'playwright'
const root=path.resolve(`test-results/p03/window-lab-${Date.now()}`);fs.mkdirSync(root,{recursive:true})
const binary=path.resolve('src-tauri/target/release/examples/segmented-lab.exe');execFileSync('icacls',[binary,'/setintegritylevel','M'],{windowsHide:true,stdio:'pipe'})
const child=spawn(binary,[],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:child.stdout})
let pending,stderr='';child.stderr.on('data',b=>stderr+=b);lines.on('line',line=>{const response=JSON.parse(line);const p=pending;pending=undefined;p?.resolve(response)})
child.on('error',error=>pending?.reject(error));child.on('exit',code=>pending?.reject(Error(`Rust laboratory exited ${code}: ${stderr}`)))
let tail=Promise.resolve(),requests=0,maxRequestBytes=0,maxResponseBytes=0,activeReads=0,peakReads=0
const send=request=>{
 const operation=tail.then(()=>new Promise((resolve,reject)=>{const text=JSON.stringify(request);requests++;maxRequestBytes=Math.max(maxRequestBytes,Buffer.byteLength(text));pending={resolve:response=>{maxResponseBytes=Math.max(maxResponseBytes,Buffer.byteLength(JSON.stringify(response)));resolve(response)},reject};child.stdin.write(text+'\n')}));tail=operation.catch(()=>{});return operation
}
const source=path.join(root,'100m.txt'),size=100*1024*1024,block=Buffer.from('0123456789abcdef'.repeat(255)+'中文😀\r\n')
const descriptor=fs.openSync(source,'wx');for(let at=0;at<size;at+=block.length)fs.writeSync(descriptor,block,0,Math.min(block.length,size-at));fs.closeSync(descriptor)
// Truncation above can split a scalar only in the last block; ensure a valid tail.
let bytes=fs.readFileSync(source);while(bytes.length && (bytes.at(-1)&0xc0)===0x80)bytes=bytes.subarray(0,bytes.length-1);if(bytes.length && bytes.at(-1)>=0xc0)bytes=bytes.subarray(0,bytes.length-1);fs.writeFileSync(source,bytes);bytes=undefined
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),results=[],errors=[]
const server=await createServer({server:{host:'127.0.0.1',port:1505,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-segmented-lab',plugins:[{name:'rust-lab-port',configureServer(server){server.middlewares.use('/p03/port',(req,res)=>{void(async()=>{let chunks=[],length=0;for await(const chunk of req){length+=chunk.length;if(length>2*1024*1024)throw Error('Test request over budget');chunks.push(chunk)}const request=JSON.parse(Buffer.concat(chunks).toString());const read=request.command==='window';if(read){activeReads++;peakReads=Math.max(peakReads,activeReads)}try{const response=await send(request);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response))}finally{if(read)activeReads--}})().catch(error=>{res.statusCode=500;res.end(JSON.stringify({ok:false,error:String(error)}))})})}}]})
await server.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1200,height:780}});page.on('pageerror',e=>errors.push(String(e)))
async function check(name,fn){try{const detail=await fn();results.push({name,ok:true,detail});console.log('PASS',name)}catch(e){results.push({name,ok:false,error:String(e)});console.log('FAIL',name,String(e))}}
try{
 await page.goto('http://127.0.0.1:1505/tests/p03/fixture.html');await page.waitForFunction(()=>window.ready)
 await page.evaluate(async({source,root})=>{
  const {SegmentedWindowEditor}=await import('/src/editor/text/SegmentedWindowEditor.ts'),{SegmentedScrollRail}=await import('/src/editor/text/SegmentedScrollRail.ts'),{WindowMap}=await import('/src/editor/text/WindowMap.ts')
  const request=async command=>{const r=await(await fetch('/p03/port',{method:'POST',body:JSON.stringify(command)})).json();if(!r.ok)throw Error(r.error);return r.value}
  const status=await request({command:'open',path:source,workspace:root}),first=await request({command:'window',revision:status.revision,start:0,budget:65536})
  const port={mode:'segmented',positionUnit:'utf8',window:(revision,start,budget)=>request({command:'window',revision,start,budget}),edit:(revision,edits)=>request({command:'edit',revision,edits}),undo:revision=>request({command:'undo',revision}),redo:revision=>request({command:'redo',revision}),search:(revision,query,start,limit)=>request({command:'search',revision,query,start,limit}),replace:(revision,query,replacement)=>request({command:'replace',revision,query,replacement}),checkpoint:revision=>request({command:'checkpoint',revision}),saveCopy:(revision,path)=>request({command:'saveCopy',revision,path}),close:discard=>request({command:'close',discard}),position:(revision,byte)=>request({command:'position',revision,byte}),lineStart:(revision,line)=>request({command:'lineStart',revision,line})}
  const notices=[],host=document.getElementById('app');host.style.cssText='display:flex;height:650px';const editorHost=document.createElement('section');editorHost.style.cssText='height:100%;width:1100px';host.append(editorHost)
  const editor=new SegmentedWindowEditor(editorHost,port,first,status,'\r\n',e=>notices.push(e.message)),rail=new SegmentedScrollRail(host,editor,e=>notices.push(e.message))
  Object.assign(window,{lab:{editor,rail,port,request,notices,WindowMap,status}})
 },{source,root})
 await check('100 MiB document retains one bounded editable CM window',async()=>{const result=await page.evaluate(()=>window.lab.editor.metrics);assert(result.byteLength>99*1024**2);assert(result.visibleChars<=65536);assert(result.mappingBytes<1024**2);return result})
 await check('UTF-8/UTF-16/CRLF mapping rejects split scalars and preserves mixed source',async()=>{return page.evaluate(()=>{const {WindowMap}=window.lab,raw='中😀e\u0301\r\nnext\rlast\n',map=new WindowMap(raw,100);for(let i=0;i<map.text.length;i++){if(i===2)continue;const byte=map.toByte(i);if(map.toLocal(byte)!==i)throw Error('Offset roundtrip failed')}let rejected=false;try{map.toByte(2)}catch{rejected=true}if(!rejected)throw Error('Split surrogate accepted');const change=map.change([{from:0,to:1,insert:'汉\n'}],'\r\n');if(change.mapping.raw!=='汉\r\n😀e\u0301\r\nnext\rlast\n')throw Error('Raw separators changed');return{bytes:map.retainedBytes}})})
 await check('real input, rapid queued edits, composition, backend undo/redo',async()=>{
  await page.locator('[data-segmented-lab]').click();await page.keyboard.press('Control+a');await page.keyboard.insertText('输入😀e\u0301');
  const beforeCopy=path.join(root,'before-history.txt'),afterCopy=path.join(root,'after-history.txt')
  await page.evaluate(async({beforeCopy,afterCopy})=>{const e=window.lab.editor;for(let i=0;i<30;i++)e.view.dispatch({changes:{from:0,insert:'中'},userEvent:'input.type'});await e.flush();const before=e.view.state.doc.toString(),length=e.metrics.byteLength;await e.saveCopy(beforeCopy);await e.history(false);await e.history(true);const after=e.view.state.doc.toString();if(after!==before.slice(0,after.length)||length!==e.metrics.byteLength)throw Error('Undo/Redo changed acknowledged content');await e.saveCopy(afterCopy);e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));let rejected=false;try{await e.seek(1000000)}catch{rejected=true}e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));if(!rejected)throw Error('Composition window was replaced')},{beforeCopy,afterCopy})
  // Reloading re-bounds the visible tail; full-file hashes, rather than equal
  // window lengths, prove that Undo/Redo did not truncate the canonical body.
  assert.equal(sha(beforeCopy),sha(afterCopy))
  await page.waitForFunction(()=>!window.lab.editor.view.compositionStarted)
  const result=await page.evaluate(()=>window.lab.editor.metrics);assert.equal(result.pendingBytes,0);assert(!result.failed);return result
 })
 await check('200 rapid seeks are coalesced, scrollbar and line jump reach distant content',async()=>{
  const result=await page.evaluate(async()=>{const {editor:e,rail}=window.lab;await Promise.all(Array.from({length:200},(_,i)=>e.seek(i*400000)));await e.gotoLine(10000);const point=await window.lab.port.position(e.metrics.revision,e.metrics.startByte);if(point.line!==10000)throw Error('Wrong global line');rail.element.scrollTop=rail.element.scrollHeight*.9;rail.element.dispatchEvent(new Event('scroll'));await new Promise(r=>setTimeout(r,250));await e.seek(Math.floor(e.metrics.byteLength*.8));return e.metrics});assert(result.startByte>70*1024**2);assert(result.visibleChars<=65536);assert(peakReads<=1);return{...result,peakReads}
 })
 await check('global search, streamed replace, save copy and recovery retain distant edits',async()=>{
  const target=path.join(root,'saved.txt')
  const result=await page.evaluate(async target=>{const {editor:e}=window.lab;e.view.dispatch({changes:{from:10,insert:'P03_UNIQUE_标记😀'},userEvent:'input.type'});await e.flush();const found=await e.search('P03_UNIQUE_标记😀');if(found.count!==1)throw Error('Global search missed distant edit');await e.replaceAll('P03_UNIQUE_标记😀','P03_REPLACED_中文');await e.saveCopy(target);const result={...e.metrics};await e.history(false);if((await e.search('P03_UNIQUE_标记😀')).count!==1)throw Error('Replace undo lost original edit');await e.history(true);await e.saveCopy(target+'.redo');window.lab.directory=(await window.lab.request({command:'checkpoint',revision:e.metrics.revision})).directory;await e.close(false);window.lab.rail.destroy();return result},target)
  assert.equal(sha(target),sha(target+'.redo'));const directory=await page.evaluate(()=>window.lab.directory);const restored=await send({command:'restore',directory});assert(restored.ok,restored.error);const copy=target+'.restore';assert((await send({command:'saveCopy',revision:restored.value.revision,path:copy})).ok);assert.equal(sha(target),sha(copy));assert((await send({command:'close',discard:true})).ok);return result
 })
 await check('unsupported full-selection operation is explicit and closed projection is released',async()=>{const result=await page.evaluate(()=>({notices:window.lab.notices,metrics:window.lab.editor.metrics,views:document.querySelectorAll('.cm-editor').length,rails:document.querySelectorAll('[aria-label="全文字节进度（原型）"]').length}));assert(result.notices.some(n=>n.includes('全文选择/复制')));assert.equal(result.views,0);assert.equal(result.rails,0);assert.equal(result.metrics.visibleChars,0);assert.equal(result.metrics.mappingBytes,8);return result})
}finally{await browser.close();await server.close();child.stdin.end();lines.close();child.kill();fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({results,errors,requests,maxRequestBytes,maxResponseBytes,peakReads,stderr},null,2))}
assert.equal(errors.length,0,JSON.stringify(errors));assert(results.every(r=>r.ok),JSON.stringify(results.filter(r=>!r.ok)));console.log(path.join(root,'results.json'))
