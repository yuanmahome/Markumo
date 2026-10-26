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

  // Fence completion must create a focused, editable block in the same action.
  for (const scenario of [
    { opening: '```java', language: 'java' },
    { opening: '```', language: '' },
    { opening: '~~~java', language: 'java' },
    { opening: '```js', language: 'js' },
    { opening: '```customlang', language: 'customlang', hidden: true },
    { opening: '```jav', language: 'java', action: 'Tab' },
    { opening: '```jav', language: 'java', action: 'ArrowDown' },
    { opening: '```jav', language: 'java', action: 'click' },
    { opening: '```java', language: 'java', action: 'Escape' },
  ]) {
    await page.evaluate(() => window.f.reset('Before.\n\nStart\n\nAfter.\n'))
    await page.waitForFunction(() => window.f.ready())
    await page.evaluate(() => window.f.caret('Start'))
    await page.keyboard.press('Shift+End')
    await page.keyboard.type(scenario.opening)
    const popup = page.locator('.md-fence-autocomplete')
    if (scenario.hidden) await popup.waitFor({ state: 'hidden' })
    else await popup.waitFor({ state: 'visible' })
    if (scenario.action === 'click') {
      await popup.getByRole('option', { name: 'Java', exact: true }).click()
    } else {
      if (scenario.action) await page.keyboard.press(scenario.action)
      if (scenario.action === 'Tab') {
        assert.equal(await page.locator('.md-code-block').count(), 0, 'Tab only completes the language')
        assert.equal(await page.locator('.md-prose > p').nth(1).innerText(), '```java')
      }
      await page.keyboard.press('Enter')
    }
    const label = `${scenario.opening} (${scenario.action || 'Enter'})`
    await page.waitForFunction(() => !!document.querySelector('.md-code-block .cm-content:focus'), null, { timeout: 3000 })
    assert.equal(await page.locator('.md-code-block').count(), 1, label)
    assert.equal(await popup.isVisible(), false, label)
    assert.deepEqual(await page.evaluate(() => {
      const editor = window.f.live()
      const block = editor.view.state.doc.child(1)
      return { type: block.type.name, language: block.attrs.params, text: block.textContent }
    }), { type: 'code_block', language: scenario.language, text: '' }, label)
    await page.keyboard.type('hello')
    const fence = scenario.opening.startsWith('~~~') ? '~~~' : '```'
    assert.equal(await page.evaluate(() => window.f.manager.getText(window.f.id)),
      `Before.\n\n${fence}${scenario.language}\nhello\n${fence}\n\nAfter.\n`, label)
    assert.deepEqual(await page.evaluate(() => window.f.notices), [], label)
  }
  console.log('PASS: fence Enter, Tab, arrow selection, click, and dismissed suggestions create editable code blocks')

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
