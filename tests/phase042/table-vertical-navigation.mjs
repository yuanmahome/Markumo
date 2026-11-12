import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 1521, strictPort: true, hmr: false, watch: null }, cacheDir: 'node_modules/.vite-table-vertical-navigation' })
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
async function tableCaret() {
  return page.evaluate(() => {
    const view = window.f.live().view, selection = view.state.selection
    let cell
    for (let depth = selection.$head.depth; depth > 0; depth--) {
      if (['cell', 'header_cell'].includes(selection.$head.node(depth).type.spec.tableRole)) {
        cell = view.nodeDOM(selection.$head.before(depth)); break
      }
    }
    const rect = view.coordsAtPos(selection.head)
    return { row: cell?.parentElement.rowIndex, column: cell?.cellIndex, x: rect.left, top: rect.top,
      head: selection.head, offset: selection.$head.parentOffset, text: selection.$head.parent.textContent }
  })
}
async function focusCell(row, column, offset) {
  await page.evaluate(({ row, column, offset }) => {
    const view = window.f.live().view
    const paragraph = view.dom.querySelector('table').rows[row].cells[column].querySelector('p')
    const pos = view.posAtDOM(paragraph, 0) + offset
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, pos)))
    view.focus()
  }, { row, column, offset })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
try {
  await page.goto('http://127.0.0.1:1521/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  const architecture = '## 2. 功能架构\n\n| 模块 | 主要功能 | 说明 |\n|---|---|---|\n' +
    '| 看板 | 产品、优化师、广告账户、广告系列、广告组、素材等维度分析 | 常规功能说明内容 |\n' +
    '| 推广 | 按媒体渠道查看账户、广告系列、广告组、广告、素材 | 常规功能说明内容 |\n' +
    '| 素材 | XMP 素材库、媒体素材库、文案库、素材编辑 | 常规功能说明内容 |\n\n后文\n'
  await reset(architecture)
  await focusCell(1, 1, 12)
  const originalCaret = await tableCaret()
  await page.keyboard.press('ArrowDown')
  await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, originalCaret.head)
  const nextCaret = await tableCaret()
  assert.equal(nextCaret.row, 2)
  assert.equal(nextCaret.column, 1)
  assert.ok(Math.abs(nextCaret.x - originalCaret.x) < 10, 'Down must preserve the visual text column instead of jumping to the cell start')
  await page.keyboard.press('ArrowUp')
  await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, nextCaret.head)
  assert.deepEqual(await tableCaret(), originalCaret)
  assert.equal((await current()).source, architecture)
  console.log('PASS table arrows preserve the current column and horizontal caret position')

  await focusCell(1, 2, 4)
  const thirdColumn = await tableCaret()
  await page.keyboard.press('ArrowDown')
  await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, thirdColumn.head)
  assert.equal((await tableCaret()).column, 2)
  assert.ok(Math.abs((await tableCaret()).x - thirdColumn.x) < 2)

  const longText = '一二三四五六七八九十'.repeat(2)
  const unevenRows = '| 模块 | 功能 |\n|---|---|\n| 甲 | ' + longText + ' |\n| 乙 | 短 |\n| 丙 | |\n| 丁 | ' + longText + ' |\n'
  await reset(unevenRows)
  await focusCell(1, 1, 12)
  const goal = await tableCaret()
  for (const row of [2, 3, 4, 3, 2, 1]) {
    const before = await tableCaret()
    await page.keyboard.press(row > before.row ? 'ArrowDown' : 'ArrowUp')
    await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, before.head)
    const after = await tableCaret()
    assert.equal(after.row, row)
    assert.equal(after.column, 1)
    if (row === 1 || row === 4) {
      assert.equal(after.offset, 12)
      assert.ok(Math.abs(after.x - goal.x) < 2, 'Short and empty rows must not erase the desired horizontal position')
    }
  }
  await focusCell(4, 1, 3)
  for (const row of [3, 2, 1]) {
    const before = await tableCaret()
    await page.keyboard.press('ArrowUp')
    await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, before.head)
    assert.equal((await tableCaret()).row, row)
  }
  assert.equal((await tableCaret()).offset, 3, 'A new caret position must reset the old horizontal goal')
  assert.equal((await current()).source, unevenRows)
  console.log('PASS repeated arrows retain their horizontal goal through short and empty cells')

  const wrappedCells = '| 模块 | 功能 |\n|---|---|\n| 甲 | ' + longText.repeat(3) + ' |\n| 乙 | ' + longText.repeat(3) + ' |\n'
  await reset(wrappedCells)
  await page.locator('.md-prose table').evaluate(table => { table.style.width = '360px'; table.style.tableLayout = 'fixed' })
  await focusCell(1, 1, 2)
  const firstLine = await tableCaret()
  await page.keyboard.press('ArrowDown')
  await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, firstLine.head)
  const secondLine = await tableCaret()
  assert.equal(secondLine.row, 1, 'A wrapped cell must finish its internal lines before changing rows')
  assert.ok(secondLine.top > firstLine.top)
  assert.ok(Math.abs(secondLine.x - firstLine.x) < 2)
  await focusCell(1, 1, longText.length * 3 - 2)
  const lastLine = await tableCaret()
  await page.keyboard.press('ArrowDown')
  await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, lastLine.head)
  const nextFirstLine = await tableCaret()
  assert.equal(nextFirstLine.row, 2)
  assert.ok(Math.abs(nextFirstLine.x - lastLine.x) < 8)
  await page.keyboard.press('ArrowUp')
  await page.waitForFunction(head => window.f.live().view.state.selection.head !== head, nextFirstLine.head)
  const previousLastLine = await tableCaret()
  assert.equal(previousLastLine.row, 1)
  assert.equal(previousLastLine.top, lastLine.top, 'Up must enter the previous cell at its last visual line')
  assert.ok(Math.abs(previousLastLine.x - lastLine.x) < 8)
  assert.equal((await current()).source, wrappedCells)
  console.log('PASS wrapped cells use internal visual lines and enter adjacent cells at the matching horizontal position')

  assert.deepEqual(errors, [])
} catch (error) {
  console.error(await current(), await page.evaluate(() => window.f.snapshot()))
  throw error
} finally { await browser.close(); await server.close() }
