import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 1520, strictPort: true, hmr: false, watch: null }, cacheDir: 'node_modules/.vite-inline-source-navigation' })
await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}) })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const input = page.locator('.md-inline-source-input')
async function reset(source) {
  await page.evaluate(source => window.f.reset(source), source)
  await page.waitForFunction(() => !!window.f.live() && window.f.ready())
}
async function current() {
  return page.evaluate(() => {
    const editor = window.f.live(), selection = editor.view.state.selection
    return { parent: selection.$head.parent.textContent, offset: selection.$head.parentOffset,
      anchor: selection.anchor, head: selection.head, empty: selection.empty,
      source: window.f.manager.getText(window.f.id), bridge: editor.bridge.source,
      pending: window.f.manager.hasPendingMarkdownEdits, notices: [...window.f.notices] }
  })
}
try {
  await page.goto('http://127.0.0.1:1520/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  for (const [raw, tag, offset] of [['`facebookAdId`', 'code', 5], ['**facebookAdId**', 'strong', 6], ['*facebookAdId*', 'em', 5], ['~~facebookAdId~~', 's', 6], ['[facebookAdId](target.md)', 'a', 5]]) {
    for (const direction of ['ArrowDown', 'ArrowUp']) {
      const source = '| 字段 | 示例 |\n|---|---|\n| 上一行内容 | UP |\n| ' + raw + ' | KEEP |\n| 下一行内容 | DOWN |\n\n后文\n'
      await reset(source)
      await page.locator('.md-prose td ' + tag).click()
      await input.waitFor()
      await page.evaluate(offset => window.f.live().inlineSource.focus(offset), offset)
      await page.keyboard.press(direction)
      await page.waitForFunction(expected => window.f.live().view.state.selection.$head.parent.textContent === expected, direction === 'ArrowDown' ? '下一行内容' : '上一行内容')
      const state = await current()
      assert.equal(state.source, source)
      assert.equal(state.bridge, source)
      assert.equal(state.pending, false)
      assert.deepEqual(state.notices, [])
      assert.ok(await page.locator('.md-prose:focus').count(), 'The document must own focus after leaving inline source')
      await page.keyboard.insertText('X')
      assert.equal((await current()).source, source.replace(direction === 'ArrowDown' ? '下一行内容' : '上一行内容', state.parent.slice(0, state.offset) + 'X' + state.parent.slice(state.offset)))
    }
    console.log('PASS vertical navigation from table inline source:', tag)
  }

  for (const [raw, tag, offset] of [['`代码文字`', 'code', 3], ['**加粗文字**', 'strong', 4], ['*斜体文字*', 'em', 3], ['~~删除文字~~', 's', 4], ['[链接文字](target.md)', 'a', 3]]) {
    for (const table of [false, true]) {
      const text = '前文 ' + raw + ' 后文'
      const source = table ? '| A | B |\n|---|---|\n| ' + text + ' | KEEP |\n' : text + '\n'
      for (const direction of ['ArrowLeft', 'ArrowRight']) {
        const left = direction === 'ArrowLeft'
        await reset(source)
        await page.locator('.md-prose ' + tag).click()
        await page.evaluate(offset => window.f.live().inlineSource.focus(offset), offset)
        await page.keyboard.press(direction)
        assert.equal(await page.evaluate(() => window.f.live().inlineSource.selection().head), offset + (left ? -1 : 1))
        await page.evaluate(left => {
          const editor = window.f.live().inlineSource
          editor.focus(left ? 0 : editor.input.textContent.length)
        }, left)
        await page.keyboard.press(direction)
        await page.waitForFunction(() => !window.f.live().inlineSource)
        assert.equal((await current()).offset, left ? 3 : 7)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.keyboard.press(direction)
        await page.waitForFunction(offset => window.f.live().view.state.selection.$head.parentOffset === offset, left ? 2 : 8)
        assert.equal((await current()).offset, left ? 2 : 8)
        assert.equal((await current()).source, source)

        await reset(source)
        await page.locator('.md-prose ' + tag).click()
        await page.evaluate(left => {
          const editor = window.f.live().inlineSource
          editor.focus(left ? 0 : editor.input.textContent.length)
        }, left)
        await page.keyboard.press('Shift+' + direction)
        await page.waitForFunction(() => !window.f.live().inlineSource)
        const extended = await current()
        assert.equal(extended.empty, false)
        assert.equal(extended.offset, left ? 2 : 8)
        assert.equal(await page.evaluate(() => document.getSelection().toString()), ' ')
        assert.equal(extended.source, source)
      }
    }
    console.log('PASS horizontal movement and selection across source boundaries:', tag)
  }

  for (const direction of ['ArrowDown', 'ArrowUp']) {
    const source = '上一段内容\n\n中间 **加粗文字** 后续正文\n\n下一段内容\n'
    await reset(source)
    await page.locator('.md-prose strong').click()
    await page.evaluate(() => window.f.live().inlineSource.focus(4))
    await page.keyboard.press(direction)
    await page.waitForFunction(expected => window.f.live().view.state.selection.$head.parent.textContent === expected, direction === 'ArrowDown' ? '下一段内容' : '上一段内容')
    assert.equal((await current()).source, source)
    assert.ok(await page.locator('.md-prose:focus').count())
  }
  console.log('PASS vertical navigation from the middle of formatted prose')

  const wrappedSource = '上一段\n\n**' + '自动换行内容'.repeat(40) + '**\n\n下一段\n'
  await reset(wrappedSource)
  await page.locator('.md-prose').evaluate(el => { el.style.width = '260px' })
  await page.locator('.md-prose strong').click()
  await page.evaluate(() => window.f.live().inlineSource.focus(3))
  const before = await page.evaluate(() => window.f.live().inlineSource.selection().head)
  await page.keyboard.press('ArrowDown')
  assert.ok(await input.count(), 'An internal wrapped line keeps the source editor open')
  assert.ok(await page.evaluate(before => window.f.live().inlineSource.selection().head > before, before))
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.evaluate(() => window.f.live().inlineSource.selection().head), before)
  await page.evaluate(() => {
    const editor = window.f.live().inlineSource
    editor.focus(editor.input.textContent.length - 3)
  })
  await page.keyboard.press('ArrowDown')
  await page.waitForFunction(() => window.f.live().view.state.selection.$head.parent.textContent === '下一段')
  assert.equal((await current()).source, wrappedSource)
  console.log('PASS wrapped source moves internally before continuing into the document')

  await reset('上一段\n\n**加粗文字**\n\n下一段\n')
  await page.locator('.md-prose strong').click()
  await page.evaluate(() => window.f.live().inlineSource.focus(4))
  await page.keyboard.press('Shift+ArrowDown')
  const extended = await current()
  assert.equal(extended.parent, '下一段')
  assert.equal(extended.empty, false)
  assert.equal(await page.evaluate(() => window.f.live().view.state.doc.resolve(window.f.live().view.state.selection.anchor).parentOffset), 2)
  assert.ok((await page.evaluate(() => document.getSelection().toString())).includes('文字'))
  console.log('PASS Shift+Down preserves the anchor while extending into the next paragraph')

  const tableSource = '| 字段 | 示例 |\n|---|---|\n| **加粗文字** | KEEP |\n| 下一行 | NEXT |\n'
  await reset(tableSource)
  await page.locator('.md-prose strong').click()
  await page.evaluate(() => window.f.live().inlineSource.focus(4))
  await page.keyboard.press('Shift+ArrowDown')
  assert.equal(await page.evaluate(() => window.f.live().view.state.selection.toJSON().type), 'cell')
  assert.equal((await current()).source, tableSource)
  console.log('PASS Shift+Down keeps the document table-selection behavior')

  await reset('**加粗文字**\n\n后文\n')
  await page.locator('.md-prose strong').click()
  await input.evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  })
  await input.dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true })
  assert.ok(await input.count(), 'IME arrow keys must not leave source editing')
  await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  assert.equal((await current()).source, '**加粗文字**\n\n后文\n')
  console.log('PASS composition keeps ownership of arrow keys')
  assert.deepEqual(errors, [])
} catch (error) {
  console.error(await current(), await page.evaluate(() => window.f.snapshot()))
  throw error
} finally { await browser.close(); await server.close() }
