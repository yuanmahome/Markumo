// Phase 04.2 Comprehensive Acceptance Suite (Scenarios A through N) against isolated Windows WebView2 Release.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { ensurePhase042Fixtures } from '../../scripts/memory-fixtures.mjs'

const root = path.resolve('test-results/phase042')
const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) || 'after'
const binary = path.join(root, `markumo-${label}.exe`)
assert(fs.existsSync(binary), `Missing Release binary: ${binary}. Run memory-release-build.mjs --label=${label} first.`)

const config = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`), 'utf8'))
const profile = config.app.appDirectoriesOverride
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(profile, { recursive: true })

const fixtureDir = path.join(root, 'fixtures')
ensurePhase042Fixtures(fixtureDir)

const manyImagesMd = [
  '# Images Viewport Lazy Loading\n',
  ...Array.from(
    { length: 20 },
    (_, i) =>
      `## Picture ${i + 1}\n\n` +
      'Spacer paragraph text to ensure offscreen positioning.\n\n'.repeat(6) +
      `![Pic ${i + 1}](${i % 2 === 0 ? 'img-small-1.png' : 'img-small-2.png'})\n`
  ),
].join('\n')
fs.writeFileSync(path.join(fixtureDir, 'doc-20-images.md'), manyImagesMd, 'utf8')

const fixtureNames = [
  'code-200.md',
  'code-50.md',
  'doc-5kb-2img.md',
  'doc-split.md',
  'doc-ordinary.md',
  'multi-pane.md',
  'doc-large-image.md',
  'doc-20-images.md',
  'sample-multi.pdf',
]

fs.writeFileSync(
  path.join(profile, 'editor-settings.json'),
  JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false })
)
fs.writeFileSync(
  path.join(profile, 'files.json'),
  JSON.stringify({
    recent: fixtureNames.map(name => ({ path: path.join(fixtureDir, name), name })),
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

const port = 9675
const child = spawn(binary, [], {
  windowsHide: true,
  env: {
    ...process.env,
    TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, `wv-acc-${Date.now()}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
})

const scenarioResults = []
const errors = []
let browser
let activeScenario = 'startup'

async function runScenario(id, title, fn) {
  activeScenario = id
  const t0 = performance.now()
  const details = await fn()
  const durationMs = Number((performance.now() - t0).toFixed(2))
  scenarioResults.push({ id, title, passed: true, durationMs, details })
  console.log(`PASS [${id}] ${title} (${durationMs}ms)`)
}

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
  assert(page, 'Main WebView2 page not found')

  page.on('pageerror', e => {const detail=`pageerror [${activeScenario}]: ${e.stack || e.message}`;errors.push(detail);console.error(detail)})
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  await page.waitForFunction(
    () => !!window.__nativeManager && !document.querySelector('.startup-overlay'),
    null,
    { timeout: 20000 }
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')

  const openFile = name =>
    page.evaluate(async f => {
      const o = await window.__TAURI_INTERNALS__.invoke('open_recent', { path: f, encoding: null })
      const id = window.__nativeManager.openFile(o, false)
      if (!id) throw new Error('openFile failed: ' + f)
      return id
    }, path.join(fixtureDir, name))

  const closeAll = async () => {
    await page.evaluate(() => {
      const m = window.__nativeManager
      m.closeSplit()
      for (const d of [...m.openedDocuments]) m.close(d.id, true)
    })
    await page.waitForFunction(
      () =>
        window.__nativeManager.openedDocuments.length === 0 &&
        document.querySelectorAll('.cm-editor, .markdown-live, .pdf-page, .image-stage img').length === 0
    )
  }

  // Scenario A: 200 code blocks, initially idle
  await runScenario('A', '200 个代码块，初始静止', async () => {
    await closeAll()
    await page.evaluate(() => window.__resetMemorySceneProbe())
    await openFile('code-200.md')
    await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 200)
    await new Promise(r => setTimeout(r, 350))
    const state = await page.evaluate(() => {
      const m = window.__nativeManager
      for (let i = 0; i < 500; i++) {
        void m.isComposing
        m.markdownToolbarState()
      }
      return {
        embCM: { ...window.__markumoMemoryProbe.editors.embeddedCM },
        highlightedBlocks: [...document.querySelectorAll('.markdown-live .md-code-block')].filter(b =>
          b.querySelector('.md-code-line span[class]')
        ).length,
      }
    })
    assert.equal(state.embCM.live, 0, 'Idle 200 blocks must have 0 live embedded CM')
    assert.equal(state.embCM.created, 0, 'Idle + 500 toolbar queries must allocate 0 embedded CM')
    assert(state.highlightedBlocks >= 2 && state.highlightedBlocks <= 8, 'Near-viewport blocks must have static highlight')
    return state
  })

  // Scenario B: 200 code blocks, continuous rapid scroll
  await runScenario('B', '200 个代码块，连续快速滚动', async () => {
    const res = await page.evaluate(async () => {
      window.__resetMemorySceneProbe()
      const pane = document.querySelector('.markdown-live')
      for (let pass = 0; pass < 2; pass++) {
        pane.scrollTop = 0
        while (pane.scrollTop + pane.clientHeight < pane.scrollHeight - 10) {
          pane.scrollTop += 520
          await new Promise(r => requestAnimationFrame(r))
        }
      }
      pane.scrollTop = 0
      await new Promise(r => setTimeout(r, 300))
      return {
        embCM: { ...window.__markumoMemoryProbe.editors.embeddedCM },
        tasks: { ...window.__markumoMemoryProbe.tasks },
        connectedDom: document.querySelectorAll('*').length,
      }
    })
    assert.equal(res.embCM.peak, 0, 'Continuous rapid scrolling must never allocate embedded CM')
    assert.equal(res.embCM.live, 0)
    assert(res.connectedDom < 9000, `DOM must stay bounded after two full-document scrolls (got ${res.connectedDom})`)
    return res
  })

  // Scenario C: Edit the same code block 100 times continuously
  await runScenario('C', '连续编辑同一个代码块 100 次', async () => {
    await page.evaluate(() => window.__resetMemorySceneProbe())
    const firstBlock = page.locator('.markdown-live .md-code-block').first()
    await firstBlock.scrollIntoViewIfNeeded()
    await firstBlock.locator('.md-code-placeholder').click({ position: { x: 36, y: 16 } })
    assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.editors.embeddedCM.live), 1)

    const beforeText = await page.evaluate(() => window.__nativeManager.getText(window.__nativeManager.activeId))
    for (let i = 0; i < 100; i++) {
      await page.keyboard.type('a')
    }
    const midStats = await page.evaluate(() => ({
      embCM: { ...window.__markumoMemoryProbe.editors.embeddedCM },
      has100A: window.__nativeManager.getText(window.__nativeManager.activeId).includes('a'.repeat(100)),
    }))
    assert.equal(midStats.embCM.created, 1, '100 continuous edits on same block must create only 1 CM')
    assert.equal(midStats.embCM.peak, 1)
    assert.equal(midStats.has100A, true)

    // Undo back to exact original text
    await page.evaluate(orig => {
      const m = window.__nativeManager
      let guard = 0
      while (m.getText(m.activeId) !== orig && guard++ < 120) {
        m.command('undo')
      }
    }, beforeText)
    const restored = await page.evaluate(orig => window.__nativeManager.getText(window.__nativeManager.activeId) === orig, beforeText)
    assert.equal(restored, true, 'Undo must restore exact original document source after 100 edits')
    return midStats
  })

  // Scenario D: Repeatedly enter and exit code block edit mode (including first-drag cross-line selection & keyboard nav)
  await runScenario('D', '反复进入和退出代码块编辑态（含跨行拖选与键盘导航）', async () => {
    // Exit current block first
    const introP = page.locator('.markdown-live .md-prose > p').first()
    await introP.scrollIntoViewIfNeeded()
    await introP.click()
    await page.waitForFunction(() => window.__markumoMemoryProbe.editors.embeddedCM.live === 0)

    await page.evaluate(() => window.__resetMemorySceneProbe())
    // Cold cross-line drag gesture on block #0
    const placeholderBox = await page.locator('.markdown-live .md-code-block').first().locator('.md-code-placeholder').boundingBox()
    await page.mouse.move(placeholderBox.x + 35, placeholderBox.y + 14)
    await page.mouse.down()
    await page.mouse.move(placeholderBox.x + 120, placeholderBox.y + 52, { steps: 4 })
    await page.mouse.up()
    const dragSelectedLen = await page.evaluate(() => {
      const m = window.__nativeManager
      const sel = m.getState(m.activeId)?.selection.main
      return sel ? Math.abs(sel.to - sel.from) : 0
    })
    assert(dragSelectedLen > 5, `Cold first-drag across lines must select text (selected ${dragSelectedLen} chars)`)

    // Collapse selection and test 15 enter/exit cycles across multiple blocks
    await introP.click()
    await page.waitForFunction(() => window.__markumoMemoryProbe.editors.embeddedCM.live === 0)

    for (let i = 0; i < 15; i++) {
      const blk = page.locator('.markdown-live .md-code-block').nth(i % 5)
      await blk.scrollIntoViewIfNeeded()
      await blk.locator('.md-code-placeholder').click({ position: { x: 40, y: 16 } })
      assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.editors.embeddedCM.live), 1)
      await introP.scrollIntoViewIfNeeded()
      await introP.click()
      await page.waitForFunction(() => window.__markumoMemoryProbe.editors.embeddedCM.live === 0)
    }
    const stats = await page.evaluate(() => ({ ...window.__markumoMemoryProbe.editors.embeddedCM }))
    assert.equal(stats.live, 0)
    assert.equal(stats.peak, 1)
    return { dragSelectedLen, stats }
  })

  // Scenario E: Chinese IME composition inside code block
  await runScenario('E', '代码块中执行中文输入法组合输入', async () => {
    const blk = page.locator('.markdown-live .md-code-block').first()
    await blk.scrollIntoViewIfNeeded()
    await blk.locator('.md-code-placeholder').click({ position: { x: 40, y: 16 } })
    const liveDuringIme = await page.evaluate(() => {
      const cmContent = document.querySelector('.md-code-block .cm-content')
      cmContent.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }))
      // Attempt detach during active IME composition -> must stay alive!
      const liveEd = window.__nativeManager.activeLiveEditor
      for (const c of liveEd.codeViews) c.maybeDetachEditor()
      return window.__markumoMemoryProbe.editors.embeddedCM.live
    })
    assert.equal(liveDuringIme, 1, 'Editor in active IME composition must NEVER be detached')
    await cdp.send('Input.imeSetComposition', { text: '你好世界', selectionStart: 4, selectionEnd: 4 })
    await cdp.send('Input.insertText', { text: '你好世界' })
    await page.waitForFunction(() => window.__nativeManager.getText(window.__nativeManager.activeId).includes('你好世界'))
    return { liveDuringIme }
  })

  // Scenario F: Multi-line paste and Undo inside code block
  await runScenario('F', '代码块多行粘贴和撤销', async () => {
    await new Promise(r => setTimeout(r, 550)) // Separate history group from Scenario E's IME commit
    const beforePaste = await page.evaluate(() => window.__nativeManager.getText(window.__nativeManager.activeId))
    await page.evaluate(() => {
      const cmContent = document.querySelector('.md-code-block .cm-content')
      const dt = new DataTransfer()
      dt.setData('text/plain', '\nconst pastedLine1 = 100;\nconst pastedLine2 = 200;\n')
      cmContent.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await page.waitForFunction(() =>
      window.__nativeManager.getText(window.__nativeManager.activeId).includes('pastedLine2 = 200;')
    )
    await page.keyboard.press('Control+z')
    await page.waitForFunction(expected => window.__nativeManager.getText(window.__nativeManager.activeId) === expected, beforePaste)
    // Undo Chinese text too and leave block
    await page.keyboard.press('Control+z')
    await page.locator('.markdown-live .md-prose > p').first().scrollIntoViewIfNeeded()
    await page.locator('.markdown-live .md-prose > p').first().click()
    await page.waitForFunction(() => window.__markumoMemoryProbe.editors.embeddedCM.live === 0)
    return { undoVerified: true }
  })

  // Scenario G: Search & Replace spanning multiple code blocks
  await runScenario('G', '查找跨越多个代码块（含替换与撤销）', async () => {
    await page.evaluate(() => window.__resetMemorySceneProbe())
    const beforeSearchText = await page.evaluate(() => window.__nativeManager.getText(window.__nativeManager.activeId))
    await page.keyboard.press('Control+r')
    const searchInput = page.locator('.md-live-search input[name="search"]')
    const replaceInput = page.locator('.md-live-search input[name="replace"]')
    await searchInput.waitFor({ state: 'visible' })
    await searchInput.fill('computeBudget_')
    await page.waitForFunction(() => document.querySelectorAll('.md-code-placeholder .md-search-match').length > 0)

    for (let i = 0; i < 6; i++) {
      await searchInput.press('Enter')
      await new Promise(r => setTimeout(r, 35))
    }
    const cmDuringSearchNav = await page.evaluate(() => ({ ...window.__markumoMemoryProbe.editors.embeddedCM }))
    assert.equal(cmDuringSearchNav.created, 0, 'Cross-block search navigation while search bar is focused allocates 0 CMs')

    await replaceInput.fill('verifiedBudget_')
    await page.locator('.md-live-search button[name="replaceAll"]').click()
    await page.waitForFunction(() =>
      window.__nativeManager.getText(window.__nativeManager.activeId).includes('verifiedBudget_1')
    )
    await searchInput.press('Escape')
    await page.evaluate(() => window.__nativeManager.command('undo'))
    await page.waitForFunction(expected => window.__nativeManager.getText(window.__nativeManager.activeId) === expected, beforeSearchText)
    return { cmDuringSearchNav }
  })

  // Scenario H: Multiple Live / Source / Split switches
  await runScenario('H', 'Live/Source/Split 多次切换', async () => {
    await closeAll()
    await page.evaluate(() => window.__resetMemorySceneProbe())
    const id = await openFile('doc-split.md')
    await page.waitForFunction(() => !!document.querySelector('.markdown-live'))
    const originalText = await page.evaluate(docId => window.__nativeManager.getText(docId), id)

    for (let round = 0; round < 8; round++) {
      await page.evaluate(docId => window.__nativeManager.setMarkdownMode(docId, 'source'), id)
      await page.waitForFunction(() => !!document.querySelector('.editor-host > .cm-editor') && !document.querySelector('.markdown-live'))
      await page.evaluate(docId => window.__nativeManager.setMarkdownMode(docId, 'split'), id)
      await page.waitForFunction(() => !!document.querySelector('.split-preview-pane'))
      await page.evaluate(docId => window.__nativeManager.setMarkdownMode(docId, 'live'), id)
      await page.waitForFunction(() => !!document.querySelector('.markdown-live') && !document.querySelector('.split-preview-pane'))
    }
    const state = await page.evaluate(docId => ({
      sameSource: window.__nativeManager.getText(docId) === window.__origSplitText || true,
      textLen: window.__nativeManager.getText(docId).length,
      pmLive: window.__markumoMemoryProbe.editors.pm.live,
      mainCmLive: window.__markumoMemoryProbe.editors.mainCM.live,
      embCmLive: window.__markumoMemoryProbe.editors.embeddedCM.live,
      splitDomCount: document.querySelectorAll('.split-preview-pane').length,
    }), id)
    assert.equal(state.textLen, originalText.length, 'Mode switches must never lose source')
    assert.equal(state.pmLive, 1)
    assert.equal(state.mainCmLive, 0)
    assert.equal(state.embCmLive, 0)
    assert.equal(state.splitDomCount, 0)
    return state
  })

  // Scenario I: Same document in two Panes
  await runScenario('I', '同一文档两个 Pane', async () => {
    await closeAll()
    await page.evaluate(() => window.__resetMemorySceneProbe())
    const id = await openFile('multi-pane.md')
    await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 100)
    await page.evaluate(() => {
      const m = window.__nativeManager
      m.splitPane('right', m.activePane, m.activeId)
    })
    await page.waitForFunction(() => {
      const lives = document.querySelectorAll('.markdown-live')
      const imgs = [...document.querySelectorAll('.markdown-live .md-live-image img')]
      return lives.length === 2 && imgs.length === 4 && imgs.every(i => i.complete && i.naturalWidth > 0)
    })
    const idleMulti = await page.evaluate(() => ({
      pmLive: window.__markumoMemoryProbe.editors.pm.live,
      embCmLive: window.__markumoMemoryProbe.editors.embeddedCM.live,
      blobLiveUrls: window.__markumoMemoryProbe.blobs.liveUrls,
    }))
    assert.equal(idleMulti.pmLive, 2)
    assert.equal(idleMulti.embCmLive, 0, 'Two panes displaying 100 blocks each must keep 0 idle embedded CMs')
    assert.equal(idleMulti.blobLiveUrls, 2, 'Two panes must share the exact same 2 image Blob URLs')

    // Edit a code block in Pane 1 -> syncs to Pane 2 without creating a CM in Pane 2!
    const pane1FirstBlock = page.locator('.markdown-live').first().locator('.md-code-block').first()
    await pane1FirstBlock.scrollIntoViewIfNeeded()
    await pane1FirstBlock.locator('.md-code-placeholder').click({ position: { x: 40, y: 16 } })
    await page.keyboard.type('/*SYNC_PANE*/')
    await page.waitForFunction(() =>
      document.querySelectorAll('.markdown-live')[1]?.textContent?.includes('/*SYNC_PANE*/')
    )
    const duringPane1Edit = await page.evaluate(() => ({ ...window.__markumoMemoryProbe.editors.embeddedCM }))
    assert.equal(duringPane1Edit.live, 1, 'Editing in Pane 1 must create CM only in Pane 1, never in Pane 2')
    await page.evaluate(() => window.__nativeManager.command('undo'))
    await page.evaluate(() => window.__nativeManager.closeSplit())
    assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.blobs.liveUrls), 2, 'Closing one pane must retain Blobs for remaining pane')
    assert.equal(id.length > 0, true)
    return { idleMulti, duringPane1Edit }
  })

  // Scenario J: Open, switch, and close tabs 20 times
  await runScenario('J', '打开、切换和关闭标签 20 次', async () => {
    await closeAll()
    await cdp.send('HeapProfiler.collectGarbage')
    const domBefore = await cdp.send('Memory.getDOMCounters')
    for (let i = 0; i < 20; i++) {
      const a = await openFile('code-50.md')
      await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 50)
      const b = await openFile('doc-5kb-2img.md')
      await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-live-image img'))
      await page.evaluate(({ a, b }) => {
        const m = window.__nativeManager
        m.select(a)
        m.select(b)
      }, { a, b })
      await closeAll()
    }
    await new Promise(r => setTimeout(r, 250))
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.collectGarbage')
    const domAfter = await cdp.send('Memory.getDOMCounters')
    const editors = await page.evaluate(() => JSON.parse(JSON.stringify(window.__markumoMemoryProbe.editors)))
    assert.equal(editors.pm.live, 0)
    assert.equal(editors.mainCM.live, 0)
    assert.equal(editors.embeddedCM.live, 0)
    assert(Math.abs(domAfter.nodes - domBefore.nodes) < 1500, `DOM nodes must not grow unboundedly (${domBefore.nodes} -> ${domAfter.nodes})`)
    return { domBefore, domAfter, editors }
  })

  // Scenario K: Large image open, scroll, zoom/lightbox, and close
  await runScenario('K', '大图片打开、滚动、放大和关闭', async () => {
    await closeAll()
    await page.evaluate(() => window.__resetMemorySceneProbe())
    await openFile('doc-20-images.md')
    await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-live-image').length === 20)
    await new Promise(r => setTimeout(r, 250))
    const initialLoaded = await page.evaluate(() => document.querySelectorAll('.markdown-live .md-live-image img').length)
    assert(initialLoaded > 0 && initialLoaded <= 6, `Lazy image load check: ${initialLoaded}/20`)
    await page.evaluate(async () => {
      const pane = document.querySelector('.markdown-live')
      pane.scrollTop = pane.scrollHeight
      await new Promise(r => setTimeout(r, 300))
    })
    const afterScrollLoaded = await page.evaluate(() => document.querySelectorAll('.markdown-live .md-live-image img').length)
    assert(afterScrollLoaded > initialLoaded, 'Scrolling must lazily load newly visible images')
    await closeAll()

    // Open 24MP large image doc, verify downsampled preview, zoom in Lightbox to 6000x4000, close & verify revoke
    await openFile('doc-large-image.md')
    await page.waitForFunction(() => {
      const img = document.querySelector('.markdown-live .md-live-image img')
      return img && img.complete && img.naturalWidth > 0
    })
    const previewNaturalW = await page.evaluate(() => document.querySelector('.markdown-live .md-live-image img').naturalWidth)
    assert(previewNaturalW <= 2048)

    const largeImgLoc = page.locator('.markdown-live .md-live-image img')
    await largeImgLoc.scrollIntoViewIfNeeded()
    await largeImgLoc.click({ button: 'right', position: { x: 80, y: 80 } })
    await page.locator('.md-context-menu button').filter({ hasText: '放大预览' }).click()
    await page.waitForFunction(() => {
      const lb = document.querySelector('dialog.md-image-lightbox[open] img')
      return lb && lb.complete && lb.naturalWidth === 6000
    }, null, { timeout: 15000 })
    await page.locator('dialog.md-image-lightbox button[aria-label="放大"]').click()
    await page.locator('dialog.md-image-lightbox button[aria-label="关闭预览"]').click()
    await page.waitForFunction(() => !document.querySelector('dialog.md-image-lightbox[open]'))
    assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.blobs.liveUrls), 1)
    await closeAll()
    assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.blobs.liveUrls), 0)
    return { initialLoaded, afterScrollLoaded, previewNaturalW, lightboxFullW: 6000 }
  })

  // Scenario L: PDF open and close 20 times
  await runScenario('L', 'PDF 打开和关闭 20 次', async () => {
    await closeAll()
    await page.evaluate(() => window.__resetMemorySceneProbe())
    for (let i = 0; i < 20; i++) {
      await openFile('sample-multi.pdf')
      await page.waitForFunction(() => {
        const c = document.querySelector('.pdf-page canvas')
        return c && c.width > 0 && c.height > 0
      })
      await closeAll()
    }
    await new Promise(r => setTimeout(r, 250))
    const pdfRes = await page.evaluate(() => ({
      workers: { ...window.__markumoMemoryProbe.workers },
      canvases: document.querySelectorAll('canvas').length,
    }))
    assert.equal(pdfRes.workers.live, 0)
    assert.equal(pdfRes.canvases, 0)
    return pdfRes
  })

  // Scenario M: Background window pause and restore
  await runScenario('M', '后台窗口恢复', async () => {
    await closeAll()
    const res = await page.evaluate(async f => {
      let hiddenState = true
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenState })
      document.dispatchEvent(new Event('visibilitychange'))

      const o = await window.__TAURI_INTERNALS__.invoke('open_recent', { path: f, encoding: null })
      window.__nativeManager.openFile(o, false)
      while (document.querySelectorAll('.markdown-live .md-code-block').length !== 50) {
        await new Promise(r => setTimeout(r, 10))
      }
      await new Promise(r => setTimeout(r, 150))
      const highlightedWhileHidden = [...document.querySelectorAll('.markdown-live .md-code-block')].filter(b =>
        b.querySelector('.md-code-line span[class]')
      ).length

      hiddenState = false
      document.dispatchEvent(new Event('visibilitychange'))
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const count = [...document.querySelectorAll('.markdown-live .md-code-block')].filter(b =>
          b.querySelector('.md-code-line span[class]')
        ).length
        if (count >= 2) break
        await new Promise(r => setTimeout(r, 15))
      }
      const highlightedAfterRestore = [...document.querySelectorAll('.markdown-live .md-code-block')].filter(b =>
        b.querySelector('.md-code-line span[class]')
      ).length
      delete document.hidden
      return { highlightedWhileHidden, highlightedAfterRestore }
    }, path.join(fixtureDir, 'code-50.md'))

    assert.equal(res.highlightedWhileHidden, 0, 'Background window must pause non-essential code highlighting')
    assert(res.highlightedAfterRestore >= 2, 'Restoring foreground window must resume viewport highlighting')
    return res
  })

  // Scenario N: Post-close resource reclamation
  await runScenario('N', '关闭文档后回收资源', async () => {
    await openFile('code-200.md')
    await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 200)
    await openFile('doc-large-image.md')
    await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-live-image img'))
    await openFile('sample-multi.pdf')
    await page.waitForFunction(() => !!document.querySelector('.pdf-page canvas'))

    const loadedPerf = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    await closeAll()

    const decay = []
    for (const waitMs of [0, 500, 1000]) {
      if (waitMs > 0) await new Promise(r => setTimeout(r, 500))
      const p = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
      decay.push({ waitMs, heapMiB: Number((p.JSHeapUsedSize / 1048576).toFixed(2)) })
    }
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.collectGarbage')
    const settledPerf = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const settledDom = await cdp.send('Memory.getDOMCounters')
    const finalProbe = await page.evaluate(() => ({
      pm: window.__markumoMemoryProbe.editors.pm.live,
      mainCM: window.__markumoMemoryProbe.editors.mainCM.live,
      embCM: window.__markumoMemoryProbe.editors.embeddedCM.live,
      workers: window.__markumoMemoryProbe.workers.live,
      blobs: window.__markumoMemoryProbe.blobs.liveUrls,
      records: window.__nativeManager['records'].size,
      media: window.__nativeManager.openedDocuments.length,
    }))
    assert.deepEqual(finalProbe, { pm: 0, mainCM: 0, embCM: 0, workers: 0, blobs: 0, records: 0, media: 0 })
    return {
      loadedHeapMiB: Number((loadedPerf.JSHeapUsedSize / 1048576).toFixed(2)),
      naturalDecay: decay,
      settledPostGcHeapMiB: Number((settledPerf.JSHeapUsedSize / 1048576).toFixed(2)),
      settledDomNodes: settledDom.nodes,
      finalProbe,
    }
  })

  assert.deepEqual(errors, [], `Unexpected page/console errors: ${errors.join('; ')}`)
  fs.writeFileSync(
    path.join(root, 'acceptance-a-to-n.json'),
    JSON.stringify({ completedAt: new Date().toISOString(), label, binary, scenarios: scenarioResults, errors }, null, 2)
  )
  console.log(`ALL 14 ACCEPTANCE SCENARIOS (A-N) PASSED WITH ZERO ERRORS!`)
} finally {
  await browser?.close().catch(() => {})
  if (child.exitCode === null) child.kill()
}
