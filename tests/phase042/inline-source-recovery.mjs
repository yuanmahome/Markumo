import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1518, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-inline-source-recovery',
})
await server.listen()
const browser = await chromium.launch({ headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const prefix = '# 编辑测试\n\n- 保留 `main` 和这条列表。\n\n'
const source = prefix + '***末尾文字***\n\n\n'
async function reset(text = source) {
  await page.evaluate(source => window.f.reset(source), text)
  await page.waitForFunction(() => !!window.f.live() && window.f.ready())
  await page.locator('.md-prose strong').last().click()
  await page.locator('.md-inline-source-input').waitFor()
  await page.evaluate(() => window.f.live().inlineSource.focus(10))
}
async function snapshot() {
  return page.evaluate(() => {
    const editor = window.f.live(), local = editor.inlineSource
    return { source: window.f.manager.getText(window.f.id), bridge: editor.bridge.source,
      pending: !!local?.pending, raw: local?.input.textContent, composing: window.f.manager.isComposing,
      range: local && [local.from, local.to, local.sourceFrom, local.sourceTo], notices: [...window.f.notices] }
  })
}
async function replaceDraft(raw) {
  await page.locator('.md-inline-source-input').evaluate(el => document.getSelection().selectAllChildren(el))
  await page.keyboard.insertText(raw)
}
async function deleteToPending() {
  for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace')
  const result = await snapshot()
  assert.equal(result.raw, '*')
  assert.equal(result.pending, true)
  assert.equal(await page.evaluate(() => window.f.manager.hasPendingMarkdownEdits), true)
  assert.equal(result.source, prefix + '**\n\n\n')
}
try {
  await page.goto('http://127.0.0.1:1518/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  await reset()
  await deleteToPending()
  await page.keyboard.press('Control+z')
  let result = await snapshot()
  assert.equal(result.pending, false, 'Undo must cancel the unapplied draft before changing canonical history')
  assert.equal(result.raw, '**')
  assert.equal(await page.evaluate(() => window.f.manager.hasPendingMarkdownEdits), false)
  assert.equal(result.source, result.bridge)
  assert.equal(await page.locator('.md-inline-source-warning:visible').count(), 0)
  await page.keyboard.type('text')
  result = await snapshot()
  assert.equal(result.source, result.bridge)
  assert.equal(result.pending, false)
  assert.deepEqual(result.notices, [])
  console.log('PASS deleting final bold/italic delimiters, undoing a pending draft and continuing input')

  await reset()
  await deleteToPending()
  await page.locator('.md-prose > p').last().click()
  assert.equal(await page.locator('.md-inline-source-input:focus').count(), 0)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !window.f.live().inlineSource)
  result = await snapshot()
  assert.equal(result.composing, false)
  assert.equal(result.source, prefix + '**\n\n\n')
  assert.equal(await page.evaluate(() => window.f.manager.setMarkdownMode(window.f.id, 'source', 'main')), true)
  assert.deepEqual(result.notices, [])
  console.log('PASS Escape outside the local input releases the document without losing applied edits')

  await reset()
  const before = await snapshot()
  await page.evaluate(() => {
    const editor = window.f.live(), publish = editor.options.publish
    editor.options.publish = (...args) => { editor.options.publish = publish; throw new RangeError('Position 316 out of range') }
  })
  await replaceDraft('***替换为更长的末尾文字***')
  result = await snapshot()
  assert.equal(result.source, before.source)
  assert.equal(result.bridge, before.bridge, 'A failed edit must not advance the bridge before canonical publication')
  assert.deepEqual(result.range, before.range, 'A failed edit must retain the accepted document/source ranges')
  assert.equal(result.pending, true)
  assert.equal(result.notices.length, 1)
  assert.match(result.notices[0], /Position 316 out of range/)
  await replaceDraft('***恢复编辑***')
  result = await snapshot()
  assert.equal(result.source, prefix + '***恢复编辑***\n\n\n')
  assert.equal(result.source, result.bridge)
  assert.equal(result.pending, false)
  console.log('PASS a failed local publication preserves the accepted state and allows a retry')

  await reset()
  await replaceDraft('![图片](missing.png)')
  result = await snapshot()
  assert.equal(result.source, prefix + '![图片](missing.png)\n\n\n')
  assert.equal(result.pending, false)
  assert.deepEqual(result.notices, [])
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !window.f.live().inlineSource)
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.f.ready())
  assert.equal((await snapshot()).source, source)
  console.log('PASS structural normalization and canonical undo retain valid local ranges')

  await reset()
  for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace')
  result = await snapshot()
  assert.equal(result.pending, false)
  assert.deepEqual(result.notices, [])
  assert.ok(!result.source.includes('末尾文字'))
  assert.ok(result.source.startsWith(prefix))
  await page.keyboard.type('继续编辑')
  result = await snapshot()
  assert.equal(result.pending, false)
  assert.equal(result.source, result.bridge)
  assert.ok(result.source.includes('继续编辑'))
  assert.deepEqual(result.notices, [])
  console.log('PASS deleting all final text and delimiters still permits input')

  for (const eol of ['\n', '\r\n']) {
    for (const ending of ['', eol, eol.repeat(3)]) {
      for (const operation of ['selected', 'forward']) {
        await reset((prefix + '***末尾文字***').replaceAll('\n', eol) + ending)
        if (operation === 'selected') {
          await page.locator('.md-inline-source-input').evaluate(el => document.getSelection().selectAllChildren(el))
          await page.keyboard.press('Backspace')
        } else {
          await page.evaluate(() => window.f.live().inlineSource.focus(0))
          for (let i = 0; i < 10; i++) await page.keyboard.press('Delete')
        }
        await page.waitForFunction(() => !window.f.live().inlineSource)
        await page.keyboard.insertText('删除后继续输入')
        result = await snapshot()
        assert.equal(result.source, result.bridge)
        assert.equal(result.composing, false)
        assert.ok(result.source.includes('删除后继续输入'))
        assert.deepEqual(result.notices, [])
      }
    }
  }
  console.log('PASS selected/forward deletion and continued input with LF/CRLF and varied final blank lines')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
