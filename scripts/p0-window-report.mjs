import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const root=path.resolve('test-results/drag'),output=path.resolve('docs/performance')
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const mib=n=>(n/1048576).toFixed(2)
const records=[]
const builds={}
for(const version of ['before','after']){
 const build=JSON.parse(fs.readFileSync(`test-results/phase042/build-dnd-${version}.json`))
 assert.equal(sha(build.binary),build.sha256)
 builds[version]=Object.fromEntries(Object.entries(build).filter(([key])=>!['binary','frontendFiles'].includes(key)))
}
for(const version of ['before','after'])for(let run=1;run<=3;run++){
  const file=path.join(root,`p0-windows-${version}-foreground-r${run}.json`),r=JSON.parse(fs.readFileSync(file))
  assert.equal(r.label,'dnd-'+version)
  let cycles=r.windowCycles,derived=false
  if(!cycles){
    // The original failing trial predates the explicit cycle counters. One
    // return geometry belongs to setup H; each subsequent geometry is one I
    // attempt, written before the return/close assertion.
    assert(r.errors.length===1&&r.errors[0].includes('Empty detached window should close'))
    const attempted=r.observations.filter(o=>o.returnGeometry).length-1
    cycles={requested:120,attempted,completed:attempted-1,durationMs:null};derived=true
  }
  const completed=r.results.find(s=>s.name.startsWith('I '))
  const checkpoints=r.observations.filter(o=>[30,60,120].includes(o.round))
  if(version==='after'){
    assert.deepEqual(r.errors,[],file);assert.equal(r.results.length,11);assert.equal(cycles.completed,120)
    assert(completed);assert.equal(completed.after.windows,1)
    assert.deepEqual(checkpoints.map(p=>p.round),[30,60,120])
    for(const {snapshot:s}of checkpoints){
      assert.equal(s.windows,1);assert.equal(s.views.length,1)
      assert.equal(s.views[0].records,1);assert.equal(s.views[0].documents,1)
      assert.equal(s.views[0].cm,1);assert.equal(s.views[0].live,0);assert.equal(s.views[0].ghosts,0)
    }
  }else if(r.errors.length)assert(r.errors.every(e=>e.includes('Empty detached window should close')),file)
  const last=completed?.after||r.observations.filter(o=>o.snapshot).at(-1)?.snapshot
  records.push({version,run,cycles,countsDerivedFromGeometry:derived,errors:r.errors,evidence:{path:path.relative(process.cwd(),file).replaceAll('\\','/'),sha256:sha(file)},
    start:r.results[0]?.after,afterI:completed?.after,lastObserved:last,end:r.results.at(-1)?.cleaned,checkpoints,
    closeStages:r.closeLogs?.reduce((counts,entry)=>{const stage=entry.data?.stage||'unstructured';counts[stage]=(counts[stage]||0)+1;return counts},{})})
}
const lines=['# P0 独立窗口三轮对照','',
 '本表基线源为 9389044，优化侧为资源治理候选 034aa99（工作区源指纹已核对），二进制和构建标识见逐轮摘要。最终 b30adde 的额外标题命令修正不参与此往返负载；其 8 项窗口功能回归另列于审查报告。','',
 '同一套原生移交流程，每轮目标 120 次往返（每次含创建独立窗口、移交回主窗口、关闭空源窗口）。测试通过实际 Tauri/WebView2 窗口及原生命中检测执行；computer-use 仅激活隔离的测试窗口，然后脚本驱动生产移交 API。此结果不称为 720 次物理鼠标拖拽。','',
 '基线两轮未能完成，不能补造它们在第 120 次的内存，也不能将完成的一轮冒充三轮通过。布局/窗口遮挡会影响原生命中区域，逐轮 Pane 数及几何保留在原始记录，以下不据此推导总体内存改善百分比。', '',
 '| 版本/轮次 | 成功/尝试/目标 | 结果 | 往返阶段秒数（含采样） | 最后采样 Rust Private MiB | WV Private MiB | WV WS MiB | 窗口/子进程/Panes |',
 '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |']
for(const r of records){const s=r.lastObserved
 lines.push(`| ${r.version}/${r.run} | ${r.cycles.completed}/${r.cycles.attempted}/${r.cycles.requested} | ${r.errors.length?'失败：空源窗口未关闭':'120 次完成'} | ${r.cycles.durationMs===null?'未记录':(r.cycles.durationMs/1000).toFixed(2)} | ${s?mib(s.rustPrivate):'未记录'} | ${s?mib(s.webviewPrivate):'未记录'} | ${s?mib(s.webviewWorking):'未记录'} | ${s?`${s.windows}/${s.webviewProcesses}/${s.views.map(v=>v.panes).join('+')}`:'未记录'} |`)
}
lines.push('', '失败行的“最后采样”来自失败前最近一次五轮检查点，并非失败发生时或第 120 次的数值。before/1 的成功/尝试次数由原始返回几何记录推导（减去设置阶段 H 一次），其余五轮使用显式计数。Rust 与 WV Working Set、heap、DOM、编辑器创建/活动数及原始记录 SHA-256 见 [逐轮摘要](p0-window-results-20261028.json)。窗口流程不主动 GC。', '',
 '| 版本/轮次 | 检查点 | Rust Private/WS MiB | WV Private/WS MiB | heap MiB | WV 子进程 | 活动 CM/PM/记录/ghost |',
 '| --- | ---: | ---: | ---: | ---: | ---: | --- |')
for(const r of records)for(const p of r.checkpoints){const s=p.snapshot
 lines.push(`| ${r.version}/${r.run} | ${p.round} | ${mib(s.rustPrivate)}/${mib(s.rustWorking)} | ${mib(s.webviewPrivate)}/${mib(s.webviewWorking)} | ${mib(s.views.reduce((n,v)=>n+(v.heap||0),0))} | ${s.webviewProcesses} | ${s.views.map(v=>`${v.cm}/${v.live}/${v.records}/${v.ghosts}`).join('; ')} |`)
}
lines.push('', '主窗口始终保留一份已打开的 Source 文档，因此活动 CM=1、records=1 是预期状态。累计创建数增长代表新窗口/移交重建；不能等同于同时存活实例。本次没有消除跨 WebView 重建或运行时内部缓存的全部分配。原始三轮未扩大应用权限，也未操作日常用户实例。', '',
 '本机 native-functional 场景及其他平台范围另见 [审查与验证报告](p0-audit-20261028.md)。','')
fs.writeFileSync(path.join(output,'p0-window-comparison-20261028.md'),lines.join('\n'))
fs.writeFileSync(path.join(output,'p0-window-results-20261028.json'),JSON.stringify({generatedAt:new Date().toISOString(),builds,records},null,2)+'\n')
console.log('Verified 360 after-fix window round trips and generated all six trial summaries')
