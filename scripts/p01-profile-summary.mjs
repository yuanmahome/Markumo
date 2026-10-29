import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = path.resolve(process.argv[2])
assert(fs.statSync(directory).isDirectory())
const summaries = []
for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.heapsnapshot'))) {
  const h = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
  const fields = h.snapshot.meta.node_fields, step = fields.length, at = key => fields.indexOf(key)
  const types = h.snapshot.meta.node_types[at('type')], totals = new Map(), detached = new Map()
  const ef = h.snapshot.meta.edge_fields, es = ef.length, edgeTypes = h.snapshot.meta.edge_types[ef.indexOf('type')]
  const signatures = { sourceBridge: ['source','doc','blocks','tail','environment'], liveController: ['bridge','view','options','dom'], pmView: ['state','docView','domObserver','input'], cmView: ['viewState','docView','plugins','dom'], sourceBlock: ['id','node','from','to','raw'], vueEffect: ['fn','deps','flags'] }
  const instances = Object.fromEntries(Object.keys(signatures).map(key => [key,{count:0,bytes:0,names:{}}]))
  let edgeOffset = 0
  let bytes = 0
  for (let i = 0; i < h.nodes.length; i += step) {
    const type = types[h.nodes[i + at('type')]], name = h.strings[h.nodes[i + at('name')]], size = h.nodes[i + at('self_size')]
    const key = `${type}:${name.length > 200 ? name.slice(0,200) + '…' : name}`
    const row = totals.get(key) || { count: 0, bytes: 0 }; row.count++; row.bytes += size; totals.set(key, row); bytes += size
    if (at('detachedness') >= 0 && h.nodes[i + at('detachedness')] === 2) detached.set(key, (detached.get(key) || 0) + 1)
    const end = edgeOffset + h.nodes[i + at('edge_count')] * es
    if (type === 'object') {
      const properties = new Set(),targets=new Map()
      for(let edge=edgeOffset;edge<end;edge+=es)if(edgeTypes[h.edges[edge+ef.indexOf('type')]]==='property'){const key=h.strings[h.edges[edge+ef.indexOf('name_or_index')]];properties.add(key);targets.set(key,h.edges[edge+ef.indexOf('to_node')])}
      for(const [key,fields] of Object.entries(signatures))if(fields.every(field=>properties.has(field))){
        // V8 retains literal boilerplates whose property values are system/Hole;
        // they contain no document data and are not live SourceBlock instances.
        if(key==='sourceBlock'&&types[h.nodes[targets.get('node')+at('type')]]!=='object')continue
        const item=instances[key];item.count++;item.bytes+=size;item.names[name]=(item.names[name]||0)+1
      }
    }
    edgeOffset = end
  }
  const watched = /CodeBlockView|MarkdownEditorController|MarkdownSourceBridge|EditorView|EditorState|LiveImageView|SourceBlock|ReactiveEffect|ComputedRefImpl|Worker|HTMLImageElement|HTMLCanvasElement|ResizeObserver|IntersectionObserver|MutationObserver/
  summaries.push({ name, nodes: h.nodes.length / step, bytes, instances, detached: Object.fromEntries(detached), watched: Object.fromEntries([...totals].filter(([k]) => /^(object|native):/.test(k) && k.length < 180 && watched.test(k))), largest: [...totals].sort((a,b) => b[1].bytes - a[1].bytes).slice(0,30), totals: Object.fromEntries(totals) })
}
const traces = []
for (const name of fs.readdirSync(directory).filter(n => n.startsWith('trace-') && n.endsWith('.json'))) {
  const trace = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
  traces.push({ name, dumps: trace.dumps, processes: trace.traceEvents.filter(e => e.ph === 'M' && e.name === 'process_name'), memoryDumpEvents: trace.traceEvents.filter(e => e.ph === 'v' && e.args?.dumps).length })
}
fs.writeFileSync(path.join(directory, 'profile-summary.json'), JSON.stringify({ heaps: summaries, traces }, null, 2))
console.log('PROFILE SUMMARY', JSON.stringify(summaries.map(h => ({ name:h.name, nodes:h.nodes, MiB:h.bytes/1048576, detached:Object.values(h.detached).reduce((a,b)=>a+b,0), instances:h.instances }))))
console.log('MemoryInfra dump events', traces.map(t => ({ name:t.name, count:t.memoryDumpEvents })))
