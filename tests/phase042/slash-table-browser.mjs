import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1477, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-slash-table',
})
await server.listen()
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))

async function openPicker(entry = 'Enter') {
  await page.mouse.move(5, 5)
  await page.evaluate(() => window.f.reset('Start\n\nAfter.\n'))
  await page.waitForFunction(() => window.f.ready())
  await page.evaluate(() => window.f.caret('Start'))
  await page.keyboard.press('Shift+End')
  await page.keyboard.type('/table')
  if (entry === 'click') await page.locator('.md-slash-item[data-id="table"]').click()
  else await page.keyboard.press('Enter')
  await page.locator('.md-slash-table-grid').waitFor({ state: 'visible' })
}

async function hoverCell(rows, columns) {
  const box = await page.getByRole('button', { name: `${rows} 行 ${columns} 列`, exact: true }).boundingBox()
  assert(box, 'Table size cell must be visible')
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y)
  assert.equal(await page.locator('.md-slash-table-header strong').innerText(), `${rows} × ${columns}`)
  assert.equal(await page.locator('.md-slash-table-cell.is-selected').count(), rows * columns)
  return point
}

async function checkTable(rows, columns) {
  await page.waitForFunction(() => window.f.manager.getText(window.f.id).includes('|'), null, { timeout: 3000 })
  const source = await page.evaluate(() => window.f.manager.getText(window.f.id))
  const lines = source.split('\n').filter(line => line.startsWith('|'))
  assert.equal(lines.length, rows + 1, source)
  for (const line of lines) assert.equal(line.split('|').length - 2, columns, line)
  assert(source.includes('After.'), 'Surrounding text must be preserved')
  assert(!source.includes('/table'), 'Slash command must be replaced')
  assert.equal(await page.locator('.md-slash-menu:visible').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.f.notices), [])
  assert.equal(await page.locator('.md-prose table').count(), 1)
  assert.equal(await page.locator('.md-prose table tr').count(), rows)
  assert.equal(await page.locator('.md-prose:focus').count(), 1)
}

try {
  await page.goto('http://127.0.0.1:1477/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  for (const [rows, columns] of [[2, 4], [1, 1], [6, 6]]) {
    await openPicker('click')
    const point = await hoverCell(rows, columns)
    // Use the physical pointer sequence so a detached hover target cannot be retried away.
    await page.mouse.click(point.x, point.y)
    await checkTable(rows, columns)
    console.log(`PASS click creates ${rows} x ${columns} table`)
  }
  await openPicker()
  await page.keyboard.press('Enter')
  await checkTable(3, 3)
  console.log('PASS Enter creates default table')

  await openPicker()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await checkTable(2, 4)
  console.log('PASS arrow keys and Enter create selected dimensions')

  await openPicker()
  await hoverCell(2, 4)
  await page.keyboard.press('Enter')
  await checkTable(2, 4)
  console.log('PASS hover and Enter create selected dimensions')

  await openPicker()
  await hoverCell(2, 4)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.md-slash-menu:visible').count(), 0)
  assert.equal(await page.evaluate(() => window.f.manager.getText(window.f.id)), '/table\n\nAfter.\n')
  console.log('PASS Escape cancels without inserting a table')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
