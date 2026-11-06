import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host:'127.0.0.1', port:1529, strictPort:true, hmr:false, watch:null }, cacheDir:'node_modules/.vite-table-roundtrip' })
await server.listen()
const browser = await chromium.launch({ headless:true })
const page = await browser.newPage()
const errors=[]
page.on('pageerror', e=>errors.push(e.message))
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'markumo-tables-'))
const table='| 对比 | 内容 |\n| :--- | ---: |\n| 中文 | [链接](https://example.com) **加粗** `代码` a\\|b |'
async function reset(source){
  await page.evaluate(source=>window.f.reset(source),source)
  await page.waitForFunction(()=>window.f.ready())
}
async function source(){return page.evaluate(()=>window.f.manager.getText(window.f.id))}
async function verify(count=1){
  const result=await page.evaluate(async()=>{
    const {parseMarkdown,tokenizer}=await import('/src/editor/markdown/wysiwyg/MarkdownParser.ts')
    const {sameTables}=await import('/src/editor/markdown/wysiwyg/MarkdownSerializer.ts')
    const f=window.f,text=f.manager.getText(f.id),parsed=parseMarkdown(text).doc
    return {tokens:tokenizer.parse(text,{}).filter(t=>t.type==='table_open').length,
      same:sameTables(f.live().view.state.doc,parsed),
      cells:[...f.live().view.dom.querySelectorAll('th,td')].map(c=>c.textContent),
      nodes:(()=>{let n=0;parsed.descendants(c=>{if(c.type.name==='table')n++});return n})(),notices:f.notices}
  })
  assert.equal(result.tokens,count)
  assert.equal(result.nodes,count)
  assert.equal(result.same,true,JSON.stringify(result))
  assert.deepEqual(result.notices,[])
  assert.equal(await page.locator('.md-prose table').count(),count)
  await page.evaluate(()=>window.f.mode('split'))
  await page.waitForFunction(n=>document.querySelectorAll('[data-preview] table').length===n,count)
  assert.deepEqual(await page.locator('[data-preview] th,[data-preview] td').allTextContents(),result.cells)
  await page.evaluate(()=>window.f.mode('live'))
  await page.waitForFunction(()=>window.f.ready())
}
async function selectCell(){await page.evaluate(()=>{
  const v=window.f.live().view,cell=v.dom.querySelector('tr:nth-child(2) td p')
  const pos=v.posAtDOM(cell,0)
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(pos))))
  v.focus()
})}
try{
  await page.goto('http://127.0.0.1:1529/tests/markdown-links/fixture.html')
  await page.waitForFunction(()=>!!window.f)
  const baseline=await page.evaluate(async table=>{
    const {parseMarkdown}=await import('/src/editor/markdown/wysiwyg/MarkdownParser.ts')
    const {markdownSerializer,serializeTable,sameTables}=await import('/src/editor/markdown/wysiwyg/MarkdownSerializer.ts')
    const doc=parseMarkdown('- 列表\n\n'+table.split('\n').map(l=>'  '+l).join('\n')).doc
    const legacy=new markdownSerializer.constructor({...markdownSerializer.nodes,table(state,node){state.write(serializeTable(node));state.closeBlock(node)}},markdownSerializer.marks)
    const broken=legacy.serialize(doc),fixed=markdownSerializer.serialize(doc)
    return {broken,fixed,old:sameTables(doc,parseMarkdown(broken).doc),current:sameTables(doc,parseMarkdown(fixed).doc)}
  },table)
  assert.equal(baseline.old,false);assert.equal(baseline.current,true)
  console.log('PASS reproduces legacy multiline serializer failure and proves fixed round trip')
  const fixtures=[table,`- 列表\n\n${table}`,`- 条目\n\n${table.split('\n').map(l=>'  '+l).join('\n')}\n\n  后文`,
    `- 父项\n  - 子项\n\n${table.split('\n').map(l=>'    '+l).join('\n')}\n\n    后文`,
    table.split('\n').map(l=>'> '+l).join('\n'),`前文\n\n${table}\n\n后文`,`前文\n${table}\n后文`,
    table.split('\n').map(l=>l.replace(/^\| | \|$/g,'')).join('\n'),
    `- 条目\n\n${table.split('\n').map(l=>'  '+l).join('\n')}\n\n- 下一项`,
    `1. 条目\n\n${table.split('\n').map(l=>'   '+l).join('\n')}`]
  for(const eol of ['\n','\r\n'])for(const [index,fixture] of fixtures.entries()){
    const original=fixture.replace(/\n/g,eol)
    await reset(original);await verify()
    assert.equal(await source(),fixture)
    // Physical typing into the real editor, then source/token/PM/DOM checks.
    await selectCell();await page.keyboard.insertText('改')
    const edited=await source()
    assert.equal(edited,fixture.replace('中文','改中文'),'Only this cell changes')
    await verify()
    await selectCell();await page.keyboard.press('Control+z');assert.equal(await source(),fixture)
    await page.keyboard.press('Control+y');assert.equal(await source(),edited)
    for(let n=0;n<10;n++){
      await page.evaluate(n=>window.f.mode(n%2?'source':'split'),n)
      await page.evaluate(()=>window.f.mode('live'))
      await page.waitForFunction(()=>window.f.ready())
      assert.equal(await source(),edited)
    }
    // Actual persisted bytes, then reopen through the production manager.
    const file=path.join(temp,`${index}-${eol.length}.md`)
    await fs.writeFile(file,await page.evaluate(()=>window.f.manager.saveSnapshot(window.f.id).text),'utf8')
    const disk=await fs.readFile(file,'utf8');assert.equal(disk,original.replace('中文','改中文'))
    await reset(disk);await verify()
    console.log(`PASS fixture ${index} ${eol.length===1?'LF':'CRLF'} edit/undo/redo/10 switches/disk reopen`)
  }
  const invalid='- 消耗汇总和消耗总览的区别\n  - | 对比 | 消耗汇总 | 消耗总览（任务消耗总览） |\n| --- | --- | --- |\n| 主要用途 | 汇总任务每天的多人消耗 | 综合查看任务的投入和效果 |\n| 重点数据 | 日报消耗、注册、首充 | 预算、KPI、成本 |'
  for(const literal of [invalid,`- 列表\n${table}`,'普通 | 管道\n仍是 | 普通文字']){
    await reset(literal);await verify(0);assert.equal(await source(),literal)
  }
  // New PM tables inserted in nested lists and quotes exercise serialization,
  // rather than only no-op parsing of already valid Markdown.
  for(const container of ['- 父项\n  - 子项 Start','> Start','- Start']){
    await reset(container)
    await page.evaluate(()=>{window.f.caret('Start');window.f.live().insertTable(3,2)})
    await verify()
    console.log('PASS insert table in '+container)
  }
  for(const html of ['', '<table><tr><td align="right">对比</td><td>内容</td></tr><tr><td>中文</td><td><b>加粗</b></td></tr></table>',
    '<!--StartFragment--><table class="MsoTableGrid"><tbody><tr><th>对比</th><th>内容</th></tr><tr><td><p>中文</p></td><td><p>Word</p></td></tr></tbody></table><!--EndFragment-->']){
    await reset('- 条目\n\n  Start')
    await page.evaluate(({table,html})=>{
      window.f.caret('Start')
      const data=new DataTransfer();data.setData('text/plain',table)
      if(html)data.setData('text/html',html)
      window.f.live().view.dom.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))
    },{table,html})
    await verify()
    console.log('PASS '+(html?'HTML':'Markdown')+' paste inside list')
  }
  await reset(`- 条目\n\n${table.split('\n').map(l=>'  '+l).join('\n')}`)
  for(const command of ['addRowAfter','deleteRow','addColumnAfter','deleteColumn']){
    await selectCell()
    await page.evaluate(name=>{
      if(!window.f.tableCommand(name))throw Error(name+' failed')
    },command)
    await verify()
  }
  // Production clipboard copy of a table and native paste event.
  await page.evaluate(()=>{
    const v=window.f.live().view
    window.f.selectTable()
    let copied
    const data=new DataTransfer()
    const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data})
    v.dom.dispatchEvent(event);copied={text:data.getData('text/plain'),html:data.getData('text/html')}
    if(!copied.text.includes('|')||!copied.html.includes('<table'))throw Error('Missing table clipboard representations')
    window.tableCopy=copied
  })
  await reset('Start')
  await page.evaluate(()=>{
    window.f.caret('Start');const data=new DataTransfer()
    data.setData('text/plain',window.tableCopy.text);data.setData('text/html',window.tableCopy.html)
    window.f.live().view.dom.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))
  })
  await verify()
  await reset(table);await verify()
  await page.evaluate(()=>window.f.caret('a|b'))
  await page.keyboard.insertText('|')
  const escaped=await source()
  assert(escaped.includes('\\|a\\|b'),escaped)
  await verify();assert.equal(await source(),escaped)
  // Physical rectangular selection is a supported table drag. Native dragging
  // selected cell contents is deliberately cancelled by the production guard.
  const first=await page.locator('.md-prose th').first().boundingBox()
  const last=await page.locator('.md-prose td').last().boundingBox()
  const beforeDrag=await source()
  await page.mouse.move(first.x+8,first.y+10);await page.mouse.down()
  await page.mouse.move(last.x+last.width-8,last.y+10,{steps:12});await page.mouse.up()
  const prevented=await page.evaluate(()=>{
    const event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()})
    window.f.live().view.dom.querySelector('th').dispatchEvent(event)
    return event.defaultPrevented
  })
  assert.equal(prevented,true);assert.equal(await source(),beforeDrag)
  await verify()
  assert.deepEqual(errors,[])
  console.log('PASS table row/column operations and same-table copy/paste')
}finally{
  await browser.close();await server.close();await fs.rm(temp,{recursive:true,force:true})
}
