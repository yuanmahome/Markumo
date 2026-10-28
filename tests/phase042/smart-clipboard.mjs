import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 1497, strictPort: true, hmr: false, watch: null }, cacheDir: 'node_modules/.vite-smart-clipboard' })
await server.listen()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
const errors = [], report = []
page.on('pageerror', error => errors.push(error.message))
const original = '# 第一个标题\n\n## 第二个标题\n'
async function reset(source = original, enabled = true, copyWholeLine = false) {
  await page.evaluate(({ source, enabled, copyWholeLine }) => {
    window.f.reset(source)
    window.f.manager.setMarkdownClipboard({ copyAcrossBlocks: enabled, copyWholeLine })
    window.copied = null
  }, { source, enabled, copyWholeLine })
  await page.waitForFunction(() => window.f.ready())
}
// Range geometry is read only. Every acceptance selection is made by an actual
// pointer-down / pointer-move / pointer-up, never by dispatching PM Selection.
async function point(selector, offset) {
  return page.locator(`.md-prose ${selector}`).first().evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text, remaining = offset
    while ((text = walker.nextNode())) {
      if (remaining <= text.length) {
        const range = document.createRange()
        range.setStart(text, remaining ? remaining - 1 : 0)
        range.setEnd(text, remaining || 1)
        const rect = range.getBoundingClientRect()
        return { x: remaining ? rect.right - 0.15 : rect.left + 0.15, y: rect.top + rect.height / 2 }
      }
      remaining -= text.length
    }
    throw Error(`No character offset ${offset} in ${element.outerHTML}`)
  }, offset)
}
async function drag(start, end, reverse = false) {
  let a = await point(...start), b = await point(...end)
  if (reverse) [a, b] = [b, a]
  await page.mouse.move(a.x, a.y); await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 16 }); await page.mouse.up()
  await page.waitForTimeout(35)
  return page.evaluate(() => {
    const { selection, doc } = window.f.live().view.state
    return { type: selection.toJSON().type, from: selection.$from.parentOffset, to: selection.$to.parentOffset,
      text: doc.textBetween(selection.from, selection.to, '\n'), anchor: selection.anchor, head: selection.head }
  })
}
async function copy(operation = 'copy') {
  await page.evaluate(() => { window.copied = null; window.f.requests.length = 0 })
  if (operation === 'copy' || operation === 'cut') await page.keyboard.press(operation === 'copy' ? 'Control+c' : 'Control+x')
  else if (operation === 'markdown') await page.keyboard.press('Control+Shift+c')
  else if (operation === 'context') {
    // Right click within the existing selected range, as a user would.
    const p = await point('h1', 2)
    await page.mouse.click(p.x, p.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '复制', exact: true }).click()
  } else await page.evaluate(() => window.f.live().clipboard('copy'))
  await page.waitForFunction(() => window.copied || window.f.requests.some(r => r.command?.startsWith('plugin:clipboard-manager|write_')))
  return page.evaluate(() => {
    if (window.copied) return window.copied
    const write = window.f.requests.findLast(r => r.command?.startsWith('plugin:clipboard-manager|write_'))
    return { text: write.args.altText ?? write.args.text, html: write.args.html ?? null }
  })
}
try {
  await page.goto('http://127.0.0.1:1497/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  await page.evaluate(() => document.addEventListener('copy', event => {
    window.copied = { text: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html') }
  }))
  await page.evaluate(() => document.addEventListener('cut', event => {
    window.copied = { text: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html') }
  }))
  const cases = [
    { label: 'one heading', end: ['h1', 5], text: '第一个标题', md: '# 第一个标题', offset: 5 },
    ...[0, 1, 2, 3, 5].map(offset => ({ label: `next heading offset ${offset}`, end: ['h2', offset],
      text: '第一个标题' + (offset ? '\n' + '第二个标题'.slice(0, offset) : ''),
      md: '# 第一个标题' + (offset ? '\n\n## ' + '第二个标题'.slice(0, offset) : ''), offset })),
  ]
  for (const enabled of [true, false]) for (const reverse of [false, true]) for (const test of cases) {
    for (const operation of ['copy', 'markdown', 'context', 'menu-route', 'cut']) {
      await reset(original, enabled)
      const selection = await drag(['h1', 0], test.end, reverse)
      assert.equal(selection.type, 'text')
      assert.equal(selection.from, 0); assert.equal(selection.to, test.offset)
      if (reverse) assert(selection.anchor > selection.head)
      const result = await copy(operation)
      const expected = operation === 'markdown' || (enabled && test.end[0] !== 'h1') ? test.md : test.text
      assert.equal(result.text, expected, `${test.label}, enabled=${enabled}, reverse=${reverse}, ${operation}`)
      if (result.html !== null) {
        const html = await page.evaluate(html => {
          const root = new DOMParser().parseFromString(html, 'text/html').body
          return { text: root.textContent.replace(/\n/g, ''), headings: [...root.querySelectorAll('h1,h2')].map(el => [el.tagName, el.textContent]) }
        }, result.html)
        assert.equal(html.text, test.text.replace(/\n/g, ''))
        assert.deepEqual(html.headings, test.end[0] === 'h1' || !test.offset ? [['H1', '第一个标题']] : [['H1', '第一个标题'], ['H2', '第二个标题'.slice(0, test.offset)]])
      }
      if (operation === 'cut') {
        const remaining = await page.evaluate(() => window.f.manager.getText(window.f.id))
        assert(!remaining.includes('第一个标题'))
        if (test.end[0] === 'h2' && test.offset < 5) assert(remaining.includes('第二个标题'.slice(test.offset)))
      }
      report.push({ ...test, enabled, reverse, operation, selection, result })
    }
  }
  console.log('PASS exact heading clipboard matrix: two preferences, both drag directions, copy/explicit/context/menu-route/cut')

  for (const level of [1, 3, 4, 5, 6]) {
    await reset(`## 第一个标题\n\n${'#'.repeat(level)} 第二个标题\n`)
    await drag(['h2', 0], [`h${level}`, 3])
    assert.equal((await copy()).text, `## 第一个标题\n\n${'#'.repeat(level)} 第二个`)
  }
  const structures = [
    ['# 第一个标题\n\n> ## 第二个标题\n', 'blockquote h2', '# 第一个标题\n\n> ## 第二个'],
    ['# 第一个标题\n\n- 第二个标题\n', 'li p', '# 第一个标题\n\n- 第二个'],
    ['# 第一个标题\n\n3. 第二个标题\n', 'li p', '# 第一个标题\n\n3. 第二个'],
  ]
  for (const [source, selector, expected] of structures) for (const end of [0, 3]) {
    await reset(source); await drag(['h1', 0], [selector, end])
    assert.equal((await copy()).text, end ? expected : '# 第一个标题')
  }
  await reset('> # 第一个标题\n>\n> ## 第二个标题\n')
  await drag(['h1', 2], ['h2', 3], true)
  assert.equal((await copy()).text, '> # 个标题\n>\n> ## 第二个')
  await reset('- 第一个标题\n- 第二个标题\n')
  await drag(['li:nth-child(1) p', 2], ['li:nth-child(2) p', 3])
  assert.equal((await copy()).text, '- 个标题\n- 第二个')
  await reset('3. 第一个标题\n4. 第二个标题\n\n## 结束标题\n')
  await drag(['li:nth-child(2) p', 1], ['h2', 2])
  assert.equal((await copy()).text, '4. 二个标题\n\n## 结束')
  await reset('3. 第一个标题\n4. 第二个标题\n\n## 结束标题\n')
  await drag(['li:nth-child(1) p', 5], ['li:nth-child(2) p', 3])
  assert.equal((await copy()).text, '4. 第二个')
  console.log('PASS heading levels, partial first heading, list/quote ancestry and empty boundary wrappers')

  await reset('# **加粗文字**与[链接文字](https://example.com)\n\n## 第二个标题\n')
  await drag(['h1', 1], ['h2', 2], true)
  const rich = await copy()
  assert.equal(rich.text, '# **粗文字**与[链接文字](https://example.com)\n\n## 第二')
  assert.equal(await page.evaluate(html => { const root = new DOMParser().parseFromString(html, 'text/html'); return root.querySelector('strong')?.textContent }, rich.html), '粗文字')
  assert.equal(await page.evaluate(html => { const root = new DOMParser().parseFromString(html, 'text/html'); return root.querySelector('a')?.getAttribute('href') }, rich.html), 'https://example.com')

  const table = '| A | B |\n| --- | --- |\n| alpha | beta |\n'
  for (const enabled of [true, false]) {
    await reset(table, enabled); await drag(['td:nth-child(1) p', 1], ['td:nth-child(1) p', 4])
    assert.equal((await copy()).text, 'lph'); assert.equal((await copy('markdown')).text, 'lph')
    await reset(table, enabled); const selection = await drag(['th:nth-child(1) p', 0], ['td:nth-child(2) p', 2])
    assert.equal(selection.type, 'cell')
    assert.equal((await copy()).text, '| A | B |\n| --- | --- |\n| alpha | beta |')
  }
  console.log('PASS selected link/strong HTML, one-cell and rectangular table copy with either preference')

  for (const enabled of [true, false]) {
    await reset('```text\nalpha beta\nsecond line\n```\n', enabled)
    await page.locator('.md-code-editor-wrap').click({ position: { x: 80, y: 15 } })
    await page.locator('.md-code-block .cm-content').waitFor()
    await drag(['.cm-line:nth-child(1)', 3], ['.cm-line:nth-child(2)', 4])
    assert.equal((await copy()).text, 'ha beta\nseco', 'Multiline selection inside a code textblock remains plain text')
  }
  console.log('PASS real multiline code drags retain selected source without fences or line numbers')

  await reset('line one\nline two\n', true)
  await drag(['p', 0], ['p', 8])
  assert.equal((await copy()).text, 'line one')
  await reset('# 第一个标题\n', true, true)
  const caret = await point('h1', 2); await page.mouse.click(caret.x, caret.y)
  assert.equal((await copy()).text, '第一个标题')
  assert.equal((await copy('markdown')).text, '# 第一个标题')
  await reset('# 第一个标题\n')
  const title = await point('h1', 2); await page.mouse.click(title.x, title.y)
  await page.keyboard.press('Control+a')
  assert.equal((await copy()).text, '第一个标题', 'Select-all ignores the editor-only trailing paragraph')
  const migration = await page.evaluate(async () => {
    const { settingsFrom, persistedSettings } = await import('/src/features/shell/editorSettings.ts')
    return [null, { markdownClipboard: { copyMarkdown: false, copyWholeLine: true } }, { markdownClipboard: { copyMarkdown: true, copyWholeLine: false } },
      { settingsVersion: 7, markdownClipboard: { copyAcrossBlocks: false, copyWholeLine: true } }].map(raw => persistedSettings(settingsFrom(raw)))
  })
  assert.deepEqual(migration.map(settings => settings.markdownClipboard), [
    { copyAcrossBlocks: true, copyWholeLine: false }, { copyAcrossBlocks: true, copyWholeLine: true },
    { copyAcrossBlocks: true, copyWholeLine: false }, { copyAcrossBlocks: false, copyWholeLine: true },
  ])
  assert(migration.every(settings => settings.settingsVersion === 7 && !('copyMarkdown' in settings.markdownClipboard)))
  assert.deepEqual(errors, [])
  fs.mkdirSync('test-results/smart-clipboard', { recursive: true })
  fs.writeFileSync('test-results/smart-clipboard/browser.json', JSON.stringify({ matrix: report, errors }, null, 2))
  console.log(`PASS smart clipboard: ${report.length} exact mouse-drag cases plus structural, rich-text, table and settings migration checks`)
} finally { await browser.close(); await server.close() }
