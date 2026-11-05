import assert from 'node:assert/strict'
import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {chromium} from 'playwright'
import {createServer} from 'vite'
const baseline=process.argv.includes('--baseline'), out='test-results/reference-definitions'
fs.mkdirSync(out,{recursive:true})
const server=await createServer({server:{host:'127.0.0.1',port:1557,strictPort:true,hmr:false,watch:null},plugins:baseline?[{name:'baseline-reference-view',enforce:'pre',load(id){if(id.replaceAll('\\','/').match(/\/wysiwyg\/(MarkdownEditorController\.ts|MarkdownTheme\.css)$/))return execFileSync('git',['show','HEAD:src/editor/markdown/wysiwyg/'+id.split(/[\\/]/).at(-1)],{encoding:'utf8',windowsHide:true})}}]:[]})
await server.listen();const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1100,height:800}});page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));const results=[]
const source=()=>page.evaluate(()=>window.f.manager.getText(window.f.id))
async function reset(text){await page.evaluate(s=>window.f.reset(s),text);await page.waitForFunction(()=>window.f.ready());await page.waitForTimeout(40)}
async function check(name,run){try{await run();results.push({name,passed:true});console.log('PASS',name)}catch(e){results.push({name,passed:false,error:String(e)});console.error('FAIL',name,e);console.error('SOURCE',await source());console.error('DOC',await page.evaluate(()=>JSON.stringify(window.f.live()?.view.state.doc.toJSON())))}}
async function edit(label='链接'){const link=page.locator(`a[data-reference-label]`).filter({hasText:label}).first();await link.click({button:'right'});await page.getByRole('menuitem',{name:'编辑引用定义',exact:true}).click();await page.getByRole('dialog',{name:'编辑引用定义',exact:true}).waitFor()}
async function caret(needle,end=false){await page.evaluate(({needle,end})=>{const e=window.f.live();let at;e.view.state.doc.descendants((n,p)=>{if(n.isText&&n.text.includes(needle))at=p+n.text.indexOf(needle)+(end?needle.length:0)});e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.create(e.view.state.doc,at)));e.view.focus()},{needle,end})}
try{
 await page.goto('http://127.0.0.1:1557/tests/markdown-links/fixture.html');await page.waitForFunction(()=>!!window.f)
 const single='[引用链接][project]\n\n[project]: https://github.com/yuanmahome/Markumo\n'
 await reset(single)
 await page.screenshot({path:out+`/${baseline?'before':'after'}-live.png`})
 await page.locator('.md-document').screenshot({path:out+`/${baseline?'before':'after'}-live-content.png`})
 if(baseline){assert.match(await page.locator('.md-document').innerText(),/链接引用定义/);await page.locator('.md-reference-source summary').click();await page.locator('.md-reference-source textarea').focus();await page.locator('.md-document a').click({button:'right'});assert(await page.locator('.md-reference-source textarea').isVisible());await page.evaluate(()=>window.f.mode('split'));await page.screenshot({path:out+'/before-split.png'});console.log('REPRODUCED persistent reference definition UI in live mode');}
 else{
 await check('reading parity and zero-height model-preserving atom',async()=>{
  assert.equal((await page.locator('.md-document').innerText()).trim(),'引用链接')
  assert.equal(await page.locator('.md-prose > p').count(),1)
  assert.equal(await page.locator('.md-reference-definition textarea, .md-reference-definition summary').count(),0)
  assert.equal(await page.locator('.md-reference-definition').evaluate(e=>e.getBoundingClientRect().height),0)
  assert.equal(await page.evaluate(()=>window.f.live().bridge.blocks.filter(b=>b.node.attrs.kind==='reference').length),1)
  await page.evaluate(()=>window.f.mode('split'));await page.waitForTimeout(150);await page.screenshot({path:out+'/after-split.png'});await page.locator('[data-preview] .split-preview-content').screenshot({path:out+'/after-split-content.png'})
  assert.equal((await page.locator('[data-preview] .split-preview-content').innerText()).trim(),'引用链接')
  await page.evaluate(()=>window.f.mode('live'));await page.waitForFunction(()=>window.f.ready());assert.equal(await source(),single)
 })
 await check('native labels full/collapsed/shortcut/images and first duplicate wins',async()=>{
  const raw='[完整链接][ ProJect  ID ] / [project id][] / [PROJECT ID] / [另一个][project id]\n\n![图片][project id]\n\n[project id]: <https://example.com/old> "原始标题"\n[PROJECT ID]: https://duplicate.example\n'
  await reset(raw)
  assert.equal(await page.locator('a[data-reference-label="PROJECT ID"]').count(),4)
  assert.deepEqual(await page.locator('a[data-reference-label]').evaluateAll(es=>es.map(e=>e.getAttribute('data-href'))),Array(4).fill('https://example.com/old'))
  await edit('完整链接')
  await page.getByRole('textbox',{name:'引用目标 URL',exact:true}).fill('https://example.com/new')
  await page.waitForTimeout(60)
  assert.equal(await source(),raw.replace('https://example.com/old','https://example.com/new'))
  assert.deepEqual(await page.locator('a[data-reference-label]').evaluateAll(es=>es.map(e=>e.getAttribute('data-href'))),Array(4).fill('https://example.com/new'))
  assert.equal(await page.evaluate(()=>{let src;window.f.live().view.state.doc.descendants(n=>{if(n.type.name==='image')src=n.attrs.src});return src}),'https://example.com/new')
  await page.getByRole('textbox',{name:'引用目标 URL',exact:true}).press('Escape')
  assert.equal(await page.locator('.md-reference-panel').count(),0)
  await edit('完整链接');await page.getByRole('button',{name:'删除定义',exact:true}).click();await page.waitForTimeout(40)
  assert.equal(await page.locator('a[data-reference-label]').first().getAttribute('data-href'),'https://duplicate.example')
  await page.keyboard.press('Control+z');await page.waitForTimeout(40)
  assert.equal(await page.locator('a[data-reference-label]').first().getAttribute('data-href'),'https://example.com/new')
  await page.keyboard.press('Control+y');await page.waitForTimeout(40)
  assert.equal(await page.locator('a[data-reference-label]').first().getAttribute('data-href'),'https://duplicate.example')
 })

 await check('Unicode normalization and identical destinations retain native label identity',async()=>{
  const raw='[链接][İ] / [别名][other]\n\n![图片][İ]\n\n[İ]: https://example.com/same\n[other]: https://example.com/same\n'
  await reset(raw)
  assert.equal(await page.evaluate(()=>{let src;window.f.live().view.state.doc.descendants(n=>{if(n.type.name==='image')src=n.attrs.src});return src}),'https://example.com/same')
  await edit('链接');await page.getByRole('textbox',{name:'引用目标 URL',exact:true}).fill('https://example.com/changed')
  await page.getByRole('button',{name:'完成',exact:true}).click()
  assert.equal(await page.locator('a').filter({hasText:'链接'}).getAttribute('data-href'),'https://example.com/changed')
  assert.equal(await page.locator('a').filter({hasText:'别名'}).getAttribute('data-href'),'https://example.com/same')
  assert.equal(await source(),raw.replace('[İ]: https://example.com/same','[İ]: https://example.com/changed'))
 })

 await check('native multiline label whitespace remains editable without normalization of source',async()=>{
  const raw='[链接][foo\n bar]\n\n[ Foo\n BAR ]: <https://example.com/old> "title"\n'
  await reset(raw);await edit();await page.getByRole('textbox',{name:'引用目标 URL',exact:true}).fill('https://example.com/new')
  await page.getByRole('button',{name:'完成',exact:true}).click()
  assert.equal(await source(),raw.replace('/old','/new'))
  assert.equal(await page.locator('a[data-reference-label]').getAttribute('data-href'),'https://example.com/new')
 })
 await check('label edit invalidates old references and resolves previously undefined references',async()=>{
  const raw='[链接][old] / [new][] / [old]\n\n[old]: https://example.com "title"\n'
  await reset(raw);await edit();await page.getByRole('textbox',{name:'引用定义源码',exact:true}).fill('[new]: https://example.com "title"')
  assert.equal(await source(),raw.replace('[old]:','[new]:'))
  assert.equal(await page.locator('a[data-reference-label]').count(),1)
  assert.equal(await page.locator('a[data-reference-label]').innerText(),'new')
  await page.getByRole('textbox',{name:'引用定义源码',exact:true}).press('Escape')
  await page.keyboard.press('Control+z');await page.waitForTimeout(60)
  assert.equal(await page.locator('a[data-reference-label]').count(),2)
 })
 await check('blur closes overlay without changing layout or scrolling',async()=>{
  await reset(single+'\n尾段\n');const before=await page.locator('.md-document').boundingBox();const scroll=await page.locator('.markdown-live').evaluate(e=>e.scrollTop)
  await edit('引用链接');await page.locator('.md-document p').filter({hasText:'尾段'}).click({position:{x:700,y:8}})
  await page.waitForTimeout(50);assert.equal(await page.locator('.md-reference-panel').count(),0)
  assert.equal((await page.locator('.md-document').boundingBox()).height,before.height)
  assert.equal(await page.locator('.markdown-live').evaluate(e=>e.scrollTop),scroll)
 })
 for(const [name,raw] of [
  ['start','[id]: https://example.com\n\n# 标题\n\n[链接][id]\n'],
  ['middle','# 标题\n\n前文\n\n[id]: https://example.com\n\n[链接][id]\n\n|a|b|\n|-|-|\n|1|2|\n\n- 列表\n'],
  ['end','前文\n\n[链接][id]\n\n[id]: https://example.com\n\n[unused]: /unused "title"\n'],
 ])await check('mode cycles, save and reopen '+name,async()=>{
  for(const eol of ['\n','\r\n']){
   const original=raw.replaceAll('\n',eol)
   const roundtrip=await page.evaluate(async s=>{const {MarkdownSourceBridge}=await import('/src/editor/markdown/wysiwyg/MarkdownSourceBridge.ts');const b=new MarkdownSourceBridge(s);return b.prepare(b.doc).source},original)
   assert.equal(roundtrip,original)
   await reset(original)
   for(const mode of ['source','split','live']){await page.evaluate(m=>window.f.mode(m),mode);await page.waitForFunction(()=>window.f.ready());assert.equal(await source(),raw)}
   const saved=await page.evaluate(()=>window.f.manager.saveSnapshot(window.f.id).text);assert.equal(saved,original);await reset(saved);assert.equal(await source(),raw)
  }
 })
 await check('keyboard crosses hidden definitions, adjacent deletion and selection preserve source atoms',async()=>{
  const raw='上段\n\n[id]: https://example.com\n\n下段\n'
  await reset(raw);await caret('下段');await page.keyboard.press('ArrowLeft');await page.waitForTimeout(50)
  assert.equal(await page.evaluate(()=>window.f.live().view.state.selection.$head.parent.textContent),'上段')
  await page.keyboard.press('ArrowRight');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>window.f.live().view.state.selection.$head.parent.textContent),'下段')
  await caret('下段');await page.keyboard.press('Backspace');assert.equal(await source(),raw)
  await caret('上段',true);await page.keyboard.press('Delete');assert.equal(await source(),raw)
  await caret('上段',true);await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>window.f.live().view.state.selection.$head.parent.textContent),'下段')
  await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>window.f.live().view.state.selection.$head.parent.textContent),'上段')
  await page.evaluate(()=>{const e=window.f.live();e.view.dispatch(e.view.state.tr.setSelection(e.view.state.selection.constructor.create(e.view.state.doc,1,e.view.state.doc.content.size-1)))})
  await page.keyboard.press('Backspace');assert.match(await source(),/\[id\]: https:\/\/example.com/)
  await page.keyboard.press('Control+z');await page.waitForTimeout(40);assert.equal(await source(),raw)
 })



 await check('a mapped atom selection can always leave an invisible definition',async()=>{
  const raw='前段\n\n[id]: /ref\n\n后段\n'
  await reset(raw)
  await page.evaluate(async()=>{const {NodeSelection}=await import('/tests/reference-definitions-api.ts');const e=window.f.live();let at;e.view.state.doc.forEach((node,pos)=>{if(node.attrs.kind==='reference')at=pos});e.view.updateState(e.view.state.apply(e.view.state.tr.setSelection(NodeSelection.create(e.view.state.doc,at))));e.view.focus()})
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(()=>window.f.live().view.state.selection.$head.parent.textContent),'后段')
  assert.equal(await source(),raw)
 })
 await check('hidden definition adds no paragraph spacing or placeholder',async()=>{
  const distance=()=>page.locator('.md-prose').evaluate(e=>{const ps=[...e.querySelectorAll(':scope > p')];return ps.at(-1).getBoundingClientRect().top-ps[0].getBoundingClientRect().top})
  await reset('前段\n\n后段\n');const normal=await distance()
  await reset('前段\n\n[id]: /ref\n\n后段\n');assert.equal(await distance(),normal)
 })

 await check('URL edit preserves label spelling indentation optional title and CRLF save bytes',async()=>{
  const raw="[链接][p]\r\n\r\n  [ P ]:\t<https://example.com/old>\r\n    '可选标题'\r\n"
  await reset(raw);await edit()
  await page.getByRole('textbox',{name:'引用目标 URL',exact:true}).fill('https://example.com/new')
  await page.getByRole('button',{name:'完成',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.f.manager.saveSnapshot(window.f.id).text),raw.replace('/old','/new'))
  assert.equal(await page.locator('a[data-reference-label]').getAttribute('title'),'可选标题')
  const saved=await page.evaluate(()=>window.f.manager.saveSnapshot(window.f.id).text)
  fs.writeFileSync(out+'/saved-reference-crlf.md',saved)
  await reset(fs.readFileSync(out+'/saved-reference-crlf.md','utf8'));assert.equal(await page.locator('a[data-reference-label]').getAttribute('data-href'),'https://example.com/new')
 })
 await check('mouse selection and exact source offsets across hidden atoms',async()=>{
  const raw='前段文本\n\n[id]: /ref\n\n后段文本\n'
  await reset(raw)
  const first=await page.locator('.md-prose > p').first().boundingBox(),last=await page.locator('.md-prose > p').last().boundingBox()
  await page.mouse.move(first.x+1,first.y+first.height/2);await page.mouse.down()
  await page.mouse.move(last.x+65,last.y+last.height/2,{steps:12});await page.mouse.up()
  const selected=await page.evaluate(()=>document.getSelection().toString())
  assert.match(selected,/前段文本/);assert.match(selected,/后段文本/);assert.doesNotMatch(selected,/\[id\]/)
  assert.equal(await source(),raw)
  await caret('后段文本')
  assert.equal(await page.evaluate(()=>window.f.live().selection.anchor),raw.indexOf('后段文本'))
  const inverse=await page.evaluate(offset=>{const e=window.f.live();return e.bridge.sourcePosition(e.bridge.documentPosition(offset))},raw.indexOf('后段文本'))
  assert.equal(inverse,raw.indexOf('后段文本'))
 })
 await check('a reference after a list cannot steal arrows inside earlier items',async()=>{
  const raw='- 第一项\n- 第二项\n\n[id]: /ref\n\n尾段\n'
  await reset('- 第一项\n- 第二项\n\n尾段\n');await caret('第一项',true);await page.keyboard.press('ArrowRight');await page.waitForTimeout(50)
  const ordinary=await page.evaluate(()=>({text:window.f.live().view.state.selection.$head.parent.textContent,offset:window.f.live().view.state.selection.$head.parentOffset}))
  await reset(raw);await caret('第一项',true);await page.keyboard.press('ArrowRight');await page.waitForTimeout(50)
  assert.deepEqual(await page.evaluate(()=>({text:window.f.live().view.state.selection.$head.parent.textContent,offset:window.f.live().view.state.selection.$head.parentOffset})),ordinary)
  await caret('第二项',true);await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(()=>window.f.live().view.state.selection.$head.parent.textContent),'尾段')
  assert.equal(await source(),raw)
 })
 await check('image context edits the shared native definition and Ctrl-click still navigates',async()=>{
  const raw='[链接][ref]\n\n![alt][ref]\n\n[ref]: old.md "title"\n'
  await reset(raw);await page.locator('.md-live-image').click({button:'right'})
  await page.getByRole('menuitem',{name:'编辑引用定义',exact:true}).click()
  await page.getByRole('textbox',{name:'引用目标 URL',exact:true}).fill('new.md')
  await page.getByRole('button',{name:'完成',exact:true}).click()
  assert.equal(await source(),raw.replace('old.md','new.md'))
  await page.locator('a[data-reference-label]').click({modifiers:['Control']})
  assert.equal(await page.locator('.md-reference-panel').count(),0)
  assert.equal(await page.locator('.md-source-link').count(),0)
  const requests=await page.evaluate(()=>window.f.requests)
  assert.equal(requests.find(r=>r.kind==='relative')?.href,'new.md')
 })
 await check('footnotes Front Matter TOC and ordinary links retain their reading UI',async()=>{
  await reset('---\ntitle: 文档\ntags: [a, b]\n---\n\n# 标题\n\n[TOC]\n\n普通 [链接](/inline) 和 [引用][id]，脚注[^note]。\n\n[id]: /ref\n\n[^note]: 可阅读注释\n')
  assert.equal(await page.locator('.md-frontmatter-title-input').inputValue(),'文档')
  assert.match(await page.locator('.md-document').innerText(),/可阅读注释/)
  assert.equal(await page.locator('a[data-href="/inline"]').count(),1)
  assert.equal(await page.locator('.md-toc-block').count(),1)
 })
 assert.deepEqual(errors,[])
 fs.writeFileSync(out+'/results.json',JSON.stringify({results,errors},null,2))
 console.log(`REFERENCE DEFINITIONS: ${results.filter(r=>r.passed).length}/${results.length}`)
 if(results.some(r=>!r.passed))process.exitCode=1
 }
}finally{await browser.close();await server.close()}
