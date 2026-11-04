import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1478, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-table-image-boundaries',
})
await server.listen()
const browser = await chromium.launch({ headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
const emptyTable = '| | | |\n| --- | --- | --- |\n| | | |\n| | | |\n'
const filledTable = emptyTable.replace('| | | |\n| | | |\n', '| | 11 | |\n| | | |\n')
const image = '![test](/missing-boundary-test.png)'

async function reset(source, readOnly = false) {
  await page.evaluate(({ source, readOnly }) => window.f.reset(source, readOnly), { source, readOnly })
  await page.waitForFunction(() => window.f.ready())
}
async function snapshot() { return page.evaluate(() => window.f.snapshot()) }
async function select(selector, end = false, pane = 'main') {
  await page.evaluate(({ selector, end, pane }) => {
    const view = window.f.live(pane).view
    const element = view.dom.querySelector(selector)
    const pos = view.posAtDOM(element, end ? element.childNodes.length : 0)
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos), end ? -1 : 1)))
    view.focus()
  }, { selector, end, pane })
}
async function cellIndex(pane = 'main') {
  return page.evaluate(pane => {
    const view = window.f.live(pane).view, { $from } = view.state.selection
    for (let depth = $from.depth; depth > 0; depth--) {
      if (['cell', 'header_cell'].includes($from.node(depth).type.spec.tableRole)) {
        const cells = [...view.dom.querySelectorAll('th,td')]
        return cells.indexOf(view.nodeDOM($from.before(depth)))
      }
    }
    return -1
  }, pane)
}
async function backspace() { await page.keyboard.press('Backspace'); await page.waitForFunction(() => window.f.ready()) }
async function clickImageTail(open = false, pane = 'main') {
  const scope = page.locator(`[data-pane="${pane}"]`)
  await scope.locator('.md-image-compact').waitFor()
  if (open) await scope.locator('.md-image-compact').click()
  const boxes = await scope.locator('.md-prose p').evaluateAll(elements => elements.map(p => {
    const media = p.querySelector('.md-source-image') ?? p.querySelector('.md-image-compact')
    if (!media) return null
    const pRect = p.getBoundingClientRect(), rect = media.getBoundingClientRect()
    return { x: Math.min(rect.right + 80, pRect.right - 10), y: rect.top + Math.min(10, rect.height / 2), right: rect.right }
  }))
  const point = boxes.find(Boolean)
  assert(point && point.x > point.right, 'Must click the actual blank area after the image source')
  await page.mouse.click(point.x, point.y)
  assert.equal(await scope.locator('.md-inline-source-input:focus').count(), 1)
  assert.deepEqual(await page.evaluate(pane => {
    const editor = window.f.live(pane).inlineSource
    return [editor.selection().anchor, editor.selection().head, editor.sourceTo - editor.sourceFrom]
  }, pane), Array(3).fill(image.length), 'The first click must synchronously put the caret at the source end')
}

try {
  await page.goto('http://127.0.0.1:1478/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  // A single final terminator leaves only the temporary editing entry. Extra
  // source lines are now persistent paragraphs and Backspace deletes those.
  await reset(`Before\n\n${filledTable}`)
  await select(':scope > p:last-child')
  const initial = await snapshot()
  for (const index of [8, 7, 6, 5]) {
    await backspace()
    assert.equal(await cellIndex(), index, 'Backspace must navigate in reverse cell order')
    assert.equal((await snapshot()).source, initial.source)
    assert.equal((await snapshot()).undo, initial.undo)
  }
  console.log('PASS paragraph → last cell → previous cells, including previous row')

  await select('th:first-child p')
  for (let i = 0; i < 3; i++) await backspace()
  assert.equal(await cellIndex(), 0)
  assert.equal((await snapshot()).source, initial.source)
  console.log('PASS first empty cell protects a table with content elsewhere')

  await select('tr:nth-child(2) td:nth-child(2) p')
  await backspace()
  assert.equal(await cellIndex(), 4)
  assert.equal((await snapshot()).source, initial.source)
  await page.keyboard.press('Shift+ArrowRight')
  await page.waitForFunction(() => !window.f.live().view.state.selection.empty)
  await backspace()
  assert.equal(await page.locator('tr:nth-child(2) td:nth-child(2)').innerText(), '1')
  console.log('PASS nonempty cell start is protected while selected text still deletes')

  await reset(`Before\n\n${filledTable}`)

  await select('tr:nth-child(2) td:nth-child(2) p', true)
  await backspace()
  assert.equal(await cellIndex(), 4)
  assert.equal(await page.locator('tr:nth-child(2) td:nth-child(2)').innerText(), '1')
  await backspace()
  assert.equal(await cellIndex(), 4)
  await backspace()
  assert.equal(await cellIndex(), 3)
  console.log('PASS text deletes normally before empty-cell navigation')

  await reset(`${emptyTable}\n`)
  await select('th:first-child p')
  const emptySource = (await snapshot()).source
  await backspace()
  assert.equal(await page.locator('.md-prose table').count(), 0)
  assert.equal(await page.locator('.md-prose:focus').count(), 1)
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.f.ready())
  assert.equal((await snapshot()).source, emptySource)
  assert.equal(await page.locator('.md-prose table').count(), 1)
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => window.f.ready())
  assert.equal(await page.locator('.md-prose table').count(), 0)
  await page.keyboard.type('After deletion')
  assert((await snapshot()).source.includes('After deletion'))
  console.log('PASS entirely empty table deletes, undo/redo restores, editor remains usable')

  await reset('| |\n| --- |\n')
  await select('th p')
  await backspace()
  assert.equal(await page.locator('.md-prose table').count(), 0)
  await page.keyboard.type('One cell removed')
  assert((await snapshot()).source.includes('One cell removed'))
  console.log('PASS a single empty header cell deletes without stranding the caret')

  await reset(`Before\n\n${emptyTable}\nAfter\n`)
  await select('th:first-child p')
  await backspace()
  assert.equal((await snapshot()).source, 'Before\n\nAfter\n')
  assert.deepEqual(await page.evaluate(() => {
    const { $from } = window.f.live().view.state.selection
    return [$from.parent.textContent, $from.parentOffset]
  }), ['Before', 6])
  console.log('PASS deleting an empty table preserves adjacent paragraphs and selects the previous paragraph end')

  for (const content of ['**data**', '![image](/missing.png)', '$x$', '&nbsp;']) {
    await reset(emptyTable.replace('| | | |\n| | | |\n', `| | ${content} | |\n| | | |\n`))
    await select('th:first-child p')
    const before = (await snapshot()).source
    await backspace()
    assert.equal((await snapshot()).source, before)
    assert.equal(await page.locator('.md-prose table').count(), 1)
  }
  console.log('PASS formatted text, image, math and nonbreaking space prevent table deletion')

  await reset(`${filledTable}\nFollowing text\n`)
  await select('.md-prose > p:last-child')
  const following = (await snapshot()).source
  await backspace()
  assert.equal(await cellIndex(), 8)
  assert.equal((await snapshot()).source, following)
  console.log('PASS following paragraph text is preserved when entering table')

  await reset(`${emptyTable}\n`, true)
  await select('th:first-child p')
  await backspace()
  assert.equal(await page.locator('.md-prose table').count(), 1)
  console.log('PASS read-only table remains intact')

  await reset(`${filledTable}\n`)
  const pane = await page.evaluate(() => window.f.split())
  await page.waitForFunction(() => window.f.ready())
  await select('th:first-child p', false, pane)
  await backspace()
  assert.equal(await cellIndex(pane), 0)
  assert.equal(await page.locator('.md-prose table').count(), 2)
  console.log('PASS table protection in a second pane')

  await reset(`${emptyTable}\n`)
  await select('th:first-child p')
  const composingTable = (await snapshot()).source
  await page.locator('.md-prose').dispatchEvent('compositionstart', { data: '' })
  await page.locator('.md-prose').dispatchEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 229, isComposing: true })
  assert.equal((await snapshot()).source, composingTable)
  await page.locator('.md-prose').dispatchEvent('compositionend', { data: '' })
  console.log('PASS composition keystrokes do not delete an empty table (synthetic IME guard)')

  for (const prefix of ['> ', '- ']) {
    await reset(emptyTable.trimEnd().split('\n').map((line, index) => (prefix === '- ' && index ? '  ' : prefix) + line).join('\n') + '\n')
    assert.equal(await page.locator('.md-prose table').count(), 1)
    await select('tr:last-child td:last-child p')
    await backspace()
    assert.equal(await cellIndex(), 7)
    await select('th:first-child p')
    await backspace()
    assert.equal(await page.locator('.md-prose table').count(), 0)
  }
  console.log('PASS table boundaries in supported quote/list containers')

  for (const open of [false, true]) {
    await reset(`Before\n\n${image}\n\nAfter\n`)
    const source = (await snapshot()).source
    await clickImageTail(open)
    await page.keyboard.press('Enter')
    await page.keyboard.type('BELOW_IMAGE')
    await page.waitForFunction(() => window.f.ready())
    assert.equal((await snapshot()).source, `Before\n\n${image}\n\nBELOW_IMAGE\n\nAfter\n`)
    assert.equal(await page.locator('.md-source-image').count(), 0)
    assert.equal(await page.locator('.md-prose img, .md-prose .md-live-image').count() > 0, true)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => window.f.ready())
    assert(!(await snapshot()).source.includes('BELOW_IMAGE'))
    assert((await snapshot()).source.includes(image))
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => window.f.ready())
    assert.equal((await snapshot()).source, source)
    await page.keyboard.press('Control+y')
    await page.keyboard.press('Control+y')
    await page.waitForFunction(() => window.f.ready())
    assert.equal((await snapshot()).source, `Before\n\n${image}\n\nBELOW_IMAGE\n\nAfter\n`)
    console.log(`PASS image tail click + Enter creates paragraph (${open ? 'open source' : 'compact image'})`)
  }

  for (const source of [image, '![]()', '![test](/favicon.png)', '<img src="/favicon.png" width="80" />']) {
    await reset(`${source}\n\nAfter\n`)
    await page.locator('.md-live-image .md-image-compact-source:visible, .md-live-image img').first().click()
    const input = page.locator('.md-source-image .md-inline-source-input')
    await input.press('End')
    await input.press('Enter')
    await page.keyboard.type('NEXT')
    await page.waitForFunction(() => window.f.ready())
    assert.equal((await snapshot()).source, `${source}\n\nNEXT\n\nAfter\n`)
    assert.equal(await page.locator('.md-source-image').count(), 0)
    console.log(`PASS source-end Enter preserves ${source}`)
  }
  console.log('PASS Enter at source end for broken, empty-path, loaded and HTML images')

  await reset(`${image}\n`)
  await clickImageTail()
  await page.keyboard.press('Enter')
  await page.keyboard.type('DOCUMENT_END')
  await page.waitForFunction(() => window.f.ready())
  assert.equal((await snapshot()).source, `${image}\n\nDOCUMENT_END\n`)
  console.log('PASS image at document end creates a usable paragraph below it')

  await reset(`${image}\n\nAfter\n`)
  const imagePane = await page.evaluate(() => window.f.split())
  await page.waitForFunction(() => window.f.ready())
  await clickImageTail(true, imagePane)
  await page.keyboard.press('Enter')
  await page.keyboard.type('SECOND_PANE')
  await page.waitForFunction(() => window.f.ready())
  assert.equal((await snapshot()).source, `${image}\n\nSECOND_PANE\n\nAfter\n`)
  assert.deepEqual(await page.evaluate(() => window.f.panes.map(pane => {
    const blocks = []
    window.f.live(pane).view.state.doc.forEach(node => blocks.push([node.type.name, node.textContent]))
    return blocks
  })), Array(2).fill([['paragraph', ''], ['paragraph', 'SECOND_PANE'], ['paragraph', 'After']]))
  console.log('PASS image paragraph creation synchronizes to the other pane')

  await reset(`${image}\n\nAfter\n`)
  await page.locator('.md-live-image').click()
  const input = page.locator('.md-source-image .md-inline-source-input')
  await input.press('End')
  await input.dispatchEvent('compositionstart', { data: '' })
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true })
  assert.equal((await snapshot()).source, `${image}\n\nAfter\n`)
  assert.equal(await page.locator('.md-source-image').count(), 1)
  await input.dispatchEvent('compositionend', { data: '' })
  console.log('PASS composition confirmation does not split the image paragraph (synthetic IME guard)')
  assert.deepEqual(errors, [])
  assert.deepEqual(await page.evaluate(() => window.f.notices), [])
} catch (error) {
  console.error('Boundary failure state:', await page.evaluate(() => ({
    snapshot: window.f.snapshot(), dom: document.querySelector('.md-prose')?.outerHTML,
  })))
  throw error
} finally {
  await browser.close()
  await server.close()
}
