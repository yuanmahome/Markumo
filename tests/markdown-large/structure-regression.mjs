import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
if(!fs.existsSync('test-results/markdown-large/fixtures.json'))execFileSync(process.execPath,['scripts/markdown-large-fixtures.mjs'])
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const server=await createServer({server:{host:'127.0.0.1',port:1555,strictPort:true,hmr:false,watch:null}});await server.listen()
const browser=await chromium.launch({headless:true});const page=await browser.newPage()
try {
 await page.goto('http://127.0.0.1:1555/tests/markdown-large/fixture.html');await page.waitForFunction(()=>window.large)
 const checked=await page.evaluate(()=>{
  const {structureBatches,HeightIndex}=window.large
  const syntax=['```js\n'+('a\n'.repeat(40000))+'```\n\n','> quote\n>\n> continued\n\n','- first\n\n  nested paragraph\n\n  - child\n\n','$$\nx^2\n\ny^2\n$$\n\n','<div>\nraw\n\ntext\n</div>\n\n','| A | B |\n| --- | --- |\n'+('| a | b |\n'.repeat(4000))+'\n']
  for(const structure of syntax){const prefix='# h\n\ntext\n\n'.repeat(100),source=prefix+structure+'# end\n';const groups=structureBatches(source).flatMap(b=>b.groups);let end=0;for(const group of groups){if(group.from!==end)throw Error('gap');end=group.to;if(group.to>prefix.length&&group.to<prefix.length+structure.trimEnd().length)throw Error('unsafe boundary')}if(end!==source.length)throw Error('missing tail')}
  const front='---\n'+('key: value\n\n'.repeat(2000))+'---\n',foot='[^note]: first\n'+('\n    continuation paragraph\n'.repeat(2000))+'\n'
  for(const source of [front+'# end\n',foot+'# end\n']){const groups=structureBatches(source).flatMap(b=>b.groups);const limit=source.indexOf('# end');if(groups.some(g=>g.to>0&&g.to<limit))throw Error('front matter/footnote split')}
  const tree=new HeightIndex();for(let i=1;i<=4096;i++)tree.append(i%31+1);for(let i=0;i<4096;i+=17)tree.update(i,53)
  let sum=0;for(let i=0;i<4096;i++){if(tree.prefix(i)!==sum||tree.at(sum)!==i)throw Error('height index');sum+=tree.heights[i]}
  return syntax.length
 });assert.equal(checked,6)
 const fixtures=JSON.parse(fs.readFileSync('test-results/markdown-large/fixtures.json'))
 for(const name of ['paragraph','fence']){
  const file=fixtures.find(f=>f.name===name)
  await page.evaluate(text=>window.large.set(text),fs.readFileSync(file.file,'utf8'))
  await page.waitForSelector('.preview-local-budget')
  await page.waitForFunction(()=>!document.querySelector('.preview-progress'))
  assert(await page.locator('.preview-local-budget button').count()>0)
  assert((await page.locator('*').count())<1000)
 }
 console.log('PASS safe structure boundaries including front matter and footnotes, Fenwick heights, local oversized paragraph/fence source entry with bounded DOM')
}finally{await browser.close();await server.close()}
