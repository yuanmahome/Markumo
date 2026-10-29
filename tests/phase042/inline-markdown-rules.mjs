import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1495, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-inline-markdown-rules',
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))

async function reset(source) {
  await page.evaluate(s => window.f.reset(s), source)
  await page.waitForFunction(() => window.f.ready())
}

try {
  await page.goto('http://127.0.0.1:1495/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  // 1. 分割线输入规则：空行输入 --- 生成水平分割线，源码不带反斜杠转义
  await reset('')
  await page.locator('.md-prose').click()
  await page.keyboard.type('---')
  await page.waitForTimeout(50)
  assert.equal(await page.locator('.md-prose hr').count(), 1, '--- should generate horizontal rule')
  assert.equal((await page.evaluate(() => window.f.manager.getText(window.f.id))).trim(), '---')
  console.log('PASS 1: typing --- generates horizontal rule')

  // 2. 分割线输入规则：空行输入 ***加空格 或 ___加空格 生成水平分割线
  for (const trigger of ['*** ', '___ ']) {
    await reset('')
    await page.locator('.md-prose').click()
    await page.keyboard.type(trigger)
    await page.waitForTimeout(50)
    assert.equal(await page.locator('.md-prose hr').count(), 1, `${trigger} should generate horizontal rule`)
    assert.equal((await page.evaluate(() => window.f.manager.getText(window.f.id))).trim(), '---')
  }
  console.log('PASS 2: typing *** and ___ with trailing space generates horizontal rule')

  // 3. 粗斜体输入规则：输入 ***kdsa*** 和 ___kdsa___ 即时渲染为粗体+斜体
  for (const input of ['***kdsa***', '___kdsa___']) {
    await reset('Start\n\nEND\n')
    await page.evaluate(() => window.f.caret('Start'))
    await page.keyboard.press('Shift+End')
    await page.keyboard.type(input)
    await page.waitForTimeout(50)
    const strong = await page.locator('.md-prose strong').allInnerTexts()
    const em = await page.locator('.md-prose em').allInnerTexts()
    assert(strong.includes('kdsa'), `kdsa must be strong for ${input}`)
    assert(em.includes('kdsa'), `kdsa must be em for ${input}`)
    const src = await page.evaluate(() => window.f.manager.getText(window.f.id))
    assert(src.includes(input), `Source must contain exact ${input} without backslash escapes`)
  }
  console.log('PASS 3: typing ***kdsa*** and ___kdsa___ produces bold+italic with exact source')

  // 4. 点击粗斜体文本时，行内源码展开完整显示所有 3 个星号 ***kdsa***，绝不只显示 2 个星号
  await reset('提升。 ***kdsa***')
  const kdsaEl = page.locator('.md-prose strong, .md-prose em').first()
  await kdsaEl.click()
  const inputEl = page.locator('.md-inline-source-input')
  await inputEl.waitFor()
  const inlineRaw = await inputEl.innerText()
  assert.equal(inlineRaw, '***kdsa***', 'Inline source editor must show all 3 asterisks ***kdsa***')
  console.log('PASS 4: InlineSourceView on ***kdsa*** displays all 3 asterisks')

  // 5. 粗体输入规则：**bold** 与 __bold__
  for (const input of ['**bold**', '__bold__']) {
    await reset('Start\n\nEND\n')
    await page.evaluate(() => window.f.caret('Start'))
    await page.keyboard.press('Shift+End')
    await page.keyboard.type(input)
    await page.waitForTimeout(50)
    const strong = await page.locator('.md-prose strong').allInnerTexts()
    assert(strong.includes('bold'), `${input} produces bold text`)
    const src = await page.evaluate(() => window.f.manager.getText(window.f.id))
    assert(src.includes(input), `Source contains ${input}`)
  }
  console.log('PASS 5: typing **bold** and __bold__ produces strong')

  // 6. 斜体输入规则：*italic* 与 _italic_
  for (const input of ['*italic*', '_italic_']) {
    await reset('Start\n\nEND\n')
    await page.evaluate(() => window.f.caret('Start'))
    await page.keyboard.press('Shift+End')
    await page.keyboard.type(input)
    await page.waitForTimeout(50)
    const em = await page.locator('.md-prose em').allInnerTexts()
    assert(em.includes('italic'), `${input} produces italic text`)
    const src = await page.evaluate(() => window.f.manager.getText(window.f.id))
    assert(src.includes(input), `Source contains ${input}`)
  }
  console.log('PASS 6: typing *italic* and _italic_ produces em')

  // 7. 删除线输入规则：~~strike~~
  await reset('Start\n\nEND\n')
  await page.evaluate(() => window.f.caret('Start'))
  await page.keyboard.press('Shift+End')
  await page.keyboard.type('~~strike~~')
  await page.waitForTimeout(50)
  const strike = await page.locator('.md-prose s').allInnerTexts()
  assert(strike.includes('strike'), '~~strike~~ produces strikethrough')
  const srcStrike = await page.evaluate(() => window.f.manager.getText(window.f.id))
  assert(srcStrike.includes('~~strike~~'), 'Source contains ~~strike~~')
  console.log('PASS 7: typing ~~strike~~ produces strikethrough')

  // 8. 行内代码输入规则：`code`
  await reset('Start\n\nEND\n')
  await page.evaluate(() => window.f.caret('Start'))
  await page.keyboard.press('Shift+End')
  await page.keyboard.type('`code`')
  await page.waitForTimeout(50)
  const code = await page.locator('.md-prose code').allInnerTexts()
  assert(code.includes('code'), '`code` produces inline code')
  const srcCode = await page.evaluate(() => window.f.manager.getText(window.f.id))
  assert(srcCode.includes('`code`'), 'Source contains `code`')
  console.log('PASS 8: typing `code` produces inline code')

  assert.deepEqual(errors, [])
  console.log('\n=== ALL INLINE MARKDOWN RULES & HR TESTS PASSED ===\n')
} finally {
  await browser.close()
  await server.close()
}
