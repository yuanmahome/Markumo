import fs from 'node:fs'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const read=file=>({file,data:JSON.parse(fs.readFileSync(file)),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')})
const before=read('test-results/lossless/browser-before.json'),after=read('test-results/lossless/browser-after.json')
assert.deepEqual(before.data.errors,[]);assert.deepEqual(after.data.errors,[])
assert(after.data.results.every(r=>r.ok));assert.equal(after.data.results.length,before.data.results.length)
const nativeBefore=[0,1].map(i=>read(`test-results/lossless/native-p0-before-${i}/results.json`))
const nativeAfter=[0,1].map(i=>read(`test-results/lossless/native-p0-final-${i}/results.json`))
for(const r of [...nativeBefore,...nativeAfter])assert.deepEqual(r.data.errors,[])
const noops=reports=>reports.flatMap(r=>r.data.results).filter(r=>r.kind==='no-op/save/reopen')
const a=noops(nativeBefore),b=noops(nativeAfter)
assert.equal(a.length,29);assert.equal(b.length,29)
for(const item of a){const match=b.find(r=>r.name===item.name);assert(match);assert.equal(match.sha256,item.sha256,item.name);assert.equal(match.bytes,item.bytes)}
const summary=r=>({file:r.file,sha256:r.sha256,passed:r.data.results.filter(x=>x.ok).length,total:r.data.results.length,failures:r.data.results.filter(x=>!x.ok).map(x=>x.name),parseInput:r.data.results.find(x=>x.name.startsWith('source mutation'))})
fs.writeFileSync('docs/performance/p0-lossless-results-20261028.json',JSON.stringify({generatedAt:new Date().toISOString(),browser:{before:summary(before),after:summary(after)},native:{before:nativeBefore.map(r=>({file:r.file,sha256:r.sha256,results:r.data.results})),after:nativeAfter.map(r=>({file:r.file,sha256:r.sha256,results:r.data.results}))}},null,2)+'\n')
console.log(`Verified ${after.data.results.length} browser checks and all 29 baseline/final disk hashes; native localized/heading/history/conflict records included`)
