import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1476, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-phase042-cb',
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))

try {
  await page.goto('http://127.0.0.1:1476/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  const doc200 =
    '# 200 Blocks Browser Smoke\n\nIntro paragraph.\n\n' +
    Array.from(
      { length: 200 },
      (_, i) => `\`\`\`javascript\nfunction run_${i}(v) {\n  return v + ${i};\n}\n\`\`\`\n\n`
    ).join('')

  await page.evaluate(src => window.f.reset(src), doc200)
  await page.waitForFunction(() => window.f.ready() && document.querySelectorAll('.markdown-live .md-code-block').length === 200)
  await new Promise(r => setTimeout(r, 250))

  // 1. 200 blocks idle -> 0 embedded CM editors in DOM
  assert.equal(await page.locator('.md-code-block .cm-editor').count(), 0)

  // 2. Click block #0 -> mounts 1 CM editor, type & leave -> releases back to 0 CM
  await page.locator('.md-code-block').first().locator('.md-code-placeholder').click({ position: { x: 40, y: 16 } })
  assert.equal(await page.locator('.md-code-block .cm-editor').count(), 1)
  await page.keyboard.type('/*BROWSER_EDIT*/')
  await page.locator('.markdown-live .md-prose > p').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.md-code-block .cm-editor').length === 0)
  assert(await page.evaluate(() => window.f.manager.getText(window.f.id).includes('/*BROWSER_EDIT*/')))

  // 3. Read-only mode blocks typing inside embedded CM
  await page.evaluate(src => window.f.reset(src, true), '# ReadOnly\n\n```js\nconst fixed = 1;\n```\n')
  await page.waitForFunction(() => window.f.ready())
  const beforeRo = await page.evaluate(() => window.f.manager.getText(window.f.id))
  await page.locator('.md-code-block .md-code-placeholder').click({ position: { x: 25, y: 14 } })
  await page.keyboard.type('MUTATION')
  const afterRo = await page.evaluate(() => window.f.manager.getText(window.f.id))
  assert.equal(afterRo, beforeRo, 'Read-only code block must reject edits')

  assert.deepEqual(errors, [])
  console.log('PASS: code-block browser display/edit separation & read-only checks')
} finally {
  await browser.close()
  await server.close()
}
