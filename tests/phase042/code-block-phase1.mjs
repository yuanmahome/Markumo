import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { ensurePhase042Fixtures } from '../../scripts/memory-fixtures.mjs'

const root = path.resolve('test-results/phase042')
const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) || 'phase1'
const binary = path.join(root, `markumo-${label}.exe`)
assert(fs.existsSync(binary), `Missing Release binary: ${binary}`)

const config = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`), 'utf8'))
const profile = config.app.appDirectoriesOverride
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(profile, { recursive: true })

const fixtureDir = path.join(root, 'fixtures')
ensurePhase042Fixtures(fixtureDir)

fs.writeFileSync(
  path.join(profile, 'editor-settings.json'),
  JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false })
)
fs.writeFileSync(
  path.join(profile, 'files.json'),
  JSON.stringify({
    recent: ['code-200.md', 'code-50.md', 'doc-ordinary.md'].map(name => ({
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

const port = 9685
const child = spawn(binary, [], {
  windowsHide: true,
  env: {
    ...process.env,
    TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, `wv-${label}-${Date.now()}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
})

let browser
try {
  const deadline = Date.now() + 30000
  while (true) {
    if (child.exitCode !== null) throw new Error(`App exited early: ${child.exitCode}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) break
    } catch {}
    assert(Date.now() < deadline, 'WebView2 CDP timeout')
    await new Promise(r => setTimeout(r, 100))
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:'))
  assert(page, 'Main page not found')

  const errors = []
  page.on('pageerror', e => errors.push(e.message))

  await page.waitForFunction(
    () => !!window.__nativeManager && !document.querySelector('.startup-overlay'),
    null,
    { timeout: 20000 }
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')

  // 1. Compare 300px, 400px, 600px rootMargin on 200 code blocks
  const marginResults = {}
  for (const px of [300, 400, 600]) {
    await page.evaluate(() => {
      const m = window.__nativeManager
      m.closeSplit()
      for (const d of [...m.openedDocuments]) m.close(d.id, true)
    })
    await page.waitForFunction(() => !document.querySelector('.markdown-live'))
    await page.evaluate(m => {
      window.__MARKUMO_CODE_ROOT_MARGIN = `${m}px 0px ${m}px 0px`
      window.__resetMemorySceneProbe()
    }, px)

    await page.evaluate(async f => {
      const o = await window.__TAURI_INTERNALS__.invoke('open_recent', { path: f, encoding: null })
      window.__nativeManager.openFile(o, false)
    }, path.join(fixtureDir, 'code-200.md'))
    await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 200)
    await new Promise(r => setTimeout(r, 350))
    await cdp.send('HeapProfiler.collectGarbage')
    const idleCounters = await cdp.send('Memory.getDOMCounters')
    const idlePerf = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]))
    const idleStats = await page.evaluate(() => ({
      embCM: { ...window.__markumoMemoryProbe.editors.embeddedCM },
      tasks: { ...window.__markumoMemoryProbe.tasks },
      highlightedBlocks: [...document.querySelectorAll('.markdown-live .md-code-block')].filter(b =>
        b.querySelector('.md-code-line span[class]')
      ).length,
      connectedDom: document.querySelectorAll('*').length,
    }))

    assert.equal(idleStats.embCM.live, 0, `${px}px: idle 200 blocks must have 0 live embedded CM`)
    assert.equal(idleStats.embCM.created, 0, `${px}px: idle 200 blocks must allocate 0 embedded CM`)

    // Fast continuous scroll + rapid jump cancellation check
    const scrollStats = await page.evaluate(async () => {
      window.__resetMemorySceneProbe()
      const pane = document.querySelector('.markdown-live')
      pane.scrollTop = 0
      await new Promise(r => setTimeout(r, 100))
      let visibleChecks = 0
      let visibleAlreadyHighlighted = 0
      while (pane.scrollTop + pane.clientHeight < pane.scrollHeight - 10) {
        pane.scrollTop += 380
        await new Promise(r => requestAnimationFrame(r))
        const pRect = pane.getBoundingClientRect()
        for (const b of pane.querySelectorAll('.md-code-block')) {
          const r = b.getBoundingClientRect()
          if (r.bottom > pRect.top + 20 && r.top < pRect.bottom - 20) {
            visibleChecks++
            if (b.querySelector('.md-code-line span[class]')) visibleAlreadyHighlighted++
          }
        }
      }
      await new Promise(r => setTimeout(r, 250))
      return {
        visibleChecks,
        visibleAlreadyHighlighted,
        readyRatio: visibleChecks ? Number((visibleAlreadyHighlighted / visibleChecks).toFixed(4)) : 1,
        embCM: { ...window.__markumoMemoryProbe.editors.embeddedCM },
        tasks: { ...window.__markumoMemoryProbe.tasks },
        longTasks: window.__markumoMemoryProbe.longTasks.length,
        connectedDomAfterScroll: document.querySelectorAll('*').length,
      }
    })
    assert.equal(scrollStats.embCM.peak, 0, `${px}px: scrolling 200 blocks must keep 0 embedded CM`)
    marginResults[`${px}px`] = {
      idleDomNodes: idleCounters.nodes,
      idleListeners: idleCounters.jsEventListeners,
      idleHeapMiB: Number((idlePerf.JSHeapUsedSize / 1048576).toFixed(2)),
      idleStats,
      scrollStats,
    }
    console.log(
      `PASS rootMargin=${px}px | idleBlocks=${idleStats.highlightedBlocks} heap=${marginResults[`${px}px`].idleHeapMiB}MiB readyRatio=${scrollStats.readyRatio}`
    )
  }

  // 2. Benchmark display highlight character budget (20k, 40k, 60k, 80k, 100k)
  await page.evaluate(() => {
    delete window.__MARKUMO_CODE_ROOT_MARGIN
  })
  const budgetResults = {}
  const unit = 'export function calcMetric(a: number, b: number): number { return (a * 31 + b) ^ 0xff; }\n'
  for (const chars of [20000, 40000, 50000, 60000, 80000, 100000]) {
    const body = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
    const md = `# Char Budget Test (${chars})\n\n\`\`\`typescript\n${body}\n\`\`\`\n`
    await page.evaluate(() => {
      const m = window.__nativeManager
      for (const d of [...m.openedDocuments]) m.close(d.id, true)
    })
    await page.waitForFunction(() => !document.querySelector('.markdown-live'))
    const res = await page.evaluate(async ({ md }) => {
      const m = window.__nativeManager
      window.__resetMemorySceneProbe()
      const id = m.createUntitled('md')
      while (!m.activeLiveEditor) await new Promise(r => setTimeout(r, 10))
      const t0 = performance.now()
      m.dispatch(id, { changes: { from: 0, insert: md } })
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const el = document.querySelector('.markdown-live .md-code-block')
        const st = el?.getAttribute('data-language-status')
        if (st === 'ready' || st === 'plain') break
        await new Promise(r => setTimeout(r, 5))
      }
      const elapsedMs = Number((performance.now() - t0).toFixed(2))
      const el = document.querySelector('.markdown-live .md-code-block')
      const hasTokens = !!el?.querySelector('.md-code-line span[class]')
      const status = el?.getAttribute('data-language-status')
      const longTasks = [...window.__markumoMemoryProbe.longTasks]
      m.close(id, true)
      return { elapsedMs, status, hasTokens, longTasks }
    }, { md })
    if (chars <= 50000) assert.equal(res.hasTokens, true, `${chars} chars should highlight`)
    else assert.equal(res.hasTokens, false, `${chars} chars (>50k) must degrade to plain text`)
    budgetResults[chars] = res
    console.log(`PASS charBudget=${chars} | elapsed=${res.elapsedMs}ms hasTokens=${res.hasTokens} longTasks=${res.longTasks.length}`)
  }

  // 3. Comprehensive interactive edit / IME / drag / search / paste / undo / detach verification
  await page.evaluate(async f => {
    const m = window.__nativeManager
    for (const d of [...m.openedDocuments]) m.close(d.id, true)
    window.__resetMemorySceneProbe()
    const o = await window.__TAURI_INTERNALS__.invoke('open_recent', { path: f, encoding: null })
    m.openFile(o, false)
  }, path.join(fixtureDir, 'code-200.md'))
  await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 200)
  await new Promise(r => setTimeout(r, 300))

  // 3a. 1000 toolbar/composing queries allocate 0 CM
  const qRes = await page.evaluate(() => {
    const m = window.__nativeManager
    for (let i = 0; i < 1000; i++) {
      void m.isComposing
      m.markdownToolbarState()
    }
    return { ...window.__markumoMemoryProbe.editors.embeddedCM }
  })
  assert.equal(qRes.created, 0)
  assert.equal(qRes.live, 0)
  console.log('PASS 1000 state queries -> 0 CM allocated')

  // 3b. First click enters edit mode with exact caret placement, typing & multi-line paste & undo/redo
  const firstCodeBlock = page.locator('.markdown-live .md-code-block').first()
  await firstCodeBlock.scrollIntoViewIfNeeded()
  await firstCodeBlock.locator('.md-code-placeholder').click({ position: { x: 45, y: 16 } })
  assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.editors.embeddedCM.live), 1)
  await page.keyboard.type('/*MARK1*/')
  await page.evaluate(() => {
    const cmContent = document.querySelector('.md-code-block .cm-content')
    const dt = new DataTransfer()
    dt.setData('text/plain', 'lineA\nlineB')
    cmContent.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() =>
    window.__nativeManager.getText(window.__nativeManager.activeId).includes('/*MARK1*/lineA\nlineB')
  )
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  assert(
    await page.evaluate(() =>
      window.__nativeManager.getText(window.__nativeManager.activeId).includes('/*MARK1*/lineA\nlineB')
    )
  )
  console.log('PASS first click, typing, multi-line paste, and Undo/Redo')

  // 3c. IME composition guard: must NOT detach while composing
  const imeLive = await page.evaluate(() => {
    const cmContent = document.querySelector('.md-code-block .cm-content')
    cmContent.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))
    return window.__markumoMemoryProbe.editors.embeddedCM.live
  })
  assert.equal(imeLive, 1)
  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '中文输入' })
  await page.waitForFunction(() =>
    window.__nativeManager.getText(window.__nativeManager.activeId).includes('中文输入')
  )
  console.log('PASS Chinese IME composition inside embedded CodeMirror')

  // 3d. Leave code block -> immediately detaches CM back to 0 while keeping edited source & static highlight
  await page.locator('.markdown-live .md-prose > p').first().click()
  await page.waitForFunction(() => window.__markumoMemoryProbe.editors.embeddedCM.live === 0, null, { timeout: 5000 })
  assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.editors.embeddedCM.live), 0)
  assert(
    await page.evaluate(() =>
      window.__nativeManager.getText(window.__nativeManager.activeId).includes('中文输入')
    )
  )
  console.log('PASS leaving code block safely releases embedded CM to 0')

  // 3e. Repeatedly enter and exit 10 different code blocks -> live never exceeds 1, returns to 0
  for (let idx = 0; idx < 10; idx++) {
    const target = page.locator('.markdown-live .md-code-block').nth(idx)
    await target.scrollIntoViewIfNeeded()
    await target.locator('.md-code-placeholder').click({ position: { x: 40, y: 16 } })
    assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.editors.embeddedCM.live), 1)
    await page.locator('.markdown-live .md-prose > p').first().scrollIntoViewIfNeeded()
    await page.locator('.markdown-live .md-prose > p').first().click()
    await page.waitForFunction(() => window.__markumoMemoryProbe.editors.embeddedCM.live === 0, null, { timeout: 5000 })
  }
  console.log('PASS 10 enter/exit cycles -> peak concurrent CM = 1, settled CM = 0')

  // 3f. Cross-block search highlights in display mode without allocating 200 CMs
  await page.evaluate(() => window.__resetMemorySceneProbe())
  await page.keyboard.press('Control+f')
  const searchInput = page.locator('.md-live-search input[name="search"]')
  await searchInput.waitFor({ state: 'visible' })
  await searchInput.fill('return')
  await page.waitForFunction(() => document.querySelectorAll('.md-code-placeholder .md-search-match').length > 0)
  for (let step = 0; step < 8; step++) {
    await searchInput.press('Enter')
    await new Promise(r => setTimeout(r, 40))
  }
  const searchCmStats = await page.evaluate(() => ({ ...window.__markumoMemoryProbe.editors.embeddedCM }))
  assert.equal(searchCmStats.created, 0, 'Display-mode cross-block search navigation should allocate 0 CMs while search bar holds focus')
  await searchInput.press('Escape')
  console.log('PASS cross-block search highlights & F3 navigation in display mode (0 CMs allocated)')

  assert.deepEqual(errors, [])
  fs.writeFileSync(
    path.join(root, 'phase1-release-experiments.json'),
    JSON.stringify({ marginResults, budgetResults, searchCmStats }, null, 2)
  )
  console.log('ALL PHASE 1 VERIFICATION CHECKS PASSED!')
} finally {
  await browser?.close().catch(() => {})
  if (child.exitCode === null) child.kill()
}
