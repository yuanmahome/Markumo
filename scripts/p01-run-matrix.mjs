// Sequential orchestration: never overlap Release measurements or compilation.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const arg = name => process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)
const after = arg('after')
if(after){
  console.log('Waiting for initial matrix:',after)
  for(;;){
    const report=JSON.parse(fs.readFileSync(after,'utf8'))
    assert(!report.failure,report.failure)
    if(report.completedAt){assert(report.passed);break}
    await new Promise(resolve=>setTimeout(resolve,5000))
  }
}
fs.mkdirSync('test-results/p01',{recursive:true})
const manifest = process.argv.includes('--resume') ? JSON.parse(fs.readFileSync('test-results/p01/matrix.json','utf8')) : {startedAt:new Date().toISOString(),steps:[]}
if(process.argv.includes('--resume')){delete manifest.completedAt;(manifest.resumes||=[]).push(new Date().toISOString())}
const persist=()=>fs.writeFileSync('test-results/p01/matrix.json',JSON.stringify(manifest,null,2))
async function run(name,script,args=[],env={}){
  const earlier=manifest.steps.filter(s=>s.name===name),last=earlier.at(-1)
  if(last?.code===0){console.log('REUSE',name);return}
  const attempt=earlier.length+1
  if(last)last.supersededBy=attempt
  const log=path.resolve(`test-results/p01/${name}${attempt>1?'-attempt'+attempt:''}.log`),fd=fs.openSync(log,'w')
  const step={name,attempt,script,args,log,startedAt:new Date().toISOString()};manifest.steps.push(step);persist()
  console.log('START',name)
  const child=spawn(process.execPath,[script,...args],{windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,...env}})
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
  fs.closeSync(fd);Object.assign(step,{code,completedAt:new Date().toISOString()});persist()
  assert.equal(code,0,`Failed ${name}: ${log}`);console.log('PASS',name)
}
const measure='scripts/p01-memory-investigation.mjs'
const sequence='ordinary,code200,panes,image,markdown-image,pdf,split,mixed240,text2mb'
await run('v112-isolated',measure,['--label=p01-v112','--mode=isolated','--rounds=3'])
for(const label of ['p01-v111','p01-v112'])await run(`${label}-sequence`,measure,[`--label=${label}`,'--mode=sequence','--rounds=3',`--scenes=${sequence}`])
await run('v112-profile',measure,['--label=p01-v112','--mode=profile','--rounds=1','--scenes=mixed240,pdf,image,split'])
await run('build-fixed','scripts/memory-release-build.mjs',['--label=p01-fixed'])
await run('fixed-isolated',measure,['--label=p01-fixed','--mode=isolated','--rounds=3'])
await run('fixed-sequence',measure,['--label=p01-fixed','--mode=sequence','--rounds=3',`--scenes=${sequence}`])
await run('fixed-profile',measure,['--label=p01-fixed','--mode=profile','--rounds=1','--scenes=mixed240,pdf,image,split'])
await run('regression','tests/run-suite.mjs',['regression'],{MARKUMO_PHASE042_RELEASE_LABEL:'p01-fixed'})
for(const batch of [0,1])await run(`native-lossless-${batch}`,'tests/lossless/native.mjs',['--label=p01-fixed',`--batch=${batch}`])
manifest.completedAt=new Date().toISOString();persist();console.log('MATRIX COMPLETE')
