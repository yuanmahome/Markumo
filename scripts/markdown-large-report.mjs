import fs from 'node:fs'
import path from 'node:path'
import {gzipSync} from 'node:zlib'
const root='docs/performance/markdown-large-20261109'
fs.mkdirSync(root,{recursive:true})
const before=JSON.parse(fs.readFileSync('test-results/markdown-large/native-md-before-950k.json'))
const after=JSON.parse(fs.readFileSync('test-results/markdown-large/native-md-verified-950k-100kb-500kb-1024kb-2048kb-5120kb-10240kb.json'))
if(!after.completedAt||after.samples.length!==21||after.samples.some(s=>s.failure||!s.passed))throw Error('Native acceptance matrix incomplete or failed')
for(const [name,value] of Object.entries({before,after,fixtures:JSON.parse(fs.readFileSync('test-results/markdown-large/fixtures.json')),liveFailure:JSON.parse(fs.readFileSync('test-results/markdown-large/native-md-before-live-unresponsive.json'))}))fs.writeFileSync(path.join(root,`${name}.json.gz`),gzipSync(JSON.stringify(value)))
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1]
const stats=(samples,key)=>({p50:quantile(samples.map(s=>s[key]),.5),p95:quantile(samples.map(s=>s[key]),.95)})
const total=(s,stage)=>s[stage].native.processes.reduce((n,p)=>n+p.private,0)/1048576
const summary={before:{split:stats(before.samples,'splitReadableMs'),privateP50:quantile(before.samples.map(s=>total(s,'split')),.5)},after:{},hardware:after.hardware,runtime:after.runtime,sourceInputsSha256:after.build.sourceInputsSha256,installedBinarySha256:after.build.sha256}
for(const scene of ['950k','100kb','500kb','1024kb','2048kb','5120kb','10240kb']){const samples=after.samples.filter(s=>s.scene===scene);summary.after[scene]={sourceDom:stats(samples,'sourceReadableEditableMs'),splitReadable:stats(samples,'splitReadableMs'),indexed:stats(samples,'splitIndexedMs'),endJump:stats(samples,'endJumpMs'),loadedPrivateP50:quantile(samples.map(s=>total(s,'split')),.5),closedPrivateP50:quantile(samples.map(s=>total(s,'closed')),.5),heapP50:quantile(samples.map(s=>s.split.js.usedSize),.5)/1048576,connectedDOM:samples.map(s=>s.split.connected.nodes),closedWorkers:samples.map(s=>s.closed.connected.workers.live),scrollFrameP50:quantile(samples.flatMap(s=>s.scrolling),.5),scrollFrameP95:quantile(samples.flatMap(s=>s.scrolling),.95)}}
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2))
const f=n=>n.toFixed(1)
const table=Object.entries(summary.after).map(([scene,s])=>`| ${scene} | ${f(s.splitReadable.p50)} / ${f(s.splitReadable.p95)} | ${f(s.indexed.p50)} | ${f(s.endJump.p50)} | ${f(s.loadedPrivateP50)} | ${s.connectedDOM.join(' / ')} |`).join('\n')
fs.writeFileSync(path.join(root,'native-table.md'),`| 样本 | 双栏首屏 P50 / P95 ms | 索引完成 P50 ms | 尾部跳转 P50 ms | loaded Private P50 MiB | 连接 DOM 三轮 |\n|---|---:|---:|---:|---:|---|\n${table}\n`)
console.log(JSON.stringify(summary,null,2))
