import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const server=await createServer({server:{host:'127.0.0.1',port:1498,strictPort:true,hmr:false}})
await server.listen()
const browser=await chromium.launch({headless:true})
try {
 const page=await browser.newPage()
 await page.goto('http://127.0.0.1:1498')
 const checks=await page.evaluate(async()=>{
  const {ImportController}=await import('/src/features/document-conversion/ImportController.ts')
  const {ExportController}=await import('/src/features/document-conversion/ExportController.ts')
  const {saveConversionBytes}=await import('/src/features/document-conversion/conversionLease.ts')
  const results=[]
  const check=(condition,label)=>{if(!condition)throw Error(label);results.push(label)}
  const source={token:'source',path:'C:\\selected\\原文.docx'}
  const draft={token:'draft',path:source.path,warnings:[{kind:'math',message:'公式降级'}],stats:{images:1}}
  const target={token:'target',path:'C:\\output\\原文.md'}
  const file={token:'file',path:target.path,name:'原文.md',text:'# Imported',encoding:'UTF-8',bom:false,eol:'LF',version:'new',readOnly:false,kind:'text'}
  let calls=[],documents=[],opens=0,reloads=0,untitled=0,released=[],sourceNull=false,targetNull=false,commitFailure=false,pendingPrepare=null
  const manager={get openedDocuments(){return documents},createUntitled(){untitled++;return 'untitled'},dispatch(){},select(){},openFile(f){opens++;documents.push({id:'saved',path:f.path,fileToken:f.token,dirty:false});return 'saved'},reloadFile(){reloads++;return true}}
  window.isTauri=true; window.__TAURI_INTERNALS__={invoke:async(command,args,options)=>{
   calls.push([command,args,options])
   if(command==='import_open_dialog')return sourceNull?null:source
   if(command==='prepare_docx_import'){if(args.sourceToken!=='source')throw Error('wrong source authorization');if(pendingPrepare)await pendingPrepare;return draft}
   if(command==='export_save_dialog')return targetNull?null:target
   if(command==='commit_docx_import'){if(args.draftToken!=='draft'||args.targetToken!=='target')throw Error('wrong commit authorization');if(commitFailure)throw Error('simulated conflict');return {path:target.path,file,warnings:draft.warnings,stats:draft.stats}}
   if(command==='release_conversion_lease')return
   if(command==='release_file'){released.push(args.token);return}
   if(command==='save_conversion_bytes')return
   throw Error('unexpected IPC '+command)
  }}
  const notices=[];let controller=new ImportController(manager,s=>notices.push(s))
  check(await controller.importDocument('docx')===target.path,'import returns saved path')
  check(opens===1&&untitled===0&&documents.length===1,'opens real file once without untitled copy')
  check(calls.findIndex(c=>c[0]==='prepare_docx_import')<calls.findIndex(c=>c[0]==='export_save_dialog'),'parse completes before save dialog')
  check(controller.result.value.warnings[0].kind==='math','structured diagnostics reach frontend')
  await controller.importDocument('docx');check(opens===1&&reloads===1,'repeat import reuses and refreshes existing clean tab')
  documents[0].dirty=true;calls=[];let rejected=false;try{await controller.importDocument('docx')}catch{rejected=true}
  check(rejected&&!calls.some(c=>c[0]==='commit_docx_import'),'dirty target prevents commit')
  documents=[];targetNull=true;calls=[];check(await controller.importDocument('docx')===null&&!calls.some(c=>c[0]==='commit_docx_import'),'save cancellation never writes a partial import');targetNull=false
  sourceNull=true;calls=[];check(await controller.importDocument('docx')===null&&!calls.some(c=>c[0]==='prepare_docx_import'),'source cancellation does not parse');sourceNull=false
  commitFailure=true;rejected=false;try{await controller.importDocument('docx')}catch{rejected=true}check(rejected&&!controller.progress.value,'failed commit recovers UI');commitFailure=false
  let finish;pendingPrepare=new Promise(resolve=>finish=resolve);const task=controller.importDocument('docx');await new Promise(resolve=>setTimeout(resolve,20));check(controller.cancelImport(),'parse is cancellable');finish();await task;pendingPrepare=null;check(!controller.progress.value,'cancel releases progress')
  calls=[];const bytes=new Uint8Array([137,80,78,71]);await saveConversionBytes(target,'png',bytes);const binary=calls.find(c=>c[0]==='save_conversion_bytes');check(binary[1]===bytes&&binary[2].headers['x-markumo-conversion-token']==='target','binary save uses raw bytes and native token headers')
  delete window.__TAURI_INTERNALS__; delete window.isTauri
  let dispatched='';const htmlManager={createUntitled(){return 'html'},dispatch(_id,tr){dispatched=tr.changes.insert},select(){}}
  const {importHtmlToMarkdown}=await import('/src/features/document-conversion/HtmlImporter.ts')
  const html=importHtmlToMarkdown('<h1>中文</h1><p><b>bold</b> 😀</p><script>alert(1)</script><table><tr><th>A</th></tr><tr><td>B</td></tr></table>')
  check(html.markdown.includes('# 中文')&&html.markdown.includes('**bold**')&&!html.markdown.includes('alert(1)'),'HTML keeps built-in semantic and sanitization pipeline')
  const exp=new ExportController({activeDocument:{name:'x.md',kind:'text',mode:'live'},getText(){return '# 中文 😀'},getMarkdownTypography(){return {}}},()=>{})
  // A cancelled task is also allowed to retry immediately, with no retained lease.
  window.isTauri=true; window.__TAURI_INTERNALS__={invoke:async(command)=>command==='export_save_dialog'?null:undefined}
  check(await exp.exportDocument('html')===null&&!exp.progress.value,'export dialog cancellation recovers UI')
  delete window.__TAURI_INTERNALS__; delete window.isTauri
  const {generateDocx}=await import('/src/features/document-conversion/docxWorkerClient.ts')
  const {parseControlledImageHtml}=await import('/src/editor/markdown/wysiwyg/imageHtml.ts')
  const {parseMarkdown}=await import('/src/editor/markdown/wysiwyg/MarkdownParser.ts')
  const {markdownSerializer}=await import('/src/editor/markdown/wysiwyg/MarkdownSerializer.ts')
  const imageHtml='<img src="asset/a.png" alt="中文 &amp; image" width="120" height="60">'
  const parsed=parseMarkdown(imageHtml).doc
  check(parsed.firstChild.firstChild.type.name==='image'&&parsed.firstChild.firstChild.attrs.height==='60'&&markdownSerializer.serialize(parsed).includes(imageHtml),'sized imported image remains editable and keeps original HTML')
  check(!parseControlledImageHtml('<img src="a" height="0">')&&!parseControlledImageHtml('<img src="a" height="60" onerror="alert(1)">'),'height support retains strict image attribute validation')
  const canvas=document.createElement('canvas');canvas.width=20;canvas.height=10
  const data=new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer())
  const paths=[]
  const word=await generateDocx('前 '+imageHtml+' 后\n\n<img src="asset/b.png" width="90" height="30">',{resolveImage:async source=>{paths.push(source);return {data,alt:'image',width:20,height:10}}})
  const packageText=new TextDecoder().decode(word.bytes)
  check(word.stats.images===2&&paths.join(',')==='asset/a.png,asset/b.png','inline and standalone imported images survive second Word export')
  check(packageText.includes('cx="1143000" cy="571500"')&&packageText.includes('cx="857250" cy="285750"')&&packageText.includes('descr="中文 &amp; image"'),'Word image extent and alternative text match source dimensions')
  return results
 })
 fs.mkdirSync('test-results/native-docx',{recursive:true})
 fs.writeFileSync('test-results/native-docx/frontend-checks.json',JSON.stringify(checks,null,2))
 console.log(`PASS native conversion: ${checks.length} interaction checks\n${checks.join('\n')}`)
}finally{await browser.close();await server.close()}
