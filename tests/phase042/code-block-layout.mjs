// Real DOM geometry and pointer regression for the lazy static/CM code block.
// --baseline loads only the three layout files from v1.0.7, without changing the checkout.
// --full adds the zoom/font/width/theme matrix. --native=<label> uses an isolated Release.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const baseline = process.argv.includes('--baseline')
const baselineRef = process.argv.find(arg => arg.startsWith('--baseline-ref='))?.slice(15) || 'e72cf73'
const full = process.argv.includes('--full')
const interactionsOnly = process.argv.includes('--interactions-only')
const native = process.argv.find(arg => arg.startsWith('--native='))?.slice(9)
const output = path.resolve('test-results/phase042/code-layout')
const port = interactionsOnly ? 1479 : baseline ? 1480 : 1478
fs.mkdirSync(output, { recursive: true })
const originals = new Map()
if (baseline) for (const file of [
  'src/editor/markdown/wysiwyg/CodeBlockView.ts',
  'src/editor/markdown/wysiwyg/MarkdownTheme.css',
  'src/editor/markdown/staticCode.ts',
]) originals.set(path.resolve(file).replaceAll('\\', '/'), execFileSync('git', ['show', `${baselineRef}:${file}`], { encoding: 'utf8' }))

let server, child, browser, page, cdp
const report = { engine: native ? 'WebView2 Release' : 'Chromium', baseline, baselineRef: baseline ? baselineRef : undefined, cycles: baseline ? 1 : 20, cases: [], interactions: [], errors: [] }
const settle = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
try {
  if (native) {
    const root = path.resolve('test-results/phase042')
    const binary = path.join(root, `markumo-${native}.exe`)
    assert(fs.existsSync(binary), `Build isolated Release first: ${binary}`)
    const config = JSON.parse(fs.readFileSync(path.join(root, `config-${native}.json`), 'utf8'))
    report.build = JSON.parse(fs.readFileSync(path.join(root, `build-${native}.json`), 'utf8'))
    const profile = path.resolve(config.app.appDirectoriesOverride)
    assert(profile.startsWith(root + path.sep), 'Only reset the isolated test profile inside test-results/phase042')
    fs.rmSync(profile, { recursive: true, force: true })
    fs.mkdirSync(config.app.appDirectoriesOverride, { recursive: true })
    fs.writeFileSync(path.join(config.app.appDirectoriesOverride, 'editor-settings.json'), JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false }))
    child = spawn(binary, [], { windowsHide: true, env: { ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: path.join(output, `wv-${native}-${Date.now()}`),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9688',
    } })
    const deadline = Date.now() + 30000
    while (true) {
      try { if ((await fetch('http://127.0.0.1:9688/json/version')).ok) break } catch {}
      assert(Date.now() < deadline, 'WebView2 debug port unavailable')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:9688')
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => !candidate.url().startsWith('devtools:'))
    await page.waitForFunction(() => !!window.__nativeManager && !document.querySelector('.startup-overlay'))
  } else {
    server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
      cacheDir: 'node_modules/.vite-code-layout', plugins: [{ name: 'code-layout-baseline', enforce: 'pre',
        load(id) { return originals.get(id.split('?')[0].replaceAll('\\', '/')) },
        transform(code, id) {
          if (!id.replaceAll('\\', '/').endsWith('/wysiwyg/CodeBlockView.ts')) return
          return "import { ViewPlugin as LayoutProbe } from '@codemirror/view';\n" + code.replace('extensions: [', `extensions: [LayoutProbe.define(() => {
            const p = (window.__layoutCM ||= { created: 0, live: 0, peak: 0 });
            p.created++; p.live++; p.peak = Math.max(p.peak, p.live);
            return { destroy() { p.live-- } };
          }),`)
        },
      }] })
    await server.listen()
    browser = await chromium.launch({ headless: true, ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}) })
    page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/tests/markdown-links/fixture.html`)
    await page.waitForFunction(() => !!window.f)
  }
  page.on('pageerror', error => report.errors.push(error.message))
  cdp = await page.context().newCDPSession(page)

  async function reset(config) {
    const source = config.source ?? Array.from({ length: config.lines }, (_, index) => `alpha beta ${index + 1}`).join('\n')
    // Tall logical viewport measures every DOM line of <=1000-line cases, rather
    // than confusing CM's virtual gaps/visual wraps with Markdown logical rows.
    const height = config.scroll ? 800 : Math.min(50000, Math.max(900, source.split('\n').length * config.font * 1.65 * (config.wrap ? 3 : 1) + 700))
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: Math.ceil(height), deviceScaleFactor: config.zoom, mobile: false })
    await page.evaluate(async ({ config, source }) => {
      document.documentElement.style.zoom = String(config.zoom)
      document.body.classList.toggle('light', config.light)
      let manager, id
      const markdown = `Intro paragraph.\n\n\`\`\`${config.language ?? ''}\n${source}\n\`\`\`\n\n## Following heading\n\nFollowing paragraph.\n`
      if (window.f) {
        document.querySelector('#app').style.height = '100vh'
        window.f.reset(markdown)
        manager = window.f.manager; id = window.f.id
      } else {
        manager = window.__nativeManager
        manager.closeSplit()
        for (const document of [...manager.openedDocuments]) manager.close(document.id, true)
        id = manager.createUntitled('md')
        const initial = { changes: { from: 0, insert: markdown } }
        const transaction = manager.getState(id).update(initial)
        manager.dispatch(id, { ...initial, annotations: transaction.constructor.addToHistory.of(false) })
      }
      manager.setMarkdownTypography({ width: config.width, fontSize: 16, fontFamily: 'system', lineHeight: 1.6,
        codeLineNumbers: config.numbers, codeWrap: config.wrap, imageBorder: true })
      manager.setCaretAnimation('off')
      window.layout = { manager, id, source, config }
    }, { config, source })
    await page.waitForFunction(() => window.layout.manager.activeLiveEditor && document.querySelector('.md-code-block'))
    if (config.panes) {
      await page.evaluate(() => {
        if (window.f) window.f.split()
        else window.layout.manager.splitPane('right')
      })
      await page.waitForFunction(() => document.querySelectorAll('.markdown-live').length === 2)
    }
    await page.evaluate(config => {
      for (const pane of document.querySelectorAll('.markdown-live')) {
        pane.style.setProperty('--md-code-font-size', `${config.font}px`)
        if (config.family) pane.style.setProperty('--font-mono', config.family)
      }
      const pane = document.querySelectorAll('.markdown-live')[config.pane ?? 0]
      const editor = [...window.layout.manager.liveViews.values()].find(item => item.editor.dom === pane).editor
      const block = pane.querySelector('.md-code-block')
      const code = [...editor.codeViews].find(view => view.dom === block)
      Object.assign(window.layout, { pane, editor, block, code })
      pane.scrollTop = 0
    }, config)
    await settle()
    if (config.language) await page.waitForFunction(() => ['ready', 'plain'].includes(window.layout.block.dataset.languageStatus))
    assert.equal(await page.locator('.md-code-block .cm-editor').count(), 0, 'Idle blocks allocate no CMView')
    return source
  }

  // Range rectangles measure glyphs, not a guessed character width. Empty rows
  // use the logical line box; both values are recorded separately.
  async function sample() {
    return page.evaluate(() => {
      const { block, pane, code, source } = window.layout
      const cm = code.existingEditor
      const pre = block.querySelector('.md-code-placeholder')
      const scroll = pre || cm.scrollDOM
      const origin = block.getBoundingClientRect()
      const rect = element => {
        const box = element.getBoundingClientRect()
        return { x: box.x / window.layout.config.zoom, y: box.y / window.layout.config.zoom, width: box.width / window.layout.config.zoom, height: box.height / window.layout.config.zoom }
      }
      const glyph = (element, offset, length = 1) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node, from, to, remaining = offset
        while ((node = walker.nextNode())) {
          if (remaining <= node.length) { from = { node, at: remaining }; break }
          remaining -= node.length
        }
        if (!from) return null
        remaining = length
        node = from.node
        let at = from.at
        while (node) {
          if (remaining <= node.length - at) { to = { node, at: at + remaining }; break }
          remaining -= node.length - at; node = walker.nextNode(); at = 0
        }
        if (!to) return null
        const range = document.createRange()
        range.setStart(from.node, from.at); range.setEnd(to.node, to.at)
        const box = range.getBoundingClientRect(), zoom = window.layout.config.zoom
        return { x: box.x / zoom, y: box.y / zoom, width: box.width / zoom, height: box.height / zoom }
      }
      const lines = source.split('\n'), rows = []
      if (pre) {
        const flat = pre.querySelector('.md-code-flat-text') || pre.querySelector('code.md-code-flat')
        const elements = [...pre.querySelectorAll('.md-code-line')]
        let offset = 0, numberOffset = 0
        for (let index = 0; index < lines.length; index++) {
          const row = flat || elements[index]
          const text = flat || row.querySelector('.md-code-text') || row
          const number = flat ? pre.querySelector('.md-code-number') : row.querySelector('.md-code-number')
          let numberBox = number ? glyph(number, flat ? numberOffset : 0, String(index + 1).length) : null
          let gutterWidth = number ? rect(number).width : 0
          if (!number && window.layout.config.numbers) {
            // HEAD uses generated pseudo content, which has no Range API.
            // Record its computed box separately as an inferred baseline only.
            const pseudo = getComputedStyle(row, '::before')
            gutterWidth = parseFloat(pseudo.width)
            const style = getComputedStyle(text)
            const lineHeight = parseFloat(style.lineHeight)
            numberBox = { x: rect(row).x, y: rect(row).y + (flat ? index * lineHeight : 0), width: gutterWidth, height: lineHeight, inferred: true }
          }
          rows.push({ line: index + 1, text: lines[index] ? glyph(text, flat ? offset : 0) : null,
            box: rect(row), number: numberBox, gutterWidth })
          offset += lines[index].length + 1
          numberOffset += String(index + 1).length + 1
        }
      } else {
        const gutter = cm.dom.querySelector('.cm-gutters')
        const numbers = new Map([...cm.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
          .filter(element => element.style.visibility !== 'hidden').map(element => [element.textContent, element]))
        for (const element of cm.contentDOM.querySelectorAll('.cm-line')) {
          const pos = cm.posAtDOM(element, 0), line = cm.state.doc.lineAt(pos).number
          const number = numbers.get(String(line))
          rows.push({ line, text: lines[line - 1] ? glyph(element, 0) : null, box: rect(element),
            number: number ? glyph(number, 0, String(line).length) : null, gutterWidth: gutter ? rect(gutter).width : 0 })
        }
      }
      const box = rect(block), heading = pane.querySelector('h2')
      const style = getComputedStyle(pre || cm.contentDOM)
      return { state: cm ? 'edit' : 'display', box, rows, scrollTop: pane.scrollTop, scrollLeft: scroll.scrollLeft,
        scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, codeWidth: rect(scroll).width,
        scrollbarHeight: scroll.offsetHeight - scroll.clientHeight,
        headingY: rect(heading).y, paneWidth: pane.clientWidth, cmLive: document.querySelectorAll('.md-code-block .cm-editor').length,
        font: { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight, letterSpacing: style.letterSpacing, tabSize: style.tabSize },
        origin: { x: origin.x, y: origin.y } }
    })
  }

  async function leave() {
    await page.locator('.markdown-live').nth(0).locator('.md-prose > p').first().click()
    await page.waitForFunction(() => !window.layout.code.existingEditor)
    await settle()
  }
  async function focusOutsideWithoutScrolling() {
    await page.evaluate(() => {
      let button = document.querySelector('#code-layout-blur')
      if (!button) {
        button = document.createElement('button')
        button.id = 'code-layout-blur'; button.textContent = 'Blur code'
        button.style.cssText = 'position:fixed;top:2px;left:2px;z-index:99999'
        document.body.append(button)
      }
    })
    await page.locator('#code-layout-blur').click()
  }

  function compare(a, b) {
    const byLine = new Map(a.rows.map(row => [row.line, row]))
    const result = { numberX: 0, textX: 0, textY: 0, numberY: 0, gutter: 0,
      height: Math.abs(a.box.height - b.box.height), width: Math.abs(a.box.width - b.box.width),
      codeWidth: Math.abs(a.codeWidth - b.codeWidth), headingY: Math.abs(a.headingY - b.headingY),
      scrollWidth: Math.abs(a.scrollWidth - b.scrollWidth), clientWidth: Math.abs(a.clientWidth - b.clientWidth),
      paneWidth: Math.abs(a.paneWidth - b.paneWidth), scrollbarHeight: Math.abs(a.scrollbarHeight - b.scrollbarHeight),
      scrollTop: Math.abs(a.scrollTop - b.scrollTop), scrollLeft: Math.abs(a.scrollLeft - b.scrollLeft), rows: 0 }
    for (const row of b.rows) {
      const other = byLine.get(row.line)
      if (!other) continue
      result.rows++
      for (const [field, key] of [['text', 'textX'], ['number', 'numberX']]) {
        if (row[field] && other[field] && !row[field].inferred && !other[field].inferred) {
          result[key] = Math.max(result[key], Math.abs(row[field].x - other[field].x))
          const vertical = field === 'text' ? 'textY' : 'numberY'
          result[vertical] = Math.max(result[vertical], Math.abs(row[field].y - other[field].y))
        }
      }
      result.gutter = Math.max(result.gutter, Math.abs(row.gutterWidth - other.gutterWidth))
    }
    return result
  }

  const defaults = { lines: 21, numbers: true, wrap: false, font: 13, width: 860, light: false, zoom: 1 }
  const configs = []
  for (const lines of full || baseline ? [1, 9, 10, 21, 99, 100, 999, 1000] : [1, 10, 21, 1000]) {
    for (const numbers of full ? [false, true] : [true]) for (const wrap of full ? [false, true] : [false]) configs.push({ ...defaults, lines, numbers, wrap })
  }
  for (const source of ['', 'alpha\n', '\talpha\tbeta\n\t\tgamma', 'alpha beta '.repeat(40) + '\nend']) {
    for (const wrap of [false, true]) configs.push({ ...defaults, source, wrap })
  }
  if (full) {
    for (const [index, zoom] of [0.8, 1, 1.25, 1.5].entries()) for (const font of [11, 16, 19]) for (const wrap of [false, true]) {
      configs.push({ ...defaults, zoom, font, wrap, width: index % 2 ? 560 : 1100, light: index % 2 === 0, numbers: font !== 16,
        source: 'alpha\tbeta '.repeat(25) + '\nend\n', family: font === 19 ? '"Courier New", monospace' : undefined })
    }
    for (const pane of [0, 1]) for (const wrap of [false, true]) configs.push({ ...defaults, panes: true, pane, wrap, width: 600, lines: 100 })
    configs.push({ ...defaults, lines: 10001, scroll: true })
    configs.push({ ...defaults, lines: 100, scroll: true, language: 'javascript' })
  }
  for (const [caseIndex, config] of configs.entries()) {
    if (interactionsOnly) break
    await reset(config)
    const item = { config, transitions: [], max: {} }
    report.cases.push(item)
    for (let cycle = 0; cycle < report.cycles; cycle++) {
      const before = await sample()
      const point = await page.evaluate(() => {
        const { block } = window.layout
        const target = block.querySelector('.md-code-flat-text, .md-code-line .md-code-text, code.md-code-flat, .md-code-line')
        const box = target.getBoundingClientRect(), style = getComputedStyle(target)
        return { x: box.x + parseFloat(style.paddingLeft) * window.layout.config.zoom + 2, y: box.y + 9 * window.layout.config.zoom }
      })
      await page.mouse.click(point.x, point.y)
      await page.waitForFunction(() => !!window.layout.code.existingEditor)
      const immediate = await sample()
      await settle()
      const editing = await sample()
      await leave()
      const after = await sample()
      const differences = [compare(before, immediate), compare(before, editing), compare(before, after)]
      for (const diff of differences) for (const [key, value] of Object.entries(diff)) if (key !== 'rows') item.max[key] = Math.max(item.max[key] || 0, value)
      // Keep every measured logical row for the first cycle; subsequent cycles
      // retain maxima plus complete block/scroll rectangles, bounding report size.
      item.transitions.push(cycle === 0 ? { before, immediate, editing, after, differences } : { cycle, differences, before: { ...before, rows: undefined }, editing: { ...editing, rows: undefined }, after: { ...after, rows: undefined } })
      if (!baseline) {
        for (const [key, value] of Object.entries(item.max)) assert(value <= 1, `case ${caseIndex}, cycle ${cycle}, ${key}=${value}: ${JSON.stringify(config)}`)
        assert.equal(after.cmLive, 0, 'Editor must be destroyed after leaving')
        assert.equal(editing.cmLive, 1, 'Only the selected block mounts CM')
        if (!config.scroll && config.lines <= 1000) assert.equal(editing.rows.length, before.rows.length, 'Every logical line must have measured DOM')
      }
    }
    console.log(`PASS layout ${caseIndex + 1}/${configs.length}: ${JSON.stringify(config)} max=${JSON.stringify(item.max)}`)
  }
  if (!baseline) {
    async function pointAt(offset, side = 'start') {
      return page.evaluate(({ offset, side }) => {
        const { block, source, code } = window.layout
        const cm = code.existingEditor
        if (cm) {
          const box = cm.coordsAtPos(offset)
          return { x: box.left + 0.1, y: (box.top + box.bottom) / 2 }
        }
        const lines = source.split('\n')
        let row = 0, local = offset
        while (local > lines[row].length && row < lines.length - 1) local -= lines[row++].length + 1
        const flat = block.querySelector('.md-code-flat-text')
        const text = flat || block.querySelectorAll('.md-code-line .md-code-text')[row]
        let at = flat ? offset : local
        if (side === 'end') at--
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          if (at < node.length) break
          at -= node.length
        }
        const range = document.createRange()
        range.setStart(node, at); range.setEnd(node, at + 1)
        const box = range.getBoundingClientRect()
        return { x: side === 'end' ? box.right - 0.1 : box.left + 0.1, y: (box.top + box.bottom) / 2 }
      }, { offset, side })
    }
    const selection = () => page.evaluate(() => {
      const { code, editor } = window.layout
      const cm = code.existingEditor, range = cm.state.selection.main
      return { anchor: range.anchor, head: range.head, text: cm.state.sliceDoc(range.from, range.to),
        outerAnchor: editor.view.state.selection.anchor - code.getPos() - 1,
        outerHead: editor.view.state.selection.head - code.getPos() - 1 }
    })
    const interactiveSource = 'alpha beta gamma\n\tsecond line\nlast'
    for (const language of ['', 'javascript']) for (const [offset, side] of [[0, 'start'], [6, 'start'], [16, 'end'], [18, 'start'], [interactiveSource.length, 'end']]) {
      await reset({ ...defaults, source: interactiveSource, language })
      const point = await pointAt(offset, side)
      await page.mouse.click(point.x, point.y)
      await page.waitForFunction(() => !!window.layout.code.existingEditor)
      await settle()
      const result = await selection()
      assert.equal(result.anchor, offset, `First click: ${JSON.stringify({ offset, language, result })}`)
      assert.equal(result.head, offset)
      assert.equal(result.outerHead, offset, 'Outer PM selection follows embedded caret')
      report.interactions.push({ action: 'first click', offset, language, result })
    }
    await reset({ ...defaults, source: interactiveSource })
    const wordPoint = await pointAt(7)
    await page.mouse.dblclick(wordPoint.x + 2, wordPoint.y)
    await settle()
    assert.equal((await selection()).text, 'beta', 'First double click selects the word')
    report.interactions.push({ action: 'first double click', result: await selection() })

    await reset({ ...defaults, source: interactiveSource })
    const start = await pointAt(0), end = await pointAt(10, 'end')
    await page.mouse.move(start.x, start.y); await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up()
    assert.equal((await selection()).text, 'alpha beta', 'First drag selects source without line numbers')
    await page.evaluate(() => window.layout.code.existingEditor.contentDOM.addEventListener('copy', event => {
      window.layout.copied = event.clipboardData.getData('text/plain')
    }, { once: true }))
    await page.keyboard.press('Control+c')
    assert.equal(await page.evaluate(() => window.layout.copied), 'alpha beta', 'Copy preserves selected text')
    report.interactions.push({ action: 'cold drag and copy', result: await selection() })

    await reset({ ...defaults, source: interactiveSource })
    const anchor = await pointAt(2)
    await page.mouse.click(anchor.x, anchor.y)
    await leave()
    const shiftHead = await pointAt(8)
    await page.keyboard.down('Shift'); await page.mouse.click(shiftHead.x, shiftHead.y); await page.keyboard.up('Shift')
    assert.deepEqual([(await selection()).anchor, (await selection()).head], [2, 8], 'Cold Shift-click preserves the saved anchor')
    report.interactions.push({ action: 'cold Shift-click', result: await selection() })

    await reset({ ...defaults, source: interactiveSource })
    const imePoint = await pointAt(6)
    await page.mouse.click(imePoint.x, imePoint.y)
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
    assert(await page.evaluate(() => window.layout.code.isComposing), 'IME composition is active')
    await page.evaluate(() => { window.layout.code.maybeDetachEditor() })
    assert.equal(await page.locator('.md-code-block .cm-editor').count(), 1, 'Do not detach during composition')
    await cdp.send('Input.insertText', { text: '中文' })
    await page.waitForFunction(() => window.layout.manager.getText(window.layout.id).includes('中文'))
    const committed = await page.evaluate(() => window.layout.manager.getText(window.layout.id))
    await page.keyboard.press('Control+z')
    assert(!await page.evaluate(() => window.layout.manager.getText(window.layout.id).includes('中文')), 'Undo reaches canonical Markdown')
    await page.keyboard.press('Control+y')
    assert.equal(await page.evaluate(() => window.layout.manager.getText(window.layout.id)), committed, 'Redo preserves composition result')
    report.interactions.push({ action: 'IME, undo and redo', passed: true })

    // A synthetic composition lifecycle lets us keep composition active across
    // blur, unlike an OS IME which may commit immediately when focus changes.
    await page.evaluate(() => {
      const content = window.layout.code.existingEditor.contentDOM
      window.layout.composingContent = content
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))
    })
    await focusOutsideWithoutScrolling()
    assert(await page.evaluate(() => window.layout.code.isComposing), 'Composition guard survives focus loss')
    assert.equal(await page.locator('.md-code-block .cm-editor').count(), 1, 'Composing CM must remain mounted after blur')
    await page.evaluate(() => window.layout.composingContent.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })))
    await page.waitForFunction(() => !window.layout.code.existingEditor)
    report.interactions.push({ action: 'composition blur lifecycle guard', passed: true })

    // A nonzero horizontal scroll offset must survive both replacement directions.
    await reset({ ...defaults, source: 'alpha beta '.repeat(100), scroll: true })
    await page.evaluate(() => { window.layout.block.querySelector('.md-code-placeholder').scrollLeft = 180 })
    await settle()
    const scrolledBefore = await sample()
    const longPoint = await pointAt(30)
    await page.mouse.click(longPoint.x, longPoint.y)
    await settle()
    const scrolledEdit = await sample()
    await leave()
    const scrolledAfter = await sample()
    for (const snapshot of [scrolledEdit, scrolledAfter]) assert(Math.abs(snapshot.scrollLeft - scrolledBefore.scrollLeft) <= 1, 'Horizontal offset survives replacement')
    report.interactions.push({ action: 'horizontal scroll preservation', before: scrolledBefore.scrollLeft, edit: scrolledEdit.scrollLeft, after: scrolledAfter.scrollLeft })

    await reset({ ...defaults, lines: 100, scroll: true })
    await page.evaluate(() => { window.layout.pane.scrollTop = 120 })
    await settle()
    const verticalBefore = await sample()
    const visiblePoint = await pointAt(await page.evaluate(() => window.layout.source.indexOf('alpha beta 10')))
    await page.mouse.click(visiblePoint.x, visiblePoint.y)
    await settle()
    const verticalEdit = await sample()
    await focusOutsideWithoutScrolling()
    await page.waitForFunction(() => !window.layout.code.existingEditor)
    const verticalAfter = await sample()
    assert.equal(verticalBefore.scrollTop, 120)
    assert.equal(verticalEdit.scrollTop, 120, 'Entering preserves the nonzero page offset')
    assert.equal(verticalAfter.scrollTop, 120, 'Leaving preserves the nonzero page offset')
    report.interactions.push({ action: 'vertical scroll preservation', before: 120, edit: verticalEdit.scrollTop, after: verticalAfter.scrollTop })

    for (const zoom of [0.8, 1.25, 1.5]) {
      await reset({ ...defaults, source: 'alpha beta '.repeat(30) + '\n\tsecond line\nlast', wrap: true, width: 560, zoom, font: 16 })
      const point = await pointAt(250)
      await page.mouse.click(point.x, point.y)
      await settle()
      assert.equal((await selection()).head, 250, `First wrapped click at zoom=${zoom}`)
      report.interactions.push({ action: 'first wrapped click at zoom', zoom, offset: 250, passed: true })
    }
    for (const lines of [9, 99, 999]) {
      await reset({ ...defaults, lines })
      const endOffset = await page.evaluate(() => window.layout.source.length)
      const point = await pointAt(endOffset, 'end')
      await page.mouse.click(point.x, point.y)
      await page.keyboard.press('Enter')
      await settle()
      await page.evaluate(() => { window.layout.source = window.layout.code.node.textContent })
      const added = await sample()
      assert.equal(await page.evaluate(() => window.layout.block.style.getPropertyValue('--code-digits')), String(String(lines + 1).length))
      await leave()
      const displayAdded = await sample()
      for (const [key, value] of Object.entries(compare(added, displayAdded))) if (key !== 'rows') assert(value <= 1, `${lines} -> ${lines + 1}: ${key}=${value}`)
      const reopen = await pointAt(0)
      await page.mouse.click(reopen.x, reopen.y)
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Backspace')
      await settle()
      await page.evaluate(() => { window.layout.source = window.layout.code.node.textContent })
      const removed = await sample()
      assert.equal(await page.evaluate(() => window.layout.block.style.getPropertyValue('--code-digits')), String(String(lines).length))
      await leave()
      const displayRemoved = await sample()
      for (const [key, value] of Object.entries(compare(removed, displayRemoved))) if (key !== 'rows') assert(value <= 1, `${lines + 1} -> ${lines}: ${key}=${value}`)
      report.interactions.push({ action: 'digit boundary grows and shrinks while editing', lines, addedGutter: added.rows[0].gutterWidth, removedGutter: removed.rows[0].gutterWidth, passed: true })
    }
    console.log(`PASS ${report.interactions.length} pointer, copy, Shift, IME/history and scroll checks`)
  }
  await reset({ ...defaults, lines: 21, light: true })
  const visualPrefix = path.join(output, `${native || 'chromium'}-${baseline ? 'before' : 'after'}`)
  const surface = page.locator('.md-code-surface').first()
  await surface.screenshot({ path: `${visualPrefix}-display.png` })
  await surface.click({ position: { x: 80, y: 18 } })
  await settle()
  await surface.screenshot({ path: `${visualPrefix}-edit.png` })
  await leave()
  await surface.screenshot({ path: `${visualPrefix}-return.png` })
  report.cm = await page.evaluate(() => window.__layoutCM || window.__markumoMemoryProbe?.editors.embeddedCM)
  assert.equal(report.cm.live, 0)
  assert.equal(report.cm.peak, 1)
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  const filename = `${native || 'chromium'}-${baseline ? 'before' : interactionsOnly ? 'interactions' : full ? 'full' : 'smoke'}.json`
  fs.writeFileSync(path.join(output, filename), JSON.stringify(report))
  console.log(`Geometry report: ${path.join(output, filename)}`)
  await browser?.close().catch(() => {})
  await server?.close()
  if (child && child.exitCode === null) child.kill()
}
