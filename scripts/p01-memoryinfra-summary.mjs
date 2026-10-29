import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory=path.resolve(process.argv[2])
assert(fs.statSync(directory).isDirectory())
const hex=value=>typeof value==='string'?Number.parseInt(value,16):value
const summaries=[]
for(const name of fs.readdirSync(directory).filter(n=>n.startsWith('trace-')&&n.endsWith('.json'))){
 const trace=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'))
 // Perfetto JSON export renumbers event ids; CDP dumpGuid is not that id.
 // Use a shared monotonic timestamp in new captures. For older captures,
 // require a unique multi-point wall/trace alignment, and report its residual.
 const events=trace.traceEvents.filter(e=>e.ph==='v'&&e.args?.dumps)
 const times=new Map()
 for(const e of events)times.set(e.id,Math.min(times.get(e.id)??Infinity,e.ts))
 const tags=new Map();let correlation
 if(trace.dumps.every(d=>Number.isFinite(d.cdpTimestamp))){
  const residuals=[]
  for(const [id,ts] of times){const ranked=trace.dumps.map(d=>({d,error:Math.abs(d.cdpTimestamp*1000-ts/1000)})).sort((a,b)=>a.error-b.error);if(ranked[0]?.error<=1000){tags.set(id,ranked[0].d);residuals.push(ranked[0].error)}}
  correlation={method:'CDP Performance.Timestamp vs trace ts',maxResidualMs:Math.max(...residuals)}
 }else{
  let best={matches:[],error:Infinity}
  for(const [,ts] of times)for(const request of trace.dumps){
   const offset=request.time-ts/1000,used=new Set(),matches=[];let error=0
   for(const [id,time] of times){
    const ranked=trace.dumps.filter(d=>!used.has(d)).map(d=>({d,error:Math.abs(d.time-time/1000-offset)})).sort((a,b)=>a.error-b.error)
    if(ranked[0]?.error<=250){used.add(ranked[0].d);matches.push({id,request:ranked[0].d,residualMs:ranked[0].error});error+=ranked[0].error}
   }
   if(matches.length>best.matches.length||(matches.length===best.matches.length&&error<best.error))best={matches,error,offset}
  }
  assert(best.matches.length>=Math.min(3,times.size)&&best.matches.length>=times.size*.75,'Cannot safely align dump timestamps')
  for(const match of best.matches)tags.set(match.id,match.request)
  correlation={method:'multi-point wall/trace interval alignment (legacy capture)',matched:best.matches.length,groups:times.size,maxResidualMs:Math.max(...best.matches.map(m=>m.residualMs)),offsetMs:best.offset}
 }
 correlation.unmatchedRequests=trace.dumps.filter(d=>![...tags.values()].includes(d)).map(d=>d.tag)
 const merged=new Map()
 for(const event of events){
  const dump=event.args.dumps,request=tags.get(event.id),process=request?.processes.processes.find(p=>p.pid===event.pid)
  if(!request)continue
  const key=`${event.id}:${event.pid}`,point=merged.get(key)||{tag:request.tag,pid:event.pid,role:process?.role,subtype:process?.subtype,native:process,ts:event.ts,id:event.id,processTotals:{},allocators:{},eventParts:0}
  Object.assign(point.processTotals,dump.process_totals||{});point.eventParts++
  Object.assign(point.allocators,Object.fromEntries(Object.entries(dump.allocators||{}).map(([key,item])=>[key,Object.fromEntries(Object.entries(item.attrs||{}).map(([key,attr])=>[key,{value:attr.type==='scalar'?hex(attr.value):attr.value,units:attr.units}]))])))
  merged.set(key,point)
 }
 const points=[...merged.values()]
 for(const point of points){
  const allocators=point.allocators
  const categories=Object.fromEntries(Object.entries(allocators).filter(([key])=>!key.includes('/')||/^(v8\/heap|partition_alloc\/partitions\/[^/]+|skia\/[^/]+|gpu\/[^/]+|blink_objects\/[^/]+|blink_gc\/[^/]+|web_cache\/[^/]+)$/.test(key)))
  const largest=Object.entries(allocators).filter(([,attrs])=>attrs.size?.units==='bytes').sort((a,b)=>b[1].size.value-a[1].size.value).slice(0,40)
  Object.assign(point,{categories,largest})
 }
 summaries.push({name,correlation,dumps:trace.dumps,points})
}
fs.writeFileSync(path.join(directory,'memoryinfra-summary.json'),JSON.stringify(summaries,null,2))
for(const trace of summaries)for(const point of trace.points)console.log(JSON.stringify({trace:trace.name,tag:point.tag,pid:point.pid,role:point.role,privateMiB:point.native?.private/1048576,categories:point.categories}))
