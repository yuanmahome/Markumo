import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { corpus, eolVariants } from './corpus.mjs'

const baseline = process.argv.includes('--baseline')
const label = baseline ? 'before' : 'after'
const originals=new Map()
if(baseline){
  const files=execFileSync('git',['diff','--name-only','9389044','--','src'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean)
  const historicalFiles=new Set(execFileSync('git',['ls-tree','-r','--name-only','9389044','--','src'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/))
  for(const file of files)if(historicalFiles.has(file))originals.set(path.resolve(file).replaceAll('\\','/'),execFileSync('git',['show',`9389044:${file}`],{encoding:'utf8',windowsHide:true}))
}
const server = await createServer({ server: { host:'127.0.0.1', port:1501, strictPort:true, hmr:false, watch:null }, cacheDir:'node_modules/.vite-lossless-'+label,
 plugins:baseline?[{name:'lossless-read-only-baseline-overlay',enforce:'pre',load(id){const [file,query]=id.split('?');if(query&&file.endsWith('.vue'))return;return originals.get(file.replaceAll('\\','/'))}}]:[] })
await server.listen()
const browser = await chromium.launch({ headless:true })
const page = await browser.newPage({ viewport:{ width:1280, height:850 } })
const results = [], errors = []
page.on('pageerror', error => errors.push(error.message))
const sha = value => createHash('sha256').update(value).digest('hex')
async function check(name, run) {
  try { const data=await run();results.push({name,ok:true,...data});console.log('PASS',name) }
  catch(error){results.push({name,ok:false,error:String(error)});console.log('FAIL',name,String(error).slice(0,500))}
}
try {
  await page.goto('http://127.0.0.1:1501/tests/markdown-links/fixture.html')
  await page.waitForFunction(()=>!!window.f)
  await page.evaluate(async()=>{
    window.lossless=await import('/tests/lossless/api.ts')
  })
  for(const {name,source} of eolVariants) {
    await check('no-op bridge '+name,async()=>{
      const output=await page.evaluate(source=>{const b=new window.lossless.MarkdownSourceBridge(source);return b.prepare(b.doc).source},source)
      assert.equal(output,source);return{sha256:sha(source)}
    })
    await check('mode cycle '+name,async()=>{
      const normalized=source.replace(/\r\n/g,'\n')
      await page.evaluate(source=>window.f.reset(source),source)
      for(const mode of ['source','split','live','source','live']){
        await page.evaluate(mode=>window.f.mode(mode),mode)
        await page.waitForFunction(()=>window.f.ready())
        assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),normalized)
      }
      assert.equal(await page.evaluate(()=>window.f.manager.metadata(window.f.id).dirty),false)
      return{sha256:sha(normalized)}
    })
  }
  const complex=corpus.find(c=>c.name==='complex').source
  for(const [name,source,needle,rawNeedle]of [
    ['entity','alpha &amp; beta __bold__\n','beta','beta'],
    ['entity atom','alpha &amp; beta\n','&','&amp;'],
    ['escaped','alpha \\* beta\n','beta','beta'],
    ['heading','##   标题 __bold__  ##\n','bold','bold'],
    ['fence','```code\ncode\nsecond\n```\n','second','second'],
    ['indented','    first\n    second\n','second','second'],
    ['nested quote','> > first __bold__\n> > second\n','second','second'],
  ])await check('bidirectional source offset '+name,async()=>{
    const result=await page.evaluate(({source,needle})=>{
      const b=new window.lossless.MarkdownSourceBridge(source);let at
      b.doc.descendants((node,pos)=>{if(at===undefined&&node.isText&&node.text.includes(needle))at=pos+node.text.indexOf(needle)})
      const offset=b.sourcePosition(at)
      return{at,offset,back:b.documentPosition(offset)}
    },{source,needle})
    assert.equal(result.offset,source.indexOf(rawNeedle));assert.equal(result.back,result.at)
  })
  const localized=[
    ['paragraph insert',complex,'LOCAL_EDIT_TARGET','LOCAL_EDIT_TARGET 新增中文😀'],
    ['paragraph delete',complex,'LOCAL_EDIT_TARGET','LOCAL_EDIT'],
    ['nested list text',complex,'NESTED_EDIT_TARGET','NESTED_EDIT_TARGET 新增'],
    ['nested quote text',complex,'QUOTE_EDIT_TARGET','QUOTE_EDIT_TARGET 新增'],
    ['table cell',complex,'CELL_EDIT_TARGET','CELL_EDIT_TARGET 新增'],
    ['code fence',complex,'CODE_EDIT_TARGET','CODE_EDIT_TARGET 新增'],
    ['unclosed fence',corpus.find(c=>c.name==='unclosed-fence').source,'print','print_new'],
    ['nested code',complex,'const nested','const nested_changed'],
    ['indented code',complex,'缩进代码第一行','缩进代码第一行新增'],
    ['entity prefix','alpha &amp; beta __bold__ and é 😀\n\nEND_SENTINEL\n','alpha & beta ','alpha & beta 新增 '],
    ['escaped prefix','alpha \\* beta __bold__\n\nEND_SENTINEL\n','alpha * beta ','alpha * beta 新增 '],
    ['repeated text','same __same__ same\n\nEND_SENTINEL\n','same','same changed'],
    ['inline mark text','prefix __bold__ _italic_ ~~strike~~ `code`\n\nEND_SENTINEL\n','bold','bold 新增'],
    ['literal punctuation','prefix __bold__ tail\n\nEND_SENTINEL\n','tail','tail *literal*'],
    ['intraword underscore','prefix tail\n\nEND_SENTINEL\n','tail','BELOW_IMAGE'],
  ]
  for(const [name,source,needle,insert] of localized) await check('localized '+name,async()=>{
    const output=await page.evaluate(({source,needle,insert})=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc})
      let at=-1;b.doc.descendants((node,pos)=>{if(at<0&&node.isText&&node.text.includes(needle))at=pos+node.text.indexOf(needle)})
      if(at<0)throw Error('Missing target '+needle)
      const prepared=b.prepare(state.tr.insertText(insert,at,at+needle.length).doc);prepared.commit();return b.source
    },{source,needle,insert})
    const rawNeedle=name==='entity prefix'?'alpha &amp; beta ':name==='escaped prefix'?'alpha \\* beta ':needle
    const rawInsert=name==='entity prefix'?'alpha &amp; beta 新增 ':name==='escaped prefix'?'alpha \\* beta 新增 ':name==='literal punctuation'?'tail \\*literal\\*':insert
    const expected=source.replace(rawNeedle,rawInsert)
    assert.equal(output,expected);return{sha256:sha(output)}
  })
  await check('boundary deletion preserves entity and changes only touching emphasis delimiters',async()=>{
    const source='alpha &amp; beta __bold__ tail\n\nEND_SENTINEL\n'
    const output=await page.evaluate(source=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc});let at
      b.doc.descendants((node,pos)=>{if(node.isText&&node.text==='alpha & beta ')at=pos+node.text.length-1})
      return b.prepare(state.tr.delete(at,at+1).doc).source
    },source)
    assert.equal(output,'alpha &amp; beta**bold** tail\n\nEND_SENTINEL\n')
  })
  await check('indented code newline uses existing source indentation',async()=>{
    const source='Before\n\n    first\n    second\n\nEND_SENTINEL\n'
    const output=await page.evaluate(source=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc});let at
      b.doc.descendants((node,pos)=>{if(node.isText&&node.text.includes('first\nsecond'))at=pos+5})
      return b.prepare(state.tr.insertText('\nnew',at).doc).source
    },source)
    assert.equal(output,source.replace('    first\n','    first\n    new\n'))
  })
  await check('localized ATX marker only',async()=>{
    const output=await page.evaluate(source=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc})
      let target;b.doc.forEach((node,pos)=>{if(node.type.name==='heading'&&node.attrs.level===2)target={node,pos}})
      return b.prepare(state.tr.setNodeMarkup(target.pos,undefined,{...target.node.attrs,level:3}).doc).source
    },complex)
    assert.equal(output,complex.replace('##   ATX 标题  ##','###   ATX 标题  ##'))
  })
  await check('heading keyboard command preserves source identity and undo bytes',async()=>{
    await page.evaluate(source=>window.f.reset(source),complex);await page.waitForFunction(()=>window.f.ready())
    await page.evaluate(()=>window.f.caret('ATX 标题'))
    await page.keyboard.press('Control+3')
    const expected=complex.replace('##   ATX 标题  ##','###   ATX 标题  ##')
    assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),expected)
    await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),complex)
    assert.equal(await page.evaluate(()=>window.f.manager.metadata(window.f.id).dirty),false)
    await page.keyboard.press('Control+y');assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),expected)
  })
  await check('heading format command preserves distinct IDs across multiple blocks',async()=>{
    const source='#   First #\n\n##  Second ##\n'
    await page.evaluate(source=>window.f.reset(source),source);await page.waitForFunction(()=>window.f.ready())
    const output=await page.evaluate(()=>{
      const e=window.f.manager.activeLiveEditor,positions=[]
      e.view.state.doc.forEach((node,pos)=>{if(node.type.name==='heading')positions.push({from:pos+1,to:pos+1+node.content.size})})
      e.view.dispatch(e.view.state.tr.setSelection(window.lossless.TextSelection.create(e.view.state.doc,positions[0].from,positions[1].to)))
      e.format('heading-3');return window.f.manager.getText(window.f.id)
    })
    assert.equal(output,'###   First #\n\n###  Second ##\n')
  })
  await check('localized image destination preserves quotes and neighbors',async()=>{
    const output=await page.evaluate(source=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc});let target
      b.doc.descendants((node,pos)=>{if(node.type.name==='image'&&node.attrs.src==='./path%20space/image.png')target={node,pos}})
      return b.prepare(state.tr.setNodeMarkup(target.pos,undefined,{...target.node.attrs,src:'./new%20path/image.png'}).doc).source
    },complex)
    assert.equal(output,complex.replace('./path%20space/image.png','./new%20path/image.png'))
  })
  await check('localized task toggle and Setext level preserve all other source',async()=>{
    const output=await page.evaluate(source=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc});let target
      b.doc.descendants((node,pos)=>{if(node.type.name==='list_item'&&node.attrs.checked===true)target={node,pos}})
      return b.prepare(state.tr.setNodeMarkup(target.pos,undefined,{...target.node.attrs,checked:false}).doc).source
    },complex)
    assert.equal(output,complex.replace('- [X] 完成任务','- [ ] 完成任务'))
    const heading=await page.evaluate(source=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc});let target
      b.doc.forEach((node,pos)=>{if(node.type.name==='heading'&&node.attrs.level===1)target={node,pos}})
      return b.prepare(state.tr.setNodeMarkup(target.pos,undefined,{...target.node.attrs,level:2}).doc).source
    },complex)
    assert.equal(heading,complex.replace('=============','-------------'))
  })
  await check('source mutation/undo/redo and multi-pane canonical ownership',async()=>{
    await page.evaluate(source=>window.f.reset(source),complex)
    await page.waitForFunction(()=>window.f.ready())
    await page.evaluate(()=>window.f.split())
    await page.waitForFunction(()=>window.f.ready()&&window.f.manager.liveViews.size===2)
    const metrics=await page.evaluate(async()=>{
      const m=window.f.manager,id=window.f.id,original=m.getText(id),at=original.indexOf('LOCAL_EDIT_TARGET')
      if(m.liveViews.size!==2)throw Error('Both Live panes must be mounted before measuring')
      const samples=[],parse=window.lossless.tokenizer.parse;let chars=0,calls=0
      window.lossless.tokenizer.parse=function(text,...args){chars+=text.length;calls++;return parse.call(this,text,...args)}
      try{
        for(let i=0;i<30;i++){const start=performance.now();m.dispatch(id,{changes:{from:at,insert:'中'}});samples.push(performance.now()-start)}
        const expected='中'.repeat(30)+original.slice(at)
        if(m.getText(id).slice(at)!==expected)throw Error('Cross-pane source differs')
        for(const live of m.liveViews.values())if(live.editor.bridge.source!==m.getText(id))throw Error('Live source mismatch')
        m.command('undo');if(m.getText(id)!==original||m.metadata(id).dirty)throw Error('Undo did not restore original clean state')
        for(const live of m.liveViews.values())if(live.editor.bridge.source!==original)throw Error('Live Undo source mismatch')
        m.command('redo');if(m.getText(id).slice(at)!==expected||!m.metadata(id).dirty)throw Error('Redo differs')
        for(const live of m.liveViews.values())if(live.editor.bridge.source!==m.getText(id))throw Error('Live Redo source mismatch')
        return{chars,calls,samples,livePanes:m.liveViews.size}
      }finally{window.lossless.tokenizer.parse=parse}
    })
    if(!baseline)assert(metrics.chars<complex.length*15,'ordinary edits must parse a bounded block, not each full pane document')
    return metrics
  })
  await check('mode switching preserves caret across entities and emphasis',async()=>{
    const source='## Heading\n\nalpha &amp; beta __bold__ tail\n'
    await page.evaluate(source=>window.f.reset(source),source);await page.waitForFunction(()=>window.f.ready())
    await page.evaluate(()=>window.f.mode('source'))
    const at=source.indexOf('bold')+2
    await page.evaluate(at=>window.f.manager.dispatch(window.f.id,{selection:{anchor:at}}),at)
    await page.evaluate(()=>window.f.mode('live'));await page.waitForFunction(()=>window.f.ready())
    assert.equal(await page.evaluate(()=>window.f.manager.activeLiveEditor.selection.head),at)
    await page.evaluate(()=>window.f.mode('source'));await page.waitForFunction(()=>window.f.ready())
    assert.equal(await page.evaluate(()=>window.f.manager.activeEditorView.state.selection.main.head),at)
    assert.equal(await page.evaluate(()=>window.f.manager.getText(window.f.id)),source)
    assert.equal(await page.evaluate(()=>window.f.manager.metadata(window.f.id).dirty),false)
  })
  await check('incremental source synchronization equals a full parse at structural boundaries',async()=>{
    await page.evaluate(source=>window.f.reset(source),complex);await page.waitForFunction(()=>window.f.ready())
    const result=await page.evaluate(async()=>{
      const m=window.f.manager,id=window.f.id,original=m.getText(id)
      const normalize=node=>JSON.stringify(node.toJSON(),(key,value)=>key==='sourceId'?undefined:value)
      let count=0
      for(const [needle,insert]of [['LOCAL_EDIT_TARGET','中'],['LOCAL_EDIT_TARGET','*'],['LOCAL_EDIT_TARGET','\n\n## New\n\n'],['[ref]: <https://example.com/a%20b>','[ref]: <https://example.org/new>'],['##   ATX 标题  ##','ordinary paragraph'],['CELL_EDIT_TARGET','CELL_EDIT_TARGET\\| more']]){
        const at=m.getText(id).indexOf(needle),to=at+(needle.startsWith('[ref]')||needle.startsWith('##')||needle.startsWith('CELL')?needle.length:0)
        m.dispatch(id,{changes:{from:at,to,insert}})
        await new Promise(r=>setTimeout(r,5))
        const full=new window.lossless.MarkdownSourceBridge(m.getText(id))
        if(normalize(m.activeLiveEditor.bridge.doc)!==normalize(full.doc))throw Error('Incremental parse differs for '+needle+' / '+insert)
        count++;m.command('undo');if(m.getText(id)!==original)throw Error('Structural differential Undo differs')
      }
      return{cases:count}
    });return result
  })
  await check('seeded edit/history/mode differential',async()=>{
    await page.evaluate(()=>window.f.reset('# Header\n\nLOCAL_EDIT_TARGET\n\n__unchanged__ [link](<a%20b> "title")\n'))
    const output=await page.evaluate(async()=>{
      const m=window.f.manager,id=window.f.id,initial=m.getText(id),states=[initial];let index=0,seed=0x51a7e
      const {isolateHistory}=window.lossless
      const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0}
      for(let i=0;i<120;i++){
        const op=random()%5
        if(op===0&&index>0){m.command('undo');index--}
        else if(op===1&&index<states.length-1){m.command('redo');index++}
        else if(op===2){m.setMarkdownMode(id,['live','source','split'][random()%3]);await new Promise(r=>setTimeout(r,5))}
        else{
          const text=states[index],start=text.indexOf('LOCAL_EDIT_TARGET')+'LOCAL_EDIT_TARGET'.length
          const suffix=text.indexOf('\n',start),at=start+(random()%Math.max(1,suffix-start+1))
          const insert=['中','x','😀','é'][random()%4],to=at<suffix&&random()%3===0?at+1:at
          // Keep UTF-16 pairs atomic in both the independent oracle and change.
          const from=at>start&&/[\uD800-\uDBFF]/.test(text[at-1])?at-1:at
          const end=to<suffix&&to>from&&/[\uD800-\uDBFF]/.test(text[to-1])?to+1:to
          m.dispatch(id,{changes:{from,to:end,insert},annotations:isolateHistory.of('full')})
          states.splice(index+1);states.push(text.slice(0,from)+insert+text.slice(end));index++
        }
        if(m.getText(id)!==states[index])throw Error('Seeded oracle differs '+JSON.stringify({i,op,index,actual:m.getText(id),expected:states[index],composing:m.isComposing,mode:m.getMarkdownMode(id)}))
        if(m.saveSnapshot(id).text!==states[index])throw Error('Save snapshot differs at operation '+i)
      }
      return{operations:120,seed:'0x51a7e'}
    });return output
  })
  fs.mkdirSync('test-results/lossless',{recursive:true})
  fs.writeFileSync(`test-results/lossless/browser-${label}.json`,JSON.stringify({baseline,results,errors},null,2)+'\n')
  const failures=results.filter(result=>!result.ok)
  console.log(`LOSSLESS ${label}: ${results.length-failures.length}/${results.length}, failures=${failures.length}, pageErrors=${errors.length}`)
  if(!baseline){assert.deepEqual(errors,[]);assert.equal(failures.length,0,failures.map(f=>f.name).join('\n'))}
}finally{await browser.close();await server.close()}
