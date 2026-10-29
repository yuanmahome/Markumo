// Save completed commands, logs and source identity separately from memory data.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const matrices=[]
for(const name of ['matrix','interleaved-matrix','final-matrix','additional-matrix','main-control-matrix']){
 const file=path.resolve('test-results/p01',name+'.json'),matrix=JSON.parse(fs.readFileSync(file,'utf8'))
 assert(matrix.completedAt,`Incomplete ${name}`)
 assert(matrix.steps.filter(step=>!step.supersededBy).every(step=>step.code===0),`Failed ${name}`)
 matrices.push({name,source:{file,sha256:hash(file)},...matrix,steps:matrix.steps.map(step=>({...step,logSha256:hash(step.log)}))})
}
const build=JSON.parse(fs.readFileSync('test-results/phase042/build-p01-final.json','utf8'))
const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim()
assert.equal(git(['branch','--show-current']),'main')
assert.equal(git(['rev-parse','HEAD']),build.commit,'HEAD moved since final Release')
const inputs=git(['ls-files','--cached','--others','--exclude-standard','--','src','src-tauri']).split(/\r?\n/).filter(file=>file&&!file.startsWith('src-tauri/gen/')).sort().map(file=>[file,hash(file)])
assert.equal(createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),build.sourceInputsSha256,'Application sources changed after measured Release')
assert.equal(hash(build.binary),build.sha256,'Measured binary changed')
const rustFile=path.resolve('test-results/p01/rust-validation.json'),rust=JSON.parse(fs.readFileSync(rustFile,'utf8'))
assert(rust.completedAt&&rust.commands.length===2,'Rust checks are not complete')
assert(rust.commands.every(command=>command.code===0),'Rust validation failed')
const final=matrices.find(m=>m.name==='final-matrix'),log=name=>fs.readFileSync(final.steps.find(step=>step.name===name&&step.code===0).log,'utf8')
const artifacts=['p01-memory-investigation-20261028.md','p01-memory-tables-20261028.md','p01-memory-results-20261028.json','p01-memory-diagnostics-20261028.json','p01-memory-growth-raw-20261028.svg','p01-memory-growth-raw-20261028.csv','p01-memory-growth-interleaved-20261028.svg','p01-memory-growth-playwright-20261028.svg'].map(name=>{const file=path.resolve('docs/performance',name);return{file,bytes:fs.statSync(file).size,sha256:hash(file)}})
const output={generatedAt:new Date().toISOString(),branch:'main',head:build.commit,build,sourceInputsMatchMeasuredRelease:true,
 results:{regression:log('regression').match(/SUITE SUMMARY \(regression\): (.+)/)?.[1],ownership:log('regression').match(/OWNERSHIP after: (.+)/)?.[1],losslessBrowser:log('regression').split(/\r?\n/).filter(line=>/LOSSLESS|lossless .*passed/i.test(line)),boldInput:log('bold-input').match(/BOLD INPUT (.+)/)?.[1],nativeLossless:[0,1].map(batch=>log('native-lossless-'+batch).match(/PASS native lossless batch (.+)/)?.[1])},
 matrices,rust:{source:{file:rustFile,sha256:hash(rustFile)},...rust,commands:rust.commands.map(command=>({...command,logSha256:hash(command.log)}))},artifacts,
 notes:['Natural benchmark completion is not a proof of a universal Private Bytes limit.','Superseded/incomplete attempts remain listed and do not supply replacement points.','No push, release or version change was performed by this investigation.']}
const target=path.resolve('docs/performance/p01-validation-20261028.json')
fs.writeFileSync(target,JSON.stringify(output,null,2)+'\n');console.log('SAVED',target)
