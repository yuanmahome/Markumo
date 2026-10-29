import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 1509, strictPort: true, hmr: false, watch: null }, cacheDir: 'node_modules/.vite-link-input' })
await server.listen()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = [], results = []
page.on('pageerror', error => errors.push(error.message))
async function reset(source = 'Start\n\nEND_SENTINEL\n') {
  await page.evaluate(source => window.f.reset(source), source)
  await page.waitForFunction(() => !!window.f.live() || window.f.notices.length > 0)
  assert.deepEqual(await page.evaluate(() => window.f.notices), [], 'Live must load')
  await page.waitForFunction(() => !!window.f.live() && window.f.ready())
  await page.evaluate(() => window.f.caret('Start'))
  await page.keyboard.press('Shift+End')
}
async function state() {
  await page.waitForFunction(() => window.f.ready())
  return page.evaluate(() => ({ source: window.f.manager.getText(window.f.id), text: window.f.live().view.state.doc.textContent,
    links: [...document.querySelectorAll('.md-prose a[data-href]')].map(el => ({ text: el.textContent, href: el.dataset.href })), notices: window.f.notices }))
}
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log('PASS', name) }
  catch (error) { results.push({ name, passed: false, error: String(error), actual: error.actual }); console.log('FAIL', name, String(error), error.actual ?? '') }
}
try {
  await page.goto('http://127.0.0.1:1509/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  await check('typed explicit link renders the label and preserves exact source', async () => {
    await reset()
    await page.keyboard.type('[链接](http://129.com)')
    const result = await state()
    assert.deepEqual(result.links, [{ text: '链接', href: 'http://129.com' }])
    assert.equal(result.source, '[链接](http://129.com)\n\nEND_SENTINEL\n')
    assert.deepEqual(result.notices, [])
  })
  await check('native DOM transaction completes a link without handleTextInput', async () => {
    await reset()
    await page.keyboard.type('[11](111')
    await page.evaluate(() => { const v = window.f.live().view; v.dispatch(v.state.tr.insertText(')').setMeta('uiEvent', 'input')) })
    const result = await state()
    assert.equal(result.source, '[11](111)\n\nEND_SENTINEL\n')
    assert.deepEqual(result.links, [{ text: '11', href: '111' }])
  })
  await check('fill label and destination after typing an empty bracket template', async () => {
    await reset()
    await page.keyboard.type('[]()')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('11')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('111')
    await page.locator('.md-prose p').filter({ hasText: 'END_SENTINEL' }).click()
    const result = await state()
    assert.equal(result.source, '[11](111)\n\nEND_SENTINEL\n')
    assert.deepEqual(result.links, [{ text: '11', href: '111' }])
  })
  await check('composition completion waits for commit before converting the link', async () => {
    await reset()
    await page.keyboard.type('[11](111')
    await page.evaluate(() => {
      const v = window.f.live().view
      v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      v.dispatch(v.state.tr.insertText(')').setMeta('composition', 7))
    })
    assert.deepEqual((await state()).links, [])
    await page.evaluate(() => window.f.live().view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    await page.waitForTimeout(80)
    const result = await state()
    assert.deepEqual(result.links, [{ text: '11', href: '111' }])
    assert.equal(result.source, '[11](111)\n\nEND_SENTINEL\n')
  })
  await check('template destination first, Unicode label, mode switch and Undo/Redo', async () => {
    await reset()
    await page.keyboard.type('[]()')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('http://129.com')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.insertText('链接👩‍💻')
    await page.locator('.md-prose p').filter({ hasText: 'END_SENTINEL' }).click()
    const before = await state()
    assert.equal(before.source, '[链接👩‍💻](http://129.com)\n\nEND_SENTINEL\n')
    assert.deepEqual(before.links, [{ text: '链接👩‍💻', href: 'http://129.com' }])
    await page.keyboard.press('Control+z')
    assert.notEqual((await state()).source, before.source)
    await page.keyboard.press('Control+y')
    assert.equal((await state()).source, before.source)
    await page.evaluate(() => window.f.mode('split'))
    await page.waitForFunction(() => !!document.querySelector('.split-preview-content a'))
    assert.equal(await page.locator('.split-preview-content a').textContent(), '链接👩‍💻')
    assert.equal(await page.locator('.split-preview-content a').getAttribute('href'), 'http://129.com/')
    await page.evaluate(() => window.f.mode('live'))
    assert.deepEqual((await state()).links, before.links)
  })
  await check('template Chinese composition defers normalization until commit', async () => {
    await reset()
    await page.keyboard.type('[]()')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.evaluate(() => {
      const v = window.f.live().view
      v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      v.dispatch(v.state.tr.insertText('中').setMeta('composition', 8))
      v.dispatch(v.state.tr.insertText('文').setMeta('composition', 8))
    })
    assert.deepEqual((await state()).links, [])
    await page.evaluate(() => window.f.live().view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    await page.waitForTimeout(80)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('111')
    await page.locator('.md-prose p').filter({ hasText: 'END_SENTINEL' }).click()
    const result = await state()
    assert.equal(result.source, '[中文](111)\n\nEND_SENTINEL\n')
    assert.deepEqual(result.links, [{ text: '中文', href: '111' }])
  })
  await check('editing a loaded escaped template never acquires local draft ownership', async () => {
    await reset('[](' + '\\' + ')\n\nEND_SENTINEL\n')
    await page.evaluate(() => window.f.caret('[]()'))
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('11')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('111')
    await page.locator('.md-prose p').filter({ hasText: 'END_SENTINEL' }).click()
    assert.deepEqual((await state()).links, [])
    assert.equal((await state()).source, '[11](111\\)\n\nEND_SENTINEL\n')
  })
  await check('temporarily empty link label stays pending and Escape restores accepted content', async () => {
    await reset()
    await page.keyboard.type('[]()')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    const before = (await state()).source
    await page.keyboard.press('Backspace')
    assert.equal(await page.locator('.md-inline-source-warning:not([hidden])').count(), 1)
    assert.equal((await state()).source, before)
    await page.keyboard.press('Escape')
    assert.equal((await state()).source, '[X]()\n\nEND_SENTINEL\n')
    assert.deepEqual((await state()).links, [{ text: 'X', href: '' }])
  })
  for (const singleInput of [false, true]) await check(`empty document (${singleInput ? 'single' : 'character'} input)`, async () => {
    await page.evaluate(() => window.f.reset(''))
    await page.waitForFunction(() => !!window.f.live() && window.f.ready())
    await page.evaluate(() => window.f.live().view.focus())
    if (singleInput) await page.keyboard.insertText('[链接](http://129.com)')
    else await page.keyboard.type('[链接](http://129.com)')
    const result = await state()
    assert.deepEqual(result.links, [{ text: '链接', href: 'http://129.com' }])
    assert.equal(result.source, '[链接](http://129.com)')
  })
  await check('screenshot sequence: new paragraph after horizontal rule and a relative link', async () => {
    await page.evaluate(() => window.f.reset('***asdjf***\n\n---'))
    await page.waitForFunction(() => !!window.f.live() && window.f.ready())
    await page.evaluate(() => {
      const v = window.f.live().view
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.atEnd(v.state.doc)))
      v.focus()
    })
    await page.keyboard.type('[111](jkasdfkdsakf)')
    assert((await state()).links.some(link => link.text === '111' && link.href === 'jkasdfkdsakf'))
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('[链接](http://129.com)')
    const result = await state()
    assert(result.links.some(link => link.text === '链接' && link.href === 'http://129.com'))
    assert(!result.source.includes('\\['))
  })
  for (const [input, href] of [
    ['[11](111)', '111'],
    ['[链接](http://129.com)', 'http://129.com'],
    ['[带标题](https://example.com/a_(b)?x=1&y=2 "说明")', 'https://example.com/a_(b)?x=1&y=2'],
    ['[文档](notes.md#section)', 'notes.md#section'],
    ['[嵌套[文字]](https://example.com)', 'https://example.com'],
  ]) await check(`single text input: ${input}`, async () => {
    await reset()
    await page.keyboard.insertText(input)
    const result = await state()
    assert.equal(result.links.length, 1)
    assert.equal(result.links[0].href, href)
    assert.equal(result.source, input + '\n\nEND_SENTINEL\n')
  })
  await check('multiple links and subsequent prose keep their own marks', async () => {
    await reset()
    await page.keyboard.type('[一](https://one.example) and [二](https://two.example)')
    await page.keyboard.insertText(' 正文')
    const result = await state()
    assert.deepEqual(result.links, [{ text: '一', href: 'https://one.example' }, { text: '二', href: 'https://two.example' }])
    assert.equal(result.source, '[一](https://one.example) and [二](https://two.example) 正文\n\nEND_SENTINEL\n')
  })
  for (const [source, expected] of [
    ['## Start\n\nEND_SENTINEL\n', '## [链接](http://129.com)\n\nEND_SENTINEL\n'],
    ['> Start\n\nEND_SENTINEL\n', '> [链接](http://129.com)\n\nEND_SENTINEL\n'],
    ['- Start\n\nEND_SENTINEL\n', '- [链接](http://129.com)\n\nEND_SENTINEL\n'],
    ['| A | B |\n|---|---|\n| Start | untouched |\n\nEND_SENTINEL\n', '| A | B |\n|---|---|\n| [链接](http://129.com) | untouched |\n\nEND_SENTINEL\n'],
  ]) await check(`typed link inside ${source.split('\n')[0]}`, async () => {
    await reset(source)
    await page.keyboard.type('[链接](http://129.com)')
    const result = await state()
    assert.deepEqual(result.links, [{ text: '链接', href: 'http://129.com' }])
    assert.equal(result.source, expected)
  })
  await check('undo, redo and source/live round trip retain the link', async () => {
    await reset()
    await page.keyboard.type('[链接](http://129.com)')
    const before = await state()
    await page.keyboard.press('Control+z')
    assert.notEqual((await state()).source, before.source)
    await page.keyboard.press('Control+y')
    assert.equal((await state()).source, before.source)
    await page.evaluate(() => { window.f.mode('source'); window.f.mode('live') })
    const after = await state()
    assert.equal(after.source, before.source)
    assert.deepEqual(after.links, before.links)
  })
  await check('code and explicitly escaped opening brackets stay literal', async () => {
    await reset('`Start`\n\nEND_SENTINEL\n')
    await page.evaluate(() => window.f.caret('Start'))
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.type('[链接](http://129.com)')
    assert.deepEqual((await state()).links, [])
    assert.equal((await state()).source, '`[链接](http://129.com)`\n\nEND_SENTINEL\n')
    await reset('\\[Start](http://129.com)\n\nEND_SENTINEL\n')
    await page.keyboard.press('End')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(')')
    assert(!(await state()).links.some(link => link.text === 'Start'))
  })
  await check('unsafe destinations and image syntax do not create explicit text links', async () => {
    for (const input of ['[链接](javascript:alert(1))', '![图片](image.png)']) {
      await reset()
      await page.keyboard.type(input)
      assert.deepEqual((await state()).links, [])
    }
  })
  await check('literal escaped parenthesis is preserved when loading Markdown', async () => {
    const source = '[链接]\\(http://129.com)\n\nEND_SENTINEL\n'
    await page.evaluate(source => window.f.reset(source), source)
    const result = await state()
    assert(!result.links.some(link => link.text === '链接'))
    assert.equal(result.source, source)
  })
  fs.mkdirSync('test-results/link-input', { recursive: true })
  fs.writeFileSync('test-results/link-input/results.json', JSON.stringify({ results, errors }, null, 2) + '\n')
  assert.deepEqual(errors, [])
  assert.equal(results.filter(result => !result.passed).length, 0)
} finally { await browser.close(); await server.close() }
