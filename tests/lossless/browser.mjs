import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { corpus, eolVariants } from './corpus.mjs'

const baseline = process.argv.includes('--baseline')
const label = baseline ? 'before' : 'after'
const server = await createServer({ server: { host:'127.0.0.1', port:1501, strictPort:true, hmr:false, watch:null }, cacheDir:'node_modules/.vite-lossless' })
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
  const localized=[
    ['paragraph insert',complex,'LOCAL_EDIT_TARGET','LOCAL_EDIT_TARGET 新增中文😀'],
    ['paragraph delete',complex,'LOCAL_EDIT_TARGET','LOCAL_EDIT'],
    ['nested list text',complex,'NESTED_EDIT_TARGET','NESTED_EDIT_TARGET 新增'],
    ['nested quote text',complex,'QUOTE_EDIT_TARGET','QUOTE_EDIT_TARGET 新增'],
    ['table cell',complex,'CELL_EDIT_TARGET','CELL_EDIT_TARGET 新增'],
    ['code fence',complex,'CODE_EDIT_TARGET','CODE_EDIT_TARGET 新增'],
    ['unclosed fence',corpus.find(c=>c.name==='unclosed-fence').source,'print','print_new'],
    ['entity prefix','alpha &amp; beta __bold__ and é 😀\n\nEND_SENTINEL\n','alpha & beta ','alpha & beta 新增'],
    ['escaped prefix','alpha \\* beta __bold__\n\nEND_SENTINEL\n','alpha * beta ','alpha * beta 新增'],
    ['repeated text','same __same__ same\n\nEND_SENTINEL\n','same','same changed'],
  ]
  for(const [name,source,needle,insert] of localized) await check('localized '+name,async()=>{
    const output=await page.evaluate(({source,needle,insert})=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc})
      let at=-1;b.doc.descendants((node,pos)=>{if(at<0&&node.isText&&node.text.includes(needle))at=pos+node.text.indexOf(needle)})
      if(at<0)throw Error('Missing target '+needle)
      const prepared=b.prepare(state.tr.insertText(insert,at,at+needle.length).doc);prepared.commit();return b.source
    },{source,needle,insert})
    const rawNeedle=name==='entity prefix'?'alpha &amp; beta ':name==='escaped prefix'?'alpha \\* beta ':needle
    const rawInsert=name==='entity prefix'?'alpha &amp; beta 新增':name==='escaped prefix'?'alpha \\* beta 新增':insert
    const expected=source.replace(rawNeedle,rawInsert)
    assert.equal(output,expected);return{sha256:sha(output)}
  })
  await check('localized ATX marker only',async()=>{
    const output=await page.evaluate(source=>{
      const b=new window.lossless.MarkdownSourceBridge(source),state=window.lossless.EditorState.create({doc:b.doc})
      let target;b.doc.forEach((node,pos)=>{if(node.type.name==='heading'&&node.attrs.level===2)target={node,pos}})
      return b.prepare(state.tr.setNodeMarkup(target.pos,undefined,{...target.node.attrs,level:3}).doc).source
    },complex)
    assert.equal(output,complex.replace('##   ATX 标题  ##','###   ATX 标题  ##'))
  })
  await check('source mutation/undo/redo and multi-pane canonical ownership',async()=>{
    await page.evaluate(source=>window.f.reset(source),complex)
    await page.waitForFunction(()=>window.f.ready())
    await page.evaluate(()=>window.f.split())
    const metrics=await page.evaluate(async()=>{
      const m=window.f.manager,id=window.f.id,original=m.getText(id),at=original.indexOf('LOCAL_EDIT_TARGET')
      const samples=[],parse=window.lossless.tokenizer.parse;let chars=0,calls=0
      window.lossless.tokenizer.parse=function(text,...args){chars+=text.length;calls++;return parse.call(this,text,...args)}
      try{
        for(let i=0;i<30;i++){const start=performance.now();m.dispatch(id,{changes:{from:at,insert:'中'}});samples.push(performance.now()-start)}
        const expected='中'.repeat(30)+original.slice(at)
        if(m.getText(id).slice(at)!==expected)throw Error('Cross-pane source differs')
        for(const live of m.liveViews.values())if(live.editor.bridge.source!==m.getText(id))throw Error('Live source mismatch')
        m.command('undo');if(m.getText(id)!==original)throw Error('Undo did not restore original')
        m.command('redo');if(m.getText(id).slice(at)!==expected)throw Error('Redo differs')
        return{chars,calls,samples}
      }finally{window.lossless.tokenizer.parse=parse}
    })
    return metrics
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
