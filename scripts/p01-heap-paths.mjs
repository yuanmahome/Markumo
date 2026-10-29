import fs from 'node:fs'
const h = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const nf = h.snapshot.meta.node_fields, ef = h.snapshot.meta.edge_fields, ns = nf.length, es = ef.length
const ni = key => nf.indexOf(key), ei = key => ef.indexOf(key), nodes = h.nodes, edges = h.edges, count = nodes.length/ns
const typeNames = h.snapshot.meta.edge_types[ei('type')]
const firstEdge = new Uint32Array(count+1)
let edgeAt=0
for(let i=0;i<count;i++){firstEdge[i]=edgeAt;edgeAt+=nodes[i*ns+ni('edge_count')]*es}firstEdge[count]=edgeAt
const parent = new Int32Array(count).fill(-1), via = new Int32Array(count), queue = new Uint32Array(count)
let head=0,tail=1;queue[0]=0;parent[0]=0
while(head<tail){const from=queue[head++];for(let e=firstEdge[from];e<firstEdge[from+1];e+=es){const type=typeNames[edges[e+ei('type')]],label=h.strings[edges[e+ei('name_or_index')]];if(type==='weak'||(type==='internal'&&label?.includes('part of key')))continue;const to=edges[e+ei('to_node')]/ns;if(parent[to]>=0)continue;parent[to]=from;via[to]=e;queue[tail++]=to}}
const name = index => h.strings[nodes[index*ns+ni('name')]]
const matches=[]
for(let i=0;i<count;i++){
 if(!(process.argv[3] ? name(i).includes(process.argv[3]) : name(i).startsWith('<div class="markdown-live"'))||nodes[i*ns+ni('detachedness')]!==2)continue
 const chain=[];let at=i
 for(let depth=0;depth<80&&at>0;depth++){
  const e=via[at],t=typeNames[edges[e+ei('type')]],v=edges[e+ei('name_or_index')]
  chain.push({id:nodes[at*ns+ni('id')],name:name(at).slice(0,200),edge:t==='element'||t==='hidden'?v:h.strings[v],edgeType:t})
  if(parent[at]<0)break;at=parent[at]
 }
 matches.push(chain.reverse())
}
console.log(JSON.stringify(matches,null,2))
