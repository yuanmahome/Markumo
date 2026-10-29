import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const inputs = process.argv.includes('--all-completed') ? fs.readdirSync('test-results/p01',{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>path.join('test-results/p01',item.name,'results.json')).filter(file=>{
  if(!fs.existsSync(file))return false
  const r=JSON.parse(fs.readFileSync(file,'utf8'))
  return r.completedAt&&r.passed&&!r.failure&&r.profiling===false
}) : process.argv.slice(2)
assert(inputs.length, 'Pass completed results.json paths')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const median = values => { const sorted = [...values].sort((a,b)=>a-b); return sorted.length%2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2 }
const round = n => Number(n.toFixed(3)), mib = n => round(n/1048576)
function medMetrics(rows){
 const result={}
 for(const key of new Set(rows.flatMap(row=>Object.keys(row)))){
  const present=rows.find(row=>row[key]!==undefined)[key],numeric=typeof present==='number'
  // A process role absent in one run contributes zero, not a missing replicate.
  const values=rows.map(row=>row[key]??(numeric?0:{}))
  result[key]=numeric?round(median(values)):medMetrics(values)
 }
 return result
}
const metrics = point => {
  const result = { heapMiB:mib(point.heapUsed), heapCapacityMiB:mib(point.heapTotal), nodes:point.dom.nodes, listeners:point.dom.jsEventListeners, documents:point.dom.documents }
  for(const proc of point.native.processes){
    const key = proc.role === 'Utility' ? `Utility:${proc.subtype}` : proc.role
    const item = result[key] ||= {privateMiB:0,workingMiB:0,count:0,handles:0}
    item.privateMiB+=proc.private/1048576;item.workingMiB+=proc.working/1048576;item.count++;item.handles+=proc.handles
  }
  result.webviewPrivateMiB = mib(point.native.processes.filter(p=>p.role!=='Rust').reduce((sum,p)=>sum+p.private,0))
  result.webviewWorkingMiB = mib(point.native.processes.filter(p=>p.role!=='Rust').reduce((sum,p)=>sum+p.working,0))
  return result
}
function processAudit(samples){
 return samples.map(sample=>({run:sample.run,scene:sample.scene,roles:Object.fromEntries(['Rust','Browser','Renderer','GPU','Utility','crashpad-handler'].map(role=>{
  const identities=point=>point.native.processes.filter(p=>p.role===role).map(p=>`${p.pid}@${p.start}`)
  const initial=identities(sample.points[0]),seen=[...new Set(sample.points.flatMap(identities))]
  let previous=initial;const transitions=[]
  for(const point of sample.points){const current=identities(point),added=current.filter(id=>!previous.includes(id)),removed=previous.filter(id=>!current.includes(id));if(added.length||removed.length)transitions.push({stage:point.stage,workload:point.workload||sample.scene,cycle:point.cycle,plannedMs:point.plannedMs,time:point.time,added,removed});previous=current}
  return[role,{initial,seen,initialPresentAtEveryPoint:sample.points.every(point=>initial.every(id=>identities(point).includes(id))),maxConcurrent:Math.max(...sample.points.map(point=>identities(point).length)),transitions}]
 }))}))
}
const reports = []
for(const input of inputs){
  const bytes = fs.readFileSync(input), r = JSON.parse(bytes)
  assert(r.completedAt && r.passed && !r.failure, `Incomplete/failed input ${input}`)
  assert.equal(r.profiling,false,'Never combine invasive diagnosis with natural acceptance')
  r.transport ||= 'playwright'
  // Early build records used the annotated-tag object's oid as "commit".
  // Preserve that raw evidence and expose the actual commit separately.
  r.build.resolvedCommit = execFileSync('git',['rev-parse',`${r.build.commit}^{commit}`],{encoding:'utf8',windowsHide:true}).trim()
  const groups = new Map()
  const samples = r.samples.map(sample=>{
    const points = sample.points.map(point=>{
      const workload=point.workload || sample.scene
      const key = `${workload}/${point.stage}/${point.cycle ?? point.plannedMs ?? ''}`
      const values=groups.get(key)||[];values.push(metrics(point));groups.set(key,values)
      return {...point,workload}
    })
    return {...sample,points}
  })
  const medians=Object.fromEntries([...groups].map(([key,values])=>[key,{n:values.length,...medMetrics(values)}]))
  reports.push({...r,samples,medians,processAudit:processAudit(samples),evidence:{file:path.resolve(input),sha256:sha(bytes)}})
}
function groupMedians(samples){
 const groups=new Map()
 for(const sample of samples)for(const point of sample.points){const key=`${point.workload||sample.scene}/${point.stage}/${point.cycle??point.plannedMs??''}`,rows=groups.get(key)||[];rows.push(metrics(point));groups.set(key,rows)}
 return Object.fromEntries([...groups].map(([key,rows])=>[key,{n:rows.length,...medMetrics(rows)}]))
}
const cohorts=[]
if(fs.existsSync('test-results/p01/interleaved-matrix.json')){
 const matrix=JSON.parse(fs.readFileSync('test-results/p01/interleaved-matrix.json','utf8')),members=new Map()
 for(const step of matrix.steps.filter(step=>step.code===0&&step.name.startsWith('interleaved-'))){
  const output=fs.readFileSync(step.log,'utf8').match(/COMPLETE (.+)/)?.[1]?.trim();if(!output)continue
  const file=path.resolve(output,'results.json'),report=reports.find(report=>report.evidence.file.toLowerCase()===file.toLowerCase());if(!report)continue
  const key=`${report.label}/${report.transport}`,list=members.get(key)||[];list.push({report,run:Number(step.name.split('-')[1])});members.set(key,list)
 }
 for(const [key,list] of members){
  assert(list.every(item=>item.report.build.sha256===list[0].report.build.sha256&&item.report.runtime===list[0].report.runtime&&JSON.stringify(item.report.display)===JSON.stringify(list[0].report.display)),'Interleaved build/runtime/geometry mismatch')
  const samples=list.flatMap(({report,run})=>report.samples.map(sample=>({...sample,sourceRun:sample.run,run,source:report.evidence})))
  cohorts.push({kind:'Interleaved independent processes',id:key,label:list[0].report.label,transport:list[0].report.transport,build:list[0].report.build,runtime:list[0].report.runtime,display:list[0].report.display,n:list.length,sourceReports:list.map(({report})=>report.evidence),samples,medians:groupMedians(samples)})
 }
}
const acceptance=[]
const reportForStep=(matrix,name)=>{
 const step=matrix.steps.find(step=>step.name===name&&step.code===0)
 assert(step,`Missing successful step ${name}`)
 const matches=[...fs.readFileSync(step.log,'utf8').matchAll(/COMPLETE (.+)/g)]
 const file=path.resolve(matches.at(-1)?.[1]?.trim()||'', 'results.json')
 const report=reports.find(report=>report.evidence.file.toLowerCase()===file.toLowerCase())
 assert(report,`Missing completed report ${name}: ${file}`);return report
}
if(fs.existsSync('test-results/p01/additional-matrix.json')&&JSON.parse(fs.readFileSync('test-results/p01/additional-matrix.json','utf8')).completedAt){
 const additional=JSON.parse(fs.readFileSync('test-results/p01/additional-matrix.json','utf8')),final=JSON.parse(fs.readFileSync('test-results/p01/final-matrix.json','utf8')),interleaved=JSON.parse(fs.readFileSync('test-results/p01/interleaved-matrix.json','utf8'))
 for(const label of ['p01-v111','p01-v112','p01-final']){
  const independent=label==='p01-final'?[reportForStep(final,'isolated')]:[reportForStep(additional,label==='p01-v111'?'raw-v111-remaining':'raw-v112-remaining')]
  if(label==='p01-v112'){
   const control=reportForStep(interleaved,'raw-transport-control')
   independent.push({...control,samples:control.samples.filter(sample=>sample.scene!=='mixed240')})
  }
  const mixed=label==='p01-final'?[]:cohorts.find(cohort=>cohort.label===label&&cohort.transport==='raw-cdp-no-network')?.samples
  assert(mixed,'Missing three-run interleaved cohort')
  const exact=reportForStep(label==='p01-final'?final:interleaved,label==='p01-final'?'exact2mib':'exact2mib-'+label)
  const samples=[...independent.flatMap(report=>report.samples.map(sample=>({...sample,source:report.evidence}))),...mixed,...exact.samples.map(sample=>({...sample,source:exact.evidence}))]
  const medians=groupMedians(samples)
  assert(Object.values(medians).every(value=>value.n===3),`Unexpected acceptance replicate count ${label}`)
  const sourceReports=[...new Map(samples.map(sample=>[sample.source.file,sample.source])).values()]
  for(const source of sourceReports){const report=reports.find(report=>report.evidence.file===source.file);assert(report.build.sha256===independent[0].build.sha256&&report.runtime===independent[0].runtime&&JSON.stringify(report.display)===JSON.stringify(independent[0].display),'Acceptance source mismatch')}
  acceptance.push({kind:'Isolated natural acceptance',label,transport:'raw-cdp-no-network',n:3,build:independent[0].build,runtime:independent[0].runtime,display:independent[0].display,sourceReports,samples,medians})
  const sequence=reportForStep(label==='p01-final'?final:additional,label==='p01-final'?'sequence':'raw-sequence-'+label)
  acceptance.push({kind:'Fixed-order natural sequence',label,transport:sequence.transport,n:3,build:sequence.build,runtime:sequence.runtime,display:sequence.display,sourceReports:[sequence.evidence],samples:sequence.samples,medians:sequence.medians})
 }
 if(fs.existsSync('test-results/p01/main-control-matrix.json')){
  const main=JSON.parse(fs.readFileSync('test-results/p01/main-control-matrix.json','utf8'))
  if(main.completedAt){
   const independent=reportForStep(main,'clean-main-isolated'),exact=reportForStep(main,'clean-main-exact2mib'),sequence=reportForStep(main,'clean-main-sequence')
   const samples=[...independent.samples.map(sample=>({...sample,source:independent.evidence})),...exact.samples.map(sample=>({...sample,source:exact.evidence}))]
   const medians=groupMedians(samples)
   assert(Object.values(medians).every(value=>value.n===3),'Clean main replicate count')
   acceptance.push({kind:'Isolated natural acceptance',label:independent.label,transport:independent.transport,n:3,build:independent.build,runtime:independent.runtime,display:independent.display,sourceReports:[independent.evidence,exact.evidence],samples,medians})
   acceptance.push({kind:'Fixed-order natural sequence',label:sequence.label,transport:sequence.transport,n:3,build:sequence.build,runtime:sequence.runtime,display:sequence.display,sourceReports:[sequence.evidence],samples:sequence.samples,medians:sequence.medians})
  }
 }
}
if(acceptance.length){
 const reference=acceptance[0]
 assert(acceptance.every(item=>item.runtime===reference.runtime&&JSON.stringify(item.display)===JSON.stringify(reference.display)),'Cross-version runtime/window mismatch')
 const selected=new Set(acceptance.flatMap(item=>item.sourceReports.map(source=>source.file)))
 const sources=reports.filter(report=>selected.has(report.evidence.file)),environment=sources[0]
 assert(sources.every(report=>JSON.stringify(report.os)===JSON.stringify(environment.os)&&JSON.stringify(report.hardware)===JSON.stringify(environment.hardware)),'Cross-version OS/hardware mismatch')
 for(const name of Object.keys(environment.fixtures))if(sources.every(report=>report.fixtures[name]))assert(sources.every(report=>report.fixtures[name].sha256===environment.fixtures[name].sha256),'Cross-version fixture changed: '+name)
}
const latencyControl=[]
if(fs.existsSync('test-results/p01/latency-matrix.json')){
 const matrix=JSON.parse(fs.readFileSync('test-results/p01/latency-matrix.json','utf8'))
 if(matrix.completedAt)for(const label of ['p01-main-before','p01-final']){
  const list=matrix.steps.filter(step=>step.label===label&&step.code===0).map(step=>({pair:step.pair,report:reportForStep(matrix,step.name)}))
  assert.equal(list.length,3,'Latency follow-up requires three pairs')
  assert(list.every(({report})=>report.build.sha256===list[0].report.build.sha256&&report.runtime===list[0].report.runtime&&JSON.stringify(report.display)===JSON.stringify(list[0].report.display)),'Latency source mismatch')
  latencyControl.push({label,build:list[0].report.build,runtime:list[0].report.runtime,display:list[0].report.display,n:3,sourceReports:list.map(({report})=>report.evidence),scenes:Object.fromEntries(['ordinary','image'].map(scene=>{
   const runs=list.map(({pair,report})=>({pair,durationMs:report.samples.find(sample=>sample.scene===scene).operations.find(operation=>operation.scene===scene).durationMs,source:report.evidence}))
   return[scene,{runs,medianMs:median(runs.map(run=>run.durationMs)),minMs:Math.min(...runs.map(run=>run.durationMs)),maxMs:Math.max(...runs.map(run=>run.durationMs))}]
  }))})
 }
}
const destination=path.resolve('docs/performance/p01-memory-results-20261028.json')
fs.writeFileSync(destination,JSON.stringify({generatedAt:new Date().toISOString(),unit:'MiB=1048576 bytes; raw point processes use bytes; Working Set sums include shared pages',reports,cohorts,acceptance,latencyControl})+'\n')
console.log('SAVED',destination)
for(const report of reports){
 console.log(report.label,report.mode)
 for(const [key,value] of Object.entries(report.medians))if(key.includes('/loaded/')||(/cycle-closed/.test(key)&&[30,60,120,240].includes(Number(key.split('/').at(-1)))))console.log(key,value.n,value.webviewPrivateMiB,value.heapMiB,value.Renderer?.privateMiB,value.GPU?.privateMiB)
}
