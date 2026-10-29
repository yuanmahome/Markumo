// Native-only laboratory; these are NOT WebView/Tauri application numbers.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createInterface} from 'node:readline'
import {createHash} from 'node:crypto'
const root=path.resolve('test-results/p03'),binary=path.resolve('src-tauri/target/release/examples/segmented-lab.exe'),out=path.join(root,`prototype-${Date.now()}`),exec=promisify(execFile)
fs.mkdirSync(out,{recursive:true})
const sha=b=>createHash('sha256').update(b).digest('hex'),report={binary,sha256:sha(fs.readFileSync(binary)),kind:'native Rust prototype only; no WebView',os:os.version(),cpu:os.cpus()[0].model,startedAt:new Date().toISOString(),samples:[]}
await exec('icacls',[binary,'/setintegritylevel','M'],{windowsHide:true});report.integrity='Medium mandatory label'
report.sourceInputsSha256=sha(Buffer.from(JSON.stringify(['src-tauri/Cargo.toml','src-tauri/examples/segmented-lab.rs',...fs.readdirSync('src-tauri/src/text_document').filter(n=>n.endsWith('.rs')).sort().map(n=>'src-tauri/src/text_document/'+n)].map(file=>[file,sha(fs.readFileSync(file))]))))
const persist=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2))
for(let run=1;run<=3;run++)for(const size of ['1kb','100kb','1mb','4mb','16mb','50mb','100mb']){
 const source=path.join(root,'fixtures',`${size}.txt`),workspace=path.join(out,`${run}-${size}`);fs.mkdirSync(workspace)
 const child=spawn(binary,[],{windowsHide:true,stdio:'pipe'}),responses=[],lines=createInterface({input:child.stdout});let waiter
 lines.on('line',line=>{const value=JSON.parse(line);if(waiter){const w=waiter;waiter=null;w(value)}else responses.push(value)})
 let stderr='';child.stderr.on('data',b=>stderr+=b)
 async function request(data){let onError;const response=new Promise((resolve,reject)=>{if(responses.length)return resolve(responses.shift());waiter=resolve;onError=reject;child.once('error',onError)});child.stdin.write(JSON.stringify(data)+'\n');const timer=setTimeout(()=>child.kill(),60000);try{const result=await response;assert(result.ok,result.error);return result}finally{clearTimeout(timer);if(onError)child.removeListener('error',onError)}}
 const row={run,size,source,bytes:fs.statSync(source).size,sourceSha256:sha(fs.readFileSync(source)),pid:child.pid,stages:[]};report.samples.push(row)
 let revision=0
 async function stage(name,data){const result=await request(data);if(result.value?.revision!==undefined)revision=result.value.revision;const native=JSON.parse((await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/p01-process-tree.ps1'),'-RootPid',String(child.pid)],{windowsHide:true})).stdout);row.stages.push({name,ms:result.ms,value:typeof result.value?.text==='string'?{...result.value,text:undefined,windowChars:result.value.text.length}:result.value,native});persist();return result}
 try{
  await stage('open',{command:'open',path:source,workspace})
  await stage('window',{command:'window',revision,start:Math.floor(row.bytes/2),budget:65536})
  await stage('edit',{command:'edit',revision,edits:[{from:Math.floor(row.bytes/2),to:Math.floor(row.bytes/2),insert:'中😀\r\n'}]})
  const found=await stage('search',{command:'search',revision,query:'中😀',limit:16});assert.equal(found.value.count,1)
  await stage('undo',{command:'undo',revision});await stage('redo',{command:'redo',revision})
  const target=path.join(workspace,'saved.txt');await stage('saveCopy',{command:'saveCopy',revision,path:target});assert.equal(fs.statSync(target).size,row.bytes+9)
  await stage('replace',{command:'replace',revision,query:'中😀',replacement:'replaced'})
  await stage('checkpoint',{command:'checkpoint',revision})
  const directory=row.stages.at(-1).value.directory;await stage('close',{command:'close'})
  await stage('restore',{command:'restore',directory})
  await stage('discard',{command:'close',discard:true});row.passed=true
 }catch(e){row.error=String(e);row.stderr=stderr;persist();throw e}finally{child.stdin.end();lines.close();child.kill()}
 console.log(run,size,'PASS')
}
report.completedAt=new Date().toISOString();persist();console.log(path.join(out,'results.json'))
