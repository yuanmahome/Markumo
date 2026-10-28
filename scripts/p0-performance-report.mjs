// Summarize measured Release results; never substitute a missing run with zero.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const output=path.resolve('docs/performance'),root=path.resolve('test-results/phase042')
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const read=(label,suffix='')=>{
  const file=path.join(root,`native-${label}${suffix}/results.json`),data=JSON.parse(fs.readFileSync(file))
  assert.equal(data.passed,true,file);assert.deepEqual(data.errors,[]);assert.equal(data.rounds,3)
  assert.equal(digest(data.build.binary),data.build.sha256,'Measured binary no longer matches its manifest')
  assert.equal(data.samples.length,data.scenarios.length*3)
  for(const scenario of data.scenarios)assert.deepEqual(data.samples.filter(s=>s.scenario===scenario).map(s=>s.run),[1,2,3])
  for(const sample of data.samples){
    const j=sample.afterClose.postGc.js
    for(const editor of ['pm','mainCM','embeddedCM'])assert.equal(j.editors[editor].live,0,`${file} ${sample.scenario} retained ${editor}`)
    assert.equal(j.workers.live,0,'Workers must settle after close')
    assert.equal(j.blobs.liveUrls,0,'Owned Blob URLs must settle after close')
    assert.equal(j.domMedia.canvasCount,0,'Canvas nodes must be removed after close')
    assert.equal(j.observers.IntersectionObserver.targets,0,'Render visibility targets must unregister after close')
  }
  return{...data,evidence:{path:path.relative(process.cwd(),file).replaceAll('\\','/'),sha256:digest(file)}}
}
const bytes=n=>Number((n/1048576).toFixed(2)),round=n=>Number(n.toFixed(2))
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]
const rows=(report,id)=>report.samples.filter(s=>s.scenario===id)
function state(point){
  const j=point.js,n=point.native
  return{rustPrivateMiB:bytes(n.rustPrivate),rustWorkingMiB:bytes(n.rustWorking),webviewPrivateMiB:bytes(n.webviewPrivate),webviewWorkingMiB:bytes(n.webviewWorking),webviewProcesses:n.webviewProcesses,
    heapMiB:bytes(j.jsHeapUsed),dom:j.domCounters,connectedDom:j.domMedia.connectedDomNodes,editors:j.editors,observers:j.observers,workers:j.workers,cdpWorkers:j.cdpWorkers,blobs:j.blobs,
    decodedPixels:j.domMedia.decodedImagePixels,canvasPixels:j.domMedia.canvasPixels,canvasCount:j.domMedia.canvasCount,longTasks:j.longTasksCount,longTaskMs:j.longTasksTotalMs,tasks:j.tasks}
}
function memory(point){const s=state(point);return{rustPrivateMiB:s.rustPrivateMiB,rustWorkingMiB:s.rustWorkingMiB,webviewPrivateMiB:s.webviewPrivateMiB,webviewWorkingMiB:s.webviewWorkingMiB,heapMiB:s.heapMiB,dom:s.dom,connectedDom:s.connectedDom}}
const reports={before:read('p0-before'),after:read('p0-after'),workloadsBefore:read('p0-before','-workloads'),workloadsAfter:read('p0-after','-workloads'),syncBefore:read('p0-before','-sync'),syncAfter:read('p0-final','-sync')}
assert.deepEqual(reports.before.scenarios,reports.after.scenarios)
assert.deepEqual(reports.workloadsBefore.scenarios,reports.workloadsAfter.scenarios)
assert.deepEqual(reports.syncBefore.scenarios,reports.syncAfter.scenarios)
for(const [a,b]of [[reports.before,reports.after],[reports.workloadsBefore,reports.workloadsAfter],[reports.syncBefore,reports.syncAfter]]){
  assert.equal(a.webviewRuntime,b.webviewRuntime,'WebView2 runtime changed between A/B')
  assert.deepEqual(a.hardware,b.hardware,'Hardware changed between A/B')
  assert.deepEqual(a.display,b.display,'Viewport or DPI changed between A/B')
}
const compact={generatedAt:new Date().toISOString(),note:'MiB; original evidence hashes included. CPU is sampled normalized machine utilization, not an instantaneous peak.',reports:{}}
for(const [name,r]of Object.entries(reports))compact.reports[name]={evidence:r.evidence,build:Object.fromEntries(Object.entries(r.build).filter(([key])=>!['binary','frontendFiles'].includes(key))),hardware:r.hardware,os:r.os,webviewRuntime:r.webviewRuntime,display:r.display,viewport:r.viewport,startups:r.startups,
  samples:r.samples.map(s=>({scenario:s.scenario,run:s.run,readyMs:s.sceneReadyMs,peaks:s.peaks,cpuPercent:s.extra.sampledCpuPercent||null,
    operationMetrics:Object.fromEntries(Object.entries(s.extra).filter(([key])=>!['checkpoints','sampledCpuPercent','loadedBeforeCloseJs','loadedBeforeCloseNative'].includes(key))),
    preGc:state(s.preGc),postGc:memory(s.postGcStable),closeNatural:s.afterClose.natural.map(p=>({scheduledDelayMs:p.elapsedMs,sinceFirstJsSampleMs:p.js.time-s.afterClose.natural[0].js.time,sinceFirstNativeSampleMs:p.native.time-s.afterClose.natural[0].native.time,...memory(p)})),closeGc:state(s.afterClose.postGc),
    cycleCheckpoints:s.extra.checkpoints?.map(p=>({cycle:p.cycle,...state(p)}))}))}
let encoded=JSON.stringify(compact,null,2)
for(const report of Object.values(compact.reports)){
  const expanded=JSON.stringify(report.samples,null,2).replace(/\n/g,'\n      ')
  assert(encoded.includes(expanded))
  encoded=encoded.replace(expanded,'[\n'+report.samples.map(sample=>'        '+JSON.stringify(sample)).join(',\n')+'\n      ]')
}
assert(JSON.stringify(JSON.parse(encoded))===JSON.stringify(compact),'Formatting changed the dataset')
fs.writeFileSync(path.join(output,'p0-native-results-20261028.json'),encoded+'\n')
const lines=['# P0 Windows Release 三轮实测对照','',
  '本文件由 `node scripts/p0-performance-report.mjs` 从完整的三轮结果生成。完整逐轮摘要及原始 JSON 的 SHA-256 见 [测量数据](p0-native-results-20261028.json)。根因、无损测试及限制见 [审查报告](p0-audit-20261028.md)。',
  '', '数据版本：基线 9389044；主场景/Y 的资源治理候选源等同 034aa99（按工作区输入指纹核对）；Z 的最终模式/同步数据来自 b30adde。最终增加的标题格式命令修正没有在主场景/Y 中调用；各组二进制和源指纹独立记录，不将它们冒称同一个构建。',
  '',`Windows / WebView2: \`${JSON.stringify(reports.after.webviewRuntime)}\`；硬件：\`${JSON.stringify(reports.after.hardware)}\`。`,
  '', '表内为三轮中位数；MiB = 1,048,576 字节。Private 与 Working Set 分列；WebView2 为当前应用子进程合计，Working Set 会重复共享页。pre-GC 是操作后自然状态；GC 只作单独参考。A 的 ready 是空场景操作耗时，完整启动另列。',
  '', '完整启动（进程启动至 CDP 观察 UI 就绪，含约 120 ms 轮询及驱动开销）：', '',
  `- 基线三轮：${reports.before.startups.map(s=>round(s.processToObservedReadyMs)).join(' / ')} ms；中位数 ${round(median(reports.before.startups.map(s=>s.processToObservedReadyMs)))} ms。`,
  `- 优化后三轮：${reports.after.startups.map(s=>round(s.processToObservedReadyMs)).join(' / ')} ms；中位数 ${round(median(reports.after.startups.map(s=>s.processToObservedReadyMs)))} ms。`,
  '', '| 场景 | ready ms 前→后 | Rust Private 前→后 | Rust WS 前→后 | WV Private 自然 前→后 | WV WS 自然 前→后 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |']
function pair(id,get,format=round,a=reports.before,b=reports.after){return `${format(median(rows(a,id).map(get)))} → ${format(median(rows(b,id).map(get)))}`}
for(const id of reports.before.scenarios)lines.push(`| ${id} | ${pair(id,s=>s.sceneReadyMs)} | ${pair(id,s=>s.preGc.native.rustPrivate,bytes)} | ${pair(id,s=>s.preGc.native.rustWorking,bytes)} | ${pair(id,s=>s.preGc.native.webviewPrivate,bytes)} | ${pair(id,s=>s.preGc.native.webviewWorking,bytes)} |`)
lines.push('', '| 场景 | heap 自然/GC 前 | heap 自然/GC 后 | DOM GC 前→后 | listeners GC 前→后 | IO 活动 前→后 | 长任务数 前→后 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
for(const id of reports.before.scenarios){
 const heap=r=>`${bytes(median(rows(r,id).map(s=>s.preGc.js.jsHeapUsed)))}/${bytes(median(rows(r,id).map(s=>s.postGcStable.js.jsHeapUsed)))}`
 lines.push(`| ${id} | ${heap(reports.before)} | ${heap(reports.after)} | ${pair(id,s=>s.postGcStable.js.domCounters.nodes)} | ${pair(id,s=>s.postGcStable.js.domCounters.jsEventListeners)} | ${pair(id,s=>s.preGc.js.observers.IntersectionObserver.active)} | ${pair(id,s=>s.preGc.js.longTasksCount)} |`)
}
lines.push('','## 不主动 GC 的 30 / 60 / 120 轮检查点','','每轮 L 内部不请求 GC；在已关闭所有文档后等待 500 ms 采样。其他场景的 GC 不代表整段进程生命周期完全没有 GC。以下保留每一轮值，不用单个中位数掩盖趋势。','',
 '| 版本/轮次 | 循环 | WV Private | WV WS | heap | DOM | CM/PM/Worker | IO/Blob/Canvas |', '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |')
for(const name of ['before','after'])for(const s of reports[name].samples.filter(s=>s.extra.checkpoints))for(const p of s.extra.checkpoints){const j=p.js
 lines.push(`| ${name}/${s.run} | ${p.cycle} | ${bytes(p.native.webviewPrivate)} | ${bytes(p.native.webviewWorking)} | ${bytes(j.jsHeapUsed)} | ${j.domCounters.nodes} | ${j.editors.mainCM.live+j.editors.embeddedCM.live}/${j.editors.pm.live}/${j.workers.live} | ${j.observers.IntersectionObserver.active}/${j.blobs.liveUrls}/${j.domMedia.canvasCount} |`)
}
lines.push('','## 补充交互三轮','','代码场景包括 200 块中的六个滚动位置、进入编辑/输入/Undo/退出；TXT 包含 2 MB 编辑和精确查找；PDF 包含 3→1→2 页和 150% 缩放；图片为 24MP 原始尺寸、放大、适应窗口。ready 包含整个操作序列与必要等待，不是单键输入延迟。PDF 导航包含每次 300 ms 稳定等待。', '',
 '| 场景 | ready ms 前→后 | WV Private 自然 前→后 | heap GC 前→后 | CM 嵌入峰值 前→后 | CPU 采样峰值% WV 前→后 |', '| --- | ---: | ---: | ---: | ---: | ---: |')
for(const id of reports.workloadsBefore.scenarios){const p=(fn,fmt)=>pair(id,fn,fmt,reports.workloadsBefore,reports.workloadsAfter)
 lines.push(`| ${id} | ${p(s=>s.sceneReadyMs)} | ${p(s=>s.preGc.native.webviewPrivate,bytes)} | ${p(s=>s.postGcStable.js.jsHeapUsed,bytes)} | ${p(s=>s.peaks.embeddedCmPeak)} | ${p(s=>s.extra.sampledCpuPercent.webview)} |`)
}
lines.push('', 'CPU 是采样区间内 TotalProcessorTime 差值 / 实际墙钟间隔 / 逻辑核心数，首个区间覆盖操作，不能捕获输入瞬间的峰值；原始长任务探针与操作延迟同时保留。图像指标仅包含可见 DOM 的解码尺寸及 Canvas 像素，不等于 GPU/native 解码总内存。', '',
 '## 原生模式切换与双 Pane 同步输入','',
 '模式测试每轮 30 次 Live→Source→Split→Live，共 90 次切换，逐次等待目标编辑器、预览以及两帧；记录包含驱动和帧等待。同步输入每轮严格挂载两个 Live Pane 后连续插入 30 次，验证精确规范文本、两边 Bridge、Undo 与干净状态；以下输入耗时为同步派发耗时，未包含下一帧绘制。表中是每轮中位数的三轮中位数。','',
 '| 操作 | ms 前→后 |', '| --- | ---: |')
for(const mode of ['source','split','live']){
  const p=pair('Z-mode-switch',s=>median(s.extra.switches.filter(x=>x.mode===mode).map(x=>x.ms)),round,reports.syncBefore,reports.syncAfter)
  lines.push(`| 切换至 ${mode} | ${p} |`)
}
lines.push(`| 双 Live Pane 单次插入 | ${pair('Z-multipane-input',s=>median(s.extra.inputMs),round,reports.syncBefore,reports.syncAfter)} |`, '',
 '| 原生场景 | CPU Rust 采样峰值% 前→后 | CPU WV 采样峰值% 前→后 | 长任务总时长 ms 前→后 |', '| --- | ---: | ---: | ---: |')
for(const id of reports.before.scenarios)lines.push(`| ${id} | ${pair(id,s=>s.extra.sampledCpuPercent.rust)} | ${pair(id,s=>s.extra.sampledCpuPercent.webview)} | ${pair(id,s=>s.preGc.js.longTasksTotalMs)} |`)
lines.push('', '关闭后回收曲线的 JSON 同时给出计划等待点及 JS/native 实际时间戳间隔；CIM 查询本身有耗时，计划的 0/500/1000/1500 ms 不等于精确的实时时刻。Observer 的 peak 字段为累计目标数峰值，active 为仍有显式注册目标的实例数；创建数是累计分配，不能当成存活数。', '', '## 证据标识','')
for(const [name,r]of Object.entries(reports))lines.push(`- ${name}: \`${r.evidence.path}\`, SHA-256 \`${r.evidence.sha256}\`; binary \`${r.build.sha256}\`.`)
fs.writeFileSync(path.join(output,'p0-native-comparison-20261028.md'),lines.join('\n')+'\n')
console.log('Generated P0 native comparison and all-round resource summaries')
