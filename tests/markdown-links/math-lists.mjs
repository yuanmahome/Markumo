import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 1468, strictPort: true, hmr: false, watch: null } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const keepGoing = process.argv.includes('--keep-going')
const failures = []
const settle = () => page.waitForTimeout(100)
const source = () => page.evaluate(() => window.f.snapshot().source)
async function reset(text) {
  await page.evaluate(text => window.f.reset(text), text)
  await page.waitForFunction(() => window.f.ready())
  await page.locator('.md-prose').click()
}
async function test(name, work) {
  try { await work(); console.log('PASS', name) }
  catch (error) { failures.push(name); console.error('FAIL', name, error.message); if (!keepGoing) throw error }
}
async function consistent() {
  const result = await page.evaluate(async () => {
    const { parseMarkdown, sameBlockSemantics } = await import('/src/editor/markdown/wysiwyg/MarkdownParser.ts')
    const { withoutTrailingParagraph } = await import('/src/editor/markdown/wysiwyg/TrailingParagraph.ts')
    const e = window.f.live()
    const { extractOutline } = await import('/src/editor/outline/outlineService.ts')
    const outline = extractOutline(window.f.manager.metadata(window.f.id), window.f.manager.getState(window.f.id))
    const headings = []
    e.view.state.doc.descendants(node => { if (node.type.name === 'heading') headings.push(node.textContent) })
    return { same: !e.bridge.source || sameBlockSemantics(withoutTrailingParagraph(e.view.state.doc), parseMarkdown(e.bridge.source).doc),
      outline: outline.map(item => item.name), headings,
      source: e.bridge.source, doc: e.view.state.doc.toJSON(), parsed: parseMarkdown(e.bridge.source).doc.toJSON(), canonical: window.f.snapshot().source }
  })
  assert.equal(result.source, result.canonical)
  assert.equal(result.same, true, JSON.stringify(result))
  assert.deepEqual(result.outline, result.headings)
}
try {
  await page.goto('http://127.0.0.1:1468/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  await test('type bracket math line by line without accumulating escapes', async () => {
    await reset('')
    await page.keyboard.type(String.raw`\[`); await page.keyboard.press('Enter'); await settle()
    assert.equal(await page.locator('.md-math-source:visible').count(), 1)
    await page.keyboard.type(String.raw`N=\lceil 5000/1260\rceil=4`)
    await settle()
    assert.equal(await source(), String.raw`\[
N=\lceil 5000/1260\rceil=4
\]`)
    await page.keyboard.press('Enter'); await page.keyboard.type(String.raw`\]`); await settle()
    assert.equal(await source(), String.raw`\[
N=\lceil 5000/1260\rceil=4
\]`)
    await consistent()
  })
  await test('Typora layout: delimiters, empty preview, finish button and inline preview bubble', async () => {
    fs.mkdirSync('test-results/math-lists', { recursive: true })
    await page.evaluate(() => document.body.classList.add('light'))
    await reset(''); await page.keyboard.type('$$'); await page.keyboard.press('Enter'); await settle()
    await page.locator('.md-math-empty').waitFor()
    assert.deepEqual(await page.locator('.md-math-delimiter').allTextContents(), ['$$', '$$'])
    assert.equal(await page.locator('.md-math-source').inputValue(), '')
    assert.equal(await page.locator('.md-math-source').evaluate(el => document.activeElement === el), true)
    const captureBlock = async name => {
      const box = await page.locator('.md-math-output').boundingBox()
      await page.screenshot({ path: `test-results/math-lists/${name}.png`, clip: { x: box.x, y: box.y - 22, width: box.width, height: box.height + 22 } })
    }
    await captureBlock('typora-empty')
    await page.keyboard.type(String.raw`N=\lceil 5000/1260\rceil=4`)
    await page.locator('.md-math-preview .katex').waitFor()
    await captureBlock('typora-block')
    await page.getByRole('button', { name: '完成公式编辑' }).click()
    assert.equal(await page.locator('.md-math-source:visible').count(), 0)
    await page.locator('.md-math-preview').click(); assert.equal(await page.locator('.md-math-source:visible').count(), 1)
    await reset('需要服务器数量：')
    await page.keyboard.press('End'); await page.keyboard.type(String.raw` \[ N=\lceil 5000/1260\rceil=4 \]`); await settle()
    assert.equal(await page.locator('.md-inline-math .md-math-source:visible').count(), 1)
    await page.locator('.md-inline-math .katex').waitFor()
    assert.equal(await page.locator('.md-inline-math .md-math-preview').evaluate(el => getComputedStyle(el).position), 'absolute')
    assert.equal(await source(), String.raw`需要服务器数量： \[ N=\lceil 5000/1260\rceil=4 \]`)
    await consistent()
    const box = await page.locator('.md-prose p').first().boundingBox()
    const bubble = await page.locator('.md-inline-math .md-math-preview').boundingBox()
    await page.screenshot({ path: 'test-results/math-lists/typora-inline.png', clip: { x: box.x, y: box.y, width: box.width, height: bubble.y + bubble.height - box.y + 8 } })
    await page.evaluate(() => document.body.classList.remove('light'))
  })
  await test('complete bracket formula typed on one line retains its delimiters across modes', async () => {
    await reset('')
    const raw = String.raw`\[ N=\lceil 5000/1260\rceil=4 \]`
    await page.keyboard.type(raw); await settle()
    assert.equal(await source(), raw)
    assert.equal(await page.locator('.md-math-output .md-math-source:visible').count(), 1)
    await consistent()
    for (const mode of ['source', 'split', 'live']) { await page.evaluate(mode => window.f.mode(mode), mode); await settle() }
    assert.equal(await source(), raw); await consistent()
  })
  await test('create list and bold Chinese using keyboard before heading undo', async () => {
    await reset('')
    await page.keyboard.type('- '); await page.keyboard.insertText('中文文字')
    await settle()
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift'); await settle()
    await page.keyboard.press('Control+b'); await settle()
    assert.equal(await source(), '- **中文文字**')
    await page.keyboard.press('Control+2'); await settle()
    await consistent()
    await page.keyboard.press('Control+z'); await settle()
    assert.equal(await source(), '- **中文文字**'); await consistent()
    await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await settle()
    assert.equal(await page.locator('.md-prose ul ul').count(), 1)
    await consistent()
    assert.equal(await page.locator('.md-prose h2').count(), 0)
    const nested = await source()
    for (const mode of ['split', 'live']) { await page.evaluate(mode => window.f.mode(mode), mode); await settle() }
    assert.equal(await source(), nested); await consistent()
    assert.equal(await page.locator('.md-prose ul ul').count(), 1)
    fs.mkdirSync('test-results/math-lists', { recursive: true })
    fs.writeFileSync('test-results/math-lists/nested.md', nested)
    await reset(fs.readFileSync('test-results/math-lists/nested.md', 'utf8')); await consistent()
    assert.equal(await page.locator('.md-prose ul ul').count(), 1)
  })
  await test('list heading undo, empty nested item and mode roundtrip', async () => {
    await reset('- **中文**\n')
    await page.evaluate(() => window.f.caret('中文')); await page.keyboard.press('End')
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Control+2'); await settle()
    await consistent()
    await page.keyboard.press('Control+z'); await settle()
    await consistent()
    await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await settle()
    await consistent()
    assert.equal(await page.locator('.md-prose h2').count(), 0)
    await page.keyboard.type('二级'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Control+0'); await settle()
    await consistent()
    const before = await source()
    for (const mode of ['split', 'live']) { await page.evaluate(mode => window.f.mode(mode), mode); await settle() }
    assert.equal(await source(), before); await consistent()
    await reset(before); assert.equal(await source(), before); await consistent()
  })
  await test('four math delimiters preserve original bytes', async () => {
    const text = String.raw`中文 $a+b$ 和 \(x+1\)

\[
1800 \times 70\% = 1260
\]

$$
N=\lceil 5000/1260\rceil=4
$$`
    await reset(text)
    assert.equal(await page.locator('.md-inline-math').count(), 2)
    assert.equal(await page.locator('.md-math-output').count(), 2)
    assert.equal(await source(), text); await consistent()
  })
  await test('typed inline math does not become escaped currency', async () => {
    await reset('Start\n'); await page.keyboard.press('End'); await page.keyboard.type(' $a+b$'); await settle()
    assert.match(await source(), / \$a\+b\$/)
    assert.equal(await page.locator('.md-inline-math').count(), 1)
    await consistent()
  })
  await test('dollar Enter creates focused empty formula and Backspace deletes it', async () => {
    await reset(''); await page.keyboard.type('$$'); await page.keyboard.press('Enter'); await settle()
    const input = page.locator('.md-math-source')
    assert.equal(await input.count(), 1); await input.waitFor({ state: 'visible' })
    assert.equal(await input.inputValue(), ''); await input.press('a'); await input.press('Backspace'); await input.press('Backspace'); await settle()
    assert.equal(await page.locator('.md-math-source').count(), 0)
    assert.doesNotMatch(await source(), /\$\$/); await consistent()
    await page.keyboard.press('Control+z'); await settle()
    assert.equal(await page.locator('.md-math-source').count(), 1)
  })
  await test('typed backslash inline formula and explicit escaped dollar', async () => {
    await reset('Start'); await page.keyboard.press('End'); await page.keyboard.type(String.raw` \(x+1\)`); await settle()
    assert.match(await source(), /\\\(x\+1\\\)/); assert.equal(await page.locator('.md-inline-math').count(), 1)
    await consistent()
    const text = String.raw`价格 \$5 和 $10 或 $20，未完成 $x。字面 \[ 和 \(。` + '\n\n`$code$`\n\n```latex\n\\[ x \\]\n$$x$$\n```'
    await reset(text); assert.equal(await page.locator('.md-inline-math,.md-math-output').count(), 0)
    assert.equal(await source(), text)
  })
  await test('clipboard paste recognizes both backslash math forms without escaping', async () => {
    for (const formula of [String.raw`\(a+b\)`, String.raw`\[
N=\lceil 5000/1260\rceil=4
\]`]) {
      await reset('Start'); await page.keyboard.press('End'); await page.keyboard.press('Enter')
      await page.locator('.md-prose').evaluate((el, text) => {
        const data = new DataTransfer(); data.setData('text/plain', text)
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
      }, formula); await settle()
      assert.equal(await page.locator('.md-inline-math,.md-math-output').count(), 1)
      assert.equal((await source()).includes(formula), true); await consistent()
    }
  })
  await test('automatic formula creation is one undo step and prose dollars do not trigger it', async () => {
    await reset(''); await page.keyboard.type('$$'); await settle()
    const before = await source()
    await page.keyboard.press('Enter'); await settle()
    await page.locator('.md-math-source').press('Control+z'); await settle()
    assert.equal(await source(), before)
    await page.keyboard.press('Control+y'); await settle()
    assert.equal(await page.locator('.md-math-output').count(), 1)
    await reset('正文 $$'); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await settle()
    assert.equal(await page.locator('.md-math-output').count(), 0)
  })
  await test('formula body edits preserve CRLF and delimiter spelling, textarea survives IME', async () => {
    for (const [opening, closing] of [['$$', '$$'], [String.raw`\[`, String.raw`\]`]]) {
      const original = `正文\r\n\r\n${opening}\r\nx\r\n${closing}\r\n\r\n尾部`
      await reset(original); await page.locator('.md-math-output').click()
      const input = page.locator('.md-math-source')
      await input.press('Control+a'); await input.press('a'); await input.press('b'); await settle()
      // CodeMirror's canonical Text uses LF; disk serialization restores EOL.
      assert.equal(await source(), original.replace('\r\nx\r\n', '\r\nab\r\n').replaceAll('\r\n', '\n'))
      assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), original.replace('\r\nx\r\n', '\r\nab\r\n'))
      await input.evaluate(el => {
        window.mathInput = el
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        el.value += '+中文'
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      }); await settle()
      assert.equal(await input.evaluate(el => el === window.mathInput && document.activeElement === el), true)
      assert.match(await source(), /ab\+中文/); await consistent()
      await input.press('Control+z'); await settle(); await input.press('Control+y'); await settle()
      assert.match(await source(), /ab\+中文/)
      await input.press('Escape'); await page.locator('.md-math-output').click(); assert.equal(await input.inputValue(), 'ab+中文')
    }
  })
  await test('inline edits only replace LaTeX body', async () => {
    const original = String.raw`前文  \(x\)  &amp; 后文`
    await reset(original); await page.locator('.md-inline-math').click()
    await page.locator('.md-math-source').press('y'); await settle()
    assert.equal(await source(), original.replace('(x', '(xy')); await consistent()
  })
  await test('clearing inline math removes its atom without leaving an ambiguous dollar pair', async () => {
    await reset('前文 $x$ 后文')
    await page.locator('.md-inline-math').click()
    await page.locator('.md-math-source').press('Control+a'); await page.keyboard.press('Backspace'); await settle()
    assert.equal(await source(), '前文  后文'); await consistent()
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await source(), '前文 $x$ 后文')
  })
  await test('create formula inside a list without losing list structure', async () => {
    await reset('- '); await page.keyboard.type('$$'); await page.keyboard.press('Enter'); await settle()
    assert.equal(await page.locator('.md-prose li .md-math-output').count(), 1)
    await page.locator('.md-math-source').press('x'); await settle(); await consistent()
  })
  for (const [key, caret] of [['Backspace', 'After'], ['Delete', 'Before']]) await test(`${key} deletes adjacent block formula with undo/redo`, async () => {
    await reset('Before\n\n$$\nx\n$$\n\nAfter')
    await page.evaluate(text => window.f.caret(text), caret)
    if (key === 'Delete') await page.keyboard.press('End')
    await page.keyboard.press(key); await settle()
    assert.equal(await page.locator('.md-math-output').count(), 0); assert.doesNotMatch(await source(), /\$\$/); await consistent()
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await page.locator('.md-math-output').count(), 1)
    await page.keyboard.press('Control+y'); await settle(); assert.equal(await page.locator('.md-math-output').count(), 0)
  })
  await test('context menu deletes formula', async () => {
    await reset('$$\nx\n$$'); await page.locator('.md-math-output').click({ button: 'right' })
    await page.getByText('删除公式', { exact: true }).click(); await settle()
    assert.equal(await source(), ''); await consistent()
  })
  await test('node selection Delete removes formula and synchronizes another pane', async () => {
    await reset('Before\n\n$$\nx\n$$\n\nAfter')
    await page.evaluate(() => {
      window.f.split()
      window.f.selectMath()
    })
    await page.keyboard.press('Delete'); await settle()
    assert.equal(await page.locator('.md-math-output').count(), 0); await consistent()
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await page.locator('.md-math-output').count(), 2)
  })
  await test('formula headings stay outside outline and an invalid command cannot break export', async () => {
    await reset('# 标题\n\n\\[\n# math only\n\\]\n\n尾部 $\\notAValidCommand$ 和 $x$')
    await consistent()
    const result = await page.evaluate(async text => {
      const { renderMarkdownForExport } = await import('/src/features/document-conversion/ExportRenderer.ts')
      return renderMarkdownForExport(text)
    }, await source())
    assert.equal(result.warnings.length, 2) // '#' in display math and an unknown command
    assert.match(result.warnings.map(w => w.message).join(' '), /notAValidCommand/)
    assert.match(result.bodyHtml, /class="katex"/)
  })
  await test('shared parser drives preview, source highlighting, HTML and DOCX exports', async () => {
    const text = String.raw`# 正文

$a$ 和 \(b\)

\[
1800 \times 70\% = 1260
\]

$$
N=\lceil 5000/1260\rceil=4
$$`
    await reset(text); await consistent()
    await page.evaluate(() => window.f.mode('split')); await settle()
    assert.equal(await page.locator('.cm-content [data-math-source]').count() >= 4, true)
    await page.waitForFunction(() => document.querySelectorAll('.split-preview-content .katex').length === 4)
    const exported = await page.evaluate(async text => {
      const { renderMarkdownForExport } = await import('/src/features/document-conversion/ExportRenderer.ts')
      const { exportMarkdownToNativeDocx } = await import('/src/features/document-conversion/nativeDocxExport.ts')
      const { renderExportMath } = await import('/src/features/document-conversion/ExportMath.ts')
      const { buildCompleteHtml } = await import('/src/features/document-conversion/ExportStyles.ts')
      const html = await renderMarkdownForExport(text)
      const docx = await exportMarkdownToNativeDocx(text, { renderMath: renderExportMath })
      return { html: buildCompleteHtml('公式回归', html.bodyHtml, true), warnings: [...html.warnings, ...docx.warnings], images: docx.stats.images, bytes: Array.from(docx.bytes) }
    }, text)
    assert.equal((exported.html.match(/class="katex"/g) || []).length, 4)
    assert.equal(exported.images, 4); assert.deepEqual(exported.warnings, [])
    fs.writeFileSync('test-results/math-lists/math.docx', Buffer.from(exported.bytes))
    fs.writeFileSync('test-results/math-lists/math.html', exported.html)
    await page.setContent(exported.html); await page.evaluate(() => document.fonts.ready)
    await page.pdf({ path: 'test-results/math-lists/math.pdf' })
    await page.screenshot({ path: 'test-results/math-lists/math.png', fullPage: true })
  })
} finally { await browser.close(); await server.close() }
if (failures.length) process.exitCode = 1
