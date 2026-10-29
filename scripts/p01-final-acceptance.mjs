import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

for(;;){
 const previous=JSON.parse(fs.readFileSync('test-results/p01/interleaved-matrix.json','utf8'))
 assert(previous.steps.every(s=>s.code===undefined||s.code===0),'Interleaved measurement failed; inspect before continuing')
 if(previous.completedAt)break
 await new Promise(resolve=>setTimeout(resolve,5000))
}
const manifest=process.argv.includes('--resume')?JSON.parse(fs.readFileSync('test-results/p01/final-matrix.json','utf8')):{startedAt:new Date().toISOString(),steps:[]}
if(process.argv.includes('--resume')){delete manifest.completedAt;(manifest.resumes||=[]).push(new Date().toISOString())}
const persist=()=>fs.writeFileSync('test-results/p01/final-matrix.json',JSON.stringify(manifest,null,2))
async function run(name,script,args=[],env={}){
 const earlier=manifest.steps.filter(step=>step.name===name),last=earlier.at(-1)
 if(last?.code===0){console.log('REUSE',name);return}
 const attempt=earlier.length+1;if(last)last.supersededBy=attempt
 const log=path.resolve(`test-results/p01/final-${name}${attempt>1?'-attempt'+attempt:''}.log`),fd=fs.openSync(log,'w'),step={name,attempt,script,args,log,startedAt:new Date().toISOString()}
 manifest.steps.push(step);persist();console.log('START',name)
 const child=spawn(process.execPath,[script,...args],{windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,...env}})
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 fs.closeSync(fd);Object.assign(step,{code,completedAt:new Date().toISOString()});persist();assert.equal(code,0,log);console.log('PASS',name)
}
await run('build','scripts/memory-release-build.mjs',['--label=p01-final'])
const measure='scripts/p01-memory-investigation.mjs',base=['--label=p01-final','--raw-cdp','--rounds=3']
await run('isolated',measure,[...base,'--mode=isolated'])
await run('sequence',measure,[...base,'--mode=sequence','--scenes=ordinary,code200,panes,image,markdown-image,pdf,split,mixed240,text2mb'])
await run('exact2mib',measure,[...base,'--mode=isolated','--scenes=text-exact2mib'])
await run('regression','tests/run-suite.mjs',['regression'],{MARKUMO_PHASE042_RELEASE_LABEL:'p01-final'})
await run('bold-input','tests/phase042/bold-input.mjs')
for(const batch of [0,1])await run(`native-lossless-${batch}`,'tests/lossless/native.mjs',['--label=p01-final',`--batch=${batch}`])
await run('vue-types','node_modules/vue-tsc/bin/vue-tsc.js',['--noEmit'])
await run('node-types','node_modules/typescript/bin/tsc',['--noEmit','-p','tsconfig.node.json'])
await run('frontend','node_modules/vite/bin/vite.js',['build'])
const build=JSON.parse(fs.readFileSync('test-results/phase042/build-p01-final.json','utf8'))
const inputs=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','src','src-tauri'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(file=>file&&!file.startsWith('src-tauri/gen/')).sort().map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
assert.equal(createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),build.sourceInputsSha256,'Application source changed after final Release build')
manifest.build=build;manifest.completedAt=new Date().toISOString();persist();console.log('FINAL ACCEPTANCE COMPLETE')
