import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 1519, strictPort: true, hmr: false, watch: null }, cacheDir: 'node_modules/.vite-inline-formatting-edit' })
await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}) })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const word = '爱神的箭'
const input = page.locator('.md-inline-source-input')
async function reset(source = 'Start\n\n后文\n') {
  await page.evaluate(source => window.f.reset(source), source)
  await page.waitForFunction(() => !!window.f.live() && window.f.ready())
}
async function snapshot() {
  return page.evaluate(() => ({ source: window.f.manager.getText(window.f.id), bridge: window.f.live().bridge.source,
    pending: window.f.manager.hasPendingMarkdownEdits, composing: window.f.manager.isComposing,
    raw: window.f.live().inlineSource?.input.textContent, notices: [...window.f.notices] }))
}
async function assertApplied(expected) {
  const state = await snapshot()
  assert.equal(state.source, expected)
  assert.equal(state.bridge, expected)
  assert.equal(state.pending, false)
  assert.equal(state.composing, false)
  assert.deepEqual(state.notices, [])
}
try {
  await page.goto('http://127.0.0.1:1519/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  for (const [opening, closing, kind] of [['**', '**', 'strong'], ['__', '__', 'strong'], ['*', '*', 'em'], ['_', '_', 'em'], ['***', '***', 'strong'], ['___', '___', 'strong'], ['~~', '~~', 'strike'], ['`', '`', 'code']]) {
    await reset()
    await page.evaluate(() => window.f.caret('Start'))
    await page.keyboard.press('Shift+End')
    const raw = opening + word + closing
    await page.keyboard.type(raw)
    await input.waitFor()
    assert.equal(await input.innerText(), raw, 'The active format keeps every delimiter visible after completion')
    assert.equal(await page.evaluate(() => window.f.live().inlineSource.selection().head), raw.length)
    assert.ok(await input.locator('.md-raw-' + kind).count() > 0)
    const style = await input.locator('.md-raw-' + kind + ':not(.md-raw-delimiter)').first().evaluate(el => {
      const style = getComputedStyle(el)
      return { weight: style.fontWeight, italic: style.fontStyle, decoration: style.textDecorationLine, family: style.fontFamily }
    })
    if (kind === 'strong') assert.equal(style.weight, '700')
    if (kind === 'em') assert.equal(style.italic, 'italic')
    if (kind === 'strike') assert.ok(style.decoration.includes('line-through'))
    if (kind === 'code') assert.match(style.family, /mono|consolas/i)
    await assertApplied(raw + '\n\n后文\n')

    // Match the reported sequence with a real native selection and Backspace.
    await page.evaluate(at => window.f.live().inlineSource.focus(at), opening.length)
    for (let i = 0; i < word.length + closing.length; i++) await page.keyboard.press('Shift+ArrowRight')
    assert.equal(await page.evaluate(() => document.getSelection().toString()), word + closing)
    await page.keyboard.press('Backspace')
    await assertApplied(opening + '\n\n后文\n')
    for (let i = opening.length - 1; i > 0; i--) {
      await page.keyboard.press('Backspace')
      await assertApplied(opening.slice(0, i) + '\n\n后文\n')
    }
    await page.keyboard.insertText('继续编辑')
    await assertApplied(opening[0] + '继续编辑\n\n后文\n')
    await page.locator('.md-prose > p').filter({ hasText: '后文' }).click()
    await page.waitForFunction(() => !window.f.live().inlineSource)
    await assertApplied(opening[0] + '继续编辑\n\n后文\n')
    await page.keyboard.press('Control+z')
    const undone = await snapshot()
    assert.equal(undone.pending, false)
    assert.equal(undone.source, undone.bridge)
    await page.keyboard.press('Control+y')
    await assertApplied(opening[0] + '继续编辑\n\n后文\n')
    console.log('PASS active delimiters, selected/partial deletion, continued input and history:', opening)
  }

  for (const raw of ['**加粗**', '*斜体*', '***粗斜体***', '~~删除线~~', '`代码`']) {
    await reset()
    await page.evaluate(() => window.f.caret('Start'))
    await page.keyboard.press('Shift+End')
    await page.keyboard.type(raw)
    await input.waitFor()
    await page.keyboard.insertText(' 后续正文')
    await page.waitForFunction(() => !window.f.live().inlineSource)
    await assertApplied(raw + ' 后续正文\n\n后文\n')
    assert.equal(await input.count(), 0)
    await page.locator('.md-prose strong, .md-prose em, .md-prose s, .md-prose code').first().click()
    await input.waitFor()
    assert.equal(await input.innerText(), raw)
    await page.locator('.md-prose > p').filter({ hasText: '后文' }).click()
    await page.waitForFunction(() => !window.f.live().inlineSource)
    await assertApplied(raw + ' 后续正文\n\n后文\n')
  }
  console.log('PASS moving beyond, back into and away from formatted text shows/hides delimiters')

  for (const raw of ['**爱神的箭**', '*斜体*', '***粗斜体***', '~~删除线~~', '`代码`']) {
    await reset()
    await page.evaluate(() => window.f.caret('Start'))
    await page.keyboard.press('Shift+End')
    await page.evaluate(async raw => {
      const { textClipboard } = await import('/src/features/shell/clipboard.ts')
      const read = textClipboard.readText
      textClipboard.readText = async () => raw
      try { await window.f.live().clipboard('paste') }
      finally { textClipboard.readText = read }
    }, raw)
    await input.waitFor()
    assert.equal(await input.innerText(), raw)
    assert.equal(await page.evaluate(() => window.f.live().inlineSource.selection().head), raw.length)
    await assertApplied(raw + '\n\n后文\n')
  }
  console.log('PASS native clipboard paste shows complete active delimiters with the caret after their end')

  await reset('**爱神的箭**\n\n后文\n')
  await page.locator('.md-prose strong').click()
  await page.evaluate(() => window.f.live().inlineSource.focus(2))
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await assertApplied('*\n\n后文\n')
  await page.locator('.md-prose > p').filter({ hasText: '后文' }).click()
  await page.waitForFunction(() => !window.f.live().inlineSource)
  await page.evaluate(() => window.f.mode('source'))
  await page.evaluate(() => window.f.mode('live'))
  await page.waitForFunction(() => !!window.f.live() && window.f.ready())
  assert.ok(await page.locator('.md-prose').innerText().then(text => text.includes('*')), 'A lone delimiter stays visible after a source/live cycle')
  await assertApplied('*\n\n后文\n')
  console.log('PASS a remaining star survives blur and Source/Live changes as editable literal text')

  for (const context of ['## Start', '> Start', '- Start', '保留 &amp; Start', '| A | B |\n|---|---|\n| Start | KEEP |']) {
    for (const eol of ['\n', '\r\n']) {
      const original = (context + '\n\n后文\n').replaceAll('\n', eol)
      const expected = original.replace('Start', '*')
      await reset(original)
      await page.evaluate(() => window.f.caret('Start'))
      await page.keyboard.press('Shift+End')
      await page.keyboard.type('**爱神的箭**')
      await input.waitFor()
      await page.evaluate(() => window.f.live().inlineSource.focus(2))
      for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
      await assertApplied(expected.replaceAll('\r\n', '\n'))
      assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), expected)
      await page.locator('.md-prose p').filter({ hasText: '后文' }).last().click()
      await page.waitForFunction(() => !window.f.live().inlineSource)
      await page.evaluate(() => window.f.mode('source'))
      await page.evaluate(() => window.f.mode('live'))
      await page.waitForFunction(() => !!window.f.live() && window.f.ready())
      await assertApplied(expected.replaceAll('\r\n', '\n'))
      assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), expected)
      assert.ok((await page.locator('.md-prose').innerText()).includes('*'))
    }
  }
  console.log('PASS partial formatting deletion preserves heading/quote/list/table/entity context and LF/CRLF')

  await reset('**爱神的箭**\n\n后文\n')
  await page.locator('.md-prose strong').click()
  await input.evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.textContent = '*输入中'
    const selection = document.getSelection(); selection.selectAllChildren(el); selection.collapseToEnd()
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }))
  })
  assert.equal((await snapshot()).source, '**爱神的箭**\n\n后文\n')
  assert.equal((await snapshot()).composing, true)
  await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入中' })))
  await page.waitForFunction(() => !window.f.manager.isComposing)
  await assertApplied('*输入中\n\n后文\n')
  console.log('PASS Chinese composition commits incomplete delimiters without blocking after composition ends')
  assert.deepEqual(errors, [])
} finally { await browser.close(); await server.close() }
