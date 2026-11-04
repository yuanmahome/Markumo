import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
const output=path.resolve('test-results/export-quality');fs.mkdirSync(output,{recursive:true})
const server=await createServer({server:{host:'127.0.0.1',port:1497,strictPort:true,hmr:false},cacheDir:'node_modules/.vite-export-quality'})
await server.listen()
const browser=await chromium.launch({headless:true})
try {
 const page=await browser.newPage({viewport:{width:1100,height:900}})
 await page.goto('http://127.0.0.1:1497')
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=240;const x=c.getContext('2d');x.fillStyle='#e5f3ff';x.fillRect(0,0,600,240);x.fillStyle='#2080d0';x.fillRect(30,30,180,180);x.fillStyle='#142d48';x.font='32px sans-serif';x.fillText('Markumo 示例',240,130);return c.toDataURL().split(',')[1]})
 fs.writeFileSync('examples/05-Media/example.png',Buffer.from(png,'base64'))
 const md=fs.readFileSync('examples/01-Markdown/08-导出验收.md','utf8')
 const tutorial=fs.readFileSync('examples/01-Markdown/03-Mermaid图表.md','utf8')
 const resources=Object.fromEntries(['example.png','example.svg','wide.svg'].map(n=>['../05-Media/'+n,[...fs.readFileSync('examples/05-Media/'+n)]]))
 const result=await page.evaluate(async({md,tutorial,resources})=>{
  const {renderMarkdownForExport}=await import('/src/features/document-conversion/ExportRenderer.ts')
  const {sanitizeHtml}=await import('/src/editor/markdown/html/SafeHtmlRenderer.ts')
  const {buildCompleteHtml}=await import('/src/features/document-conversion/ExportStyles.ts')
  const media=await import('/src/features/document-conversion/ExportMedia.ts')
  const {renderExportMath}=await import('/src/features/document-conversion/ExportMath.ts')
  const {generateDocx}=await import('/src/features/document-conversion/docxWorkerClient.ts')
  const settings=await import('/src/features/shell/editorSettings.ts')
  const fresh=settings.settingsFrom({})
  if(!fresh.wordWrap||!fresh.markdownTypography.codeWrap||!fresh.markdownClipboard.copyAcrossBlocks||fresh.syntaxStyle!=='vivid')throw Error('new defaults')
  const old=settings.settingsFrom({wordWrap:false,markdownTypography:{codeWrap:false},markdownClipboard:{copyAcrossBlocks:false},syntaxStyle:'soft',settingsVersion:6})
  if(old.wordWrap||old.markdownTypography.codeWrap||old.markdownClipboard.copyAcrossBlocks||old.syntaxStyle!=='soft')throw Error('preferences overwritten')
  const rs={loadLocal:async p=>{if(!resources[p])throw Error('missing');return new Uint8Array(resources[p])},allowedRemote:new Set(),identity:()=> 'test'}
  const diagrams=[]
  for(const match of tutorial.matchAll(/```mermaid\n([\s\S]*?)\n```/g)){
   const svg=await media.compileExportDiagram(match[1]);const before=new DOMParser().parseFromString(svg,'text/html'),after=new DOMParser().parseFromString(sanitizeHtml(svg),'text/html')
   const image=await media.renderExportDiagram(match[1])
   diagrams.push({type:match[1].split('\n')[0],before:{style:before.querySelectorAll('style').length,marker:before.querySelectorAll('marker').length},after:{style:after.querySelectorAll('style').length,marker:after.querySelectorAll('marker').length},width:image.width,height:image.height})
  }
  const gallery=await renderMarkdownForExport(tutorial,rs,true,true)
  const galleryWord=await generateDocx(tutorial,{renderDiagram:s=>media.renderExportDiagram(s)})
  if(galleryWord.stats.images!==11||galleryWord.warnings.length)throw Error('diagram gallery')
  const rendered=await renderMarkdownForExport(md,rs,true,true)
  if(new DOMParser().parseFromString(rendered.bodyHtml,'text/html').querySelectorAll('.markumo-diagram-export svg').length!==3)throw Error('missing export SVG')
  if(!rendered.bodyHtml.includes('katex'))throw Error('missing math')
  const malicious=await renderMarkdownForExport('<script>alert(1)</script><img src="x" onerror="alert(1)"><svg onload="alert(1)"></svg>')
  if(/<script|onerror|onload/.test(malicious.bodyHtml))throw Error('unsafe HTML')
  let rejected=false;try{await media.compileExportDiagram('flowchart LR\n A[broken')}catch{rejected=true}if(!rejected)throw Error('invalid Mermaid accepted')
  const word=await generateDocx(md,{title:'导出验收 Export acceptance',linkTargets:{[encodeURI('01-基础语法.md')]:'file:///C:/Examples/01-基础语法.md'},renderDiagram:s=>media.renderExportDiagram(s),renderMath:renderExportMath,resolveImage:s=>media.resolveExportImage(s,rs)})
  const abort=new AbortController();abort.abort();let cancelled=false;try{await generateDocx(md,{signal:abort.signal})}catch{cancelled=true}if(!cancelled)throw Error('cancellation')
  const failure=await generateDocx('![missing](missing.png)\n\n```mermaid\ninvalid!\n```',{renderDiagram:s=>media.renderExportDiagram(s)})
  if(!failure.warnings.some(w=>w.kind==='diagram')||!failure.warnings.some(w=>w.kind==='image'))throw Error('missing diagnostics')
  return {galleryHtml:buildCompleteHtml('Mermaid gallery',gallery.bodyHtml,true),galleryBytes:[...galleryWord.bytes],html:buildCompleteHtml('导出验收',rendered.bodyHtml,true,{paperSize:'A4',orientation:'portrait',margins:'normal',printBackground:true}),bytes:[...word.bytes],warnings:word.warnings,stats:word.stats,diagrams}
 },{md,tutorial,resources})
 fs.writeFileSync(path.join(output,'gallery.html'),result.galleryHtml)
 fs.writeFileSync(path.join(output,'gallery.docx'),Buffer.from(result.galleryBytes))
 fs.writeFileSync(path.join(output,'acceptance.html'),result.html)
 fs.writeFileSync(path.join(output,'acceptance.docx'),Buffer.from(result.bytes))
 const xml=Buffer.from(result.bytes).toString('utf8');assert(xml.includes('<w:br/>'));assert(xml.includes('file:///'));assert.equal(result.stats.images,7)
 assert(!result.warnings.some(w=>['diagram','image','math'].includes(w.kind)),JSON.stringify(result.warnings))
 const preview=await browser.newPage({viewport:{width:1100,height:900}})
 await preview.setContent(result.html,{waitUntil:'load'});await preview.evaluate(()=>document.fonts.ready)
 await preview.screenshot({path:path.join(output,'acceptance.png'),fullPage:true})
 await preview.pdf({path:path.join(output,'acceptance.pdf'),printBackground:true,preferCSSPageSize:true})
 const download = page.waitForEvent('download')
 await page.evaluate(async ({md,resources}) => {
  const {ExportController}=await import('/src/features/document-conversion/ExportController.ts')
  const {defaultConversionSettings}=await import('/src/features/document-conversion/conversionSettings.ts')
  const {defaultMarkdownTypography}=await import('/src/editor/markdown/wysiwyg/contracts.ts')
  let embedded=md
  for(const [source,bytes]of Object.entries(resources)) {
    const {detectMimeType}=await import('/src/editor/markdown/images.ts')
    let binary=''; for(const byte of bytes)binary+=String.fromCharCode(byte)
    embedded=embedded.split(source).join('data:'+detectMimeType(new Uint8Array(bytes))+';base64,'+btoa(binary))
  }
  const controller=new ExportController({getMarkdownTypography:defaultMarkdownTypography},()=>{})
  await controller.exportPng(embedded,{path:'product-export.png',token:''},defaultConversionSettings())
 },{md,resources})
 await (await download).saveAs(path.join(output,'product-export.png'))
 const product=fs.readFileSync(path.join(output,'product-export.png'))
 assert.equal(product.readUInt32BE(16),1720, 'PNG must obey configured width at 2x')

 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({...result,html:undefined,bytes:undefined,galleryHtml:undefined,galleryBytes:undefined},null,2))
 console.log(JSON.stringify({passed:true,stats:result.stats,diagrams:result.diagrams,warnings:result.warnings},null,2))
} finally {await browser.close();await server.close()}
