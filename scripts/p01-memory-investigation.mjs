// Windows Release only. Natural acceptance and invasive profiling run in
// different processes; no GC or memory pressure in the acceptance matrix.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { ensurePhase042Fixtures } from './memory-fixtures.mjs'

assert.equal(process.platform, 'win32')
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const label = arg('label')
assert(label && /^[\w-]+$/.test(label))
const mode = arg('mode') || 'isolated'
const rawCdp = process.argv.includes('--raw-cdp')
const networkCacheControl = process.argv.includes('--network-cache-control')
assert(['isolated', 'sequence', 'profile'].includes(mode))
assert(!networkCacheControl || (mode === 'profile' && rawCdp), 'Network cache control is a separate diagnostic process only')
const rounds = Number(arg('rounds') || 3)
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 5)
const root = path.resolve('test-results/phase042'), out = path.resolve(`test-results/p01/${label}-${mode}-${Date.now()}`)
fs.mkdirSync(out, { recursive: true })
const build = JSON.parse(fs.readFileSync(path.join(root, `build-${label}.json`)))
const config = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(fs.readFileSync(build.binary)), build.sha256)
const fixtureDir = path.join(root, 'fixtures'), fixtures = ensurePhase042Fixtures(fixtureDir)
const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const allScenes = ['blank', 'ordinary', 'code200', 'text2mb', 'panes', 'pdf', 'image', 'markdown-image', 'split', 'same240', 'mixed240']
const scenes = (arg('scenes') || allScenes.join(',')).split(',')
assert(scenes.every(scene => allScenes.includes(scene) || ['text-exact2mib','math-images'].includes(scene)))
if (scenes.includes('text-exact2mib')) {
  const line = '[2026-10-28] INFO Markumo fixed size text fixture; preserve full editing and undo history.\n'
  const bytes = Buffer.from(line.repeat(Math.ceil(2097152 / line.length))).subarray(0, 2097152)
  fs.writeFileSync(path.join(fixtureDir, 'text-exact-2mib.txt'), bytes)
  fixtures['text-exact-2mib.txt'] = { bytes: bytes.length, sha256: sha(bytes) }
}
const report = { label, mode, rounds, transport:networkCacheControl?'raw-cdp-network-control':rawCdp?'raw-cdp-no-network':'playwright', build, fixtures, runnerSha256: sha(fs.readFileSync(new URL(import.meta.url))), startedAt: new Date().toISOString(), os: { release: os.release(), version: os.version(), arch: os.arch() }, hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, memory: os.totalmem() }, samples: [], errors: [], profiling: mode === 'profile', out }
const persist = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2))
const native = async pid => JSON.parse((await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/p01-process-tree.ps1'), '-RootPid', String(pid)], { windowsHide: true })).stdout)
let child, browser, page, cdp, bc, traceEvents, traceDumps, current, tracing = false
async function optional(method, params = {}, session = cdp) {
  let timer
  try { return await Promise.race([session.send(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Diagnostic command exceeded 20s')), 20000) })]) } catch (error) { return { unsupported: String(error) } }
  finally { clearTimeout(timer) }
}
async function sample(stage, extra = {}) {
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const js = await page.evaluate(() => {
    const m = window.__nativeManager, p = window.__markumoMemoryProbe
    const sizes = {}
    for (const key of ['records', 'views', 'liveViews', 'liveLoads', 'hosts', 'paneNavigation', 'deferred', 'listeners', 'releaseListeners']) sizes[key] = m[key]?.size
    return { visibility:document.visibilityState, focused:document.hasFocus(), editors: p.editors, workers: p.workers, blobs: p.blobs, observers: p.observers, tasks: p.tasks, media: window.__collectDomMediaMetrics(), manager: sizes, openTabs: m.openedDocuments.length }
  })
  const record = { stage, workload: current.scene, time: Date.now(), ...extra, heapUsed: metrics.JSHeapUsedSize, heapTotal: metrics.JSHeapTotalSize, dom: await cdp.send('Memory.getDOMCounters'), js, native: await native(child.pid) }
  if (mode === 'profile') {
    record.heapUsage = await cdp.send('Runtime.getHeapUsage')
    record.workerTargets = (await bc.send('Target.getTargets')).targetInfos.filter(t => ['worker','dedicated_worker','service_worker'].includes(t.type)).map(t => ({ id:t.targetId, type:t.type, url:t.url }))
  }
  current.points.push(record); persist()
  return record
}
async function readyFrames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function open(name, kind) {
  const id = await page.evaluate(async file => {
    const f = await window.__TAURI_INTERNALS__.invoke('open_recent', { path: file, encoding: null })
    const m = window.__nativeManager, id = m.openFile(f, false, m.activePane, true)
    if (!id) throw Error('Rejected fixture ' + file)
    return id
  }, path.join(fixtureDir, name))
  await page.waitForFunction(kind => {
    const m = window.__nativeManager
    if (kind === 'pdf') { const c = document.querySelector('.pdf-page canvas'); return c && c.width > 0 && c.height > 0 }
    if (kind === 'image') { const i = document.querySelector('.image-stage img'); return i?.complete && i.naturalWidth === 6000 }
    if (kind === 'text') return !!document.querySelector('.editor-host > .cm-editor')
    const editor = m.activeLiveEditor
    return editor && editor.bridge.source === m.getText(m.activeId)
  }, kind || 'markdown', { timeout: 30000 })
  if (kind === 'mdimage') await page.waitForFunction(() => { const imgs = [...document.querySelectorAll('.markdown-live .md-live-image img')]; return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0) })
  await readyFrames()
  if (mode === 'profile') await page.evaluate(() => {
    const editor = window.__nativeManager.activeLiveEditor
    const witnesses = window.__p01WeakEditors ||= []
    if (editor && witnesses.length < 16) witnesses.push({ editor: new WeakRef(editor), bridge: new WeakRef(editor.bridge), record: new WeakRef(window.__nativeManager.records.get(window.__nativeManager.activeId)), name: editor.constructor.name, bridgeName: editor.bridge.constructor.name })
  })
  return id
}
async function close() {
  await page.evaluate(() => { const m = window.__nativeManager; m.mergeAllPanes(); for (const d of [...m.openedDocuments]) if (!m.close(d.id, true)) throw Error('Close failed') })
  await page.waitForFunction(() => { const p = window.__markumoMemoryProbe; return window.__nativeManager.openedDocuments.length === 0 && Object.values(p.editors).every(e => e.live === 0) && p.workers.live === 0 && !document.querySelector('.pdf-page canvas, .image-stage img') })
  await readyFrames()
}
async function curve(scene) {
  const start = Date.now()
  const points = ['same240', 'mixed240', 'blank'].includes(scene) ? [0, 1000, 5000, 15000, 30000, 60000] : [0, 1000, 5000]
  for (const plannedMs of points) {
    await wait(Math.max(0, start + plannedMs - Date.now()))
    await sample('closed-natural', { plannedMs, elapsedMs: Date.now() - start })
  }
}
async function dump(tag) {
  const metrics=await cdp.send('Performance.getMetrics'),timestamp=metrics.metrics.find(m=>m.name==='Timestamp')?.value
  const syncId=`p01-${current.run}-${current.scene}-${tag}-${traceDumps.length}`
  await optional('Tracing.recordClockSyncMarker',{syncId},bc)
  traceDumps.push({ tag, time: Date.now(), cdpTimestamp:timestamp, syncId, result: await optional('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'detailed' }, bc), processes: await native(child.pid) })
}
async function snapshot(tag) {
  const file = path.join(out, `${current.run}-${current.scene}-${tag}.heapsnapshot`), fd = fs.openSync(file, 'w')
  const listener = ({ chunk }) => fs.writeSync(fd, chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', listener)
  try { await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true, exposeInternals: true }) }
  finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', listener); fs.closeSync(fd) }
  current.snapshots ||= []; current.snapshots.push({ tag, file, sha256: sha(fs.readFileSync(file)) }); persist()
}
async function start(run, scene) {
  const profile = path.resolve(config.app.appDirectoriesOverride)
  assert.equal(profile, path.join(root, `native-profile-${label}`))
  // Preserve earlier profiles; every process gets new app and WebView storage.
  if (fs.existsSync(profile)) fs.renameSync(profile, `${profile}-p01-backup-${Date.now()}`)
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'editor-settings.json'), JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false }))
  fs.writeFileSync(path.join(profile, 'files.json'), JSON.stringify({ recent: Object.keys(fixtures).map(name => ({ path: path.join(fixtureDir, name), name })), layout: { mode: 'single', sidebarVisible: false, sidebarWidth: 240 } }))
  fs.writeFileSync(path.join(profile, 'last-session.json'), JSON.stringify({ schemaVersion: 1, kind: 'single', roots: [], tabs: [], activePath: null, layout: { mode: 'single', sidebarVisible: false, sidebarWidth: 240 } }))
  const udf = path.join(out, `webview-${run}-${scene}`)
  // Avoid reusing a killed browser's debug socket or an HTTP keep-alive pool.
  const reservation=net.createServer()
  await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve)})
  const port=reservation.address().port
  await new Promise(resolve=>reservation.close(resolve))
  const started = performance.now()
  child = spawn(build.binary, [], { windowsHide: true, stdio: 'pipe', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: udf, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
  current = { run, scene, pid: child.pid, udf, port, points: [] }; report.samples.push(current); persist()
  const spawned=child
  spawned.once('exit',(code,signal)=>{if(current?.pid===spawned.pid){current.processExit={code,signal,time:Date.now(),expected:!!current.expectedTermination};persist()}})
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000);if(current?.pid===spawned.pid){current.stderr=stderr;persist()} })
  const deadline = Date.now() + 45000
  for (;;) {
    assert.equal(child.exitCode, null, stderr)
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500)})).ok) break } catch {}
    assert(Date.now() < deadline, 'CDP startup timeout'); await wait(100)
  }
  browser = rawCdp ? await (await import('./p01-raw-cdp.mjs')).connectRawCDP(`http://127.0.0.1:${port}`) : await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  assert(!report.runtime || report.runtime === browser.version(), 'Runtime changed during test'); report.runtime = browser.version()
  page = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:'))
  page.on('pageerror', error => { report.errors.push({ run, scene, error: String(error) }); persist() })
  page.on('console', msg => { if (msg.type() === 'error') { report.errors.push({ run, scene, console: msg.text() }); persist() } })
  await page.waitForFunction(() => window.__nativeManager && document.querySelector('.app:not([inert])') && !document.querySelector('.startup-overlay'))
  cdp = await page.context().newCDPSession(page); bc = await browser.newBrowserCDPSession()
  if (networkCacheControl) await cdp.send('Network.enable')
  await cdp.send('Performance.enable')
  const display = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screen: [screen.width, screen.height] }))
  assert(!report.display || JSON.stringify(display) === JSON.stringify(report.display), 'Window geometry changed'); report.display = display
  Object.assign(current, { display, startupMs: performance.now() - started }); persist()
  await wait(2000); await sample('cold')
  if (mode === 'profile') {
    traceEvents = []; traceDumps = []
    current.gpuInfo = await optional('SystemInfo.getInfo', {}, bc)
    bc.on('Tracing.dataCollected', ({ value }) => { for (const event of value) if (event.ph === 'v' || event.ph === 'M' || event.name === 'clock_sync') traceEvents.push(event) })
    await bc.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordContinuously', traceBufferSizeInKb: 16384, excludedCategories: ['*'], includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } } }); tracing = true
    await wait(500); await dump('cold'); await snapshot('cold'); await sample('diagnostic-cold-after-snapshot')
    if(process.argv.includes('--native-sampling'))current.nativeSampling=await optional('Memory.startSampling',{samplingInterval:1048576,suppressRandomness:true})
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 })
  }
}
async function stop() {
  if (current && browser?.protocolCommandCounts) { current.protocolCommands = browser.protocolCommandCounts(); persist() }
  if (current && browser?.transportStatus) { current.transportStatus=browser.transportStatus();persist() }
  if (tracing && bc) {
    const complete = new Promise(resolve => bc.once('Tracing.tracingComplete', resolve))
    await bc.send('Tracing.end'); tracing = false; await complete
    const file = path.join(out, `trace-${current.run}-${current.scene}.json`)
    fs.writeFileSync(file, JSON.stringify({ traceEvents, dumps: traceDumps }))
    current.trace = { file, sha256: sha(fs.readFileSync(file)), dumps: traceDumps }; persist()
  }
  if (child?.exitCode === null) { current.expectedTermination=true;await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}) }
  await browser?.close().catch(() => {}); child = browser = page = cdp = bc = undefined
  await wait(500)
}
async function exercise(scene) {
  console.log('SCENE', label, mode, current.run, scene)
  const started = performance.now()
  if (scene === 'blank') await wait(3000)
  if (scene === 'ordinary') await open('doc-ordinary.md')
  if (scene === 'math-images') await open('doc-5kb-2img.md', 'mdimage')
  if (scene === 'code200') { await open('code-200.md'); assert.equal(await page.locator('.md-code-block').count(), 200) }
  if (scene === 'text2mb') await open('large-2mb.txt', 'text')
  if (scene === 'text-exact2mib') await open('text-exact-2mib.txt', 'text')
  if (scene === 'pdf') await open('sample-multi.pdf', 'pdf')
  if (scene === 'image') await open('img-large-24mp.png', 'image')
  if (scene === 'markdown-image') await open('doc-large-image.md', 'mdimage')
  if (scene === 'split') {
    const id = await open('doc-split.md')
    await page.evaluate(id => window.__nativeManager.setMarkdownMode(id, 'split'), id)
    await page.waitForFunction(() => !!document.querySelector('.split-preview-pane') && !!document.querySelector('.editor-host > .cm-editor'))
    await wait(1000)
  }
  if (scene === 'panes') {
    await open('multi-pane.md', 'mdimage')
    for (let i = 1; i <= 60; i++) {
      await page.evaluate(() => window.__nativeManager.splitPane('right'))
      await page.waitForFunction(() => window.__nativeManager.liveViews.size === 2)
      await readyFrames()
      await page.evaluate(() => window.__nativeManager.mergeAllPanes())
      await page.waitForFunction(() => window.__nativeManager.liveViews.size === 1)
      if ([30,60].includes(i)) await sample('panes-checkpoint', { cycle: i })
    }
  }
  if (scene === 'same240' || scene === 'mixed240') {
    for (let cycle = 1; cycle <= 240; cycle++) {
      const a = await open(scene === 'same240' ? 'doc-ordinary.md' : 'code-50.md')
      if (scene === 'mixed240') {
        const b = await open('doc-5kb-2img.md', 'mdimage')
        await page.evaluate(({ a, b }) => { const m = window.__nativeManager; m.select(a); m.setMarkdownMode(a, 'source'); m.setMarkdownMode(a, 'live'); m.select(b) }, { a, b })
        await readyFrames()
      }
      await close()
      if (cycle % 15 === 0) {
        await wait(500); const s = await sample('cycle-closed', { cycle })
        console.log(label, mode, current.run, scene, cycle, (s.native.processes.filter(p => p.role !== 'Rust').reduce((n,p) => n+p.private,0)/1048576).toFixed(2))
        if (mode === 'profile' && [30,120,240].includes(cycle)) await dump(`cycle-${cycle}`)
      }
    }
  }
  current.operations ||= []; current.operations.push({ scene, durationMs: performance.now() - started })
  await wait(1000); await sample('loaded', { workload: scene })
  if(mode==='profile')await page.evaluate(()=>{
    const views=window.__p01WeakViews||=[]
    for(const view of window.__nativeManager.views.values())if(views.length<16)views.push(new WeakRef(view))
    const surfaces=window.__p01WeakSurfaces||=[]
    for(const element of document.querySelectorAll('.split-preview-pane,.image-viewer,.pdf-viewer'))if(surfaces.length<16)surfaces.push(new WeakRef(element))
  })
  if (process.argv.includes('--assert-released')) {
    const coverage=await page.evaluate(()=>({editors:window.__p01WeakEditors?.length||0,views:window.__p01WeakViews?.length||0,surfaces:window.__p01WeakSurfaces?.length||0}))
    if(['ordinary','math-images','split'].includes(scene))assert(coverage.editors>0,'No Live editor witness was captured')
    if(scene==='split')assert(coverage.views>0,'No Source view witness was captured')
    if(['split','pdf','image'].includes(scene))assert(coverage.surfaces>0,'No preview/media host witness was captured')
  }
  if (scene === 'text-exact2mib') {
    current.textIntegrity = await page.evaluate(() => {
      const m=window.__nativeManager,id=m.activeId,original=m.getText(id),at=Math.floor(original.length/2)
      const expected=original.slice(0,at)+'中'+original.slice(at)
      m.dispatch(id,{changes:{from:at,insert:'中'},userEvent:'input.type'})
      if(m.getText(id)!==expected||!m.metadata(id).dirty)throw Error('2 MiB insert lost text')
      m.command('undo')
      if(m.getText(id)!==original||m.metadata(id).dirty)throw Error('2 MiB Undo did not restore baseline')
      m.command('redo')
      if(m.getText(id)!==expected||m.saveSnapshot(id).text!==expected)throw Error('2 MiB Redo/save snapshot differs')
      m.command('undo')
      if(m.getText(id)!==original||m.metadata(id).dirty)throw Error('2 MiB final Undo differs')
      return {characters:original.length,insertUndoRedoAndSaveSnapshot:true,finalClean:true}
    })
    await readyFrames(); await sample('after-edit-undo-redo')
  }
  if (mode === 'profile') await dump('loaded-' + scene)
  await close(); await curve(scene)
  console.log('CLOSED', label, mode, current.run, scene)
  if (mode === 'profile') {
    await dump('natural-' + scene)
    // Explicit diagnostic only; never run in isolated/sequence acceptance.
    await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage')
    current.weakWitnesses = await page.evaluate(() => (window.__p01WeakEditors || []).map(w => ({ name: w.name, bridgeName: w.bridgeName, editorAlive: !!w.editor.deref(), bridgeAlive: !!w.bridge.deref(), recordAlive: !!w.record.deref() })))
    current.weakViews=await page.evaluate(()=>(window.__p01WeakViews||[]).map(view=>!!view.deref()))
    current.weakSurfaces=await page.evaluate(()=>(window.__p01WeakSurfaces||[]).map(view=>!!view.deref()))
    await sample('diagnostic-gc'); await dump('gc-' + scene)
    if (networkCacheControl) {
      await cdp.send('Network.disable')
      await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage')
      await wait(1000)
      await sample('diagnostic-network-disabled'); await dump('network-disabled-' + scene)
    }
    await snapshot('closed-' + scene)
    await sample('diagnostic-after-snapshot'); await dump('after-snapshot-' + scene)
    current.allocations = await cdp.send('HeapProfiler.getSamplingProfile')
    if(process.argv.includes('--native-sampling')){
      current.nativeProfile=await optional('Memory.getSamplingProfile')
      current.nativeSamplingStopped=await optional('Memory.stopSampling')
    }
    await sample('diagnostic-after-allocation-profile')
    current.pressureResponse = await optional('Memory.simulatePressureNotification', { level: 'critical' })
    for (const delay of [1000, 5000, 15000]) {
      await wait(delay === 1000 ? 1000 : delay === 5000 ? 4000 : 10000)
      await sample('diagnostic-pressure', { plannedMs: delay })
    }
    await dump('pressure-' + scene)
    if (process.argv.includes('--assert-released')) assert(current.weakWitnesses.every(w => !w.editorAlive && !w.bridgeAlive && !w.recordAlive)&&current.weakViews.every(alive=>!alive)&&current.weakSurfaces.every(alive=>!alive), 'Closed document/editor retained after diagnostic GC; inspect heap snapshot')
  }
}
try {
  for (let run = 1; run <= rounds; run++) {
    if (mode === 'sequence') {
      await start(run, 'fixed-sequence')
      for (const scene of scenes) { current.scene = scene; await exercise(scene) }
      await stop()
    } else for (const scene of scenes) { await start(run, scene); await exercise(scene); await stop() }
  }
  report.completedAt = new Date().toISOString(); report.passed = report.errors.length === 0; persist()
  assert(report.passed, 'Release page reported errors; inspect results.json')
  console.log('COMPLETE', out)
} catch (error) {
  if(child?.pid)report.failureProcessTree=await native(child.pid).catch(error=>({error:String(error)}))
  if (page) report.debug = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0,3000), probe: !!window.__markumoMemoryProbe, manager: !!window.__nativeManager, scripts: [...document.scripts].map(s => s.src) })).catch(() => null)
  report.failure = String(error.stack || error); persist(); throw error
} finally { await stop() }
