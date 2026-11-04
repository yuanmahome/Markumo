import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1541, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-markdown-source-fidelity',
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
const report = []

async function reset(source) {
  await page.evaluate(text => window.f.reset(text), source)
  await page.waitForFunction(() => !!window.f.live() && window.f.ready())
}
const source = () => page.evaluate(() => window.f.manager.getText(window.f.id))
const bridgeSource = () => page.evaluate(() => window.f.live().bridge.source)
const pmBlock = () =>
  page.evaluate(() =>
    JSON.stringify(window.f.live().view.state.doc.firstChild.toJSON(), (key, value) =>
      key === 'sourceId' ? undefined : value
    )
  )
async function assertFidelity(expected, label) {
  const [text, bridge] = await Promise.all([source(), bridgeSource()])
  assert.equal(text, expected, `${label}: canonical source`)
  assert.equal(bridge, expected, `${label}: bridge source`)
  return { text, bridge }
}
async function caretAt(needle, offset = 0) {
  await page.evaluate(({ needle, offset }) => {
    const view = window.f.live().view
    let at = -1
    view.state.doc.descendants((node, pos) => {
      if (at >= 0) return false
      if (node.isText && node.text.includes(needle)) at = pos + node.text.indexOf(needle) + offset
    })
    if (at < 0) throw new Error(`Missing caret target ${needle}`)
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, at)))
    view.focus()
  }, { needle, offset })
}
async function selectWord(needle) {
  await page.evaluate(needle => {
    const view = window.f.live().view
    let at = -1
    view.state.doc.descendants((node, pos) => {
      if (at >= 0) return false
      if (node.isText && node.text.includes(needle)) at = pos + node.text.indexOf(needle)
    })
    if (at < 0) throw new Error(`Missing selection target ${needle}`)
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, at, at + needle.length)))
    view.focus()
  }, needle)
}
async function pasteText(text) {
  await page.evaluate(async text => {
    const { textClipboard } = await import('/src/features/shell/clipboard.ts')
    const read = textClipboard.readText
    textClipboard.readText = async () => text
    try {
      await window.f.live().clipboard('paste')
    } finally {
      textClipboard.readText = read
    }
  }, text)
}
async function pasteEvent(plain, html) {
  await page.evaluate(({ plain, html }) => {
    const view = window.f.live().view
    const data = new DataTransfer()
    data.setData('text/plain', plain)
    if (html) data.setData('text/html', html)
    view.dom.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  }, { plain, html })
}
async function toggleMark(mark) {
  await page.evaluate(async mark => {
    const view = window.f.live().view
    view.dispatch(view.state.tr.addMark(view.state.selection.from, view.state.selection.to, view.state.schema.marks[mark].create()))
  }, mark)
}
async function modeCycle() {
  for (const mode of ['source', 'live', 'split', 'source', 'live']) {
    await page.evaluate(m => window.f.mode(m), mode)
    await page.waitForFunction(() => window.f.ready())
  }
}

try {
  await page.goto('http://127.0.0.1:1541/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  // =========================================================================
  // A. `AuthController` 由 `AuthController` 被改写的全部真实输入路径
  // =========================================================================
  const authCases = []

  await reset('')
  await page.locator('.md-prose').click()
  await page.keyboard.type('`AuthController`')
  await page.waitForTimeout(30)
  await assertFidelity('`AuthController`', 'typed backticks around a word')
  authCases.push('typed pair of backticks')

  await reset('')
  await page.locator('.md-prose').click()
  await page.keyboard.type('``AuthController')
  await page.keyboard.type('``')
  await page.waitForTimeout(30)
  await assertFidelity('``AuthController``', 'paired multi-backticks completed last')
  authCases.push('pair completed after inner text')

  await reset('')
  await page.locator('.md-prose').click()
  await page.keyboard.type('AuthController`')
  await page.keyboard.press('Home')
  await page.keyboard.type('`')
  await page.waitForTimeout(30)
  await assertFidelity('`AuthController`', 'prepended opening backtick')
  authCases.push('prepend opening delimiter')

  await reset('')
  await page.locator('.md-prose').click()
  await page.keyboard.type('``AuthController``')
  await page.waitForTimeout(30)
  await assertFidelity('``AuthController``', 'multi-backtick code span')
  authCases.push('multi-backtick span')

  await reset('这是  控制器\n')
  await caretAt(' 控制器')
  await page.keyboard.insertText('`AuthController`')
  await page.waitForTimeout(30)
  await assertFidelity('这是 `AuthController` 控制器\n', 'insertText commit in one shot')
  authCases.push('single-shot insertText / IME commit')

  await reset('这是 ')
  await page.locator('.md-prose').click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    const view = window.f.live().view
    const paragraph = view.dom.querySelector('p')
    const text = paragraph.firstChild
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    text.data = '这是 `AuthController`'
    document.getSelection().collapse(text, text.data.length)
    view.dom.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '`AuthController`', isComposing: true }))
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '`AuthController`' }))
  })
  await page.waitForTimeout(50)
  await assertFidelity('这是 `AuthController` ', 'IME composition DOM mutation')
  authCases.push('IME composition (readDOMChange path)')

  await reset('这是  控制器\n')
  await caretAt(' 控制器')
  await pasteEvent(
    '`AuthController`',
    '<meta charset="utf-8"><div style="color:#d4d4d4;font-family:Consolas;"><span>`AuthController`</span></div>'
  )
  await page.waitForTimeout(30)
  await assertFidelity('这是 `AuthController` 控制器\n', 'VS Code / terminal HTML paste')
  authCases.push('IDE code-styled HTML paste')

  for (const [prefix, expected] of [
    ['- `AuthController`', '- `AuthController`'],
    ['> `AuthController`', '> `AuthController`'],
    ['1. `AuthController`', '1. `AuthController`'],
  ]) {
    await reset('')
    await page.locator('.md-prose').click()
    await page.keyboard.type(prefix)
    await page.waitForTimeout(30)
    await assertFidelity(expected, `typed ${prefix.split(' ')[0]} marker`)
    authCases.push(`typing inside ${prefix.split(' ')[0]} marker`)
  }
  await reset('- \n')
  await page.locator('.md-prose li p').first().click()
  await page.keyboard.type('`AuthController`')
  await page.waitForTimeout(30)
  await assertFidelity('- `AuthController`\n', 'typing inside existing empty list item')
  authCases.push('existing empty list item')
  console.log(`PASS A: ${authCases.length} real input paths keep \`AuthController\` byte-exact`)

  // =========================================================================
  // B. 未修改源码保持不变（18 类语法语料 + 模式往返）
  // =========================================================================
  const corpus = [
    ['inline code single', 'Use `AuthController` here\n'],
    ['inline code multi', 'Use ``a `b` c`` here\n'],
    ['inline code special', 'Use ``a*b_c[d]`` here\n'],
    ['bold star', 'A **bold** word\n'],
    ['bold underscore', 'A __bold__ word\n'],
    ['italic star', 'A *italic* word\n'],
    ['italic underscore', 'A _italic_ word\n'],
    ['bold italic', 'A ***bi*** and ___bi___ word\n'],
    ['strike', 'A ~~gone~~ word\n'],
    ['atx heading', '##   ATX 标题  ##\n'],
    ['setext heading', '标题\n====\n\n副标题\n----\n'],
    ['links', 'A [text](https://example.com/a_b~c "t") <https://example.com/x~y> <me@example.com> [ref][r]\n\n[r]: https://example.com/r\n'],
    ['images', 'A ![alt *x*](./p a.png) and ![ref][i]\n\n[i]: ./i.png\n'],
    ['lists', '- one\n- two\n\n1. first\n2. second\n   - nested\n'],
    ['tasks', '- [ ] todo\n- [x] done\n'],
    ['quotes', '> a\n> > b **c**\n'],
    ['tables', '| A | B |\n| :-- | --: |\n| `x|y` | a \\| b |\n'],
    ['math', 'Inline $x_1 + x_2$ and block:\n\n$$\n\\int_0^1 x\\,dx\n$$\n'],
    ['fences', '```ts\nconst a: string = "**not bold**"\n```\n\n~~~md\n`tick`\n~~~\n'],
    ['footnotes', 'A note[^1]\n\n[^1]: the text\n'],
    ['html', 'Inline <kbd>Ctrl</kbd> and block:\n\n<div class="x">raw</div>\n'],
    ['mermaid', '```mermaid\ngraph TD\n  A["<b>Start</b>"] --> B\n```\n'],
    ['escapes', 'A \\*literal\\* and \\`tick\\` and \\[x\\] and \\\\ backslash\n'],
    ['mixed', '# T `code`\n\n> - [x] **a** &amp; `b` [c][d]\n>\n> | h |\n> | - |\n> | v |\n\n[d]: https://example.com\n'],
    ['entities', 'alpha &amp; beta &lt;gamma&gt; &#65;\n'],
  ]
  for (const [label, text] of corpus) {
    await reset(text)
    await assertFidelity(text, `${label}: load`)
    const before = await pmBlock()
    await modeCycle()
    await assertFidelity(text, `${label}: mode round trip`)
    assert.equal(await page.evaluate(() => window.f.manager.metadata(window.f.id).dirty), false, `${label}: must stay clean`)
    assert.deepEqual(await pmBlock(), before, `${label}: PM tree must be stable`)
  }
  console.log(`PASS B: ${corpus.length} syntax corpora load and survive mode round trips byte-exactly`)

  // CRLF variants of the same corpora must keep CRLF on save
  for (const [label, text] of corpus.slice(0, 12)) {
    const crlf = text.replace(/\n/g, '\r\n')
    await reset(crlf)
    assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), crlf, `${label}: CRLF save`)
  }
  console.log('PASS B2: CRLF documents save with CRLF bytes preserved')

  // =========================================================================
  // C. 修改普通文本不影响周围格式；既有转义不被删除
  // =========================================================================
  await reset('这是 `AuthController` 控制器\n')
  await page.locator('.md-prose code').click()
  await page.locator('.md-inline-source-input').waitFor()
  await page.evaluate(() => window.f.live().inlineSource.select(1, 5))
  await page.keyboard.insertText('User')
  await page.waitForTimeout(30)
  await assertFidelity('这是 `UserController` 控制器\n', 'edit inside inline code keeps backticks')
  console.log('PASS C1: editing inside `AuthController` keeps delimiters and neighbours')

  for (const [source_, needle, insert, expected] of [
    ['A **bold** and `code` and ~~gone~~ tail\n', 'tail', 'X', 'A **bold** and `code` and ~~gone~~ Xtail\n'],
    ['alpha &amp; beta __bold__ tail\n', 'tail', 'X', 'alpha &amp; beta __bold__ Xtail\n'],
    ['A [ref][r] tail\n\n[r]: https://example.com\n', 'tail', 'X', 'A [ref][r] Xtail\n\n[r]: https://example.com\n'],
    ['A `x` tail\n', 'tail', 'X', 'A `x` Xtail\n'],
  ]) {
    await reset(source_)
    await caretAt(needle)
    await page.keyboard.type(insert)
    await page.waitForTimeout(30)
    await assertFidelity(expected, `insert text next to ${needle}`)
  }
  console.log('PASS C2: inserting ordinary text never rewrites sibling Markdown or entities')

  for (const [source_, expected] of [
    ['A \\*literal\\* tail\n', 'A \\*literal\\* tail\n'],
    ['A \\`tick\\` tail\n', 'A \\`tick\\` tail\n'],
    ['A \\[x\\] tail\n', 'A \\[x\\] tail\n'],
    ['A \\\\ tail\n', 'A \\\\ tail\n'],
  ]) {
    await reset(source_)
    await caretAt('tail')
    await page.keyboard.type(' ')
    await page.waitForTimeout(30)
    assert.equal(await source(), expected.replace('tail', ' tail'), `author escapes preserved for ${JSON.stringify(source_)}`)
  }
  console.log('PASS C3: author-typed escapes are never consumed or stripped')

  // =========================================================================
  // D. 粘贴 / 格式切换 / 参考链接 / 脚注 / 数学 / 自动链接
  // =========================================================================
  await reset('前置 __重要__ &amp; [文档][doc] 以及  控制器\n\n[doc]: https://example.com\n')
  await caretAt(' 控制器')
  await pasteText('`AuthController`')
  await page.waitForTimeout(30)
  await assertFidelity(
    '前置 __重要__ &amp; [文档][doc] 以及 `AuthController` 控制器\n\n[doc]: https://example.com\n',
    'pasting Markdown keeps untouched inline syntax'
  )
  console.log('PASS D1: Markdown paste only patches the pasted range')

  for (const [container, expected] of [
    ['- 前缀 __保留__ 与 目标\n', '- 前缀 __保留__ 与 **目标**\n'],
    ['> 前缀 __保留__ 与 目标\n', '> 前缀 __保留__ 与 **目标**\n'],
    ['| h | v |\n| --- | --- |\n| 前缀 __保留__ | 目标 |\n', '| h | v |\n| --- | --- |\n| 前缀 __保留__ | **目标** |\n'],
  ]) {
    await reset(container)
    await selectWord('目标')
    await toggleMark('strong')
    await page.waitForTimeout(30)
    await assertFidelity(expected, `bold toggle in ${container.slice(0, 1)} container`)
  }
  console.log('PASS D2: mark toggles inside list/quote/table cells only patch the changed range')

  await reset('| h | v |\n| --- | --- |\n| `AuthController` | 包含 __强调__ 与 $\\|x\\|$ |\n')
  await selectWord('包含')
  await toggleMark('strong')
  await page.waitForTimeout(30)
  await assertFidelity(
    '| h | v |\n| --- | --- |\n| `AuthController` | **包含** __强调__ 与 $\\|x\\|$ |\n',
    'table cell keeps sibling inline syntax and escaped pipes'
  )
  console.log('PASS D3: table cells keep `\\|` and untouched inline syntax')

  await reset('详见 \n\n[doc]: https://example.com\n')
  await caretAt('详见', 2)
  await page.keyboard.press('End')
  await page.keyboard.type('[说明][doc]')
  await page.waitForTimeout(30)
  assert.equal((await source()).startsWith('详见'), true)
  assert((await source()).includes('[说明][doc]'), 'reference link keeps its exact source spelling')
  const refSource = await source()
  await modeCycle()
  assert.equal(await source(), refSource, 'reference link survives a mode cycle unchanged')
  console.log('PASS D4: `[label][id]` reference links keep exact spelling')

  await reset('参考\n')
  await caretAt('参考')
  await page.keyboard.press('End')
  await page.keyboard.type('[^1]')
  await page.waitForTimeout(30)
  await assertFidelity('参考[^1]\n', 'footnote reference typed literally')
  console.log('PASS D5: footnote references are not escaped')

  await reset('公式：\n')
  await caretAt('公式：')
  await page.keyboard.press('End')
  await page.keyboard.type('$x_1 + x_2$')
  await page.waitForTimeout(30)
  assert.equal(await source(), '公式：$x_1 + x_2$\n')
  const mathMarks = await page.evaluate(() => {
    const first = window.f.live().view.state.doc.firstChild
    let hasMath = false
    first.descendants(node => { if (node.type.name === 'math_inline') hasMath = true })
    return hasMath
  })
  assert.equal(mathMarks, true, 'inline math becomes a math_inline atom')
  console.log('PASS D6: inline math keeps LaTeX underscores and produces a math atom')

  await reset('访问 <https://example.com/~user_name/a_b> 详情\n')
  await selectWord('详情')
  await toggleMark('strong')
  await page.waitForTimeout(30)
  await assertFidelity('访问 <https://example.com/~user_name/a_b> **详情**\n', 'autolink URL not escaped')
  console.log('PASS D7: angle autolinks keep `~` and `_` unescaped')

  await reset('A ~~gone~~ tail\n')
  await selectWord('tail')
  await toggleMark('em')
  await page.waitForTimeout(30)
  assert.equal(await source(), 'A ~~gone~~ *tail*\n')
  console.log('PASS D8: single `~` inside strike is not escaped when serializing')

  // =========================================================================
  // E. 撤销/重做、重复保存幂等、纯文本不受影响
  // =========================================================================
  await reset('前 __保留__ 后\n')
  await caretAt('后')
  await pasteText('`X`')
  await page.waitForTimeout(30)
  const afterPaste = await source()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.f.ready())
  await assertFidelity('前 __保留__ 后\n', 'undo after paste')
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => window.f.ready())
  await assertFidelity(afterPaste, 'redo after paste')
  console.log('PASS E1: undo/redo restore exact pasted and original source')

  await reset('`AuthController` 与 __加粗__ 与 $x_1$ 与 \\*escape\\*\n')
  const idempotent = await source()
  for (let i = 0; i < 10; i++) {
    const saved = await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text)
    assert.equal(saved, idempotent, `save #${i + 1} must be byte-identical`)
    await reset(saved)
  }
  await assertFidelity(idempotent, 'ten save/reopen cycles')
  console.log('PASS E2: ten open/save cycles never accumulate backslashes')

  const plainText = await page.evaluate(async () => {
    const manager = window.f.manager
    const id = manager.openFile({
      token: 'plain',
      path: 'C:/workspace/说明/notes.log',
      name: 'notes.log',
      text: '',
      version: 'plain',
      encoding: 'UTF-8',
      bom: false,
      eol: 'LF',
      readOnly: false,
    })
    manager.dispatch(id, { changes: { from: 0, insert: '`AuthController` *x* _y_ [z] \\* $$' } })
    const text = manager.getText(id)
    const live = manager.liveViews.size
    for (const doc of [...manager.openedDocuments]) manager.close(doc.id, true)
    return { text, live }
  })
  assert.equal(plainText.text, '`AuthController` *x* _y_ [z] \\* $$', 'plain text edits must never use Markdown escaping')
  console.log('PASS E3: TXT/LOG documents never apply Markdown escaping')

  await reset('混合 `a` **b** [c](d) tail\n')
  await caretAt('tail', 2)
  await page.keyboard.type('Z')
  await page.waitForTimeout(30)
  const caretText = await page.evaluate(() => {
    const live = window.f.live()
    return { sourceSelection: live.selection, pm: live.view.state.selection.toJSON() }
  })
  assert.equal(await source(), '混合 `a` **b** [c](d) taZil\n', 'typing inside a word keeps all formatting')
  assert.equal(typeof caretText.sourceSelection.anchor, 'number')
  console.log('PASS E4: typing inside a word preserves all sibling formatting and caret mapping')

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`)
  fs.mkdirSync('test-results/markdown-source-fidelity', { recursive: true })
  fs.writeFileSync(
    path.join('test-results/markdown-source-fidelity', 'report.json'),
    `${JSON.stringify({ authCases, corpus: corpus.map(([label]) => label), pageErrors }, null, 2)}\n`
  )
  console.log('\n=== ALL MARKDOWN SOURCE FIDELITY TESTS PASSED ===\n')
  report.push('ok')
} finally {
  await browser.close()
  await server.close()
}
