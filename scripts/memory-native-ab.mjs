// Real Windows WebView2 Release memory & lifecycle suite for Phase 04.2 (Scenarios A-M + Large TXT check).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { ensurePhase042Fixtures } from './memory-fixtures.mjs'

assert.equal(process.platform, 'win32', 'Windows WebView2 Release measurement requires win32')
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3)
const label = arg('label') || 'before'
const rounds = Number(arg('rounds') || 3)
const cycles = Number(arg('cycles') || 20)
assert(Number.isInteger(cycles) && cycles >= 1 && cycles <= 120, 'Cycles must be 1..120')
assert(/^[\w-]+$/.test(label), `Invalid label: ${label}`)
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5, `Invalid rounds: ${rounds}`)

const root = path.resolve('test-results/phase042')
const out = path.join(root, `native-${label}`)
fs.mkdirSync(out, { recursive: true })

const build = JSON.parse(fs.readFileSync(path.join(root, `build-${label}.json`), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(fs.readFileSync(build.binary)), build.sha256, 'Binary SHA256 mismatch with build record')

const config = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`), 'utf8'))
const profile = config.app.appDirectoriesOverride
fs.mkdirSync(profile, { recursive: true })

const fixtureDir = path.join(root, 'fixtures')
const fixtureManifest = ensurePhase042Fixtures(fixtureDir)

const SCENARIOS = [
  'A-blank',
  'B-md-5kb-2img',
  'C-md-live',
  'D-md-source',
  'E-md-split',
  'F-code-50',
  'G-code-100',
  'H-code-200',
  'I-multi-pane',
  'J-large-image-viewer',
  'J2-md-large-image',
  'K-pdf-viewer',
  `L-open-switch-close-${cycles}`,
  'M-post-close-recovery',
  'X-large-txt-2mb',
]

const nativeSamplerPs1 = path.join(root, 'sample-process-tree.ps1')
fs.writeFileSync(
  nativeSamplerPs1,
  `param([int]$RootPid, [int]$Samples = 1, [int]$DelayMs = 250)
for ($i = 1; $i -le $Samples; $i++) {
  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootPid)
  $rows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name)
  do {
    $added = $false
    foreach ($r in $rows) {
      if ($ids.Contains([int]$r.ParentProcessId) -and $ids.Add([int]$r.ProcessId)) {
        $added = $true
      }
    }
  } while ($added)
  $nativeProc = Get-Process -Id $RootPid -ErrorAction Stop
  $wvProcs = @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'msedgewebview2')
  [pscustomobject]@{
    time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    rustPrivate = [long]$nativeProc.PrivateMemorySize64
    rustWorking = [long]$nativeProc.WorkingSet64
    webviewPrivate = [long](($wvProcs | Measure-Object PrivateMemorySize64 -Sum).Sum)
    webviewWorking = [long](($wvProcs | Measure-Object WorkingSet64 -Sum).Sum)
    webviewProcesses = [int]$wvProcs.Count
  } | ConvertTo-Json -Compress
  if ($i -lt $Samples) { Start-Sleep -Milliseconds $DelayMs }
}
`
)

const execAsync = promisify(execFile)
const wait = ms => new Promise(r => setTimeout(r, ms))

const report = {
  kind: 'Windows WebView2 native Release (Phase 04.2)',
  label,
  rounds,
  cycles,
  startups: [],
  build,
  os: { release: os.release(), version: os.version(), arch: os.arch() },
  hardware: {
    cpu: os.cpus()[0]?.model || 'unknown',
    logicalCPUs: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  fixtures: fixtureManifest,
  scenarios: SCENARIOS,
  startedAt: new Date().toISOString(),
  viewport: { width: 1200, height: 780 },
  samples: [],
  errors: [],
  unmeasuredMetrics: [
    'GPU-internal or Chromium blink::ImageDecodeCache detached decoded bitmaps not attached to connected <img>/<canvas> elements cannot be introspected from JS/CDP; decodedImagePixels and canvasPixels report connected DOM element natural/backing pixel totals.',
  ],
}

const persist = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2))

async function sampleNative(pid, count = 1, delayMs = 250) {
  const { stdout } = await execAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativeSamplerPs1, '-RootPid', String(pid), '-Samples', String(count), '-DelayMs', String(delayMs)],
    { windowsHide: true }
  )
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

let child
let browser
try {
  const allFixtureNames = Object.keys(fixtureManifest)
  for (let run = 1; run <= rounds; run++) {
    fs.writeFileSync(
      path.join(profile, 'editor-settings.json'),
      JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false })
    )
    fs.writeFileSync(
      path.join(profile, 'files.json'),
      JSON.stringify({
        recent: allFixtureNames.map(name => ({
          path: path.join(fixtureDir, name),
          name,
        })),
        layout: { mode: 'single', sidebarVisible: false, sidebarWidth: 240 },
      })
    )
    fs.writeFileSync(
      path.join(profile, 'last-session.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'single',
        roots: [],
        tabs: [],
        activePath: null,
        layout: { mode: 'single', sidebarVisible: false, sidebarWidth: 240 },
      })
    )

    const port = 9610 + (label === 'after' ? 20 : label === 'before' ? 0 : 40) + run
    const webProfile = path.join(out, `webview-${Date.now()}-r${run}`)
    const tempDir = path.join(root, 'tmp')
    fs.mkdirSync(tempDir, { recursive: true })

    const processStarted = performance.now()
    child = spawn(build.binary, [], {
      windowsHide: true,
      env: {
        ...process.env,
        TEMP: tempDir,
        TMP: tempDir,
        WEBVIEW2_USER_DATA_FOLDER: webProfile,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      },
      stdio: 'pipe',
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })

    const deadline = Date.now() + 45000
    while (true) {
      if (child.exitCode !== null) throw new Error(`Native app exited early (${child.exitCode}): ${stderr}`)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (res.ok) break
      } catch {}
      assert(Date.now() < deadline, 'Timed out waiting for WebView2 CDP endpoint')
      await wait(120)
    }

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    report.webviewRuntime = browser.version()
    const page = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:'))
    assert(page, 'Failed to locate main Tauri WebView2 page')

    page.on('pageerror', err => report.errors.push(`[run ${run}] pageerror: ${err.message}`))
    page.on('console', msg => {
      if (msg.type() === 'error') report.errors.push(`[run ${run}] console.error: ${msg.text()}`)
    })

    await page.waitForFunction(
      () => document.querySelector('.app:not([inert])') && !document.querySelector('.startup-overlay'),
      null,
      { timeout: 25000 }
    )
    report.startups.push({run, processToObservedReadyMs: performance.now() - processStarted})

    const display = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
    }))
    if (!report.display) report.display = display

    await page.evaluate(() => {
      if (!window.__nativeManager || !window.__markumoMemoryProbe) {
        throw new Error('Phase 04.2 native probe or DocumentManager missing')
      }
    })

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const browserCdp = await browser.newBrowserCDPSession()

    const collectJsMetrics = async () => {
      const perf = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
      const domCounters = await cdp.send('Memory.getDOMCounters')
      const targets = (await browserCdp.send('Target.getTargets')).targetInfos || []
      const cdpWorkers = targets.filter(t => t.type === 'worker' || t.type === 'dedicated_worker' || t.type === 'service_worker').length
      const inPage = await page.evaluate(() => {
        const p = window.__markumoMemoryProbe
        const domMedia = window.__collectDomMediaMetrics()
        const longTasksCount = p.longTasks.length
        const longTasksTotalMs = p.longTasks.reduce((sum, item) => sum + item.duration, 0)
        return {
          editors: JSON.parse(JSON.stringify(p.editors)),
          workers: { ...p.workers },
          tasks: { ...p.tasks },
          blobs: { ...p.blobs },
          observers: JSON.parse(JSON.stringify(p.observers || {})),
          longTasksCount,
          longTasksTotalMs: Number(longTasksTotalMs.toFixed(2)),
          domMedia,
          openTabs: window.__nativeManager.openedDocuments.length,
          paneCount: window.__nativeManager.layout.getAllLeafIds().length,
        }
      })
      return {
        time: Date.now(),
        jsHeapUsed: perf.JSHeapUsedSize,
        jsHeapTotal: perf.JSHeapTotalSize,
        domCounters,
        cdpWorkers,
        ...inPage,
      }
    }

    const openFixtureFile = async (name, paneId = null) => {
      const fullPath = path.join(fixtureDir, name)
      return page.evaluate(
        async ({ file, targetPane }) => {
          let opened
          try {
            opened = await window.__TAURI_INTERNALS__.invoke('open_recent', { path: file, encoding: null })
          } catch (err) {
            throw new Error(`open_recent failed for ${file}: ${JSON.stringify(err)}`)
          }
          const m = window.__nativeManager
          const id = m.openFile(opened, false, targetPane || m.activePane, true)
          if (!id) throw new Error(`openFile rejected for ${file}`)
          return id
        },
        { file: fullPath, targetPane: paneId }
      )
    }

    const closeAllDocs = async () => {
      await page.evaluate(() => {
        const m = window.__nativeManager
        m.closeSplit()
        for (const doc of [...m.openedDocuments]) {
          m.close(doc.id, true)
        }
      })
      await page.waitForFunction(
        () =>
          window.__nativeManager.openedDocuments.length === 0 &&
          document.querySelectorAll('.cm-editor, .markdown-live, .pdf-page, .image-stage img').length === 0,
        null,
        { timeout: 15000 }
      )
    }

    const waitNextFrame = () =>
      page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    for (const scenario of SCENARIOS) {
      await closeAllDocs()
      await wait(120)
      await page.evaluate(() => window.__resetMemorySceneProbe())

      const timeline = []
      const startMs = performance.now()
      let extraScenarioNotes = {}

      if (scenario === 'A-blank') {
        assert.equal(
          await page.locator('.cm-editor, .markdown-live, .tab .filename').count(),
          0,
          'Blank welcome page must have zero editors and zero tabs'
        )
        await waitNextFrame()
      } else if (scenario === 'B-md-5kb-2img') {
        await openFixtureFile('doc-5kb-2img.md')
        await page.waitForFunction(() => {
          const imgs = [...document.querySelectorAll('.markdown-live .md-live-image img')]
          return imgs.length === 2 && imgs.every(img => img.complete && img.naturalWidth > 0)
        }, null, { timeout: 15000 })
        await waitNextFrame()
      } else if (scenario === 'C-md-live') {
        await openFixtureFile('doc-ordinary.md')
        await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-prose h2'), null, { timeout: 15000 })
        await waitNextFrame()
      } else if (scenario === 'D-md-source') {
        const id = await openFixtureFile('doc-ordinary.md')
        await page.evaluate(docId => {
          window.__nativeManager.setMarkdownMode(docId, 'source')
        }, id)
        await page.waitForFunction(
          () => !document.querySelector('.markdown-live') && !!document.querySelector('.editor-host > .cm-editor .cm-content'),
          null,
          { timeout: 15000 }
        )
        await waitNextFrame()
      } else if (scenario === 'E-md-split') {
        const id = await openFixtureFile('doc-split.md')
        await page.evaluate(docId => {
          window.__nativeManager.setMarkdownMode(docId, 'split')
        }, id)
        await page.waitForFunction(() => {
          const preview = document.querySelector('.split-preview-pane')
          const cm = document.querySelector('.editor-host > .cm-editor')
          const imgs = [...document.querySelectorAll('.split-preview-pane img')]
          return !!preview && !!cm && imgs.length >= 2 && imgs.every(i => i.complete && i.naturalWidth > 0)
        }, null, { timeout: 20000 })
        await waitNextFrame()
      } else if (scenario === 'F-code-50') {
        await openFixtureFile('code-50.md')
        await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 50, null, { timeout: 15000 })
        await waitNextFrame()
      } else if (scenario === 'G-code-100') {
        await openFixtureFile('code-100.md')
        await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 100, null, { timeout: 15000 })
        await waitNextFrame()
      } else if (scenario === 'H-code-200') {
        await openFixtureFile('code-200.md')
        await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 200, null, { timeout: 20000 })
        await waitNextFrame()
      } else if (scenario === 'I-multi-pane') {
        await openFixtureFile('multi-pane.md')
        await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 100, null, { timeout: 15000 })
        await page.evaluate(() => {
          const m = window.__nativeManager
          m.splitPane('right', m.activePane, m.activeId)
        })
        await page.waitForFunction(() => {
          const lives = document.querySelectorAll('.markdown-live')
          const imgs = [...document.querySelectorAll('.markdown-live .md-live-image img')]
          return lives.length === 2 && imgs.length >= 4 && imgs.every(img => img.complete && img.naturalWidth > 0)
        }, null, { timeout: 20000 })
        await waitNextFrame()
      } else if (scenario === 'J-large-image-viewer') {
        await openFixtureFile('img-large-24mp.png')
        await page.waitForFunction(() => {
          const img = document.querySelector('.image-stage img')
          return img && img.complete && img.naturalWidth === 6000 && img.naturalHeight === 4000
        }, null, { timeout: 20000 })
        await waitNextFrame()
      } else if (scenario === 'J2-md-large-image') {
        await openFixtureFile('doc-large-image.md')
        await page.waitForFunction(() => {
          const img = document.querySelector('.markdown-live .md-live-image img')
          return img && img.complete && img.naturalWidth > 0
        }, null, { timeout: 20000 })
        const previewDims = await page.evaluate(() => {
          const img = document.querySelector('.markdown-live .md-live-image img')
          return img ? { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } : null
        })
        extraScenarioNotes = { markdownPreviewDimensions: previewDims }
        await waitNextFrame()
      } else if (scenario === 'K-pdf-viewer') {
        await openFixtureFile('sample-multi.pdf')
        await page.waitForFunction(() => {
          const canvas = document.querySelector('.pdf-page canvas')
          return canvas && canvas.width > 0 && canvas.height > 0
        }, null, { timeout: 20000 })
        await waitNextFrame()
      } else if (scenario.startsWith('L-open-switch-close-')) {
        extraScenarioNotes.checkpoints = []
        for (let cycle = 1; cycle <= cycles; cycle++) {
          const idCode = await openFixtureFile('code-50.md')
          await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 50, null, { timeout: 15000 })
          const idImg = await openFixtureFile('doc-5kb-2img.md')
          await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-live-image img'), null, { timeout: 15000 })
          await page.evaluate(({ a, b }) => {
            const m = window.__nativeManager
            m.select(a)
            m.setMarkdownMode(a, 'source')
            m.setMarkdownMode(a, 'live')
            m.select(b)
          }, { a: idCode, b: idImg })
          await wait(30)
          if (cycle % 5 === 0) {
            timeline.push(await collectJsMetrics())
          }
          await closeAllDocs()
          if ([30,60,120].includes(cycle)) {
            await wait(500)
            extraScenarioNotes.checkpoints.push({cycle, js:await collectJsMetrics(), native:(await sampleNative(child.pid,1))[0]})
          }
        }
        // Leave one final active document open briefly or keep settled post-20 state?
        // Scenario L measures the state right after 20 open/switch/close cycles.
        await waitNextFrame()
      } else if (scenario === 'M-post-close-recovery') {
        // Load heavy mixed resources first, sample loaded peak, then close and track recovery curve.
        await openFixtureFile('code-200.md')
        await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 200, null, { timeout: 20000 })
        await openFixtureFile('doc-large-image.md')
        await page.waitForFunction(() => {
          const img = document.querySelector('.markdown-live .md-live-image img')
          return img && img.complete && img.naturalWidth > 0
        }, null, { timeout: 20000 })
        await openFixtureFile('sample-multi.pdf')
        await page.waitForFunction(() => !!document.querySelector('.pdf-page canvas'), null, { timeout: 20000 })
        const loadedBeforeCloseJs = await collectJsMetrics()
        const loadedBeforeCloseNative = (await sampleNative(child.pid, 1))[0]
        extraScenarioNotes = { loadedBeforeCloseJs, loadedBeforeCloseNative }
        await closeAllDocs()
        await waitNextFrame()
      } else if (scenario === 'X-large-txt-2mb') {
        const id = await openFixtureFile('large-2mb.txt')
        await page.waitForFunction(() => !!document.querySelector('.editor-host > .cm-editor .cm-content'), null, { timeout: 20000 })
        await page.evaluate(docId => {
          const m = window.__nativeManager
          m.dispatch(docId, { changes: { from: 0, insert: '// header edit check\n' } })
          m.command('undo')
        }, id)
        await waitNextFrame()
      }

      const sceneReadyMs = Number((performance.now() - startMs).toFixed(2))
      const firstJs = await collectJsMetrics()

      // Sample both JS and Native process tree over ~2.5s WITHOUT forcing GC so real operational peaks are captured!
      const nativePromise = sampleNative(child.pid, 6, 350)
      const sampleEnd = Date.now() + 2200
      while (Date.now() < sampleEnd) {
        timeline.push(await collectJsMetrics())
        await wait(250)
      }
      const nativeSamples = await nativePromise
      const preGcJs = await collectJsMetrics()
      const preGcNative = (await sampleNative(child.pid, 1))[0]

      // Now collect post-GC settled reference separately (never conflated with operational peak)
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('HeapProfiler.collectGarbage')
      const postGcStableJs = await collectJsMetrics()
      const postGcStableNative = (await sampleNative(child.pid, 1))[0]

      // Close document(s) and record natural post-close decay curve before & after GC
      await closeAllDocs()
      const afterCloseNatural = []
      for (const delay of [0, 500, 1000, 1500]) {
        if (delay > 0) await wait(delay === 500 ? 500 : 500)
        afterCloseNatural.push({
          elapsedMs: delay,
          js: await collectJsMetrics(),
          native: (await sampleNative(child.pid, 1))[0],
        })
      }
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('HeapProfiler.collectGarbage')
      const afterClosePostGc = {
        js: await collectJsMetrics(),
        native: (await sampleNative(child.pid, 1))[0],
      }

      const allJs = [firstJs, ...timeline, preGcJs]
      if (extraScenarioNotes.loadedBeforeCloseJs) allJs.push(extraScenarioNotes.loadedBeforeCloseJs)
      const allNative = [...nativeSamples, preGcNative]
      if (extraScenarioNotes.loadedBeforeCloseNative) allNative.push(extraScenarioNotes.loadedBeforeCloseNative)

      const sampleRecord = {
        scenario,
        run,
        sceneReadyMs,
        extra: extraScenarioNotes,
        peaks: {
          sampledJsHeapBytes: Math.max(...allJs.map(s => s.jsHeapUsed)),
          sampledWebviewPrivateBytes: Math.max(...allNative.map(s => s.webviewPrivate)),
          sampledWebviewWorkingBytes: Math.max(...allNative.map(s => s.webviewWorking)),
          sampledRustPrivateBytes: Math.max(...allNative.map(s => s.rustPrivate)),
          sampledRustWorkingBytes: Math.max(...allNative.map(s => s.rustWorking)),
          pmPeak: Math.max(...allJs.map(s => s.editors.pm.peak)),
          mainCmPeak: Math.max(...allJs.map(s => s.editors.mainCM.peak)),
          embeddedCmPeak: Math.max(...allJs.map(s => s.editors.embeddedCM.peak)),
          embeddedCmCreated: Math.max(...allJs.map(s => s.editors.embeddedCM.created)),
          workerPeak: Math.max(...allJs.map(s => s.workers.peak), ...allJs.map(s => s.cdpWorkers)),
          renderTaskPeak: Math.max(...allJs.map(s => s.tasks.peak)),
          highlightRuns: preGcJs.tasks.highlightRuns,
          blobUrlsPeak: Math.max(...allJs.map(s => s.blobs.peakUrls)),
          blobBytesPeak: Math.max(...allJs.map(s => s.blobs.peakBytes)),
          decodedImagePixelsPeak: Math.max(...allJs.map(s => s.domMedia.decodedImagePixels)),
          canvasPixelsPeak: Math.max(...allJs.map(s => s.domMedia.canvasPixels)),
        },
        preGc: {
          js: preGcJs,
          native: preGcNative,
        },
        postGcStable: {
          js: postGcStableJs,
          native: postGcStableNative,
        },
        afterClose: {
          natural: afterCloseNatural,
          postGc: afterClosePostGc,
        },
      }

      report.samples.push(sampleRecord)
      persist()

      const mib = b => (b / 1048576).toFixed(2)
      console.log(
        `[${label} r${run}] ${scenario.padEnd(24)} ready=${String(sceneReadyMs).padStart(7)}ms | ` +
          `embCM(peak=${sampleRecord.peaks.embeddedCmPeak},live=${preGcJs.editors.embeddedCM.live}) ` +
          `mainCM=${preGcJs.editors.mainCM.live} PM=${preGcJs.editors.pm.live} | ` +
          `Heap(peak=${mib(sampleRecord.peaks.sampledJsHeapBytes)},stable=${mib(postGcStableJs.jsHeapUsed)})MiB ` +
          `DOM=${postGcStableJs.domCounters.nodes} | ` +
          `WV_Priv=${mib(postGcStableNative.webviewPrivate)}MiB WV_WS=${mib(postGcStableNative.webviewWorking)}MiB ` +
          `Rust_Priv=${mib(postGcStableNative.rustPrivate)}MiB`
      )
    }

    await browser.close().catch(() => {})
    browser = undefined
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise(resolve => {
        const t = setTimeout(resolve, 5000)
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
    }
    child = undefined
    await wait(500)
  }

  report.completedAt = new Date().toISOString()
  report.passed = report.errors.length === 0
  persist()
  if (report.errors.length > 0) {
    console.warn('Recorded non-fatal console/page errors:', report.errors)
  }
  console.log(`Completed ${rounds} rounds for label="${label}" -> ${path.join(out, 'results.json')}`)
} catch (error) {
  try {
    const pages = browser?.contexts().flatMap(c => c.pages()).filter(p => !p.url().startsWith('devtools:')) || []
    if (pages[0]) {
      report.debugDom = await pages[0].evaluate(() => ({
        liveExists: !!document.querySelector('.markdown-live'),
        liveImages: [...document.querySelectorAll('.md-live-image, .md-image-slot')].map(el => ({
          cls: el.className,
          title: el.getAttribute('title'),
          text: el.textContent,
          imgSrc: el.querySelector('img')?.getAttribute('src') || null,
          naturalW: el.querySelector('img')?.naturalWidth || 0,
        })),
        tabs: [...document.querySelectorAll('.tab')].map(el => el.textContent?.trim()),
      }))
      console.error('DEBUG DOM:', JSON.stringify(report.debugDom, null, 2))
    }
  } catch {}
  report.failure = String(error?.stack || error)
  persist()
  throw error
} finally {
  await browser?.close().catch(() => {})
  if (child?.exitCode === null) child.kill()
}
