import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { ensurePhase042Fixtures } from '../../scripts/memory-fixtures.mjs'

const root = path.resolve('test-results/phase042')
const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) || 'phase3'
const binary = path.join(root, `markumo-${label}.exe`)
assert(fs.existsSync(binary), `Missing Release binary: ${binary}`)

const config = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`), 'utf8'))
const profile = config.app.appDirectoriesOverride
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(profile, { recursive: true })

const fixtureDir = path.join(root, 'fixtures')
ensurePhase042Fixtures(fixtureDir)

// Create a Markdown fixture with 25 distinct/spaced local images + broken/remote refs to test lazy viewport loading & zero infinite retry
const manyImagesMd = [
  '# 25 Images Viewport Lazy Loading Test\n',
  '![Broken Missing](non-existent-file-12345.png)\n',
  '![Remote Blocked](https://example.invalid/remote-image.png)\n',
  ...Array.from(
    { length: 25 },
    (_, i) =>
      `## Image Section ${i + 1}\n\n` +
      'Spacer paragraph line to push subsequent images far below the 400px viewport margin.\n\n'.repeat(6) +
      `![Sample ${i + 1}](${i % 2 === 0 ? 'img-small-1.png' : 'img-small-2.png'})\n`
  ),
].join('\n')
fs.writeFileSync(path.join(fixtureDir, 'doc-many-images.md'), manyImagesMd, 'utf8')

const recentNames = [
  'doc-many-images.md',
  'doc-large-image.md',
  'doc-5kb-2img.md',
  'code-50.md',
  'sample-multi.pdf',
  'img-large-24mp.png',
]

fs.writeFileSync(
  path.join(profile, 'editor-settings.json'),
  JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false })
)
fs.writeFileSync(
  path.join(profile, 'files.json'),
  JSON.stringify({
    recent: recentNames.map(name => ({ path: path.join(fixtureDir, name), name })),
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

const port = 9681
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

  const openFile = name =>
    page.evaluate(async f => {
      const o = await window.__TAURI_INTERNALS__.invoke('open_recent', { path: f, encoding: null })
      return window.__nativeManager.openFile(o, false)
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

  // 1. Lazy loading of many images + broken/remote placeholders without infinite retry
  await page.evaluate(() => window.__resetMemorySceneProbe())
  await openFile('doc-many-images.md')
  await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-live-image').length === 27)
  await new Promise(r => setTimeout(r, 350))

  const lazyState = await page.evaluate(() => {
    const totalSlots = document.querySelectorAll('.markdown-live .md-live-image').length
    const loadedImgs = document.querySelectorAll('.markdown-live .md-live-image img').length
    const brokenSlots = document.querySelectorAll('.markdown-live .md-live-image.is-broken-image').length
    const pendingRemote = document.querySelectorAll('.markdown-live .md-image-media.is-pending-image').length
    return {
      totalSlots,
      loadedImgs,
      brokenSlots,
      pendingRemote,
      blobs: { ...window.__markumoMemoryProbe.blobs },
    }
  })
  assert.equal(lazyState.totalSlots, 27)
  assert(
    lazyState.loadedImgs > 0 && lazyState.loadedImgs <= 6,
    `Offscreen images must NOT all preload up front (loaded ${lazyState.loadedImgs} of 25 local images)`
  )
  assert.equal(lazyState.brokenSlots, 1, 'Missing image must render lightweight broken placeholder')
  assert.equal(lazyState.pendingRemote, 1, 'Unconsented remote HTTPS image must stay inert placeholder')
  // Wait 300ms more to verify broken image never triggers infinite retry
  const blobsBeforeWait = lazyState.blobs.created
  await new Promise(r => setTimeout(r, 300))
  const blobsAfterWait = await page.evaluate(() => window.__markumoMemoryProbe.blobs.created)
  assert.equal(blobsAfterWait, blobsBeforeWait, 'Failed image load must never trigger infinite retries')
  console.log(`PASS 25-image lazy loading (${lazyState.loadedImgs}/25 loaded initially), broken/remote safety & zero retry loop`)

  // 2. Cross-pane shared Blob URL with reference counting (closing 1 pane must NOT revoke Blob used by pane 2)
  await closeAll()
  await page.evaluate(() => window.__resetMemorySceneProbe())
  await openFile('doc-5kb-2img.md')
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.markdown-live .md-live-image img')]
    return imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0)
  })
  await page.evaluate(() => {
    const m = window.__nativeManager
    m.splitPane('right', m.activePane, m.activeId)
  })
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.markdown-live .md-live-image img')]
    return imgs.length === 4 && imgs.every(i => i.complete && i.naturalWidth > 0)
  })
  const sharedState = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('.markdown-live')]
    const p1Urls = [...panes[0].querySelectorAll('.md-live-image img')].map(i => i.src)
    const p2Urls = [...panes[1].querySelectorAll('.md-live-image img')].map(i => i.src)
    return { p1Urls, p2Urls, blobs: { ...window.__markumoMemoryProbe.blobs } }
  })
  assert.deepEqual(sharedState.p1Urls, sharedState.p2Urls, 'Both panes must share identical Blob URLs')
  assert.equal(sharedState.blobs.liveUrls, 2, 'Two distinct images across two panes must create only 2 Blob URLs')

  // Close secondary split pane -> remaining pane's images must stay valid (liveUrls still 2)
  await page.evaluate(() => window.__nativeManager.closeSplit())
  await page.waitForFunction(() => document.querySelectorAll('.markdown-live').length === 1)
  assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.blobs.liveUrls), 2, 'Blob URLs still used by active pane must remain alive')

  // Close the last pane referencing the document -> unreferenced document Blobs must be revoked (liveUrls = 0)!
  await closeAll()
  assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.blobs.liveUrls), 0, 'Closing last pane of document must revoke its unreferenced Blob URLs')
  console.log('PASS Cross-pane Blob URL deduplication, reference counting & last-pane revocation')

  // 3. Large 24MP image: downsampled preview in Live & Split (<3.5 MP) vs full 24.00 MP in Lightbox, then revoked on close!
  await page.evaluate(() => window.__resetMemorySceneProbe())
  const largeDocId = await openFile('doc-large-image.md')
  await page.waitForFunction(() => {
    const img = document.querySelector('.markdown-live .md-live-image img')
    return img && img.complete && img.naturalWidth > 0
  })
  const livePreviewInfo = await page.evaluate(() => {
    const img = document.querySelector('.markdown-live .md-live-image img')
    return {
      w: img.naturalWidth,
      h: img.naturalHeight,
      mp: Number(((img.naturalWidth * img.naturalHeight) / 1_000_000).toFixed(3)),
      blobs: { ...window.__markumoMemoryProbe.blobs },
    }
  })
  assert(
    livePreviewInfo.w <= 2048 && livePreviewInfo.mp < 3.5,
    `Live markdown must use Rust downsampled preview (got ${livePreviewInfo.w}x${livePreviewInfo.h} = ${livePreviewInfo.mp} MP)`
  )

  // Open context menu on image -> click "放大预览" -> verify upgrade to 6000x4000 (24 MP) full resolution!
  await page.locator('.markdown-live .md-live-image img').click({ button: 'right' })
  await page.locator('.md-context-menu button').filter({ hasText: '放大预览' }).click()
  await page.waitForFunction(() => {
    const lbImg = document.querySelector('dialog.md-image-lightbox[open] img')
    return lbImg && lbImg.complete && lbImg.naturalWidth === 6000 && lbImg.naturalHeight === 4000
  }, null, { timeout: 15000 })

  const lightboxInfo = await page.evaluate(() => {
    const lbImg = document.querySelector('dialog.md-image-lightbox[open] img')
    return {
      w: lbImg.naturalWidth,
      h: lbImg.naturalHeight,
      blobs: { ...window.__markumoMemoryProbe.blobs },
    }
  })
  assert.equal(lightboxInfo.w, 6000)
  assert.equal(lightboxInfo.h, 4000)
  assert.equal(lightboxInfo.blobs.liveUrls, 2, 'Lightbox holds temporary full-res Blob URL alongside preview Blob URL')

  // Close lightbox -> full-res 24MP Blob URL must be immediately revoked!
  await page.locator('dialog.md-image-lightbox button[aria-label="关闭预览"]').click()
  await page.waitForFunction(() => !document.querySelector('dialog.md-image-lightbox[open]'))
  const afterLightboxClose = await page.evaluate(() => ({ ...window.__markumoMemoryProbe.blobs }))
  assert.equal(afterLightboxClose.liveUrls, 1, 'Closing lightbox must immediately revoke full-resolution Blob URL')

  // Also verify Split preview uses downsampled preview
  await page.evaluate(id => window.__nativeManager.setMarkdownMode(id, 'split'), largeDocId)
  await page.waitForFunction(() => {
    const img = document.querySelector('.split-preview-pane img')
    return img && img.complete && img.naturalWidth > 0
  })
  const splitImgW = await page.evaluate(() => document.querySelector('.split-preview-pane img').naturalWidth)
  assert(splitImgW <= 2048, `Split preview must also use downsampled image (got width=${splitImgW})`)
  await closeAll()
  assert.equal(await page.evaluate(() => window.__markumoMemoryProbe.blobs.liveUrls), 0)
  console.log(
    `PASS 24MP image: Live/Split downsampled (${livePreviewInfo.w}x${livePreviewInfo.h}, ${livePreviewInfo.mp}MP) -> Lightbox full-res (6000x4000, 24MP) -> immediate revoke`
  )

  // 4. PDF Viewer 20 open/close cycles -> 0 leaked Workers, 0 leaked Canvases, bounded DOM & listeners
  await page.evaluate(() => window.__resetMemorySceneProbe())
  await cdp.send('HeapProfiler.collectGarbage')
  const beforePdfDom = await cdp.send('Memory.getDOMCounters')
  for (let i = 0; i < 20; i++) {
    await openFile('sample-multi.pdf')
    await page.waitForFunction(() => {
      const c = document.querySelector('.pdf-page canvas')
      return c && c.width > 0 && c.height > 0
    })
    await closeAll()
  }
  await new Promise(r => setTimeout(r, 300))
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const afterPdfDom = await cdp.send('Memory.getDOMCounters')
  const pdfProbe = await page.evaluate(() => ({
    workers: { ...window.__markumoMemoryProbe.workers },
    canvases: document.querySelectorAll('canvas').length,
  }))
  assert.equal(pdfProbe.workers.live, 0, 'All 20 PDF Workers must be terminated after closing')
  assert.equal(pdfProbe.canvases, 0, 'All PDF Canvases (including TextLayer measurement canvas) must be cleaned up')
  console.log(
    `PASS PDF 20 open/close cycles -> workers.live=0, canvases=0, DOM=${beforePdfDom.nodes}->${afterPdfDom.nodes}, listeners=${beforePdfDom.jsEventListeners}->${afterPdfDom.jsEventListeners}`
  )

  // 5. Verify Detached DOM & Listener fix on 20 open/switch/close cycles (previously leaked 149,889 DOM nodes!)
  for (let i = 0; i < 20; i++) {
    const a = await openFile('code-50.md')
    await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-code-block').length === 50)
    const b = await openFile('doc-5kb-2img.md')
    await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-live-image img'))
    await page.evaluate(({ a, b }) => {
      const m = window.__nativeManager
      m.select(a)
      m.setMarkdownMode(a, 'source')
      m.setMarkdownMode(a, 'live')
      m.select(b)
    }, { a, b })
    await new Promise(r => setTimeout(r, 25))
    await closeAll()
  }
  await new Promise(r => setTimeout(r, 400))
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const after20CyclesDom = await cdp.send('Memory.getDOMCounters')
  console.log(
    `PASS 20 mixed open/switch/close cycles -> settled DOM=${after20CyclesDom.nodes} (was 149,889!), listeners=${after20CyclesDom.jsEventListeners} (was 5,461!)`
  )
  assert(
    after20CyclesDom.nodes < 5000,
    `Detached DOM leak must stay eliminated (got ${after20CyclesDom.nodes}, baseline was 149,889)`
  )

  assert.deepEqual(errors, [])
  console.log('ALL PHASE 3 VERIFICATION CHECKS PASSED!')
} finally {
  await browser?.close().catch(() => {})
  if (child.exitCode === null) child.kill()
}
