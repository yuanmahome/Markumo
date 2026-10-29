// Generate tables from completed three-run acceptance; never type benchmark data.
import fs from 'node:fs'
import assert from 'node:assert/strict'
const data=JSON.parse(fs.readFileSync('docs/performance/p01-memory-results-20261028.json','utf8'))
const labels=['p01-v111','p01-v112','p01-main-before','p01-final']
const names={'p01-v111':'v1.1.1','p01-v112':'v1.1.2','p01-main-before':'main 315de6b 原始','p01-final':'main 315de6b + 本修复','p01-pre-io':'210d878 治理前','p01-io':'5515036 治理后','p01-fixed':'a9b3c41 + CSS 修复'}
const mainBuild=data.acceptance.find(item=>item.label==='p01-final')?.build
if(mainBuild){const commit=(mainBuild.resolvedCommit||mainBuild.commit).slice(0,7);names['p01-main-before']=`main ${commit} 原始`;names['p01-final']=`main ${commit} + 本修复`}
const scenes=['blank','ordinary','code200','text-exact2mib','text2mb','panes','pdf','image','markdown-image','split','same240','mixed240']
const sceneNames={blank:'空白工作区',ordinary:'普通 Markdown Live',code200:'200 代码块 Live','text-exact2mib':'精确 2 MiB 文本',text2mb:'旧 large-2mb.txt（3.22 MiB）',panes:'60 次分栏/合并',pdf:'PDF',image:'24MP PNG 独立查看','markdown-image':'Markdown 内大图',split:'Split',same240:'普通 Markdown 240 次开关',mixed240:'混合 240 次开切关'}
const median=values=>{const s=[...values].sort((a,b)=>a-b);assert(s.length);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2}
const number=value=>value.toFixed(2),mib=value=>value/1048576
const dataset=(label,sequence=false)=>{const d=data.acceptance.find(r=>r.label===label&&r.kind===(sequence?'Fixed-order natural sequence':'Isolated natural acceptance'));assert(d?.n===3,`Missing complete acceptance ${label}`);return d}
const points=(d,scene,stage,extra={})=>{const rows=d.samples.flatMap(s=>s.points.filter(p=>(p.workload||s.scene)===scene&&p.stage===stage&&Object.entries(extra).every(([k,v])=>p[k]===v)));assert.equal(rows.length,3,`${d.label}/${scene}/${stage}/${JSON.stringify(extra)}`);return rows}
const size=(point,field='private',role)=>mib(point.native.processes.filter(p=>role?p.role===role:p.role!=='Rust').reduce((sum,p)=>sum+p[field],0))
const fmt=values=>`${number(median(values))} [${number(Math.min(...values))}, ${number(Math.max(...values))}]`
const out=['# P0.1 Windows Release 实测表（自动生成）','','由 `node scripts/p01-report-tables.mjs` 从完整数据生成。单位 MiB；格式为中位数 [最小值, 最大值]，每格三个独立新进程/Profile。自然样本不执行 GC/压力通知，使用 Network 关闭的轻量 CDP。方法、结论和诊断见 [主报告](p01-memory-investigation-20261028.md)，全部逐点进程数据及来源 SHA 见 [原始汇总](p01-memory-results-20261028.json)。','']
function table(headers,rows){out.push('| '+headers.join(' | ')+' |','| '+headers.map(()=> '---').join(' | ')+' |',...rows.map(row=>'| '+row.join(' | ')+' |'),'')}
out.push('## 构建与输入','')
table(['角色','Commit','二进制 SHA-256','应用源输入 SHA-256'],labels.map(label=>{const d=dataset(label);return[names[label],d.build.resolvedCommit||d.build.commit,d.build.sha256,d.build.sourceInputsSha256]}))
out.push('每个构建的 Rust、完整输入和测试配置记录在 JSON；main 原始与修复侧构建时基于同一 Git HEAD，修复侧追加本次源改动。后续提交是否对应实测源，由验收清单再次比较完整源输入 SHA。v1.1.1/v1.1.2 为解引用后的提交，不是 annotated tag 对象 ID。','')
out.push('## 独立场景：打开态','')
table(['场景',...labels.map(l=>names[l])],scenes.map(scene=>[sceneNames[scene],...labels.map(label=>fmt(points(dataset(label),scene,'loaded').map(p=>size(p))))]))
out.push('循环行的 loaded 在 240 次关闭后额外等待一秒采样，此时没有打开文档；循环检查点另列。空白 loaded 是空工作区再等待三秒后的点。','')
out.push('## 独立场景：关闭后的自然恢复','')
table(['场景/关闭后等待',...labels.map(l=>names[l])],scenes.map(scene=>{const ms=['blank','same240','mixed240'].includes(scene)?60000:5000;return[`${sceneNames[scene]} / ${ms/1000}s`,...labels.map(label=>fmt(points(dataset(label),scene,'closed-natural',{plannedMs:ms}).map(p=>size(p))))]}))
out.push('## 普通操作就绪耗时','', '从操作开始到目标挂载与两帧就绪；不含后加一秒静置。启动耗时从启动进程至 CDP 观察到 UI 就绪，包含轮询/探针成本，不是纯绘制时间。','')
table(['操作/ms',...labels.map(l=>names[l])],[['冷启动（空白场景）',...labels.map(label=>fmt(dataset(label).samples.filter(s=>s.scene==='blank').map(s=>s.startupMs)))],...['ordinary','code200','text-exact2mib','image','pdf','split'].map(scene=>[sceneNames[scene],...labels.map(label=>fmt(dataset(label).samples.filter(s=>s.scene===scene).map(s=>s.operations.find(o=>o.scene===scene).durationMs)))])])
if(data.latencyControl?.length===2){
 out.push('### 同二进制交错耗时复核','', '保留上面的原始较高耗时，不用补测覆盖它们。另用三对新进程/Profile 复测普通 Live 和大图；第二对倒序。下列为逐对毫秒原值，JSON 保存源文件 SHA。','')
 const before=data.latencyControl.find(c=>c.label==='p01-main-before'),after=data.latencyControl.find(c=>c.label==='p01-final')
 table(['场景','轮次','原始 main/ms','修复 main/ms','配对差/修复−原始 ms'],['ordinary','image'].flatMap(scene=>before.scenes[scene].runs.map(a=>{const b=after.scenes[scene].runs.find(b=>b.pair===a.pair);return[sceneNames[scene],a.pair,number(a.durationMs),number(b.durationMs),number(b.durationMs-a.durationMs)]})))
 table(['场景','原始 main 中位数 [范围]','修复 main 中位数 [范围]'],['ordinary','image'].map(scene=>[sceneNames[scene],fmt(before.scenes[scene].runs.map(r=>r.durationMs)),fmt(after.scenes[scene].runs.map(r=>r.durationMs))]))
}
out.push('## 分进程变化','', '每个角色各自取三轮中位数，故角色中位数之和可能不等于总和的中位数。Utility 合并显示，逐一子类型、PID、创建时间、句柄及 CPU 位于 JSON/CSV。','')
const roleStages=[['新进程空白冷点','blank','cold',{}],['普通 Live 打开','ordinary','loaded',{}],['普通 Live 关闭 5s','ordinary','closed-natural',{plannedMs:5000}],['混合第 240 次关闭','mixed240','cycle-closed',{cycle:240}],['混合关闭 60s','mixed240','closed-natural',{plannedMs:60000}]]
for(const field of ['private','working']){
 out.push(`### ${field==='private'?'Private Bytes':'Working Set（合计可能重复共享页）'}`,'')
 table(['版本 / 状态','Rust','Browser','Renderer','GPU','Utility 合计','Crashpad','WV 总和','JS Heap Used'],labels.flatMap(label=>roleStages.map(([name,scene,stage,extra])=>{const rows=points(dataset(label),scene,stage,extra);return[`${names[label]} / ${name}`,...['Rust','Browser','Renderer','GPU','Utility','crashpad-handler'].map(role=>number(median(rows.map(p=>size(p,field,role))))),number(median(rows.map(p=>size(p,field)))),number(median(rows.map(p=>mib(p.heapUsed))))]})))
}
out.push('### Utility 子类型 Private','', '未出现的进程按 0 计入三轮统计，不把“只在一轮出现”当成三轮都常驻。原始 PID/父 PID/创建时间和每个进程 Working Set 见 JSON/CSV。','')
const utilityStages=[['冷空白','blank','cold',{}],['大图打开','image','loaded',{}],['PDF 打开','pdf','loaded',{}],['混合关闭60s','mixed240','closed-natural',{plannedMs:60000}]]
const utilityTypes=[...new Set(labels.flatMap(label=>utilityStages.flatMap(([,scene,stage,extra])=>points(dataset(label),scene,stage,extra).flatMap(p=>p.native.processes.filter(q=>q.role==='Utility').map(q=>q.subtype)))))].sort()
table(['状态 / Utility 子类型',...labels.map(label=>names[label])],utilityStages.flatMap(([name,scene,stage,extra])=>utilityTypes.map(subtype=>[`${name} / ${subtype||'未提供'}`,...labels.map(label=>fmt(points(dataset(label),scene,stage,extra).map(point=>mib(point.native.processes.filter(p=>p.role==='Utility'&&p.subtype===subtype).reduce((sum,p)=>sum+p.private,0)))))])))
out.push('## 30 / 60 / 120 / 240 次循环','', 'Δ 为每轮第 240 点减区间起点，再取中位数和范围，单位 MiB。末段斜率对每轮区间内全部 15 次检查点作普通最小二乘，单位 MiB/次；同时给出 120～240 与 180～240，避免把早期填充缓存与最后区间混为一谈。它只是有限区间的描述，不用于证明无限时间有界。','')
for(const scene of ['same240','mixed240']){
 out.push(`### ${sceneNames[scene]}`,'')
 table(['版本','30','60','120','240'],labels.map(label=>[names[label],...[30,60,120,240].map(cycle=>fmt(points(dataset(label),scene,'cycle-closed',{cycle}).map(p=>size(p))))]))
 table(['版本','Δ120→240','120～240 斜率','Δ180→240','180～240 斜率'],labels.map(label=>{
  const d=dataset(label),values=[]
  for(const start of [120,180]){
   const deltas=[],slopes=[]
   for(const sample of d.samples.filter(s=>s.scene===scene)){
    const ps=sample.points.filter(p=>p.stage==='cycle-closed'&&p.cycle>=start),at=cycle=>size(ps.find(p=>p.cycle===cycle))
    deltas.push(at(240)-at(start))
    const mx=ps.reduce((sum,p)=>sum+p.cycle,0)/ps.length,my=ps.reduce((sum,p)=>sum+size(p),0)/ps.length
    slopes.push(ps.reduce((sum,p)=>sum+(p.cycle-mx)*(size(p)-my),0)/ps.reduce((sum,p)=>sum+(p.cycle-mx)**2,0))
   }
   values.push(fmt(deltas),fmt(slopes))
  }
  return[names[label],...values]
 }))
}
out.push('## 最后文档关闭后的自然回收曲线','')
for(const scene of ['same240','mixed240']){
 out.push(`### ${sceneNames[scene]}：WebView2 Private`,'')
 table(['版本',...'0 1 5 15 30 60'.split(' ').map(t=>`${t}s`)],labels.map(label=>[names[label],...[0,1000,5000,15000,30000,60000].map(plannedMs=>fmt(points(dataset(label),scene,'closed-natural',{plannedMs}).map(p=>size(p))))]))
}
out.push('## 固定顺序累计负载','', '顺序固定；每轮新进程/Profile，但同一轮内保留前序缓存。表为每一步 loaded，不能称为独立文件成本。','')
table(['顺序 / 负载',...labels.map(l=>names[l])],['ordinary','code200','panes','image','markdown-image','pdf','split','mixed240','text2mb'].map((scene,i)=>[`${i+1}. ${sceneNames[scene]}`,...labels.map(label=>fmt(points(dataset(label,true),scene,'loaded').map(p=>size(p))))]))
out.push('### 累计负载中的 240 次混合循环','')
table(['版本','30','60','120','240','Δ180→240','180～240 斜率'],labels.map(label=>{
 const d=dataset(label,true),deltas=[],slopes=[]
 for(const sample of d.samples){const ps=sample.points.filter(p=>p.workload==='mixed240'&&p.stage==='cycle-closed'&&p.cycle>=180),at=cycle=>size(ps.find(p=>p.cycle===cycle)),my=ps.reduce((sum,p)=>sum+size(p),0)/ps.length;deltas.push(at(240)-at(180));slopes.push(ps.reduce((sum,p)=>sum+(p.cycle-210)*(size(p)-my),0)/ps.reduce((sum,p)=>sum+(p.cycle-210)**2,0))}
 return[names[label],...[30,60,120,240].map(cycle=>fmt(points(d,'mixed240','cycle-closed',{cycle}).map(p=>size(p)))),fmt(deltas),fmt(slopes)]
}))
out.push('## 交错历史提交控制','', '每轮按 v1.1.1 → 210d878 → 5515036 → v1.1.2 → a9b3c41+CSS 修复；第二轮倒序。这里只比较对应候选，不能将 a9b3c41 候选称为最新 main 最终修复。','')
table(['构建','30','60','120','240','关闭60s'],data.cohorts.filter(d=>d.n===3&&d.transport==='raw-cdp-no-network').map(d=>[names[d.label],...[30,60,120,240].map(cycle=>fmt(points(d,'mixed240','cycle-closed',{cycle}).map(p=>size(p)))),fmt(points(d,'mixed240','closed-natural',{plannedMs:60000}).map(p=>size(p)))]))
const target='docs/performance/p01-memory-tables-20261028.md'
fs.writeFileSync(target,out.join('\n')+'\n');console.log('SAVED',target)
