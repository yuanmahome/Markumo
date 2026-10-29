// Archive the exact measured binaries' results; never merge a later source build
// into a frozen comparison cohort. All aggregate values retain their raw inputs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const manifestPath = path.resolve(arg('manifest') || 'test-results/p03/campaign-1793265238810/manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath))
const output = path.resolve('docs/performance'), archive = path.join(output, 'p03-data-20261029')
fs.mkdirSync(archive, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const relative = file => path.relative(output, file).replaceAll('\\', '/')
const stats = values => {
  const raw = values.filter(Number.isFinite), ordered = [...raw].sort((a, b) => a - b)
  if (!raw.length) return { n: 0, raw: [] }
  const middle = Math.floor(raw.length / 2)
  return { n: raw.length, median: raw.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2, min: ordered[0], max: ordered.at(-1), raw }
}
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)]
const roleMemory = processes => {
  const result = {}
  for (const process of processes) {
    const row = result[process.role] ||= { private: 0, working: 0 }
    row.private += process.private; row.working += process.working
  }
  result.Total = { private: processes.reduce((n, p) => n + p.private, 0), working: processes.reduce((n, p) => n + p.working, 0) }
  result.WebView2 = { private: result.Total.private - (result.Rust?.private || 0), working: result.Total.working - (result.Rust?.working || 0) }
  return result
}
async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const expectedHashes = new Map()
async function editedHash(fixture) {
  if (expectedHashes.has(fixture.sha256)) return expectedHashes.get(fixture.sha256)
  const hash = createHash('sha256'), prefix = Buffer.alloc(5), handle = fs.openSync(fixture.file, 'r')
  fs.readSync(handle, prefix, 0, 5, 0); fs.closeSync(handle)
  hash.update(prefix); hash.update(Buffer.from('中😀'.repeat(30)))
  for await (const chunk of fs.createReadStream(fixture.file, { start: 5 })) hash.update(chunk)
  const result = hash.digest('hex'); expectedHashes.set(fixture.sha256, result); return result
}
const runs = [...manifest.runs]
if (arg('extra')) for (const [i, result] of arg('extra').split(',').entries()) {
  const report = JSON.parse(fs.readFileSync(result))
  runs.push({ cohort: report.cohort || `supplement-${i + 1}`, label: report.label, result, supplemental: true })
}
const reports = [], samples = [], failures = [], rawFiles = [], validations = []
for (const run of runs) {
  const bytes = fs.readFileSync(run.result), report = JSON.parse(bytes), prefix = `${run.cohort}-${run.label}`
  assert(report.completedAt, `Incomplete report: ${run.result}`)
  assert(report.controlledPreferences)
  assert.equal(report.transport, 'raw-CDP without Network/Debugger/GC')
  const archived = path.join(archive, `${prefix}.json.gz`), compressed = gzipSync(bytes)
  fs.writeFileSync(archived, compressed)
  rawFiles.push({ path: relative(archived), sha256: sha(compressed), originalSha256: sha(bytes), source: run.result })
  reports.push({ cohort: run.cohort, label: report.label, supplemental: !!run.supplemental, runtime: report.runtime, startedAt: report.startedAt, completedAt: report.completedAt,
    build: Object.fromEntries(['commit', 'ref', 'sha256', 'sourceInputsSha256', 'binary', 'instrumentation'].map(k => [k, report.build[k]])), runnerSha256: report.runnerSha256, os: report.os, hardware: report.hardware,
    fixtures: report.fixtures, raw: relative(archived), errors: report.errors })
  for (const sample of report.samples) {
    assert.deepEqual(sample.display, { width: 1200, height: 780, dpr: 1, screen: [2560, 1440] })
    assert(!Object.keys(sample.protocol || {}).some(k => /^(Network|Debugger|HeapProfiler)\./.test(k)))
    if (report.label === 'nomo') assert.deepEqual(sample.preferences, { themeMode: 'dark', softwareUpdateAutoCheckEnabled: false })
    const fixture = report.fixtures[sample.scene] || report.fixtures['100kb']
    const row = { cohort: run.cohort, run: sample.run, label: report.label, supplemental: !!run.supplemental, scene: sample.scene, pid: sample.pid, startupMs: sample.startupMs,
      status: sample.failure ? (/仅支持不超过/.test(sample.failure) ? 'open-rejected' : report.label === 'nomo' && /log$|^log/.test(sample.scene) ? 'unsupported-extension' : 'failed') : sample.saveRejected ? 'save-rejected' : sample.unsupported ? 'unsupported-action' : 'completed',
      failure: sample.failure || sample.saveRejected || sample.unsupported || null, stages: sample.points.map(point => ({ stage: point.stage, time: point.time, nativeTime: point.native.time,
        roles: roleMemory(point.native.processes), heapUsed: point.heapUsed, heapTotal: point.heapTotal, dom: point.dom, js: point.js })), operations: sample.operations, protocol: sample.protocol }
    if (row.status !== 'completed') failures.push({ cohort: row.cohort, label: row.label, scene: row.scene, status: row.status, failure: row.failure })
    if (sample.scene !== 'blank') {
      const file = path.join(sample.copyDir, sample.scene === 'tabs20' ? 'tab-19.txt' : path.basename(fixture.file))
      assert(fs.existsSync(file), `Missing preserved input: ${file}`)
      const actual = await fileHash(file), expected = sample.savedDisk ? await editedHash(fixture) : fixture.sha256
      assert.equal(actual, expected, `${prefix}/${sample.scene}: saved content mismatch`)
      if (sample.savedDisk) assert.equal(actual, sample.savedDisk.sha256)
      validations.push({ cohort: row.cohort, run: sample.run, label: row.label, scene: row.scene, mode: sample.savedDisk ? '30 insertions at UTF-16 position 5; whole-file SHA256 verified' : 'original unchanged', sha256: actual, bytes: fs.statSync(file).size })
    }
    if (sample.fastSampling) {
      assert.equal(sample.fastSampling.exitCode, 0)
      const native = fs.readFileSync(sample.fastSampling.file)
      assert.equal(sha(native), sample.fastSampling.sha256)
      const nativeRows = gunzipSync(native).toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
      assert.equal(nativeRows.length, sample.fastSampling.rows)
      assert(nativeRows.every(point => point.processes.filter(p => p.role === 'Rust').every(p => p.pid === sample.pid)))
      const target = path.join(archive, `${prefix}-run${sample.run}-${sample.scene}-native.jsonl.gz`)
      fs.writeFileSync(target, native)
      // Remove only an identical copy written by the earlier single-round
      // archive naming scheme, after its replacement has been saved.
      const previous = path.join(archive, `${prefix}-${sample.scene}-native.jsonl.gz`)
      if (sample.run === 1 && fs.existsSync(previous) && sha(fs.readFileSync(previous)) === sha(native)) fs.unlinkSync(previous)
      rawFiles.push({ path: relative(target), sha256: sha(native), source: sample.fastSampling.file })
      row.fastSampling = { ...sample.fastSampling, file: relative(target) }
    }
    samples.push(row)
  }
}
assert.equal(new Set(reports.map(report => report.runtime)).size, 1)
const groups = []
for (const label of [...new Set(samples.map(sample => sample.label))]) for (const scene of [...new Set(samples.filter(s => s.label === label).map(s => s.scene))]) {
  const rows = samples.filter(s => s.label === label && s.scene === scene), stages = {}, operations = {}
  for (const stage of [...new Set(rows.flatMap(row => row.stages.map(p => p.stage)))]) {
    const points = rows.map(row => row.stages.find(p => p.stage === stage)).filter(Boolean), roles = {}
    for (const role of [...new Set(points.flatMap(p => Object.keys(p.roles)))]) roles[role] = {
      private: stats(points.map(p => p.roles[role]?.private ?? 0)), working: stats(points.map(p => p.roles[role]?.working ?? 0)) }
    stages[stage] = { roles, heapUsed: stats(points.map(p => p.heapUsed)), js: points.map(p => p.js) }
  }
  for (const name of [...new Set(rows.flatMap(row => row.operations.map(op => op.name)))]) {
    const ops = rows.map(row => row.operations.find(op => op.name === name && op.ok)).filter(Boolean)
    operations[name] = { ms: stats(ops.map(op => op.ms)), inputMedianMs: stats(ops.map(op => op.value?.latencies && stats(op.value.latencies).median)), inputP95Ms: stats(ops.map(op => op.value?.latencies && quantile(op.value.latencies, .95))), values: ops.map(op => op.value ?? null),
      sampledPrivatePeak: stats(rows.map(row => row.fastSampling?.operations.find(op => op.name === name && op.sampleCount > 0)?.totalPrivate)) }
  }
  groups.push({ label, scene, attempts: rows.length, completed: rows.filter(r => r.status === 'completed').length, statuses: rows.map(r => r.status), startupMs: stats(rows.map(r => r.startupMs)), stages, operations })
}
const prototype = JSON.parse(fs.readFileSync('test-results/p03/prototype-1793265086749/results.json'))
const prototypeArchive = path.join(archive, 'prototype.json.gz'), protoBytes = gzipSync(Buffer.from(JSON.stringify(prototype)))
fs.writeFileSync(prototypeArchive, protoBytes); rawFiles.push({ path: relative(prototypeArchive), sha256: sha(protoBytes) })
const heapDiagnostics = []
for (const directory of ['heap-p03-base-4mb.txt-1793262681877', 'heap-p03-final-4mb.txt-1793263099762', 'heap-nomo-100mb.txt-1793262920215']) {
  const source = path.resolve('test-results/p03', directory), files = {}
  for (const name of fs.readdirSync(source).filter(name => name === 'metadata.json' || name.endsWith('.summary.json'))) files[name] = JSON.parse(fs.readFileSync(path.join(source, name)))
  const target = path.join(archive, directory + '.json.gz'), bytes = gzipSync(Buffer.from(JSON.stringify(files)))
  fs.writeFileSync(target, bytes); rawFiles.push({ path: relative(target), sha256: sha(bytes) })
  heapDiagnostics.push({ source, summaries: relative(target), method: 'separate invasive diagnostic; strong-edge retained size estimate; heap snapshots remain in ignored test-results' })
}
const result = { schemaVersion: 1, manifest: manifestPath, measuredAt: manifest.completedAt, metric: 'bytes; independent process/profile; Private Bytes is distinct from Task Manager memory',
  reports, samples, groups, failures, validations, rawFiles, heapDiagnostics, prototype: { ...prototype, samples: undefined, raw: relative(prototypeArchive), passed: prototype.samples.filter(s => s.passed).length, attempts: prototype.samples.length,
    groups: [...new Set(prototype.samples.map(s => s.size))].map(size => ({ size, stages: Object.fromEntries([...new Set(prototype.samples.filter(s => s.size === size).flatMap(s => s.stages.map(p => p.name)))].map(name => {
      const stages = prototype.samples.filter(s => s.size === size).map(s => s.stages.find(p => p.name === name)).filter(Boolean)
      return [name, { ms: stats(stages.map(p => p.ms)), private: stats(stages.map(p => p.native?.processes.reduce((n, p) => n + p.private, 0))), values: stages.map(p => p.value) }]
    })) })) } }
fs.writeFileSync(path.join(output, 'p03-release-results-20261029.json'), JSON.stringify(result) + '\n')
const fmt = (stat, divisor = 1) => stat?.n ? `${(stat.median / divisor).toFixed(2)} [${(stat.min / divisor).toFixed(2)}, ${(stat.max / divisor).toFixed(2)}] (${stat.n})` : '—'
const MiB = 1048576, names = { 'p03-base': 'Markumo 原版', 'p03-final': 'Markumo 修复', nomo: 'Nomo', 'p03-head-link': 'Markumo 最新 main（补充）' }
const labels = Object.fromEntries([...new Set(reports.map(report => report.label))].map(label => [label, names[label] || label]))
const lines = ['# P0.3 Windows Release 原始数据及对照表', '', '所有单元格为中位数 [最小值, 最大值] (n)。内存为 MiB，时延为 ms。工作集求和包含共享页重复计数，不代表物理内存独占量。JS Heap 是另一观测口径，不可与 Private Bytes 相加。', '',
  '主矩阵冻结在 4a94f0b + P0.3 修改；后续 main 的补测以单独标签列出，不能把冻结二进制称为最终源码构建。拒绝操作、缺测和失败没有按零内存处理。', '',
  '可复算的全部进程、PID、父进程、创建时间、Utility 子类型、每次原始采样及操作时间戳见 [结果 JSON](p03-release-results-20261029.json) 和其中 rawFiles 指向的 gzip 文件。完整性校验为离线流式 SHA256，不经过编辑器前端。', '',
  '## 构建身份', '', '| 应用 | 提交 | EXE SHA256 | Source SHA256 |', '|---|---|---|---|']
for (const label of Object.keys(labels)) {
  const r = reports.find(r => r.label === label)
  lines.push(`| ${labels[label]} | ${r.build.commit || '见 Nomo 构建元数据'} | ${r.build.sha256} | ${r.build.sourceInputsSha256 || '参考仓库提交及原始元数据'} |`)
}
lines.push('', '## 打开后的内存', '', '下表含成功打开但保存被拒绝的 16 MiB / 10 MiB JSON。它们的完整编辑验收没有通过。Nomo 100 MiB 的失败尝试另列于限制表。', '', '| 场景 | 应用 | 总 Private | Rust Private | WebView2 Private | JS Heap Used | 结果 |', '|---|---|---:|---:|---:|---:|---|')
for (const g of groups) {
  const p = g.stages.loaded
  lines.push(`| ${g.scene} | ${labels[g.label]} | ${fmt(p?.roles.Total.private, MiB)} | ${fmt(p?.roles.Rust.private, MiB)} | ${fmt(p?.roles.WebView2.private, MiB)} | ${fmt(p?.heapUsed, MiB)} | ${g.statuses.join(' / ')} |`)
}
lines.push('', '## WebView2 分进程 Private / Working Set', '', '每格为 Private / Working Set 的中位数，单位 MiB。两项原始分布分别保存在 JSON 中。Utility 为同场景各服务之和；原始文件保留各子类型。', '', '| 场景 | 应用 | Browser | Renderer | GPU | Utility | Crashpad | Rust | 总计 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|')
for (const g of groups) {
  const roles = g.stages.loaded?.roles
  if (!roles) continue
  lines.push(`| ${g.scene} | ${labels[g.label]} | ${['Browser', 'Renderer', 'GPU', 'Utility', 'crashpad-handler', 'Rust', 'Total'].map(role => roles[role] ? `${(roles[role].private.median / MiB).toFixed(2)} / ${(roles[role].working.median / MiB).toFixed(2)}` : '—').join(' | ')} |`)
}
lines.push('', '## 时延', '', '输入是 CM dispatch 到下一帧的 30 次程序化中文/Emoji 插入，分别对每轮中位数和 P95 再取三轮统计；不是键盘硬件或原生 IME 时延。冷启动包括 CDP 可用及应用启动就绪等待，不清空系统文件缓存。打开列是首个文件的操作时延，20 标签的每次打开及关闭后重新打开时延保留在原始 operations 中，不能把首个文件时延当成整批标签时延。搜索使用真实 UI；跳转是 80% 位置加载/滚动，不等价于大文件全局行号跳转。', '', '| 场景 | 应用 | 冷启动 | 首个打开 | 输入中位 | 输入 P95 | 搜索 | 跳转/滚动 | 保存 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|')
for (const g of groups) lines.push(`| ${g.scene} | ${labels[g.label]} | ${fmt(g.startupMs)} | ${fmt(g.operations.open?.ms)} | ${fmt(g.operations.input?.inputMedianMs)} | ${fmt(g.operations.input?.inputP95Ms)} | ${fmt(g.operations.search?.ms)} | ${fmt(g.operations['jump-scroll']?.ms)} | ${fmt(g.operations.save?.ms)} |`)
lines.push('', '## 读写期间采样峰值', '', '进程树总 Private，采样观测下界。没有采到短操作时显示 —，不能当作零。20 ms 为目标周期，实际间隔见 JSON 的 intervalMs；JS Heap 仅 250 ms 探针，不能证明捕获瞬时分配峰值。打开失败的超时同样留在原始文件中。', '', '| 场景 | 应用 | 打开峰值 | 保存峰值 |', '|---|---|---:|---:|')
for (const g of groups) lines.push(`| ${g.scene} | ${labels[g.label]} | ${fmt(g.operations.open?.sampledPrivatePeak, MiB)} | ${fmt(g.operations.save?.sampledPrivatePeak, MiB)} |`)
lines.push('', '## 关闭最后文档后的自然回收', '', '进程树总 Private；不强制 GC。自然等待采样自身有约 0.5 秒的进程清点成本，实际时间戳在 JSON 中。save-rejected 场景仅有 closed-rejected，不能伪装成完整曲线。', '', '| 场景 | 应用 | 新进程 cold | closed 0s | 1s | 5s | 15s |', '|---|---|---:|---:|---:|---:|---:|')
for (const g of groups) lines.push(`| ${g.scene} | ${labels[g.label]} | ${['cold', 'closed-0', 'closed-1000', 'closed-5000', 'closed-15000'].map(stage => fmt(g.stages[stage]?.roles.Total.private, MiB)).join(' | ')} |`)
lines.push('', '## 独立 Rust 原型', '', '下面是 CLI 原型，未加载 Tauri / WebView2，不能拿它的 Private 与应用进程树比较。保存是流式 saveCopy；不能视作原文件覆盖、完整编码或多窗口恢复验收。', '', '| 大小 | 打开 | 窗口读取 | 编辑 | 搜索 | saveCopy | 打开后 Rust Private MiB |', '|---|---:|---:|---:|---:|---:|---:|')
for (const g of result.prototype.groups) lines.push(`| ${g.size} | ${fmt(g.stages.open?.ms)} | ${fmt(g.stages.window?.ms)} | ${fmt(g.stages.edit?.ms)} | ${fmt(g.stages.search?.ms)} | ${fmt(g.stages.saveCopy?.ms)} | ${fmt(g.stages.open?.private, MiB)} |`)
lines.push('', '## 失败和边界', '', '| 轮次 | 应用 | 场景 | 状态 | 原因 |', '|---|---|---|---|---|')
for (const f of failures) lines.push(`| ${f.cohort} | ${labels[f.label]} | ${f.scene} | ${f.status} | ${f.failure.replaceAll('\n', ' ').replaceAll('|', '\\|')} |`)
lines.push('', `完整文件校验：${validations.length} 份，成功保存按独立期望串散列验证；拒绝/不支持按原始散列验证。Rust 原型 ${result.prototype.passed}/${result.prototype.attempts}。本表不证明 240 次循环平台期，也没有提供 ETW 原生分配归因。`, '')
fs.writeFileSync(path.join(output, 'p03-release-tables-20261029.md'), lines.join('\n'))
console.log(JSON.stringify({ reports: reports.length, samples: samples.length, verifiedFiles: validations.length, failures: failures.length, archiveBytes: rawFiles.reduce((n, file) => n + fs.statSync(path.join(output, file.path)).size, 0) }))
