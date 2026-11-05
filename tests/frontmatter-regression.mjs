import fs from 'node:fs'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const code=ts.transpileModule(fs.readFileSync('src/editor/markdown/frontmatter/frontMatterParser.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText
const {parseFrontMatter:parse,updateFrontMatterField:update}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
assert.deepEqual(parse(`---
tags: [O'Reilly, "quoted, colon: value", '&anchor', '*alias'] # safe
---`).tags, ["O'Reilly", 'quoted, colon: value', '&anchor', '*alias'])
assert.equal(parse(`---
tags: [O'Reilly, "quoted, colon: value", '&anchor', '*alias'] # safe
---`).editable, true)
for(const eol of ['\n','\r\n']) {
 const raw=['---',`title: 'Markdown 综合教程' # keep`,`tags: [示例, "a,b", 'it''s: fine', "# tag", "a\\\"b"] # tags`,'created: 2026-11-05','updated: 2026-11-06','status: draft','---'].join(eol)
 assert.equal(parse(raw).editable,true)
 assert.deepEqual(parse(raw).tags,['示例','a,b',"it's: fine",'# tag','a"b'])
 assert.equal(update(raw,'title','Markdown 综合教程'),raw)
 assert.equal(update(raw,'title',"新标题's # detail"),raw.replace("'Markdown 综合教程'","'新标题''s # detail'"))
 assert.equal(update(raw,'tags','bad'),null)
 for(const value of ['[a,\n b]','{nested: true}','&anchor foo','*anchor','|\n  text','\n  nested: true','[a, {b: c}]']) {
  const complex=`---${eol}title: ${value.replaceAll('\n',eol)}${eol}---`
  assert.equal(parse(complex).editable,false,complex)
  assert.equal(update(complex,'title','changed'),null)
 }
}
const server=await createServer({server:{host:'127.0.0.1',port:1553,strictPort:true,hmr:false,watch:null}})
await server.listen();const browser=await chromium.launch({headless:true});const page=await browser.newPage()
try {
 await page.goto('http://127.0.0.1:1553/tests/markdown-links/fixture.html');await page.waitForFunction(()=>!!window.f)
 const raw='---\ntitle: Markdown 综合教程 # keep\ntags: [示例, Markdown]\ncreated: 2026-11-05\nupdated: 2026-11-06\nstatus: draft\n---\n\n# 正文\n'
 await page.evaluate(s=>window.f.reset(s),raw);await page.waitForFunction(()=>window.f.ready())
 assert.equal(await page.locator('.md-frontmatter-error').count(),0)
 assert.equal(await page.locator('.md-frontmatter-title-input').inputValue(),'Markdown 综合教程')
 assert.match(await page.locator('.md-frontmatter-card').innerText(),/2026-11-06/)
 for(const mode of ['source','split','live']) {await page.evaluate(m=>window.f.mode(m),mode);await page.waitForFunction(()=>window.f.ready());assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),raw)}
 await page.locator('.md-frontmatter-title-input').fill('真实编辑 # 保留')
 await page.locator('.md-frontmatter-title-input').press('Tab')
 await page.waitForFunction(()=>window.f.manager.getText(window.f.id).includes('真实编辑'))
 assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),raw.replace('Markdown 综合教程', '"真实编辑 # 保留"'))
 const complex='---\ntitle: &anchor [a,\n  {nested: value}]\n---\n\n正文\n'
 await page.evaluate(s=>window.f.reset(s),complex);await page.waitForFunction(()=>window.f.ready())
 assert.equal(await page.locator('.md-frontmatter-error').count(),1)
 assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),complex)
 console.log('PASS parser LF/CRLF, quoted arrays, comments, localized edit, real editor mode cycles and safe fallback')
} finally {await browser.close();await server.close()}
