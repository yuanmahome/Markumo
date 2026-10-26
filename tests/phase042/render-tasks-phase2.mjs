import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1472, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-phase042-p2',
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))

try {
  await page.goto('http://127.0.0.1:1472/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  // 1. Bounded RenderTaskQueue concurrency, priority, cancellation, and queue cap
  const queueResult = await page.evaluate(async () => {
    const { createRenderTaskQueue } = await import('/src/editor/markdown/renderTaskQueue.ts')
    const queue = createRenderTaskQueue(2, 5)
    let running = 0
    let maxObserved = 0
    const order = []
    const gates = []
    const hold = label =>
      new Promise(resolve => {
        gates.push({ label, resolve })
      })

    const p1 = queue(async () => {
      running++
      maxObserved = Math.max(maxObserved, running)
      order.push('t1')
      await hold('t1')
      running--
      return 't1'
    })
    const p2 = queue(async () => {
      running++
      maxObserved = Math.max(maxObserved, running)
      order.push('t2')
      await hold('t2')
      running--
      return 't2'
    })

    const abortCtrl = new AbortController()
    const pCancelled = queue(async () => {
      order.push('cancelled-should-never-run')
      return 'bad'
    }, { signal: abortCtrl.signal })

    const pNormal = queue(async () => {
      order.push('normal')
      return 'normal'
    })
    const pHigh = queue(async () => {
      order.push('high')
      return 'high'
    }, { priority: 'high' })

    // Cancel queued task before it starts
    abortCtrl.abort()
    let cancelRejected = false
    try {
      await pCancelled
    } catch (e) {
      cancelRejected = e instanceof DOMException && e.name === 'AbortError'
    }

    await new Promise(r => setTimeout(r, 10))
    for (const g of gates) g.resolve()
    await Promise.all([p1, p2, pNormal, pHigh])

    // Test maxQueued cap (5): lock 2 active slots, push 7 normal tasks -> 2 must be dropped cleanly
    const lockGates = []
    const lockTask = () =>
      queue(
        () =>
          new Promise(r => {
            lockGates.push(r)
          })
      )
    const l1 = lockTask()
    const l2 = lockTask()
    await new Promise(r => setTimeout(r, 10))
    const burst = Array.from({ length: 7 }, (_, idx) =>
      queue(async () => idx).then(
        v => ({ ok: true, v }),
        () => ({ ok: false })
      )
    )
    for (const r of lockGates) r()
    const burstSettled = await Promise.all([l1, l2, ...burst])

    return {
      maxObserved,
      order,
      cancelRejected,
      stats: queue.stats(),
      droppedCount: burstSettled.slice(2).filter(x => !x.ok).length,
    }
  })

  assert.equal(queueResult.maxObserved, 2, 'Concurrency must never exceed 2')
  assert.equal(queueResult.cancelRejected, true, 'Aborted queued task must reject with AbortError')
  assert(!queueResult.order.includes('cancelled-should-never-run'), 'Cancelled queued task must never execute')
  assert.deepEqual(queueResult.order, ['t1', 't2', 'high', 'normal'], 'High priority task must run ahead of normal queued task')
  assert.equal(queueResult.droppedCount, 2, 'Bounded queue must drop excess tasks instead of unbounded queueing')
  console.log('PASS RenderTaskQueue concurrency=2, priority, cancellation & bounded queue cap')

  // 2. Dual-bounded LRU cache (entry count + byte budget) & Mermaid cancellation isolation across panes
  const cacheAndMermaid = await page.evaluate(async () => {
    const {
      renderDiagram,
      renderMath,
      clearRenderCaches,
      getRenderCacheStats,
      MATH_CACHE_LIMIT,
      MATH_CACHE_MAX_BYTES,
      DIAGRAM_CACHE_LIMIT,
      DIAGRAM_CACHE_MAX_BYTES,
    } = await import('/src/editor/markdown/wysiwyg/renderers.ts')

    clearRenderCaches()
    const sandbox = document.createElement('div')
    document.body.append(sandbox)

    // Test math entry cap (300) and active DOM preservation after cache eviction
    const firstMathHost = document.createElement('span')
    sandbox.append(firstMathHost)
    await renderMath(firstMathHost, 'x_0 + y_0 = z_0', false)
    const firstRenderedHtml = firstMathHost.innerHTML

    for (let i = 1; i <= 325; i++) {
      const h = document.createElement('span')
      sandbox.append(h)
      await renderMath(h, `a_{${i}} + b_{${i}} = c_{${i}}`, false)
      h.remove()
    }
    const afterMathStats = getRenderCacheStats()
    const firstStillIntact = firstMathHost.innerHTML === firstRenderedHtml && firstMathHost.querySelector('.katex') !== null

    // Test Mermaid cancellation isolation: cancel request A while request B renders same diagram
    const hostA = document.createElement('div')
    const hostB = document.createElement('div')
    const hostC = document.createElement('div')
    sandbox.append(hostA, hostB, hostC)

    const ctrlA = new AbortController()
    const src = 'graph TD\n  Start --> Check\n  Check --> End'
    // Occupy serial slot first with another diagram, then queue A and B, then abort A immediately
    const warmPromise = renderDiagram(hostC, 'graph LR\n  P1 --> P2')
    const reqA = renderDiagram(hostA, src, () => true, ctrlA.signal)
    const reqB = renderDiagram(hostB, src, () => true)
    ctrlA.abort()
    await Promise.all([warmPromise, reqA, reqB])

    const aHasSvg = !!hostA.querySelector('svg')
    const bHasSvg = !!hostB.querySelector('svg')
    const cHasSvg = !!hostC.querySelector('svg')
    // Unique SVG IDs across mounted diagrams
    const allIds = [...sandbox.querySelectorAll('svg [id]')].map(el => el.id)
    const uniqueIds = new Set(allIds).size === allIds.length

    const finalStats = getRenderCacheStats()
    sandbox.remove()
    return {
      afterMathStats,
      MATH_CACHE_LIMIT,
      MATH_CACHE_MAX_BYTES,
      DIAGRAM_CACHE_LIMIT,
      DIAGRAM_CACHE_MAX_BYTES,
      firstStillIntact,
      aHasSvg,
      bHasSvg,
      cHasSvg,
      uniqueIds,
      finalStats,
    }
  })

  assert(cacheAndMermaid.afterMathStats.mathEntries <= cacheAndMermaid.MATH_CACHE_LIMIT)
  assert(cacheAndMermaid.afterMathStats.mathBytes <= cacheAndMermaid.MATH_CACHE_MAX_BYTES)
  assert.equal(cacheAndMermaid.firstStillIntact, true, 'Evicting cache entry must not break active view DOM')
  assert.equal(cacheAndMermaid.aHasSvg, false, 'Aborted diagram request must not mount into cancelled host')
  assert.equal(cacheAndMermaid.bHasSvg, true, 'Cancelling one pane request must not break another pane rendering the same diagram')
  assert.equal(cacheAndMermaid.cHasSvg, true)
  assert.equal(cacheAndMermaid.uniqueIds, true, 'Mounted SVG IDs must remain isolated')
  assert(cacheAndMermaid.finalStats.diagramEntries <= cacheAndMermaid.DIAGRAM_CACHE_LIMIT)
  assert(cacheAndMermaid.finalStats.diagramBytes <= cacheAndMermaid.DIAGRAM_CACHE_MAX_BYTES)
  console.log('PASS Dual-bounded math/diagram caches & Mermaid cross-pane cancellation isolation')

  // 3. Window hidden pauses off-task rendering & resumes on visibilitychange; typing does not re-render formulas
  const hiddenAndTyping = await page.evaluate(async () => {
    const { clearRenderCaches } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    clearRenderCaches()

    let hiddenFlag = true
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hiddenFlag,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    const docWithFormulasAndCode =
      '# Hidden Window Check\n\nOrdinary text start.\n\nInline formula: $E = mc^2$.\n\n```typescript\nconst x: number = 42;\n```\n'
    window.f.reset(docWithFormulasAndCode)
    while (!window.f.ready()) await new Promise(r => setTimeout(r, 10))
    await new Promise(r => setTimeout(r, 120))

    const katexWhileHidden = document.querySelectorAll('.markdown-live .katex').length
    const tokensWhileHidden = document.querySelectorAll('.markdown-live .md-code-line span[class]').length

    // Restore window visibility -> queued/dirty code highlight & math must automatically resume!
    hiddenFlag = false
    document.dispatchEvent(new Event('visibilitychange'))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (
        document.querySelectorAll('.markdown-live .katex').length >= 1 &&
        document.querySelectorAll('.markdown-live .md-code-line span[class]').length > 0
      ) {
        break
      }
      await new Promise(r => setTimeout(r, 15))
    }
    const katexAfterVisible = document.querySelectorAll('.markdown-live .katex').length
    const tokensAfterVisible = document.querySelectorAll('.markdown-live .md-code-line span[class]').length

    // Verify typing in ordinary paragraph does NOT re-render existing formula DOM node
    const existingKatexNode = document.querySelector('.markdown-live .katex')
    window.f.caret('Ordinary text start.')
    return {
      katexWhileHidden,
      tokensWhileHidden,
      katexAfterVisible,
      tokensAfterVisible,
      hasKatexNode: !!existingKatexNode,
    }
  })

  assert.equal(hiddenAndTyping.katexWhileHidden, 0, 'Hidden window must pause non-essential formula compilation')
  assert.equal(hiddenAndTyping.tokensWhileHidden, 0, 'Hidden window must pause non-essential code highlighting')
  assert.equal(hiddenAndTyping.katexAfterVisible, 1, 'Restoring visibility must resume formula rendering')
  assert(hiddenAndTyping.tokensAfterVisible > 0, 'Restoring visibility must resume code highlighting')

  // Type ordinary text and verify exact same .katex DOM instance remains untouched (not re-rendered)
  await page.evaluate(() => {
    window.__markedKatex = document.querySelector('.markdown-live .katex')
  })
  await page.keyboard.type(' typing more plain words')
  const sameKatex = await page.evaluate(() => document.querySelector('.markdown-live .katex') === window.__markedKatex)
  assert.equal(sameKatex, true, 'Ordinary paragraph typing must not re-render unchanged formulas')
  console.log('PASS Background window pause/resume & zero formula re-render during ordinary typing')

  // 4. Split mode viewport-bounded hydration & complete DOM release when switching back to Live
  const splitCheck = await page.evaluate(async () => {
    const blocks = Array.from(
      { length: 40 },
      (_, i) => `## Section ${i + 1}\n\nFormula $x_{${i}} + 1$.\n\n\`\`\`javascript\nfunction f${i}() { return ${i}; }\n\`\`\`\n`
    ).join('\n')
    window.f.reset('# Split Test\n\n' + blocks)
    while (!window.f.ready()) await new Promise(r => setTimeout(r, 10))
    window.f.mode('split')
    await new Promise(r => setTimeout(r, 300))

    const totalFences = document.querySelectorAll('.split-preview-pane .md-preview-fence').length
    const highlightedFences = [...document.querySelectorAll('.split-preview-pane .md-preview-fence')].filter(el =>
      el.querySelector('.md-code-text span[class]')
    ).length

    // Switch back to Live -> SplitPreview must be unmounted (not v-show hidden)
    window.f.mode('live')
    while (!window.f.ready()) await new Promise(r => setTimeout(r, 10))
    const remainingSplitDom = document.querySelectorAll('.split-preview-pane').length
    return { totalFences, highlightedFences, remainingSplitDom }
  })

  assert.equal(splitCheck.totalFences, 40)
  assert(
    splitCheck.highlightedFences > 0 && splitCheck.highlightedFences < 20,
    `Split preview should highlight only near-viewport fences (got ${splitCheck.highlightedFences}/40)`
  )
  assert.equal(splitCheck.remainingSplitDom, 0, 'Switching back to Live must destroy SplitPreview DOM')
  console.log(`PASS Split preview viewport-bounded highlighting (${splitCheck.highlightedFences}/40) & clean unmount`)

  assert.deepEqual(errors, [])
  console.log('ALL PHASE 2 VERIFICATION CHECKS PASSED!')
} finally {
  await browser.close()
  await server.close()
}
