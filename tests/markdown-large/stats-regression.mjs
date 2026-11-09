import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const server=await createServer({server:{host:'127.0.0.1',port:1554,strictPort:true,hmr:false,watch:null}});await server.listen()
const browser=await chromium.launch({headless:true});const page=await browser.newPage()
const errors=[];page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto('http://127.0.0.1:1554/tests/markdown-large/stats-fixture.html');await page.waitForFunction(()=>window.stats)
 const result=await page.evaluate(()=>{const {countText,combine,Text,settingsFrom}=window.stats;const source=('中文 English 👩‍💻 é\n\n'.repeat(120))+'tail';const doc=Text.of(source.split('\n'));const leaves=t=>t.children?t.children.flatMap(leaves):[t];return {unicode:countText('中 é 👩‍💻 word'),whole:countText(source),parts:combine(leaves(doc).map(t=>countText(t.toString()))),preference:settingsFrom({primaryStatistic:'lines'}).primaryStatistic,fallback:settingsFrom({primaryStatistic:'bad'}).primaryStatistic}})
 assert.equal(result.unicode.characters,10);assert.equal(result.unicode.nonSpace,7);assert.equal(result.unicode.chinese,1);assert.equal(result.unicode.english,2)
 assert.deepEqual(result.parts,result.whole);assert.equal(result.preference,'lines');assert.equal(result.fallback,'words')
 await page.waitForFunction(()=>!document.querySelector('.stats-trigger').textContent.includes('统计中'))
 await page.locator('.stats-trigger').click();await page.getByRole('dialog').waitFor()
 await page.getByLabel('状态栏统计类型').selectOption('lines');assert(await page.getByRole('dialog').isVisible())
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert(await page.locator('.stats-trigger').evaluate(el=>el===document.activeElement))
 await page.locator('.stats-trigger').click();await page.mouse.click(600,400);assert.equal(await page.getByRole('dialog').count(),0)
 await page.evaluate(()=>window.stats.manager.dispatch(window.stats.id,{changes:{from:0,insert:'新增\n'}}))
 await page.waitForFunction(()=>document.querySelector('.stats-trigger').textContent.trim()==='4 行')
 const original=await page.evaluate(()=>window.stats.manager.getText(window.stats.id));assert(original.startsWith('新增\n中文'))
 assert.deepEqual(errors,[]);console.log('PASS Unicode graphemes, cached leaf aggregation, preference migration, popup focus/Escape/outside click, incremental update')
}finally{await browser.close();await server.close()}
