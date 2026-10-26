import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { execFileSync } from 'node:child_process'

const baseline = process.argv.includes('--baseline')
const server = await createServer({ server: { host: '127.0.0.1', port: 1467, strictPort: true, hmr: false, watch: null },
  plugins: baseline ? [{ name: 'baseline-link-controller', enforce: 'pre', load(id) {
    if (id.replaceAll('\\', '/').endsWith('/wysiwyg/MarkdownEditorController.ts')) {
      return execFileSync('git', ['show', 'origin/main:src/editor/markdown/wysiwyg/MarkdownEditorController.ts'], { encoding: 'utf8' })
    }
  } }] : [],
  cacheDir: 'node_modules/.vite-link-tests' })
await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}) })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = [], results = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
const source = 'Start plain text.\n\n[定制项目配套代码讲解文档](codeExplain.md "说明") and [other](other.md).\n\n## Target heading\n\nTail text.\n'
const ready = () => page.waitForFunction(() => window.f.ready())
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
async function reset(text = source, readOnly = false) {
  await page.evaluate(([text, readOnly]) => window.f.reset(text, readOnly), [text, readOnly]); await ready()
  await page.evaluate(() => window.f.caret()); await settle(); await page.evaluate(() => window.f.clear())
}
const link = (label = '定制项目配套代码讲解文档', pane = 'main') => page.locator(`[data-pane="${pane}"] a[data-href]`).filter({ hasText: label }).first()
const state = (pane = 'main') => page.evaluate(pane => window.f.snapshot(pane), pane)
const requests = () => page.evaluate(() => window.f.requests)
async function click(anchor, modifier = 'Control') {
  await anchor.scrollIntoViewIfNeeded(); await page.keyboard.down(modifier)
  await anchor.click(); await page.keyboard.up(modifier); await settle()
}
async function unchanged(before, pane = 'main', selection = true) {
  const after = await state(pane)
  for (const key of ['source', 'dirty', 'undo', 'redo', 'sourceEntries', 'sources', 'properties', 'anchors', ...(selection ? ['pmSelection', 'canonicalSelection', 'domSelection'] : [])]) {
    assert.deepEqual(after[key], before[key], key)
  }
}
async function test(name, work) {
  await work(); results.push(name); console.log('PASS ' + name)
}
try {
  await page.goto('http://127.0.0.1:1467/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  await test('ordinary click edits complete Markdown and another paragraph collapses it', async () => {
    await reset(); await link().click(); await settle()
    const input = page.locator('.md-source-link .md-inline-source-input')
    assert.equal(await input.innerText(), '[定制项目配套代码讲解文档](codeExplain.md "说明")')
    assert.equal((await requests()).length, 0)
    await page.locator('.md-prose p').filter({ hasText: 'Start plain text.' }).click(); await settle()
    assert.equal(await page.locator('.md-source-link').count(), 0)
  })
  for (const modifier of ['Control', 'Meta']) await test(`${modifier}: first click navigates once without any editor/DOM/selection/history change`, async () => {
    await reset(); const before = await state(); await click(link(), modifier); await unchanged(before)
    assert.deepEqual(await requests(), [{ kind: 'relative', id: await page.evaluate(() => window.f.id), href: 'codeExplain.md', pane: 'main' }])
  })
  await test('five rapid modified clicks produce exactly five requests, never inline source', async () => {
    await reset(); const before = await state()
    await page.keyboard.down('Control'); await link().click({ clickCount: 5, delay: 20 }); await page.keyboard.up('Control'); await settle()
    assert.equal((await requests()).length, 5); await unchanged(before)
  })
  const destinations = [
    ['relative file and fragment', '[destination](codeExplain.md#target-heading)', 'relative', 'codeExplain.md#target-heading'],
    ['plain project file', '[destination](../project.txt)', 'relative', '../project.txt'],
    ['file query parameters', '[destination](codeExplain.md?view=raw#target-heading)', 'relative', 'codeExplain.md?view=raw#target-heading'],
    ['URL inside a file query', '[destination](codeExplain.md?next=https://example.invalid#target-heading)', 'relative', 'codeExplain.md?next=https://example.invalid#target-heading'],
    ['spaces, Chinese and percent-encoded path', '[destination](<配套 文档%25.md#中文标题>)', 'relative', '%E9%85%8D%E5%A5%97%20%E6%96%87%E6%A1%A3%25.md#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98'],
    ['HTTPS and query', '[destination](https://example.invalid/docs?q=one%20two#part)', 'ipc', 'https://example.invalid/docs?q=one%20two#part'],
    ['HTTP', '[destination](http://example.invalid/docs)', 'ipc', 'http://example.invalid/docs'],
    ['bare URL', 'https://example.invalid/plain?q=1', 'ipc', 'https://example.invalid/plain?q=1'],
    ['reference-style link', '[destination][ref]\n\n[ref]: codeExplain.md "Reference title"', 'relative', 'codeExplain.md'],
  ]
  for (const [name, markdown, kind, href] of destinations) await test(name + ' uses the production navigation interface', async () => {
    await reset('Start\n\n' + markdown + '\n'); const before = await state()
    await click(page.locator('.md-prose a[data-href]').first()); await unchanged(before)
    const calls = await requests(); assert.equal(calls.length, 1)
    assert.equal(calls[0].kind, kind)
    if (kind === 'ipc') { assert.equal(calls[0].command, 'open_external_link'); assert.equal(calls[0].args.url, href) }
    else assert.equal(calls[0].href, href)
  })
  await test('in-document anchor selects the heading without source edits or history', async () => {
    await reset('Start\n\n[jump](#target-heading)\n\n## Target heading\n\nEnd\n')
    const before = await state(); await click(link('jump')); await unchanged(before, 'main', false)
    assert.equal(await page.evaluate(() => window.f.live().view.state.selection.$from.parent.textContent), 'Target heading')
    assert.equal((await requests()).length, 0)
  })
  await test('Ctrl-drag out and back cancels navigation and text selection', async () => {
    await reset(); const before = await state(), box = await link().boundingBox()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.keyboard.down('Control'); await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(x + 45, y, { steps: 5 }); await page.mouse.move(x, y); await page.mouse.up(); await page.keyboard.up('Control'); await settle()
    assert.equal((await requests()).length, 0); await unchanged(before)
  })
  for (const mode of ['release', 'change-back']) await test(`modifier ${mode} before mouseup safely cancels`, async () => {
    await reset(); const before = await state(), box = await link().boundingBox()
    await page.keyboard.down('Control'); await page.mouse.move(box.x + 12, box.y + 8); await page.mouse.down()
    await page.keyboard.up('Control'); if (mode === 'change-back') await page.keyboard.down('Control')
    await page.mouse.up(); if (mode === 'change-back') await page.keyboard.up('Control'); await settle()
    assert.equal((await requests()).length, 0); await unchanged(before)
  })
  await test('changed link target during a pressed gesture cannot navigate', async () => {
    await reset(); const box = await link().boundingBox()
    await page.keyboard.down('Control'); await page.mouse.move(box.x + 12, box.y + 8); await page.mouse.down()
    await link().evaluate(el => el.setAttribute('data-href', 'changed.md'))
    await page.mouse.up(); await page.keyboard.up('Control'); await settle(); assert.equal((await requests()).length, 0)
  })
  await test('window blur cancels a held gesture and releases document listeners', async () => {
    await reset(); const before = await state(), box = await link().boundingBox()
    await page.keyboard.down('Control'); await page.mouse.move(box.x + 12, box.y + 8); await page.mouse.down()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.mouse.up(); await page.keyboard.up('Control'); await settle()
    assert.equal((await requests()).length, 0); await unchanged(before)
  })
  await test('another open inline source keeps its DOM and native caret on Ctrl-click', async () => {
    await reset(); await link('other').click(); await settle()
    const before = await state(); assert.equal(before.sources, 1)
    await click(link()); await unchanged(before); assert.equal((await requests()).length, 1)
  })
  await test('right click preserves the link context menu and never navigates', async () => {
    await reset(); await link().click({ button: 'right' }); await page.locator('.md-context-menu').waitFor()
    assert.equal((await requests()).length, 0)
    assert.match(await page.locator('.md-context-menu').innerText(), /链接/)
    assert.equal((await state()).source, source)
    assert.equal(await page.locator('.md-source-link').count(), 0)
    await page.keyboard.press('Escape')
  })
  await test('ordinary inline source supports real selection, input, paste, IME and undo/redo', async () => {
    await reset(); await link().click(); await settle()
    const input = page.locator('.md-source-link .md-inline-source-input')
    await input.press('Home'); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift')
    assert.equal(await page.evaluate(() => document.getSelection().toString()), '[')
    await page.keyboard.press('ArrowRight'); await page.keyboard.type('prefix'); await settle()
    assert.match((await state()).source, /prefix/)
    await page.keyboard.press('Control+z'); await settle(); assert.equal((await state()).source, source)
    await page.keyboard.press('Control+y'); await settle(); assert.match((await state()).source, /prefix/)
    await reset(); await link().click(); await settle()
    // Real ClipboardEvent/InputEvent dispatch is limited to clipboard/IME; all
    // link gestures and ordinary typing above use browser mouse/keyboard input.
    await input.evaluate(el => { const data = new DataTransfer(); data.setData('text/plain', ' 中文'); el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })) })
    await input.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      document.execCommand('insertText', false, '输入')
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入' }))
    }); await settle(); assert.match((await state()).source, /中文输入/)
  })
  await test('read-only links navigate once and ordinary click cannot edit', async () => {
    await reset(source, true); const before = await state(); await click(link()); await unchanged(before)
    assert.equal((await requests()).length, 1); await link().click(); await settle()
    assert.equal(await page.locator('.md-source-link').count(), 0); assert.equal((await state()).source, source)
  })
  await test('inactive split pane sends the correct document and pane', async () => {
    await reset(); const pane = await page.evaluate(() => window.f.split()); await ready()
    await page.evaluate(() => window.f.manager.focusPane('main', false)); const before = await state(pane)
    await click(link('定制项目配套代码讲解文档', pane)); await unchanged(before, pane)
    assert.equal((await requests())[0].pane, pane)
  })
  await test('unsafe schemes and local absolute paths never reach a navigation interface', async () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/private.md', 'C:/private.md', '/etc/passwd', '//host/share']) {
      await reset(); await link().evaluate((el, href) => el.setAttribute('data-href', href), href)
      const before = await state(); await click(link()); await unchanged(before)
      assert.equal((await requests()).length, 0, href)
    }
    const resolution = await page.evaluate(() => ['%2Fetc/passwd', '%5C%5Chost/share', 'javascript%3Aalert(1)', '%00x', '%ZZ'].map(href => window.f.relativeMarkdownLink('C:/workspace/main.md', href)))
    assert.deepEqual(resolution, [null, null, null, null, null])
  })
  await test('relative resolution decodes paths, strips URL query and retains fragment', async () => {
    assert.deepEqual(await page.evaluate(() => window.f.relativeMarkdownLink('C:/workspace/说明/main.md', '%E9%85%8D%E5%A5%97%20%E6%96%87%E6%A1%A3%25.md?view=raw#%E4%B8%AD%E6%96%87')), { path: 'C:/workspace/说明/配套 文档%.md', anchor: '中文' })
  })
  await test('Source/Live/Split switches preserve exact Markdown and usable editors', async () => {
    await reset(source + '\n[web](https://example.invalid/mode)\n'); const before = await state()
    await page.evaluate(() => window.f.mode('source')); await ready(); await page.locator('.cm-content').waitFor()
    assert.equal((await state()).source, before.source)
    await page.evaluate(() => window.f.mode('split')); await ready(); await page.locator('.cm-content').waitFor()
    await click(page.locator('.split-preview-content a[href="https://example.invalid/mode"]'))
    assert.deepEqual(await requests(), [{ kind: 'ipc', command: 'open_external_link', args: { url: 'https://example.invalid/mode' } }])
    await page.evaluate(() => window.f.clear())
    await page.evaluate(() => window.f.mode('live')); await ready(); await link().waitFor()
    assert.equal((await state()).source, before.source); assert.equal((await state()).undo, before.undo)
    await click(link()); assert.equal((await requests()).length, 1)
  })
  await test('destroy during a held gesture releases ownership and cannot navigate', async () => {
    await reset(); const box = await link().boundingBox()
    await page.keyboard.down('Control'); await page.mouse.move(box.x + 12, box.y + 8); await page.mouse.down()
    await page.evaluate(() => window.f.dispose()); await page.mouse.up(); await page.keyboard.up('Control'); await settle()
    assert.equal((await requests()).length, 0)
    assert((await page.evaluate(() => window.f.signals())).every(Boolean), 'All abortable root/document/window listeners must be released')
    await reset(); await click(link()); assert.equal((await requests()).length, 1)
  })
  assert.deepEqual(errors, [])
  fs.mkdirSync('test-results/markdown-links', { recursive: true })
  await page.screenshot({ path: 'test-results/markdown-links/final.png' })
  fs.writeFileSync('test-results/markdown-links/results.json', JSON.stringify({ tests: results, errors }, null, 2))
  console.log(`PASS: ${results.length} browser interaction checks`)
} catch (error) {
  fs.mkdirSync('test-results/markdown-links', { recursive: true })
  await page.screenshot({ path: `test-results/markdown-links/${baseline ? 'baseline-failure' : 'failure'}.png` })
  throw error
} finally { await browser.close(); await server.close() }
