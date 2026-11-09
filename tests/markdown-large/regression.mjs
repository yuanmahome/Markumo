import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const server = await createServer({server:{host:'127.0.0.1',port:1553,strictPort:true,hmr:false,watch:null}})
await server.listen()
const browser = await chromium.launch({headless:true})
const page = await browser.newPage()
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const results=[]
try {
 await page.goto('http://127.0.0.1:1553/tests/markdown-large/fixture.html')
 await page.waitForFunction(()=>window.large)
 for(const size of process.env.REF_ONLY?[]:[102400,512000,950000,1048576,2097152,5242880,10485760]) {
  const block='# 标题\n\n中文与 English **正文**。\n\n- 一级\n  - 二级\n\n| A | B |\n| --- | --- |\n| 值 | 文 |\n\n```js\nconst a = 1\n```\n\n'
  const text=block.repeat(Math.ceil(size/block.length))+'\n# DOCUMENT_END\n'
  const began=performance.now()
  await page.evaluate(text=>window.large.set(text),text)
  await page.waitForSelector('.split-preview-pane h1')
  const first=performance.now()-began
  await page.waitForFunction(()=>!document.querySelector('.preview-progress'),null,{timeout:60000})
  const indexed=performance.now()-began
  const initial=await page.locator('*').count()
  await page.evaluate(()=>{const r=document.querySelector('.split-preview-pane');r.scrollTop=r.scrollHeight})
  await page.waitForFunction(()=>document.querySelector('.split-preview-pane').textContent.includes('DOCUMENT_END'),null,{timeout:5000}).catch(async e=>{console.log(await page.evaluate(()=>{const r=document.querySelector('.split-preview-pane');return {top:r.scrollTop,height:r.scrollHeight,body:r.innerText.slice(-500),sections:[...r.querySelectorAll('section')].map(s=>s.dataset.group)}}));throw e})
  const final=await page.locator('*').count()
  assert(initial<6000&&final<6000,`bounded DOM: ${initial},${final}`)
  assert(!await page.getByText('文档较大，已暂停只读预览；源码仍可编辑。').count())
  results.push({size:text.length,firstMs:first,indexMs:indexed,initialDOM:initial,endDOM:final})
 }
 await page.evaluate(()=>window.large.set('[jump][target]\n\n'+('# filler\n\nbody\n\n'.repeat(10000))+'\n[target]: https://example.com\n'))
 await page.waitForFunction(()=>!document.querySelector('.preview-progress'));await page.evaluate(()=>window.large.jump(1));await page.waitForFunction(()=>document.querySelector('a[href="https://example.com/"]'),null,{timeout:3000}).catch(async e=>{console.log('REF',errors,await page.evaluate(()=>({html:document.querySelector('.split-preview-pane').innerHTML.slice(0,1800),top:document.querySelector('.split-preview-pane').scrollTop})));throw e})
 assert.deepEqual(errors,[])
 fs.mkdirSync('test-results/markdown-large',{recursive:true});fs.writeFileSync('test-results/markdown-large/browser.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2))
} finally {await browser.close();await server.close()}
