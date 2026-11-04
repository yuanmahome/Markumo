// Production bundling matters: a Vite dev server does not use CSS preload links.
// Diagnostic GC is confined to this disposable Windows Release test process.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)||process.env.MARKUMO_PHASE042_RELEASE_LABEL||'p01-fixed'
assert.equal(process.platform,'win32')
assert(/^[\w-]+$/.test(label))
const child=spawn(process.execPath,['scripts/p01-memory-investigation.mjs',`--label=${label}`,'--mode=profile','--rounds=1','--scenes=ordinary,math-images,split,pdf,image','--assert-released'],{stdio:['ignore','pipe','inherit'],windowsHide:true})
let output=''
child.stdout.on('data',chunk=>{output+=chunk;process.stdout.write(chunk)})
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
assert.equal(code,0,'Release retention profiling failed')
const directory=[...output.matchAll(/COMPLETE (.+)/g)].at(-1)?.[1]?.trim()
assert(directory,'Missing completed retention evidence')
const report=JSON.parse(fs.readFileSync(path.join(directory,'results.json'),'utf8'))
for(const sample of report.samples){
 const file=sample.snapshots.find(snapshot=>snapshot.tag.startsWith('closed-')).file
 const heap=JSON.parse(fs.readFileSync(file,'utf8')),fields=heap.snapshot.meta.node_fields,step=fields.length
 const type=fields.indexOf('type'),name=fields.indexOf('name'),detached=fields.indexOf('detachedness'),types=heap.snapshot.meta.node_types[type]
 assert(type>=0&&name>=0&&detached>=0,'Snapshot lacks native detached-node metadata')
 let retained=0
 for(let i=0;i<heap.nodes.length;i+=step)if(types[heap.nodes[i+type]]==='native'&&heap.nodes[i+detached]===2&&/class="[^\"]*\b(md-code-copy|md-diagram)\b/.test(heap.strings[heap.nodes[i+name]]))retained++
 assert.equal(retained,0,`Sanitizer retained closed preview DOM: ${sample.scene}`)
}
console.log('PASS production CSS preload releases editor/document/media panes; sanitizers release removed preview DOM')
