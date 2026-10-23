import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { createServer as createSocket } from 'node:net'
import { chromium } from 'playwright'

const output = 'test-results/typora-image-parity'
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(`${output}/index.html`, `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/src/styles/reset.css"><link rel="stylesheet" href="/src/styles/variables.css"><link rel="stylesheet" href="/src/editor/markdown/styles.css"><link rel="stylesheet" href="/src/editor/markdown/presentation.css"><div id="app" style="display:flex;height:720px"></div><script type="module" src="/scripts/fixtures/markdown-live-controller.js"></script>`)
const socket = createSocket()
await new Promise(r => socket.listen(0, '127.0.0.1', r))
const port = socket.address().port
await new Promise(r => socket.close(r))
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } })
await server.listen()
let browser
const results = [], errors = []
try {
  browser = await chromium.launch({ headless: true, ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}) })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${port}/${output}/index.html`)
  await page.waitForFunction(() => window.f)
  const test = async (name, fn) => { await fn(); results.push(name); console.log('PASS ' + name) }
  const source = () => page.evaluate(() => window.f.source())
  const reset = async text => { await page.evaluate(text => window.f.reset(text, true), text); await page.waitForFunction(() => window.f.ready()) }
  const img = (index = 0) => page.locator('.md-live-image img').nth(index)
  const input = () => page.locator('.md-source-image .md-inline-source-input')
  const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const menu = async (parent, child) => {
    await img().click({ button: 'right' })
    await page.getByRole('menuitem', { name: parent, exact: true }).click()
    await page.locator(`.md-context-menu:visible button[aria-label="${child}"]`).last().click()
    await frame()
  }
  const configure = async (failures = {}, dimensions = {}) => {
    await page.evaluate(async ({ failures, dimensions }) => {
      const { markdownResources } = await import('/src/editor/markdown/images.ts')
      const resource = window.f.manager.getState(window.f.id).facet(markdownResources)
      const revision = String(Math.random()); resource.identity = () => revision
      resource.loadLocal = async path => {
        if (failures[path]) throw failures[path]
        const canvas = document.createElement('canvas'), size = dimensions[path] || [320, 180]
        canvas.width = size[0]; canvas.height = size[1]
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height)
        return Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0))
      }
      window.f.live().refreshResources()
    }, { failures, dimensions })
  }
  await test('Standalone widget precedes its image in flow; headings move and source stays unchanged', async () => {
    const original = '## BEFORE\n\n![普通](normal.png "标题")\n\n## AFTER'
    await reset(original); await img().waitFor(); assert.equal(await input().count(), 0)
    const before = await page.locator('h2').last().boundingBox()
    await img().click(); await input().waitFor(); await frame()
    const layout = await input().evaluate(el => {
      const widget = el.closest('.md-source-image'), image = widget.nextElementSibling
      return { position: getComputedStyle(widget).position, before: !!(widget.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING), sameParent: widget.parentNode === image.parentNode, sourceBottom: widget.getBoundingClientRect().bottom, imageTop: image.getBoundingClientRect().top }
    })
    assert.equal(layout.position, 'static'); assert(layout.before && layout.sameParent)
    assert(layout.sourceBottom <= layout.imageTop + 2)
    assert((await page.locator('h2').last().boundingBox()).y > before.y)
    assert.equal(await source(), original); assert.equal(await page.evaluate(() => getSelection().toString()), '普通')
    await page.screenshot({ path: `${output}/standalone.png` })
    await page.locator('h2').first().click(); await frame(); assert.equal(await input().count(), 0)
  })
  await test('Mixed prose and image retain one paragraph, real text order, and narrow line boxes', async () => {
    const original = '正文 BEFORE ![行内](normal.png) 正文 AFTER'
    await reset(original); await img().click(); await input().waitFor()
    const layout = await input().evaluate(el => {
      const p = el.closest('p'), image = p.querySelector('.md-live-image')
      return { text: p.textContent, display: getComputedStyle(el.closest('.md-source-image')).display, imageDisplay: getComputedStyle(image).display, same: el.closest('p') === image.closest('p'), imageTop: image.getBoundingClientRect().top, rects: [...el.getClientRects()].map(r => ({ x:r.x, y:r.y, width:r.width })) }
    })
    assert(layout.same && layout.rects.length > 0)
    assert(layout.text.indexOf('BEFORE') < layout.text.indexOf('![行内]') && layout.text.indexOf('AFTER') > layout.text.indexOf('![行内]'))
    assert.equal(layout.display, 'inline'); assert.notEqual(layout.imageDisplay, 'block')
    assert(Math.abs(layout.rects[0].y - layout.imageTop) < 8, JSON.stringify(layout))
    // The editable text has its own text-height box even beside a tall image;
    // native selection highlighting must not stretch to the image's full height.
    assert((await input().boundingBox()).height < 35)
    await page.setViewportSize({ width: 420, height: 800 }); await frame()
    assert(await input().evaluate(el => el.closest('p').scrollWidth <= el.closest('p').clientWidth + 1))
    assert.equal(await source(), original)
    await page.screenshot({ path: `${output}/mixed-narrow.png` }); await page.setViewportSize({ width: 1100, height: 800 })
  })
  await test('Only the current consecutive image has a widget; other decoded images are reused', async () => {
    const original = '![A](a.png)\n![B](b.png)\n![C](c.png)'
    await reset(original); await img(2).waitFor()
    await page.evaluate(() => { window.imagesBefore = [...document.querySelectorAll('.md-live-image img')] })
    for (let i = 0; i < 3; i++) { await img(i).click(); assert.equal(await input().count(), 1); assert.equal(await input().textContent(), `![${'ABC'[i]}](${'abc'[i]}.png)`) }
    assert(await page.evaluate(() => window.imagesBefore.every((el, i) => el === document.querySelectorAll('.md-live-image img')[i])))
    assert.equal(await source(), original)
  })
  await test('Full syntax selection, Chinese input, delete, immediate typing and canonical undo/redo', async () => {
    await reset('![普通](normal.png)'); await img().dblclick(); await input().waitFor()
    assert.equal(await page.evaluate(() => getSelection().toString()), '![普通](normal.png)')
    await page.keyboard.press('Control+a'); await page.keyboard.insertText('![中文](normal.png "标题")')
    assert.equal(await source(), '![中文](normal.png "标题")')
    await page.keyboard.press('Control+z'); assert.equal(await source(), '![普通](normal.png)')
    await page.keyboard.press('Control+y'); assert.equal(await source(), '![中文](normal.png "标题")')
    await img().click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace')
    assert.equal(await source(), ''); await page.keyboard.insertText('继续输入'); assert.equal(await source(), '继续输入')
  })
  await test('Incomplete Markdown and HTML publish exact source, remain editable, repair and survive history/mode changes', async () => {
    for (const draft of ['![普通](normal.p', '![普通](./images/', '![普通](', '![普通', '<img src="normal.png" width="']) {
      await reset('![普通](normal.png)'); await img().click(); await input().fill(draft)
      assert.equal(await source(), draft); assert.equal(await input().textContent(), draft)
      assert.equal(await page.evaluate(() => { const {before,patch} = window.f.publications.at(-1); return before.slice(0,patch.from) + patch.insert + before.slice(patch.to) }), draft)
      await page.waitForTimeout(600)
      await input().fill('![修复](normal.png)'); assert.equal(await source(), '![修复](normal.png)'); await img().waitFor()
      await page.evaluate(() => window.f.undo()); assert.equal(await source(), draft)
      for (const mode of ['source', 'live']) { await page.evaluate(mode => window.f.manager.setMarkdownMode(window.f.id, mode), mode); assert.equal(await source(), draft) }
    }
  })
  await test('Original HTML spelling is untouched; width/title/zoom edits are reparsed and undoable', async () => {
    const original = "<img title='保留'  alt='测试' src='normal.png' width='160' />"
    await reset(original); await img().click(); assert.equal(await input().textContent(), original); assert.equal(await source(), original)
    await input().fill('<img src="normal.png" alt="中文" width="80" style="zoom:50%;" />')
    assert((await source()).includes('zoom:50%')); assert.equal(await page.evaluate(() => window.f.node('image').node.attrs.zoom), 50)
    await page.evaluate(() => window.f.undo()); assert.equal(await source(), original)
    await page.evaluate(() => window.f.redo()); assert((await source()).includes('zoom:50%'))
  })
  await test('Reference labels survive source edits and definition changes; unresolved refs stay compact', async () => {
    const original = '![引用图片][logo]\n\n[logo]: normal.png\n\nTAIL'
    await reset(original); await img().click(); assert.equal(await input().textContent(), '![引用图片][logo]')
    await input().fill('![引用图片][missing]'); assert.equal(await source(), original.replace('[logo]\n', '[missing]\n'))
    assert.equal(await page.locator('.md-image-browse:visible').count(), 0)
    await input().fill('![引用图片][logo]'); await img().waitFor()
    await page.evaluate(() => { const at = window.f.source().indexOf('normal.png'); window.f.manager.dispatch(window.f.id, { changes: { from: at, to: at + 10, insert: 'replacement.png' } }) })
    assert((await source()).includes('[logo]: replacement.png')); assert(!(await source()).includes('![引用图片]('))
    await img().click(); await input().waitFor()
    await input().click({ button:'right' }); await page.locator('button[aria-label="跳转到图片引用定义"]').click(); await frame()
    assert.equal(await source(), original.replace('normal.png', 'replacement.png'))
  })
  await test('Only empty paths have a folder, and both file selection and direct typing modify the canonical document', async () => {
    await reset('![]()'); await page.locator('.md-image-browse:visible').waitFor()
    assert.equal(await page.locator('.md-image-compact-source').textContent(), '![]()')
    await page.locator('.md-image-compact-source').click(); await input().waitFor()
    assert.equal(await input().evaluate(el => getComputedStyle(el.closest('.md-source-image')).display), 'inline')
    assert((await input().evaluate(el => el.closest('p').getBoundingClientRect().height)) < 35)
    await page.evaluate(async () => { const { markdownResources } = await import('/src/editor/markdown/images.ts'); window.f.manager.getState(window.f.id).facet(markdownResources).chooseLocal = async () => 'chosen.png' })
    await page.locator('.md-image-browse').click(); await img().waitFor(); assert.equal(await source(), '![](chosen.png)')
    assert.equal(await page.locator('.md-image-browse:visible').count(), 0)
    await img().click(); await input().fill('![](typed.png)'); assert.equal(await source(), '![](typed.png)')
  })
  await test('Missing/corrupt/scope/budget/unknown errors are compact, preserve diagnostics, and repair immediately', async () => {
    const failures = { 'missing.png': { message:'os error 2' }, 'corrupt.png': { code:'image_format' }, 'scope.png': { code:'image_scope' }, 'budget.png': { code:'image_size' }, 'unknown.png': { nested:{} } }
    await reset(Object.keys(failures).map(path => `![失效](${path})`).join('\n\n')); await configure(failures)
    await page.waitForFunction(() => document.querySelectorAll('.md-image-media.is-broken-image').length === 5)
    for (const icon of await page.locator('.broken-image-tag').all()) assert((await icon.boundingBox()).height < 30)
    assert.equal(await page.locator('.md-image-action:visible, .md-image-browse:visible').count(), 0)
    const text = await page.locator('.md-prose').innerText()
    for (const forbidden of ['文件不存在','格式不支持','未授权','预算','[object Object]','重试']) assert(!text.includes(forbidden), text)
    assert.equal(await page.locator('.md-image-compact-source').count(), 5)
    assert((await page.locator('.md-image-media').nth(1).getAttribute('title')).includes('格式'))
    await page.locator('.broken-image-tag').first().click(); await input().fill('![恢复](normal.png)'); await img().waitFor()
    assert((await source()).includes('![恢复](normal.png)')); await page.screenshot({ path:`${output}/compact-errors.png` })
  })
  await test('Remote loading requires explicit consent and failed requests remain compact', async () => {
    let requests = 0
    await page.route('https://images.example.test/**', route => { requests++; return route.abort() })
    await reset('![网络](https://images.example.test/missing.png)'); await page.locator('.is-pending-image').waitFor(); await frame()
    assert.equal(requests, 0); assert.equal(await page.locator('.md-image-action:visible').count(), 0)
    await page.locator('.md-image-compact-source').click({ button:'right' }); await page.locator('button[aria-label="加载图片"]').click()
    await page.locator('.is-broken-image').first().waitFor(); assert.equal(requests, 1)
    assert((await page.locator('.broken-image-tag').boundingBox()).height < 30)
  })
  await test('Eight natural-size percentages, Markdown/HTML conversion and reopen remain editable and undoable', async () => {
    await reset('![a](normal.png)'); await configure()
    for (const zoom of [25,33,50,67,80,100,150,200]) {
      await menu('缩放图片', `${zoom}%`); assert((await source()).includes(`zoom:${zoom}%`))
      assert.equal(await input().textContent(), await source())
      const width = await img().evaluate(el => el.getBoundingClientRect().width)
      assert(Math.abs(width - 320 * zoom / 100) <= 2.5, `${zoom}: ${width}`)
    }
    await menu('转换图片语法', 'Markdown ![](src)'); assert.equal(await source(), '![a](normal.png)')
    await menu('转换图片语法', 'HTML <img>'); const final = await source(); assert(final.startsWith('<img '))
    await page.evaluate(() => window.f.undo()); assert.equal(await source(), '![a](normal.png)')
    await page.evaluate(() => window.f.redo()); assert.equal(await source(), final)
    await reset(final); await img().click(); assert.equal(await input().textContent(), final)
    assert.equal(await page.locator('.md-image-width, .md-image-toolbar').count(), 0)
  })
  await test('Large-image scaling clamps after natural sizing; list, quote and table edits keep structure', async () => {
    await reset('![large](large.png)'); await configure({}, {'large.png':[4000,2400]}); await menu('缩放图片','50%')
    assert(await img().evaluate(el => el.getBoundingClientRect().width <= el.closest('p').getBoundingClientRect().width + 1))
    for (const [text, container] of [['- ![a](normal.png)','li'], ['> ![a](normal.png)','blockquote'], ['| A | B |\n| --- | --- |\n| ![a](normal.png) | text |','td']]) {
      await reset(text); await img().click(); assert(await input().evaluate((el, container) => !!el.closest(container), container))
      await input().fill('![新的](normal.png)'); assert.equal(await source(), text.replace('![a]','![新的]'))
    }
  })
  await test('Long paths wrap in dual narrow panes without overlay or duplicate widgets', async () => {
    const raw = `![${'很长的替代文字'.repeat(30)}](${'long-path/'.repeat(35)}normal.png)`
    await reset(raw); await page.evaluate(() => window.f.split()); await frame()
    await page.locator('[data-pane="main"] .md-live-image img').click(); assert.equal(await input().count(), 1)
    assert(await input().evaluate(el => { const p = el.closest('p'); return p.scrollWidth <= p.clientWidth + 1 && getComputedStyle(el.closest('.md-source-image')).position === 'static' }))
    assert.equal(await source(), raw)
  })
  await test('Link editing, synthetic composition, read-only protection and HTML security stay intact', async () => {
    await reset('[链接](https://example.com)\n\n![a](normal.png)')
    await page.locator('.md-prose a').click(); assert.equal(await page.locator('.md-source-link').count(), 1)
    await img().click(); await input().evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); el.textContent='![中文](normal.png)'; el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true})); el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}))
    }); assert((await source()).includes('![中文](normal.png)'))
    const result = await page.evaluate(async () => { const { parseControlledImageHtml } = await import('/src/editor/markdown/wysiwyg/imageHtml.ts'); return ['<img src="x" onerror="alert(1)" />','<img src="x" style="position:fixed" />','<img src="x" src="y" />'].map(parseControlledImageHtml) }); assert(result.every(v => v === null))
    await page.evaluate(() => window.f.reset('![只读](normal.png)',true,true)); await img().click(); assert.equal(await input().count(),0); assert.equal(await source(),'![只读](normal.png)')
  })
  assert.deepEqual(errors, [])
  fs.writeFileSync(`${output}/results.json`,JSON.stringify({automatedBrowser:results,nativeGUI:'Reported separately in docs/typora-image-parity-report.md',errors},null,2))
  console.log(`${results.length} image scenarios passed; no skips`)
} finally { await browser?.close(); await server.close() }
