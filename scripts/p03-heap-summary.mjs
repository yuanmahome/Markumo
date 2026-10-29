// Offline strong-edge graph analysis. Independently implemented iterative
// dominators; this is an estimate, not DevTools' page-owned-object heuristic.
import fs from 'node:fs'
import {createHash} from 'node:crypto'
const input=process.argv[2],raw=fs.readFileSync(input),h=JSON.parse(raw),nf=h.snapshot.meta.node_fields,ef=h.snapshot.meta.edge_fields,N=nf.length,E=ef.length,n=h.nodes.length/N
const a=name=>nf.indexOf(name),b=name=>ef.indexOf(name),nt=h.snapshot.meta.node_types[a('type')],et=h.snapshot.meta.edge_types[b('type')]
const name=i=>h.strings[h.nodes[i*N+a('name')]],type=i=>nt[h.nodes[i*N+a('type')]],size=i=>h.nodes[i*N+a('self_size')]
const first=new Uint32Array(n+1);let cursor=0
for(let i=0;i<n;i++){first[i]=cursor;cursor+=h.nodes[i*N+a('edge_count')]*E}first[n]=cursor
const to=e=>h.edges[e+b('to_node')]/N,label=e=>['element','hidden'].includes(et[h.edges[e+b('type')]])?String(h.edges[e+b('name_or_index')]):h.strings[h.edges[e+b('name_or_index')]]
const strong=(from,e)=>{const t=et[h.edges[e+b('type')]];return t!=='weak'&&(t!=='shortcut'||from===0)&&!(t==='internal'&&label(e)?.includes('part of key'))}
const seen=new Uint8Array(n),stack=new Uint32Array(n),next=new Uint32Array(n),post=[],parent=new Int32Array(n).fill(-1),via=new Int32Array(n)
seen[0]=1;stack[0]=0;next[0]=first[0];let top=0
while(top>=0){const from=stack[top],end=first[from+1];let e=next[top];for(;e<end;e+=E){if(!strong(from,e)||seen[to(e)])continue;next[top]=e+E;const target=to(e);seen[target]=1;top++;stack[top]=target;next[top]=first[target];break}if(e>=end){post.push(from);top--}}
const order=post.reverse(),rank=new Int32Array(n).fill(-1);order.forEach((v,i)=>rank[v]=i)
const counts=new Uint32Array(n),offsets=new Uint32Array(n+1)
for(const from of order)for(let e=first[from];e<first[from+1];e+=E)if(strong(from,e)&&seen[to(e)])counts[to(e)]++
for(let i=0;i<n;i++)offsets[i+1]=offsets[i]+counts[i]
const pred=new Uint32Array(offsets[n]),fill=offsets.slice(0,n)
for(const from of order)for(let e=first[from];e<first[from+1];e+=E)if(strong(from,e)&&seen[to(e)])pred[fill[to(e)]++]=from
const idom=new Int32Array(n).fill(-1);idom[0]=0;let iterations=0,changed=true
function meet(a,b){while(a!==b){while(rank[a]>rank[b])a=idom[a];while(rank[b]>rank[a])b=idom[b]}return a}
while(changed){changed=false;iterations++;if(iterations>1000)throw Error('Dominator analysis did not converge');for(let i=1;i<order.length;i++){const v=order[i];let d=-1;for(let p=offsets[v];p<offsets[v+1];p++){const from=pred[p];if(idom[from]<0)continue;d=d<0?from:meet(d,from);if(d===0)break}if(d>=0&&idom[v]!==d){idom[v]=d;changed=true}}}
const retained=new Float64Array(n);for(const i of order)retained[i]=size(i)
for(let i=order.length-1;i>0;i--){const v=order[i];if(idom[v]>=0)retained[idom[v]]+=retained[v]}
// Shortest strong retaining paths for the small set of structural witnesses.
let head=0,tail=1;stack[0]=0;parent[0]=0
while(head<tail){const from=stack[head++];for(let e=first[from];e<first[from+1];e+=E){if(!strong(from,e))continue;const target=to(e);if(parent[target]>=0)continue;parent[target]=from;via[target]=e;stack[tail++]=target}}
function properties(i){const result=new Map();for(let e=first[i];e<first[i+1];e+=E)if(et[h.edges[e+b('type')]]==='property')result.set(label(e),to(e));return result}
function path(i){const out=[];for(let depth=0;i>0&&parent[i]>=0&&depth<50;depth++){out.push({nodeId:h.nodes[i*N+a('id')],name:name(i).slice(0,100),edge:label(via[i])});i=parent[i]}return out.reverse()}
const groups={fileSeeds:[],cmStates:[],cmViews:[],cmTextLeaves:[],vueEffects:[]},docRoots=new Set(),fixtureStrings=[];let detached=0,reachableDetached=0
for(let i=0;i<n;i++){
 if(a('detachedness')>=0&&h.nodes[i*N+a('detachedness')]===2){detached++;if(seen[i])reachableDetached++}
 if(type(i)==='string'&&name(i).includes('2026-10-29 INFO Text benchmark:'))fixtureStrings.push({nodeId:h.nodes[i*N+a('id')],snapshotNameChars:name(i).length,selfBytes:size(i),estimatedRetainedBytes:retained[i]})
 if(type(i)!=='object'||!seen[i])continue
 const p=properties(i),has=keys=>keys.every(k=>p.has(k)),row=()=>({nodeId:h.nodes[i*N+a('id')],name:name(i),selfBytes:size(i),estimatedRetainedBytes:retained[i]})
 if(has(['id','name','path','text'])&&name(p.get('id')).startsWith('file:')&&type(p.get('text')).includes('string'))groups.fileSeeds.push({...row(),fileName:name(p.get('name')),textNodeId:h.nodes[p.get('text')*N+a('id')],textSelfBytes:size(p.get('text')),textEstimatedRetainedBytes:retained[p.get('text')],retainingPath:path(i)})
 if(has(['config','doc','selection','values'])){groups.cmStates.push(row());docRoots.add(p.get('doc'))}
 if(has(['viewState','docView','plugins','dom']))groups.cmViews.push(row())
 if(has(['fn','deps','flags']))groups.vueEffects.push(row())
}
const textNodes=new Set(),work=[...docRoots];let branches=0
while(work.length){const i=work.pop();if(textNodes.has(i))continue;textNodes.add(i);const p=properties(i);if(p.has('text')&&name(p.get('text'))==='Array')groups.cmTextLeaves.push({nodeId:h.nodes[i*N+a('id')],name:name(i),selfBytes:size(i),estimatedRetainedBytes:retained[i]});else if(p.has('children')){branches++;const children=p.get('children');for(let e=first[children];e<first[children+1];e+=E)if(et[h.edges[e+b('type')]]==='element')work.push(to(e))}}
const summary={file:input,sha256:createHash('sha256').update(raw).digest('hex'),method:'Strong graph: no weak edges, no non-root shortcuts, no internal ephemeron part-of-key edges. Iterative immediate dominators over root-reachable graph. Does not reproduce DevTools page-owned/debugger flags; retained estimates cannot be equated to native Private Bytes or summed across groups.',nodes:n,reachableNodes:order.length,reachableSelfBytes:retained[0],iterations,detachedNodes:detached,stronglyReachableDetachedNodes:reachableDetached,currentTextTree:{distinctRoots:docRoots.size,nodes:textNodes.size,branches},fixtureStrings:{count:fixtureStrings.length,largest:fixtureStrings.sort((a,b)=>b.selfBytes-a.selfBytes).slice(0,10)},groups:Object.fromEntries(Object.entries(groups).map(([key,rows])=>[key,{count:rows.length,selfBytes:rows.reduce((n,r)=>n+r.selfBytes,0),largest:rows.sort((a,b)=>b.estimatedRetainedBytes-a.estimatedRetainedBytes).slice(0,key==='fileSeeds'?10:5)}]))}
fs.writeFileSync(input+'.summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary))
