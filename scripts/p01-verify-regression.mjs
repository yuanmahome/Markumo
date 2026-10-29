// Follow the main matrix with interleaved historical controls when a late GPU
// high-water difference needs separating from version/order effects.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const wait = ms => new Promise(resolve => setTimeout(resolve,ms))
if (process.argv.includes('--after-matrix')) for (;;) {
  const matrix=JSON.parse(fs.readFileSync('test-results/p01/matrix.json','utf8'))
  assert(matrix.steps.filter(s=>!s.supersededBy).every(s=>s.code===undefined||s.code===0),'Main matrix failed; inspect its log before continuing')
  if(matrix.completedAt)break
  await wait(5000)
}
const manifest={startedAt:new Date().toISOString(),steps:[]}
const persist=()=>fs.writeFileSync('test-results/p01/interleaved-matrix.json',JSON.stringify(manifest,null,2))
const transport = process.argv.includes('--raw-cdp') ? ['--raw-cdp'] : []
async function run(name,script,args,executable=process.execPath){
  const log=path.resolve(`test-results/p01/${name}.log`),fd=fs.openSync(log,'w'),step={name,executable,script,args,log,startedAt:new Date().toISOString()}
  manifest.steps.push(step);persist();console.log('START',name)
  const child=spawn(executable,[script,...args],{windowsHide:true,stdio:['ignore',fd,fd]})
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
  fs.closeSync(fd);Object.assign(step,{code,completedAt:new Date().toISOString()});persist();assert.equal(code,0,log);console.log('PASS',name)
}
if(process.argv.includes('--native-symbols'))await run('native-symbols','scripts/p01-native-symbols.py',['test-results/p01/p01-v112-profile-1793188019289/results.json'],path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'))
if(transport.length)await run('raw-transport-control','scripts/p01-memory-investigation.mjs',['--label=p01-v112','--mode=isolated','--rounds=3','--scenes=ordinary,code200,image,mixed240',...transport])
if(transport.length)await run('raw-native-profile','scripts/p01-memory-investigation.mjs',['--label=p01-v112','--mode=profile','--rounds=1','--scenes=mixed240','--native-sampling',...transport])
for(const [ref,label] of [['210d878','p01-pre-io'],['5515036','p01-io']])await run('build-'+label,'scripts/memory-release-build.mjs',[`--ref=${ref}`,`--label=${label}`,'--full-ref'])
const order=['p01-v111','p01-pre-io','p01-io','p01-v112','p01-fixed']
for(let runNumber=1;runNumber<=3;runNumber++)for(const label of runNumber===2?[...order].reverse():order)await run(`interleaved-${runNumber}-${label}`,'scripts/p01-memory-investigation.mjs',[`--label=${label}`,'--mode=isolated','--rounds=1','--scenes=mixed240',...transport])
for(const label of ['p01-v111','p01-v112','p01-fixed'])await run('exact2mib-'+label,'scripts/p01-memory-investigation.mjs',[`--label=${label}`,'--mode=isolated','--rounds=3','--scenes=text-exact2mib',...transport])
manifest.completedAt=new Date().toISOString();persist();console.log('INTERLEAVED COMPLETE')
