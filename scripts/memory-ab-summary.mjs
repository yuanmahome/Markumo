import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const single = arg('single')
const root = path.resolve('test-results/phase042')

export function calcStats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, v) => s + v, 0) / n
  const median = n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  const stddev = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
  return {
    n,
    median: Number(median.toFixed(3)),
    max: Number(sorted[n - 1].toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    stddev: Number(stddev.toFixed(3)),
    values: values.map(v => Number(v.toFixed(3))),
  }
}

const mib = bytes => bytes / (1024 * 1024)

function extractScenarioMetrics(samples) {
  return {
    sceneReadyMs: calcStats(samples.map(s => s.sceneReadyMs)),
    rustPrivateMiB: calcStats(samples.map(s => mib(s.postGcStable.native.rustPrivate))),
    rustWorkingMiB: calcStats(samples.map(s => mib(s.postGcStable.native.rustWorking))),
    webviewPrivatePeakMiB: calcStats(samples.map(s => mib(s.peaks.sampledWebviewPrivateBytes))),
    webviewPrivateStableMiB: calcStats(samples.map(s => mib(s.postGcStable.native.webviewPrivate))),
    webviewWorkingPeakMiB: calcStats(samples.map(s => mib(s.peaks.sampledWebviewWorkingBytes))),
    webviewWorkingStableMiB: calcStats(samples.map(s => mib(s.postGcStable.native.webviewWorking))),
    jsHeapPeakMiB: calcStats(samples.map(s => mib(s.peaks.sampledJsHeapBytes))),
    jsHeapPreGcMiB: calcStats(samples.map(s => mib(s.preGc.js.jsHeapUsed))),
    jsHeapStableMiB: calcStats(samples.map(s => mib(s.postGcStable.js.jsHeapUsed))),
    domNodes: calcStats(samples.map(s => s.postGcStable.js.domCounters.nodes)),
    connectedDomNodes: calcStats(samples.map(s => s.postGcStable.js.domMedia.connectedDomNodes)),
    jsListeners: calcStats(samples.map(s => s.postGcStable.js.domCounters.jsEventListeners)),
    pmLive: calcStats(samples.map(s => s.preGc.js.editors.pm.live)),
    pmPeak: calcStats(samples.map(s => s.peaks.pmPeak)),
    mainCmLive: calcStats(samples.map(s => s.preGc.js.editors.mainCM.live)),
    mainCmPeak: calcStats(samples.map(s => s.peaks.mainCmPeak)),
    embeddedCmCreated: calcStats(samples.map(s => s.peaks.embeddedCmCreated)),
    embeddedCmPeak: calcStats(samples.map(s => s.peaks.embeddedCmPeak)),
    embeddedCmLive: calcStats(samples.map(s => s.preGc.js.editors.embeddedCM.live)),
    workersLive: calcStats(samples.map(s => s.preGc.js.workers.live)),
    workersPeak: calcStats(samples.map(s => s.peaks.workerPeak)),
    renderTasksPeak: calcStats(samples.map(s => s.peaks.renderTaskPeak)),
    highlightRuns: calcStats(samples.map(s => s.peaks.highlightRuns)),
    blobUrlsLive: calcStats(samples.map(s => s.preGc.js.blobs.liveUrls)),
    blobUrlsPeak: calcStats(samples.map(s => s.peaks.blobUrlsPeak)),
    blobActiveKiB: calcStats(samples.map(s => s.preGc.js.blobs.activeBytes / 1024)),
    blobPeakKiB: calcStats(samples.map(s => s.peaks.blobBytesPeak / 1024)),
    decodedImageMP: calcStats(samples.map(s => s.peaks.decodedImagePixelsPeak / 1_000_000)),
    canvasMP: calcStats(samples.map(s => s.peaks.canvasPixelsPeak / 1_000_000)),
    longTasksCount: calcStats(samples.map(s => s.postGcStable.js.longTasksCount)),
    longTasksTotalMs: calcStats(samples.map(s => s.postGcStable.js.longTasksTotalMs)),
    afterCloseNatural1500HeapMiB: calcStats(samples.map(s => mib(s.afterClose.natural.at(-1).js.jsHeapUsed))),
    afterClosePostGcHeapMiB: calcStats(samples.map(s => mib(s.afterClose.postGc.js.jsHeapUsed))),
    afterClosePostGcWvPrivMiB: calcStats(samples.map(s => mib(s.afterClose.postGc.native.webviewPrivate))),
    afterCloseEmbeddedCm: calcStats(samples.map(s => s.afterClose.postGc.js.editors.embeddedCM.live)),
    afterCloseWorkers: calcStats(samples.map(s => s.afterClose.postGc.js.workers.live)),
  }
}

function summarizeReport(label) {
  const file = path.join(root, `native-${label}`, 'results.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const byScenario = {}
  for (const scenario of raw.scenarios) {
    const items = raw.samples.filter(s => s.scenario === scenario)
    assert(items.length >= 1, `Missing samples for ${label}/${scenario}`)
    byScenario[scenario] = extractScenarioMetrics(items)
  }
  return { meta: { commit: raw.build.commit, sha256: raw.build.sha256, webviewRuntime: raw.webviewRuntime, os: raw.os, hardware: raw.hardware, display: raw.display, errors: raw.errors }, byScenario }
}

if (single) {
  const s = summarizeReport(single)
  fs.writeFileSync(path.join(root, `summary-${single}.json`), JSON.stringify(s, null, 2))
  console.log(`=== Phase 04.2 Single Summary (${single}) ===`)
  console.log(`Commit: ${s.meta.commit} | Binary SHA256: ${s.meta.sha256}`)
  console.log(`WebView2: ${s.meta.webviewRuntime} | Errors: ${s.meta.errors.length}`)
  console.log('| Scenario | Ready ms | WV Priv (med/max) MiB | WV WS MiB | Heap Peak/Stable MiB | DOM | PM | MainCM | EmbCM (live/peak/new) | Workers (live/peak) | Blob URLs / KiB | Img/Canvas MP | PostClose WV/Heap MiB |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const [sc, m] of Object.entries(s.byScenario)) {
    console.log(
      `| ${sc} | ${m.sceneReadyMs.median.toFixed(0)} | ${m.webviewPrivateStableMiB.median.toFixed(2)} / ${m.webviewPrivatePeakMiB.max.toFixed(2)} | ${m.webviewWorkingStableMiB.median.toFixed(2)} | ${m.jsHeapPeakMiB.max.toFixed(2)} / ${m.jsHeapStableMiB.median.toFixed(2)} | ${m.domNodes.median.toFixed(0)} | ${m.pmLive.median} | ${m.mainCmLive.median} | ${m.embeddedCmLive.median}/${m.embeddedCmPeak.max}/${m.embeddedCmCreated.median} | ${m.workersLive.median}/${m.workersPeak.max} | ${m.blobUrlsPeak.max} / ${m.blobPeakKiB.max.toFixed(0)} | ${m.decodedImageMP.max.toFixed(2)} / ${m.canvasMP.max.toFixed(2)} | ${m.afterClosePostGcWvPrivMiB.median.toFixed(2)} / ${m.afterClosePostGcHeapMiB.median.toFixed(2)} |`
    )
  }
} else {
  const before = summarizeReport('before')
  const after = summarizeReport('after')
  assert.equal(before.meta.webviewRuntime, after.meta.webviewRuntime, 'WebView2 runtime version must match for A/B comparison')
  const combined = { generatedAt: new Date().toISOString(), before, after }
  fs.writeFileSync(path.join(root, 'summary-ab.json'), JSON.stringify(combined, null, 2))
  console.log('=== Phase 04.2 A/B Summary (before -> after) ===')
  console.log('| Scenario | EmbCM Live | EmbCM Peak | Heap Peak MiB | Heap Stable MiB | DOM Nodes | WV Priv Stable MiB | WV Priv Peak MiB | Ready ms |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const sc of Object.keys(before.byScenario)) {
    const a = before.byScenario[sc]
    const b = after.byScenario[sc]
    console.log(
      `| ${sc} | ${a.embeddedCmLive.median} → ${b.embeddedCmLive.median} | ${a.embeddedCmPeak.max} → ${b.embeddedCmPeak.max} | ${a.jsHeapPeakMiB.max.toFixed(2)} → ${b.jsHeapPeakMiB.max.toFixed(2)} | ${a.jsHeapStableMiB.median.toFixed(2)} → ${b.jsHeapStableMiB.median.toFixed(2)} | ${a.domNodes.median.toFixed(0)} → ${b.domNodes.median.toFixed(0)} | ${a.webviewPrivateStableMiB.median.toFixed(2)} → ${b.webviewPrivateStableMiB.median.toFixed(2)} | ${a.webviewPrivatePeakMiB.max.toFixed(2)} → ${b.webviewPrivatePeakMiB.max.toFixed(2)} | ${a.sceneReadyMs.median.toFixed(0)} → ${b.sceneReadyMs.median.toFixed(0)} |`
    )
  }
}
