import assert from 'node:assert/strict'
import fs from 'node:fs'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const server=await createServer({server:{host:'127.0.0.1',port:1507,strictPort:true,hmr:false,watch:null},cacheDir:'node_modules/.vite-bold-input'})
await server.listen()
const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[],results=[]
page.on('pageerror',e=>errors.push(e.message))
async function check(name,run){try{await run();results.push({name,passed:true});console.log('PASS',name)}catch(error){results.push({name,passed:false,error:String(error)});console.log('FAIL',name,String(error))}}
async function reset(source,word=false){await page.evaluate(source=>window.f.reset(source),source);await page.waitForFunction(()=>window.f.ready());await page.evaluate(()=>window.f.caret('Start'));if(word){for(let i=0;i<5;i++)await page.keyboard.press('Shift+ArrowRight')}else await page.keyboard.press('Shift+End')}
async function state(){await page.waitForFunction(()=>window.f.ready());return page.evaluate(()=>({source:window.f.manager.getText(window.f.id),strong:[...document.querySelectorAll('.md-prose strong')].map(e=>e.textContent),text:window.f.live().view.state.doc.textContent,notices:window.f.notices}))}
try{
 await page.goto('http://127.0.0.1:1507/tests/markdown-links/fixture.html');await page.waitForFunction(()=>!!window.f)
 for(const [name,source,expected] of [
  ['Chinese typed character by character','Start\n\nEND_SENTINEL\n','**及时答复**\n\nEND_SENTINEL\n'],
  ['existing markers and entities','__保留粗体__ &amp; KEEP Start\n\nEND_SENTINEL\n','__保留粗体__ &amp; KEEP **及时答复**\n\nEND_SENTINEL\n'],
  ['heading','## Start\n\nEND_SENTINEL\n','## **及时答复**\n\nEND_SENTINEL\n'],
  ['quote','> Start\n\nEND_SENTINEL\n','> **及时答复**\n\nEND_SENTINEL\n'],
  ['list','- Start\n\nEND_SENTINEL\n','- **及时答复**\n\nEND_SENTINEL\n'],
  ['table cell','| A | B |\n|---|---|\n| Start | untouched |\n\nEND_SENTINEL\n','| A | B |\n|---|---|\n| **及时答复** | untouched |\n\nEND_SENTINEL\n'],
 ])await check(name,async()=>{
  await reset(source);await page.keyboard.type('**及时答复**',{delay:10});const result=await state()
  assert.equal(result.source,expected);assert(result.strong.includes('及时答复'));assert.deepEqual(result.notices,[])
 })
 await check('one text input handles the complete Markdown token',async()=>{
  await reset('Start\n\nEND_SENTINEL\n');await page.keyboard.insertText('**及时答复**');const result=await state();assert.equal(result.source,'**及时答复**\n\nEND_SENTINEL\n');assert.deepEqual(result.strong,['及时答复'])
 })
 await check('complete nested inline input keeps the exact supplied spelling',async()=>{
  await reset('Start\n\nEND_SENTINEL\n');await page.keyboard.insertText('**及时*答复***');const result=await state();assert.equal(result.source,'**及时*答复***\n\nEND_SENTINEL\n');assert.equal(result.strong.join(''),'及时答复');assert.equal(await page.locator('.md-prose em').textContent(),'答复')
 })
 await check('closing the token returns subsequent text to normal weight',async()=>{
  await reset('Start\n\nEND_SENTINEL\n');await page.keyboard.type('**及时答复**');await page.keyboard.insertText('，后续正文');const result=await state();assert.equal(result.source,'**及时答复**，后续正文\n\nEND_SENTINEL\n');assert.deepEqual(result.strong,['及时答复'])
 })
 await check('undo/redo and a source/live round trip retain working bold syntax',async()=>{
  await reset('Start\n\nEND_SENTINEL\n');await page.keyboard.type('**及时答复**');const before=await state();assert.equal(before.source,'**及时答复**\n\nEND_SENTINEL\n')
  await page.keyboard.press('Control+z');const undone=await state();assert.notEqual(undone.source,before.source)
  await page.keyboard.press('Control+y');assert.equal((await state()).source,before.source)
  await page.evaluate(()=>{window.f.mode('source');window.f.mode('live')});await page.waitForFunction(()=>window.f.ready());const after=await state();assert.equal(after.source,before.source);assert.deepEqual(after.strong,['及时答复'])
 })
 await check('inline code keeps asterisks as code content',async()=>{
  await reset('`Start`\n\nEND_SENTINEL\n');await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');for(let i=0;i<5;i++)await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.type('**及时答复**');const result=await state();assert.equal(result.source,'`**及时答复**`\n\nEND_SENTINEL\n');assert.deepEqual(result.strong,[])
 })
 await check('an explicit escape and whitespace-invalid delimiters remain plain text',async()=>{
  for(const input of ['\\**及时答复**','** 及时答复 **']){
   await reset('Start\n\nEND_SENTINEL\n');await page.keyboard.type(input);const result=await state();assert.deepEqual(result.strong,[]);assert.equal(result.text,input+'END_SENTINEL');assert.deepEqual(result.notices,[])
  }
 })
 await check('editing explicitly escaped literal markers does not turn them into bold',async()=>{
  await reset('\\*\\*Start\\*\\*\n\nEND_SENTINEL\n',true)
  await page.keyboard.insertText('及时答复');const result=await state();assert.equal(result.source,'\\*\\*及时答复\\*\\*\n\nEND_SENTINEL\n');assert.deepEqual(result.strong,[])
 })
 await check('closing stars cannot claim an explicitly escaped opening from source',async()=>{
  await reset('\\*\\*Start\n\nEND_SENTINEL\n');await page.keyboard.type('及时答复**');const result=await state();assert.equal(result.source,'\\*\\*及时答复**\n\nEND_SENTINEL\n');assert.deepEqual(result.strong,[])
 })
 assert.deepEqual(errors,[]);fs.mkdirSync('test-results/bold-input',{recursive:true});fs.writeFileSync('test-results/bold-input/results.json',JSON.stringify({results,errors},null,2)+'\n')
 const failed=results.filter(r=>!r.passed);console.log(`BOLD INPUT ${results.length-failed.length}/${results.length} passed`);assert.equal(failed.length,0,failed.map(r=>r.name).join('\n'))
}finally{await browser.close();await server.close()}
