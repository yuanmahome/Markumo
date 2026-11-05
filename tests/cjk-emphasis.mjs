import assert from 'node:assert/strict'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const server=await createServer({server:{host:'127.0.0.1',port:1499,strictPort:true,hmr:false},cacheDir:'node_modules/.vite-cjk-strong'})
await server.listen();const browser=await chromium.launch({headless:true})
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1499/tests/markdown-links/fixture.html');await page.waitForFunction(()=>window.f)
 const cases=[['**何时用：**这样','何时用：'],['段落**「中文」**继续','「中文」'],['***说明：***接着','说明：'],['**何时用:**这样','何时用:'],['**测试，**后文','测试，'],['**漢字：**日本語','漢字：']]
 for(const [source,strong] of cases){
  await page.evaluate(s=>window.f.reset(s),source);await page.waitForFunction(()=>window.f.ready())
  assert.equal(await page.locator('.md-prose strong').textContent(),strong,source)
  const rendered=await page.evaluate(async source=>{
   const {createMarkdownRenderer}=await import('/src/editor/markdown/rendering.ts')
   const {parser}=await import('/tests/cjk-emphasis-api.ts');const {markdownSyntaxExtensions}=await import('/src/editor/markdown/semantics.ts')
   const {exportMarkdownToNativeDocx}=await import('/src/features/document-conversion/nativeDocxExport.ts')
   const html=createMarkdownRenderer().render(source)
   const docx=await exportMarkdownToNativeDocx(source)
   return {html,tree:parser.configure(markdownSyntaxExtensions).parse(source).toString(),xml:new TextDecoder().decode(docx.bytes),text:window.f.manager.getText(window.f.id)}
  },source)
  assert(rendered.html.includes('<strong>'),rendered.html);assert(rendered.tree.includes('StrongEmphasis'),rendered.tree);assert(rendered.xml.includes('<w:b/>'));assert.equal(rendered.text,source)
  await page.evaluate(()=>window.f.manager.setMarkdownMode(window.f.id,'source'));await page.waitForTimeout(25);await page.evaluate(()=>window.f.manager.setMarkdownMode(window.f.id,'live'));await page.waitForFunction(()=>window.f.ready());assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),source)
  console.log('PASS CJK bold read/live/source/preview/DOCX:',source)
 }
 for(const source of ['**Bold:**text','\\**何时用：**这样','`**何时用：**这样`','** 未完成：**这样','__何时用：__这样','```md\n**何时用：**这样\n```']){
  await page.evaluate(s=>window.f.reset(s),source);await page.waitForFunction(()=>window.f.ready());assert.equal(await page.locator('.md-prose strong').count(),0,source);assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),source);console.log('PASS preserves literal or CommonMark:',source)
 }
 await page.evaluate(()=>window.f.reset('这样'));await page.waitForFunction(()=>window.f.ready());await page.evaluate(()=>window.f.caret('这样'));await page.keyboard.type('**何时用：**');await page.keyboard.press('Escape');await page.waitForTimeout(80);assert.equal(await page.locator('.md-prose strong').textContent(),'何时用：');assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),'**何时用：**这样');await page.keyboard.press('Control+z');await page.keyboard.press('Control+y');assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),'**何时用：**这样');console.log('PASS real editor typing before Chinese text, Undo/Redo and source preservation')
}finally{await browser.close();await server.close()}
