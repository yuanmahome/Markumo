import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(
  process.env.MARKUMO_PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.MARKUMO_PLAYWRIGHT_MODULE).href
    : 'playwright'
)

const output = 'test-results/math-editor'
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(
  `${output}/index.html`,
  '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="app" style="display:flex;height:720px"></div><script type="module" src="./fixture.js"></script>'
)
fs.writeFileSync(
  `${output}/fixture.js`,
  `import '/scripts/fixtures/markdown-live-controller.js';
import * as Vue from 'vue';
import EditorPaneItem from '/src/components/layout/EditorPaneItem.vue';
import TreeNodeItem from '/src/components/layout/TreeNodeItem.vue';
window.Vue = Vue;
window.EditorPaneItem = EditorPaneItem;
window.TreeNodeItem = TreeNodeItem;`
)

const server = await createServer({
  server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null },
})
await server.listen()

function findSystemBrowser() {
  if (process.env.MARKUMO_CHROME && fs.existsSync(process.env.MARKUMO_CHROME)) {
    return process.env.MARKUMO_CHROME
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return undefined
}

let browser, page, browserVersion
const results = []
const failures = []

const test = async (name, work) => {
  try {
    await work()
    results.push(name)
    console.log('PASS ' + name)
  } catch (error) {
    failures.push({ name, error: String(error), stack: error.stack })
    console.error('FAIL ' + name + '\n' + error.stack)
    throw error
  }
}

const ready = () => page.waitForFunction(() => window.f && window.f.ready())
const reset = async (text, clean = false, readOnly = false) => {
  await page.evaluate(
    ({ text, clean, readOnly }) => window.f.reset(text, clean, readOnly),
    { text, clean, readOnly }
  )
  await ready()
  await page.locator('.md-prose').first().waitFor()
}

const source = () => page.evaluate(() => window.f.source())
const inputState = locator => locator.evaluate(el => ({
  active: document.activeElement === el, value: el.value,
  start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection,
}))
const openBlock = async text => {
  await reset(`$$\n${text}\n$$`, true)
  await page.locator('.md-math-output').click()
  const input = page.locator('[data-pane="main"] .md-math-source')
  await page.waitForFunction(() => document.activeElement?.matches('.md-math-source'))
  return input
}
const remoteMath = async (value, pane = 'main') => {
  await page.evaluate(({ value, pane }) => {
    const { node, pos } = window.f.node('protected_source', 0, pane)
    const view = window.f.live(pane).view
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: `$$\n${value}\n$$` }))
  }, { value, pane })
  await ready()
}
// Event-order coverage only: OS IME integration is reported separately. CDP
// supplies the composition text through Chromium's native editing machinery.
const beginComposition = async (input, text) => {
  await input.evaluate(el => {
    window.mathEventTrace = []
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) el.addEventListener(type, event => window.mathEventTrace.push({ type, value: el.value, composing: event.isComposing }))
  })
  const session = await page.context().newCDPSession(page)
  await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  assert.equal((await inputState(input)).active, true)
  return session
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: findSystemBrowser(),
    args: ['--no-sandbox'],
  })
  browserVersion = browser.version()
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  page.setDefaultTimeout(15000)

  await page.goto(`${server.resolvedUrls.local[0]}${output}/index.html`)
  await page.waitForFunction(() => window.f)

  // 1. 块级公式 $$...$$ 编辑及光标可见性（兼容光标动画开启与关闭）
  await test('1. block math editing and caret visibility with smooth caret on/off', async () => {
    await reset('$$\nx^2\n$$', true)
    await page.evaluate(() => window.f.manager.setCaretAnimation('smooth'))
    await page.locator('.md-math-output').click()
    const textarea = page.locator('.md-math-source')
    await textarea.waitFor({ state: 'visible' })

    // Verify caret-color is not transparent when smooth caret is on
    await page.evaluate(() => {
      document.querySelector('.md-prose')?.classList.add('smooth-caret-active')
    })
    const caretColorSmooth = await textarea.evaluate(el => window.getComputedStyle(el).caretColor)
    assert.notEqual(caretColorSmooth, 'rgba(0, 0, 0, 0)', 'Caret must be visible with smooth caret active')
    assert.notEqual(caretColorSmooth, 'transparent', 'Caret must not be transparent')

    // Verify caret-color with smooth caret off
    await page.evaluate(() => {
      document.querySelector('.md-prose')?.classList.remove('smooth-caret-active')
      window.f.manager.setCaretAnimation('off')
    })
    const caretColorOff = await textarea.evaluate(el => window.getComputedStyle(el).caretColor)
    assert.notEqual(caretColorOff, 'rgba(0, 0, 0, 0)', 'Caret must be visible with smooth caret off')
  })

  // 2. 行内公式 $...$ 编辑与回车提交
  await test('2. inline math editing and Enter commit', async () => {
    await reset('Prefix $a+b$ suffix', true)
    await page.locator('.md-inline-math').click()
    const inlineInput = page.locator('.md-inline-math .md-math-source')
    await inlineInput.waitFor({ state: 'visible' })

    const inlineCaret = await inlineInput.evaluate(el => window.getComputedStyle(el).caretColor)
    assert.notEqual(inlineCaret, 'rgba(0, 0, 0, 0)', 'Inline math caret must be visible')

    // Type text into inline math
    await inlineInput.type('+c')
    await page.waitForTimeout(50)
    assert.equal(await inlineInput.isVisible(), true, 'Inline input should remain visible while editing')

    // Press Enter to complete inline math
    await page.keyboard.press('Enter')
    await ready()
    assert.equal(await inlineInput.isHidden(), true, 'Inline input should close on Enter')
    const src = await source()
    assert.ok(src.includes('$a+b+c$'), `Source should contain updated inline math: ${src}`)
  })

  // 3. 点击公式源码区任意位置，能够准确定位光标
  await test('3. click positioning inside math textarea', async () => {
    await reset('$$\n\\frac{1}{2} + \\sqrt{x}\n$$', true)
    await page.locator('.md-math-output').click()
    const textarea = page.locator('.md-math-source')
    await textarea.waitFor({ state: 'visible' })

    // Click near start
    const box = await textarea.boundingBox()
    assert.ok(box, 'Textarea bounding box must exist')
    await page.mouse.click(box.x + 8, box.y + 12)
    const posStart = await textarea.evaluate(el => el.selectionStart)
    assert.ok(posStart < 3, `Cursor near start should be small offset, got: ${posStart}`)

    // Click near end
    await page.mouse.click(box.x + 180, box.y + 12)
    const posEnd = await textarea.evaluate(el => el.selectionStart)
    assert.ok(posEnd > 5, `Cursor near end should be larger offset, got: ${posEnd}`)
  })

  // 4. 鼠标从左向右、从右向左拖动选区，双击选词，Shift 选择
  await test('4. mouse selection: left-to-right, right-to-left, double-click, Shift+Arrow', async () => {
    await reset('$$\nalpha beta gamma\n$$', true)
    await page.locator('.md-math-output').click()
    const textarea = page.locator('.md-math-source')
    await textarea.waitFor({ state: 'visible' })
    const box = await textarea.boundingBox()
    assert.ok(box)

    // Left to right drag
    await page.mouse.move(box.x + 8, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + 50, box.y + 12, { steps: 5 })
    await page.mouse.up()
    let sel = await textarea.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd }))
    assert.ok(sel.end > sel.start, 'Left-to-right drag should select text')

    // Right to left drag
    await page.keyboard.press('End')
    await page.mouse.move(box.x + 50, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + 8, box.y + 12, { steps: 5 })
    await page.mouse.up()
    sel = await inputState(textarea)
    assert.ok(sel.end > sel.start, 'Right-to-left drag should select text')
    assert.equal(sel.direction, 'backward', 'Native reverse drag must retain its direction')

    // Double-click word
    await page.mouse.dblclick(box.x + 15, box.y + 12)
    sel = await textarea.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd }))
    assert.ok(sel.end > sel.start, 'Double-click should select word')

    await page.mouse.click(box.x + 15, box.y + 12, { clickCount: 3 })
    sel = await inputState(textarea)
    assert.equal(sel.start, 0)
    assert.equal(sel.end, 'alpha beta gamma'.length)

    // Shift+Arrow selection
    await page.keyboard.press('Home')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    sel = await textarea.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd }))
    assert.equal(sel.start, 0)
    assert.equal(sel.end, 3)
  })

  // 5. 首尾空格及换行输入不会意外关闭编辑
  await test('5. spaces, newlines, and backslashes do not exit edit mode', async () => {
    await reset('$$\nx\n$$', true)
    await page.locator('.md-math-output').click()
    const textarea = page.locator('.md-math-source')
    await textarea.waitFor({ state: 'visible' })

    // Type spaces at end
    await textarea.type('   ')
    await page.waitForTimeout(50)
    assert.equal(await textarea.isVisible(), true, 'Textarea must not close when typing spaces')

    // Type newline (Enter in display mode)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(50)
    assert.equal(await textarea.isVisible(), true, 'Textarea must not close on Enter in display mode')

    // Type backslash and commands
    await textarea.type('\\frac{1}{2}')
    await page.waitForTimeout(50)
    assert.equal(await textarea.isVisible(), true, 'Textarea must not close on backslash')

    const src = await source()
    assert.ok(src.includes('\\frac{1}{2}'), `Source should include fraction: ${src}`)
  })

  // 6. 多行粘贴及撤销/重做
  await test('6. multiline paste and undo/redo within math editor', async () => {
    await reset('$$\ninitial\n$$', true)
    await page.locator('.md-math-output').click()
    const textarea = page.locator('.md-math-source')
    await textarea.waitFor({ state: 'visible' })

    // Select all and replace with multiline paste
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('line1\nline2\nline3')
    await ready()
    let src = await source()
    assert.ok(src.includes('line1\nline2\nline3'), `Source should contain multiline: ${src}`)

    // Undo
    await page.keyboard.press('Control+z')
    await ready()
    src = await source()
    assert.ok(src.includes('initial'), `Undo should restore initial text: ${src}`)

    // Redo
    await page.keyboard.press('Control+y')
    await ready()
    src = await source()
    assert.ok(src.includes('line1\nline2\nline3'), `Redo should restore multiline: ${src}`)
  })

  // 7. 拖拽隔离：原生 textarea 文本拖放不受 Pane 自定义拖拽拦截
  await test('7. drag-and-drop isolation: text drag vs tab drag types in EditorPaneItem', async () => {
    const dragResult = await page.evaluate(async () => {
      const { createApp, h } = window.Vue
      const EditorPaneItem = window.EditorPaneItem
      const container = document.createElement('div')
      document.body.append(container)
      const app = createApp({
        render() {
          return h(EditorPaneItem, {
            manager: window.f.manager,
            paneId: 'main',
            revision: 0,
            desktop: false,
          })
        },
      })
      app.mount(container)
      const paneEl = container.querySelector('[data-pane-id="main"]')
      if (!paneEl) return { found: false }

      // 1. Native text dragover - should NOT be prevented
      const dtText = new DataTransfer()
      dtText.setData('text/plain', 'dragged-text')
      const eventText = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dtText })
      paneEl.dispatchEvent(eventText)

      // 2. Markumo tab dragover - SHOULD be prevented and handled
      const dtTab = new DataTransfer()
      dtTab.setData('application/x-markumo-tab', JSON.stringify({ id: 'tab-1', from: 'main' }))
      const eventTab = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dtTab })
      paneEl.dispatchEvent(eventTab)

      app.unmount()
      container.remove()

      return {
        found: true,
        textPrevented: eventText.defaultPrevented,
        tabPrevented: eventTab.defaultPrevented,
      }
    })

    assert.equal(dragResult.found, true, 'EditorPaneItem should be mountable')
    assert.equal(dragResult.textPrevented, false, 'Native text dragover must NOT be defaultPrevented by pane')
    assert.equal(dragResult.tabPrevented, true, 'Markumo tab dragover must be defaultPrevented by pane')
  })

  // 8. 同一文档多个 Pane 同步数学公式编辑
  await test('8. multi-pane synchronization for math formula', async () => {
    await reset('$$\nx+y\n$$', true)
    const secondary = await page.evaluate(() => window.f.split())
    await ready()
    await page.evaluate(second => {
      window.f.manager.setMarkdownMode(window.f.id, 'live', second)
    }, secondary)
    await ready()

    // Edit math in main pane
    await page.locator('[data-pane="main"] .md-math-output').click()
    const mainInput = page.locator('[data-pane="main"] .md-math-source')
    await mainInput.waitFor({ state: 'visible' })
    await mainInput.type('+z')
    await ready()

    // Check secondary pane rendered KaTeX preview
    await page.waitForFunction(pane => document.querySelector(`[data-pane="${pane}"] .md-math-output`)?.textContent.includes('z'), secondary)
    const secondaryText = await page.locator(`[data-pane="${secondary}"] .md-math-output`).innerText()
    assert.ok(secondaryText.includes('x') && secondaryText.includes('z'), `Secondary pane should reflect math update: ${secondaryText}`)
  })

  // 9. 从公式编辑器进入普通段落及代码块
  await test('9. transition focus from math editor to paragraph and code block', async () => {
    await reset('Paragraph before\n\n$$\nx^2\n$$\n\n```js\nconst code = 1;\n```', true)
    await page.locator('.md-math-output').click()
    const textarea = page.locator('.md-math-source')
    await textarea.waitFor({ state: 'visible' })

    // Click paragraph before
    await page.locator('.md-prose > p').first().click()
    await page.waitForTimeout(100)
    assert.equal(await textarea.isHidden(), true, 'Math editor should close when clicking paragraph')

    // Click into code block
    await page.locator('.md-code-editor-wrap .cm-content').click()
    await page.keyboard.type('// edit')
    await ready()
    const src = await source()
    assert.ok(src.includes('// edit'), 'Code block should be editable after exiting math')
  })

  // 10. 保存、重新打开及模式切换（Live/Source/Split）
  await test('10. save, reopen, and mode toggle with math formulas', async () => {
    await reset('$$\nE = mc^2\n$$\n\nInline $E=mc^2$ formula', true)
    // Toggle to source mode
    await page.evaluate(() => window.f.manager.setMarkdownMode(window.f.id, 'source', 'main'))
    await page.locator('[data-pane="main"] .cm-editor').waitFor()
    const sourceText = await source()
    assert.ok(sourceText.includes('E = mc^2'), `Source mode should contain formula: ${sourceText}`)

    // Toggle back to live mode
    await page.evaluate(() => window.f.manager.setMarkdownMode(window.f.id, 'live', 'main'))
    await ready()
    await page.locator('.md-math-output').waitFor({ state: 'visible' })
    assert.equal(await source(), sourceText, 'Live mode should preserve exact math syntax')
  })

  await test('11. inline source to math transfers focus without stale cleanup', async () => {
    for (const mark of ['**bold**', '*italic*', '[link](https://example.com)', '`code`']) {
      await reset(`${mark} then $x+y$`, true)
      const selector = mark.startsWith('**') ? 'strong' : mark.startsWith('*') ? 'em' : mark.startsWith('[') ? 'a' : 'code'
      await page.locator(`.md-prose ${selector}`).click()
      await page.locator('.md-inline-source-input').waitFor({ state: 'visible' })
      await page.locator('.md-inline-math').click()
      await page.waitForFunction(() => document.activeElement?.matches('.md-math-source'))
      await page.keyboard.type('+z')
      assert.equal(await source(), `${mark} then $x+y+z$`)
      assert.equal(await page.locator('.md-math-source').evaluate(el => document.activeElement === el), true)
    }
  })

  await test('12. external Pane updates map backward selections before and across the range exactly once', async () => {
    const input = await openBlock('alpha beta gamma')
    const secondary = await page.evaluate(() => window.f.split())
    await ready()
    await input.evaluate(el => el.setSelectionRange(6, 10, 'backward'))
    const publications = await page.evaluate(() => window.f.publications.length)
    await remoteMath('new alpha beta gamma', secondary)
    assert.deepEqual(await inputState(input), { active: true, value: 'new alpha beta gamma', start: 10, end: 14, direction: 'backward' })
    assert.equal(await page.evaluate(() => window.f.publications.length), publications + 1)
    await remoteMath('new alpha bZta gamma', secondary)
    assert.deepEqual(await inputState(input), { active: true, value: 'new alpha bZta gamma', start: 10, end: 14, direction: 'backward' })
    await remoteMath('x', secondary)
    const state = await inputState(input)
    assert.equal(state.active, true)
    assert.ok(state.start >= 0 && state.end <= 1 && state.start <= state.end)
    assert.equal(state.direction, 'backward')
    assert.equal(await source(), '$$\nx\n$$')
  })

  await test('13. own input and unrelated NodeView updates preserve textarea and native selection', async () => {
    const input = await openBlock('alpha beta')
    await input.evaluate(el => { window.originalMathInput = el; el.setSelectionRange(2, 2) })
    await page.keyboard.type('Z')
    assert.deepEqual(await inputState(input), { active: true, value: 'alZpha beta', start: 3, end: 3, direction: 'forward' })
    await page.evaluate(() => {
      const view = window.f.live().view
      view.dispatch(view.state.tr.setMeta('unrelated', true))
    })
    assert.equal(await input.evaluate(el => el === window.originalMathInput), true)
    assert.equal((await inputState(input)).start, 3)
    assert.equal(await source(), '$$\nalZpha beta\n$$')
  })

  await test('14. Chromium native composition commits once and ignores IME Enter/Escape', async () => {
    const input = await openBlock('x')
    const session = await beginComposition(input, '拼音')
    assert.equal(await source(), '$$\nx\n$$', 'Composition draft must not publish early')
    await input.evaluate(el => {
      // Some IMEs omit isComposing on their confirming keydown.
      for (const key of ['Enter', 'Escape']) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
    assert.equal(await input.isVisible(), true)
    await session.send('Input.insertText', { text: '中文' })
    await ready()
    assert.equal(await page.evaluate(() => window.mathEventTrace.filter(event => event.type === 'compositionend').length), 1)
    assert.equal(await source(), '$$\nx中文\n$$')
    assert.equal((await inputState(input)).active, true)
    assert.equal(await page.evaluate(() => window.f.publications.length), 1)
    await session.detach()
  })

  await test('15. final input before/after compositionend is idempotent and blur completes composition', async () => {
    for (const beforeEnd of [true, false]) {
      const input = await openBlock('x')
      await input.evaluate((el, beforeEnd) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        el.value = 'x中文'
        el.setSelectionRange(3, 3)
        const finalInput = () => el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' }))
        if (beforeEnd) finalInput()
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
        if (!beforeEnd) queueMicrotask(finalInput)
      }, beforeEnd)
      await ready()
      assert.equal(await source(), '$$\nx中文\n$$')
      assert.equal(await page.evaluate(() => window.f.publications.length), 1)
      assert.equal((await inputState(input)).active, true)
    }
    await reset('$$\nx\n$$\n\nParagraph', true)
    await page.locator('.md-math-output').click()
    const input = page.locator('.md-math-source')
    await input.evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = 'x中文'; window.compositionInput = el })
    await page.locator('.md-prose > p').filter({ hasText: 'Paragraph' }).click()
    await page.evaluate(() => window.compositionInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
    await ready()
    assert.equal(await input.isHidden(), true)
    assert.equal(await source(), '$$\nx中文\n$$\n\nParagraph')
    assert.equal(await page.locator('.md-prose').evaluate(el => document.activeElement === el), true)
  })

  await test('16. composition rebases disjoint external edits and reports an overlapping conflict', async () => {
    for (const conflict of [false, true]) {
      const input = await openBlock('abc')
      const secondary = await page.evaluate(() => window.f.split())
      await ready()
      await input.evaluate(el => el.setSelectionRange(3, 3))
      const session = await beginComposition(input, '中')
      await page.evaluate(({ secondary, conflict }) => {
        window.notices.length = 0
        const view = window.f.live(secondary).view, { node, pos } = window.f.node('protected_source', 0, secondary)
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: `$$\n${conflict ? 'abc外' : 'Zabc'}\n$$` }))
      }, { secondary, conflict })
      assert.equal((await inputState(input)).value, 'abc中', 'Deferred remote sync must not rewrite the composing textarea')
      await session.send('Input.insertText', { text: '中' })
      await ready()
      assert.equal(await source(), conflict ? '$$\nabc中\n$$' : '$$\nZabc中\n$$')
      assert.equal((await inputState(input)).active, true)
      assert.equal((await inputState(input)).start, conflict ? 4 : 5)
      assert.equal(await page.evaluate(() => window.notices.some(text => text.includes('同时被其他 Pane 修改'))), conflict)
      assert.equal(await page.evaluate(() => window.f.publications.filter(p => p.pane === 'main').length), 1)
      await session.detach()
    }
  })

  await test('17. exact formula whitespace and delimiter layout survive editing and Live/Source/Split round trips', async () => {
    for (const original of ['$$  x  $$  \n\nInline $  a + b  $ tail\n', '$$\n\n  x  \n\n$$  \n\nInline $  a + b  $ tail\n']) {
      await reset(original, true)
      await page.locator('.md-math-output').click()
      await page.keyboard.press('Escape')
      assert.equal(await source(), original)
      for (const mode of ['source', 'split', 'live']) {
        await page.evaluate(mode => window.f.manager.setMarkdownMode(window.f.id, mode, 'main'), mode)
        if (mode === 'live') await ready()
        else await page.locator('[data-pane="main"] .cm-editor').waitFor()
        assert.equal(await source(), original)
      }
      await page.locator('.md-math-output').click()
      await page.locator('.md-math-output .md-math-source').evaluate(el => { const at = el.value.indexOf('x') + 1; el.setSelectionRange(at, at) })
      await page.keyboard.type('Z')
      assert.equal(await source(), original.replace('x', 'xZ'))
    }
  })

  await test('18. block shortcuts exit once and hand focus to the ProseMirror document', async () => {
    for (const shortcut of ['Escape', 'Control+Enter', 'Meta+Enter']) {
      const input = await openBlock('x')
      await page.keyboard.press(shortcut)
      assert.equal(await input.isHidden(), true)
      assert.equal(await page.locator('.md-prose').evaluate(el => document.activeElement === el), true)
      assert.equal(await source(), '$$\nx\n$$')
    }
  })

  await test('19. direct math to paragraph/code/table/image transfers focus without stealing it back', async () => {
    await reset('Paragraph\n\n$$\nx\n$$\n\n```js\nconst a = 1\n```\n\n| A | B |\n| --- | --- |\n| c | d |\n\n![pixel](local.png)', true)
    const input = page.locator('.md-math-source')
    for (const target of ['paragraph', 'code', 'table', 'image']) {
      await page.locator('.md-math-output').click()
      assert.equal((await inputState(input)).active, true)
      if (target === 'paragraph') {
        await page.locator('.md-prose > p').filter({ hasText: 'Paragraph' }).click()
        assert.equal(await page.locator('.md-prose').evaluate(el => document.activeElement === el), true)
      } else if (target === 'code') {
        await page.locator('.md-code-editor-wrap .cm-content').click()
        await page.keyboard.type('Z')
        assert.equal(await page.locator('.md-code-editor-wrap .cm-content').evaluate(el => document.activeElement === el), true)
        assert.ok((await source()).includes('Z'))
      } else if (target === 'table') {
        await page.locator('.md-prose td').first().click()
        await page.keyboard.type('T')
        assert.ok((await source()).includes('T'))
      } else {
        await page.locator('.md-live-image img').click()
        await page.locator('.md-inline-source-input').waitFor({ state: 'visible' })
        assert.equal(await page.locator('.md-inline-source-input').evaluate(el => document.activeElement === el), true)
      }
      await page.waitForFunction(() => document.querySelector('.md-math-source')?.hidden)
      assert.ok((await source()).includes('$$\nx\n$$'))
    }
  })

  await test('20. read-only math cannot enter editing or mutate after permission changes', async () => {
    await reset('$$\nx\n$$', true, true)
    await page.locator('.md-math-output').click()
    assert.equal(await page.locator('.md-math-source').isHidden(), true)
    assert.equal(await source(), '$$\nx\n$$')
    const input = await openBlock('x')
    await page.evaluate(() => { window.f.manager.records.get(window.f.id).meta.readOnly = true; window.f.live().refreshResources() })
    assert.equal(await input.evaluate(el => el.readOnly), true)
    await page.keyboard.type('Z')
    await page.keyboard.press('Control+z')
    assert.equal((await inputState(input)).value, 'x')
    assert.equal(await source(), '$$\nx\n$$')
  })

  await test('21. deleting/replacing an active math NodeView removes handlers and queued work safely', async () => {
    const errors = []
    const onError = error => errors.push(String(error))
    page.on('pageerror', onError)
    try {
      for (const replacement of ['', 'ordinary text']) {
        const input = await openBlock('x')
        await input.evaluate(el => { window.deletedMathInput = el })
        await page.evaluate(replacement => window.f.manager.dispatch(window.f.id, { changes: { from: 0, to: window.f.source().length, insert: replacement } }), replacement)
        await ready()
        assert.equal(await page.locator('.md-math-source').count(), 0)
        const handlers = await page.evaluate(() => {
          const el = window.deletedMathInput
          el.dispatchEvent(new InputEvent('input', { bubbles: true }))
          el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
          return [el.oninput, el.onbeforeinput, el.onkeydown, el.onblur, window.f.listenerCount(el, 'compositionend')]
        })
        assert.deepEqual(handlers, [null, null, null, null, 0])
        assert.equal(await source(), replacement)
      }
      assert.deepEqual(errors, [])
    } finally { page.off('pageerror', onError) }
  })

  await test('22. save snapshot, disk write, close and reopen preserve exact math source', async () => {
    const input = await openBlock('  \\frac{1}{2}  ')
    await page.keyboard.insertText('\nnext \\alpha  ')
    await page.keyboard.press('Control+Enter')
    const expected = await source()
    const saved = await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id)?.text)
    assert.equal(saved, expected)
    const filename = path.join(output, 'saved-formula.md')
    fs.writeFileSync(filename, saved, 'utf8')
    assert.equal(await page.evaluate(() => window.f.manager.close(window.f.id, true)), 'closed')
    await reset(fs.readFileSync(filename, 'utf8'), true)
    assert.equal(await source(), expected)
    await page.locator('.md-math-output').click()
    assert.equal((await inputState(input)).value, '  \\frac{1}{2}  \nnext \\alpha  ')
  })

  await test('23. real selected-text drag through EditorPaneItem remains a native textarea operation', async () => {
    await reset('$$\nalpha beta gamma delta\n$$', true)
    await page.evaluate(async () => {
      const container = document.createElement('div')
      container.style.cssText = 'position:fixed;inset:0;display:flex;background:white;z-index:1000'
      document.body.append(container)
      const app = window.Vue.createApp({ render: () => window.Vue.h(window.EditorPaneItem, { manager: window.f.manager, paneId: 'main', revision: 0, desktop: false }) })
      app.mount(container)
      window.nativeDragHarness = { container, app }
      window.nativeDragEvents = []
      const pane = container.querySelector('[data-pane-id="main"]')
      for (const type of ['dragstart', 'dragover', 'drop']) pane.addEventListener(type, event => {
        window.nativeDragEvents.push({ type, trusted: event.isTrusted, prevented: event.defaultPrevented, types: [...event.dataTransfer.types] })
      })
    })
    try {
      const pane = page.locator('[data-pane-id="main"]')
      await pane.locator('.md-math-output').click()
      const input = pane.locator('.md-math-source')
      await page.keyboard.press('Home')
      await page.keyboard.down('Shift')
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
      await page.keyboard.up('Shift')
      assert.equal((await inputState(input)).end, 5)
      const geometry = await input.evaluate(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el)
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')
        ctx.font = style.font
        return { x: rect.x + parseFloat(style.paddingLeft), y: rect.y + 12, width: ctx.measureText('a').width }
      })
      await page.mouse.move(geometry.x + geometry.width * 2, geometry.y)
      await page.mouse.down()
      await page.waitForTimeout(250) // Native drag threshold, not editor focus recovery.
      await page.mouse.move(geometry.x + geometry.width * 23, geometry.y, { steps: 20 })
      await page.mouse.up()
      await page.waitForFunction(() => window.nativeDragEvents.some(event => event.type === 'drop'))
      const events = await page.evaluate(() => window.nativeDragEvents)
      assert.ok(events.some(event => event.type === 'dragstart' && event.trusted && event.types.includes('text/plain')))
      assert.ok(events.filter(event => event.type === 'dragover' || event.type === 'drop').every(event => event.trusted && !event.prevented))
      assert.equal((await inputState(input)).value, ' beta gamma deltaalpha')
      assert.equal(await source(), '$$\n beta gamma deltaalpha\n$$')
      assert.equal((await inputState(input)).active, true)
    } finally {
      await page.evaluate(() => { window.nativeDragHarness.app.unmount(); window.nativeDragHarness.container.remove() })
    }
  })

  await test('24. native copy/cut/paste and multiline clipboard keep exact formula contents', async () => {
    const input = await openBlock('alpha beta')
    await page.keyboard.press('Home')
    await page.keyboard.down('Shift')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('End')
    await page.keyboard.press('Control+v')
    await page.waitForFunction(() => window.f.source().includes('betaalpha'))
    assert.equal(await source(), '$$\nalpha betaalpha\n$$')
    await page.keyboard.press('Home')
    await page.keyboard.down('Shift')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('End')
    await page.keyboard.press('Control+v')
    assert.equal(await source(), '$$\n betaalphaalpha\n$$')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => navigator.clipboard.writeText('  \\alpha\n\n\\beta  '))
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+v')
    await page.waitForFunction(() => window.f.source().includes('\\beta'))
    assert.equal((await inputState(input)).value, '  \\alpha\n\n\\beta  ')
    assert.equal(await source(), '$$\n  \\alpha\n\n\\beta  \n$$')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+y')
    assert.equal(await source(), '$$\n  \\alpha\n\n\\beta  \n$$')
    assert.equal((await inputState(input)).active, true)
  })

  await test('25. native history beforeinput uses the canonical undo stack', async () => {
    const input = await openBlock('x')
    await page.keyboard.type('+y')
    await input.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })))
    assert.equal(await source(), '$$\nx\n$$')
    await input.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true })))
    assert.equal(await source(), '$$\nx+y\n$$')
    assert.equal((await inputState(input)).active, true)
  })

  await test('26. deleting a composing formula does not resurrect it or overwrite its successor', async () => {
    await reset('$$\nfirst\n$$\n\n$$\nsecond\n$$', true)
    await page.locator('.md-math-output').first().click()
    const input = page.locator('.md-math-source').first()
    await input.evaluate(el => {
      window.notices.length = 0
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = 'first中文'
      window.removedComposition = el
    })
    await page.evaluate(() => window.f.manager.dispatch(window.f.id, { changes: { from: 0, to: '$$\nfirst\n$$\n\n'.length, insert: '' } }))
    await page.evaluate(() => window.removedComposition.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
    await ready()
    assert.equal(await source(), '$$\nsecond\n$$')
    assert.equal(await page.locator('.md-math-source:visible').count(), 0)
    assert.equal(await page.evaluate(() => window.notices.some(text => text.includes('未提交的源码：first中文'))), true)
    assert.equal(await page.evaluate(() => window.f.manager.isComposing), false)
  })

  await test('27. escaped dollars and even trailing backslashes retain inline formula syntax', async () => {
    for (const value of [' a \\$ b ', 'a\\\\', '  \\alpha + \\beta  ']) {
      const original = `Prefix $${value}$ suffix`
      await reset(original, true)
      await page.locator('.md-inline-math').click()
      const input = page.locator('.md-math-source')
      assert.equal((await inputState(input)).value, value)
      await page.keyboard.press('Escape')
      await page.evaluate(() => window.f.manager.setMarkdownMode(window.f.id, 'source', 'main'))
      await page.locator('[data-pane="main"] .cm-editor').waitFor()
      await page.evaluate(() => window.f.manager.setMarkdownMode(window.f.id, 'live', 'main'))
      await ready()
      assert.equal(await page.locator('.md-inline-math').count(), 1)
      assert.equal(await source(), original)
    }
  })

  await test('28. destroying an IME target without compositionend releases the controller guard', async () => {
    const input = await openBlock('x')
    await input.evaluate(el => {
      window.notices.length = 0
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = 'x中文'
    })
    await page.evaluate(() => {
      const view = window.f.live().view, { node, pos } = window.f.node('protected_source')
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize))
    })
    await ready()
    assert.equal(await page.evaluate(() => window.f.manager.isComposing), false)
    assert.equal(await page.locator('.md-math-source').count(), 0)
    assert.equal(await source(), '')
    assert.equal(await page.evaluate(() => window.notices.some(text => text.includes('未提交的源码：x中文'))), true)
  })

  await test('29. real tab pointer drag and workspace file drag still reach their own handlers', async () => {
    await reset('$$\nx\n$$', true)
    await page.evaluate(() => {
      const container = document.createElement('div')
      container.style.cssText = 'position:fixed;inset:0;display:flex;background:white;z-index:1000'
      document.body.append(container)
      window.customDragCalls = []
      const manager = window.f.manager, transfer = manager.transferTab.bind(manager)
      manager.transferTab = (...args) => { window.customDragCalls.push({ type: 'tab', args }); return transfer(...args) }
      const app = window.Vue.createApp({ render: () => window.Vue.h(window.EditorPaneItem, {
        manager, paneId: 'main', revision: 0, desktop: false,
        onOpenWorkspaceFile: payload => window.customDragCalls.push({ type: 'file', payload }),
      }) })
      app.mount(container)
      const treeContainer = document.createElement('div')
      treeContainer.style.cssText = 'position:fixed;top:10px;right:20px;width:180px;height:36px;z-index:1100;background:white'
      document.body.append(treeContainer)
      const tree = window.Vue.createApp({ render: () => window.Vue.h(window.TreeNodeItem, {
        node: { id: 'drag.md', name: 'drag.md', path: 'C:/fixture/drag.md', relativePath: 'drag.md', isDirectory: false, isSymlink: false, isReadOnly: false, size: 1, mtime: 0, hasChildren: false }, depth: 0,
      }) })
      tree.mount(treeContainer)
      window.customDragHarness = { container, app, treeContainer, tree }
    })
    try {
      const pane = page.locator('[data-pane-id="main"]')
      await pane.locator('.md-math-output').click()
      const tab = await pane.locator('.tab').boundingBox(), bounds = await pane.boundingBox()
      const target = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2)
      await page.mouse.down()
      await page.mouse.move(target.x, target.y, { steps: 12 })
      await page.locator('.tab-drag-ghost').waitFor({ state: 'visible' })
      await page.mouse.up()
      assert.equal(await page.evaluate(() => window.customDragCalls.filter(call => call.type === 'tab').length), 1)
      assert.equal(await source(), '$$\nx\n$$')
      await page.locator('.treenode.file').dragTo(pane, { targetPosition: { x: bounds.width / 2, y: bounds.height / 2 } })
      await page.waitForFunction(() => window.customDragCalls.some(call => call.type === 'file'))
      assert.deepEqual(await page.evaluate(() => window.customDragCalls.find(call => call.type === 'file').payload), { path: 'C:/fixture/drag.md', name: 'drag.md', paneId: 'main', zone: 'center' })
      assert.equal(await source(), '$$\nx\n$$')
    } finally {
      await page.evaluate(() => {
        const h = window.customDragHarness
        h.app.unmount(); h.container.remove(); h.tree.unmount(); h.treeContainer.remove()
      })
    }
  })

  await test('30. CodeMirror native reverse selection and text drop work after leaving math', async () => {
    await reset('$$\nx\n$$\n\n```text\nalpha beta gamma delta\n```', true)
    await page.locator('.md-math-output').click()
    const content = page.locator('.md-code-editor-wrap .cm-content')
    await content.evaluate(el => {
      window.codeDragEvents = []
      for (const type of ['dragstart', 'dragover', 'drop']) el.addEventListener(type, event => window.codeDragEvents.push({ type, trusted: event.isTrusted, prevented: event.defaultPrevented }))
    })
    await content.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('End')
    await page.keyboard.down('Shift')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
    assert.equal(await content.evaluate(() => document.getSelection().toString()), 'delta')
    await page.keyboard.press('Control+Home')
    await page.keyboard.down('Shift')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    assert.equal(await content.evaluate(() => document.getSelection().toString()), 'alpha')
    const geometry = await content.locator('.cm-line').evaluate(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el)
      const ctx = document.createElement('canvas').getContext('2d'); ctx.font = style.font
      const range = document.createRange(); range.selectNodeContents(el)
      return { x: rect.x, y: rect.y + rect.height / 2, width: ctx.measureText('a').width, end: range.getBoundingClientRect().right + 12 }
    })
    await page.mouse.move(geometry.x + geometry.width * 2, geometry.y)
    await page.mouse.down()
    await page.waitForTimeout(250)
    await page.mouse.move(geometry.end, geometry.y, { steps: 20 })
    await page.mouse.up()
    await page.waitForFunction(() => window.f.source().includes(' beta gamma deltaalpha'))
    assert.equal(await page.evaluate(() => window.codeDragEvents.some(event => event.type === 'drop' && event.trusted)), true)
    assert.equal(await source(), '$$\nx\n$$\n\n```text\n beta gamma deltaalpha\n```')
    assert.equal(await content.evaluate(el => document.activeElement === el), true)
  })

  console.log(`\n========================================`)
  console.log(`All ${results.length} Math Editor tests passed successfully!`)
  console.log(`========================================\n`)
} finally {
  fs.writeFileSync(`${output}/results.json`, JSON.stringify({
    runtime: { platform: process.platform, browser: browserVersion },
    passed: results.length, failed: failures.length, results, failures,
    unverified: ['Windows WebView2 real interaction', 'Windows/macOS OS IME candidates and confirmation', 'OS file drag through Tauri and physical save/reopen'],
  }, null, 2))
  if (browser) await browser.close()
  await server.close()
}
