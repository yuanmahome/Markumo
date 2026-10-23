// Actual DocumentManager -> lazy Live controller -> bridge -> canonical CM history.
// All documents, images and clipboard data are isolated fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import ts from 'typescript'

const { chromium } = await import(process.env.MARKUMO_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.MARKUMO_PLAYWRIGHT_MODULE).href : 'playwright')
const full = process.argv.includes('--full')
const profile = process.argv.includes('--profile')
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'current'
if (!/^[\w-]+$/.test(label)) throw Error('Invalid result label')
const output = 'test-results/phase-05'
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(`${output}/index.html`, '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="app" style="display:flex;height:720px"></div><script type="module" src="/scripts/fixtures/markdown-live-controller.js"></script>')
const sourceFile = 'src/editor/markdown/wysiwyg/MarkdownEditorController.ts'
const controllerSource = fs.readFileSync(sourceFile, 'utf8')
function metrics(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const methods = {}, branches = new Set([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.CaseClause, ts.SyntaxKind.CatchClause])
  function complexity(node) {
    let count = 0
    function visit(child) { if (branches.has(child.kind) || ts.isBinaryExpression(child) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind)) count++; ts.forEachChild(child, visit) }
    visit(node); return count
  }
  for (const statement of ast.statements) if (ts.isClassDeclaration(statement)) for (const member of statement.members) {
    if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
      const name = member.name?.getText(ast) || 'constructor', body = member.getText(ast)
      methods[name] = { lines: body.split('\n').length, decisionPoints: complexity(member), sha256: createHash('sha256').update(body).digest('hex') }
    }
  }
  return { lines: text.trimEnd().split('\n').length, bytes: Buffer.byteLength(text), decisionPoints: complexity(ast), methods }
}
const codeMetrics = { controller: metrics(sourceFile) }
if (controllerSource.includes("'./LiveTableToolbar'")) codeMetrics.toolbar = metrics('src/editor/markdown/wysiwyg/LiveTableToolbar.ts')

const rich = [
  '---', 'title: 保真 baseline', 'tags: [one, two]', '---', '',
  '# Title', '', '## Second', '', '### Third', '',
  'Alpha paragraph target with **bold**, *italic*, `inline <code>`, [link](./note.md), [reference][ref] and <span data-x="a&b">raw</span>.', '', '',
  '> quote', '>', '> second line', '',
  '1. first', '2. second', '', '- item', '- [ ] todo', '- [x] done', '',
  '| Left | Right |', '| :--- | ---: |', '| one | two |', '',
  '```typescript title="keep"', 'const n = "<tag>"', '```', '',
  '![pixel](./assets/pixel.png "relative image")', '',
  '<div data-preserve="a&b">HTML block<br>next</div>', '',
  'Math $x^2$ inline.', '', '$$', 'a+b=c', '$$', '',
  '[ref]: ./reference.md "keep definition"', '', '',
].join('\n')
const tableSource = '# Before\n\nAnchor paragraph.\n\n| A | B |\n| :--- | ---: |\n| one | two |\n\n# After\n\nTail paragraph.\n'
const server = await createServer({ server: { host: '127.0.0.1', port: 1452, strictPort: true, hmr: false, watch: null } })
await server.listen()
let browser, page
const results = [], errors = [], notices = [], failures = [], performanceResults = []
const test = async (name, work) => {
  try { await work(); results.push(name); console.log('PASS ' + name) }
  catch (error) { failures.push({ name, error: String(error), stack: error.stack }); console.error('FAIL ' + name + '\n' + error.stack) }
}
const source = () => page.evaluate(() => window.f.source())
const ready = () => page.waitForFunction(() => window.f.ready())
const reset = async text => { await page.evaluate(text => window.f.reset(text), text); await ready(); await page.locator('.md-prose').first().waitFor() }
const activeBar = () => page.locator('.md-table-tools.is-active')
const historyRoundTrip = async (before, work) => {
  const depth = await page.evaluate(() => window.f.history().undo)
  await work()
  const after = await source()
  assert.notEqual(after, before)
  assert.equal(await page.evaluate(() => window.f.history().undo), depth + 1, 'One logical action must add exactly one canonical undo event')
  await page.evaluate(() => window.f.undo()); await ready(); assert.equal(await source(), before)
  await page.evaluate(() => window.f.redo()); await ready(); assert.equal(await source(), after)
  return after
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.MARKUMO_CHROME, args: ['--no-sandbox'] })
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:1452/${output}/index.html`, { timeout: 45000 })
  await page.waitForFunction(() => window.f)

  if (!profile) {
    await test('embedded Markdown editors follow indentation defaults, saved settings, live changes and remounts', async () => {
      const before = '```text\nvalue\n```\n\n<div>HTML</div>\n'
      await reset(before)
      const code = pane => page.locator(`[data-pane="${pane}"] .md-code-block .cm-content`)
      const selectStart = async pane => {
        await code(pane).waitFor()
        await page.evaluate(pane => {
          const cm = window.f.CMView.findFromDOM(document.querySelector(`[data-pane="${pane}"] .md-code-block .cm-editor`))
          cm.dispatch({ selection: { anchor: 0 } }); cm.focus()
        }, pane)
      }
      const checkTab = async (pane, prefix) => {
        await selectStart(pane)
        await page.keyboard.press('Tab'); await ready()
        assert.equal(await page.evaluate(pane => window.f.CMView.findFromDOM(document.querySelector(`[data-pane="${pane}"] .md-code-block .cm-editor`)).state.doc.toString(), pane), prefix + 'value')
        assert((await source()).includes('\n' + prefix + 'value\n'))
        await page.keyboard.press('Shift+Tab'); await ready()
        assert.equal(await source(), before)
      }
      await checkTab('main', '  ')
      await page.evaluate(() => {
        const f = window.f
        f.manager.setMarkdownMode(f.id, 'source', 'main')
        f.manager.setIndent(4, false)
        f.manager.setMarkdownMode(f.id, 'live', 'main')
      }); await ready()
      await checkTab('main', '    ')
      await page.evaluate(() => window.f.split()); await ready()
      for (const [size, tabs] of [[2, false], [8, false], [4, true]]) {
        const depth = await page.evaluate(() => window.f.history().undo)
        await page.evaluate(([size, tabs]) => window.f.manager.setIndent(size, tabs), [size, tabs])
        assert.equal(await page.evaluate(() => window.f.history().undo), depth, 'Changing indentation must not add an undo event')
        for (const pane of await page.evaluate(() => window.f.panes)) {
          await checkTab(pane, tabs ? '\t' : ' '.repeat(size))
          assert.equal(await page.evaluate(pane => window.f.CMView.findFromDOM(document.querySelector(`[data-pane="${pane}"] .md-code-block .cm-editor`)).state.tabSize, pane), size)
        }
      }
      await page.evaluate(() => window.f.manager.setIndent(4, false))
      await page.locator('[data-pane="main"] .md-html-preview').click()
      const html = page.locator('[data-pane="main"] .md-html-source-editor .cm-content')
      await html.waitFor()
      await page.evaluate(() => {
        const cm = window.f.CMView.findFromDOM(document.querySelector('[data-pane="main"] .md-html-source-editor .cm-editor'))
        cm.dispatch({ selection: { anchor: 0 } }); cm.focus()
      })
      await page.keyboard.press('Tab'); await ready()
      assert((await source()).includes('    <div>HTML</div>'))
      await page.keyboard.press('Shift+Tab'); await ready()
      assert.equal(await source(), before)
    })
    await test('terminal components expose one clickable paragraph without changing clean source; typing, undo/redo and mode switches stay canonical', async () => {
      for (const text of ['```js\nlast code line\n```', '```mermaid\ngraph TD\nA-->B\n```',
        '| A | B |\n| --- | --- |\n| one | two |', '$$\nx^2\n$$', '---', '![pixel](./assets/pixel.png)', '<div>HTML block</div>']) {
        await page.evaluate(text => window.f.reset(text, true), text); await ready()
        for (let i = 0; i < 2; i++) {
          await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'source', 'main') })
          await page.locator('[data-pane="main"] > .cm-editor').waitFor()
          await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'live', 'main') }); await ready()
        }
        const before = await page.evaluate(() => {
          const f = window.f, doc = f.live().view.state.doc
          return { source: f.source(), dirty: f.manager.metadata(f.id).dirty, history: f.history().undo,
            placeholders: doc.content.content.filter(node => node.attrs.editorTrailing).length,
            lastType: doc.lastChild.type.name, lastSize: doc.lastChild.content.size }
        })
        assert.deepEqual(before, { source: text, dirty: false, history: 0, placeholders: 1, lastType: 'paragraph', lastSize: 0 })
        await page.locator('.md-prose > p:last-child').click({ position: { x: 8, y: 8 } })
        assert.equal(await source(), text, 'clicking the empty line must not modify source')
        await page.keyboard.insertText('After block')
        const after = text + '\n\nAfter block'
        await page.waitForFunction(expected => window.f.source() === expected, after)
        assert.equal(await page.evaluate(() => window.f.history().undo), 1)
        await page.evaluate(() => window.f.undo()); await ready()
        assert.equal(await source(), text)
        assert.equal(await page.evaluate(() => window.f.manager.metadata(window.f.id).dirty), false)
        await page.evaluate(() => window.f.redo()); await ready()
        assert.equal(await source(), after)
      }
    })
    await test('new code/table/formula/rule/image/diagram components get one trailing line, ordinary inline content gets none', async () => {
      for (const command of ['code-block', 'table', 'table-picker', 'math', 'rule', 'image', 'diagram']) {
        await reset('')
        await page.evaluate(async command => {
          const f = window.f, editor = f.live()
          if (command === 'table-picker') editor.insertTable(3, 4)
          else if (command === 'math') editor.insertToolbar('math')
          else if (command === 'diagram') await f.paste('```mermaid\ngraph TD\nA-->B\n```')
          else editor.format(command)
        }, command)
        const last = await page.evaluate(() => {
          const doc = window.f.live().view.state.doc
          return { type: doc.lastChild.type.name, size: doc.lastChild.content.size,
            emptyParagraphs: doc.content.content.filter(node => node.type.name === 'paragraph' && !node.content.size).length }
        })
        assert.deepEqual(last, { type: 'paragraph', size: 0, emptyParagraphs: 1 }, command)
      }
      for (const text of ['Plain text', 'Text with $x^2$ inline.', 'Text with `code`.', '[link](https://example.com)', 'Before ![pixel](./assets/pixel.png) after']) {
        await reset(text)
        assert.equal(await page.evaluate(() => window.f.live().view.state.doc.childCount), 1)
        assert.equal(await source(), text)
      }
    })
    await test('bottom canvas, ArrowDown, Enter and Ctrl+Enter escape terminal code; multi-pane insertion and history stay identical', async () => {
      const text = '```js\nlast\n```'
      await reset(text)
      const canvas = await page.locator('.markdown-live').boundingBox()
      await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height - 25)
      await page.keyboard.insertText('Clicked below')
      assert.equal(await source(), text + '\n\nClicked below')
      await page.evaluate(() => window.f.undo()); await ready()
      await page.locator('.md-code-block .cm-content').click()
      await page.keyboard.press('Control+End'); await page.keyboard.press('ArrowDown')
      await page.keyboard.insertText('Outside code')
      assert.equal(await source(), text + '\n\nOutside code')
      await page.evaluate(() => window.f.undo()); await ready()
      await page.locator('.md-code-block .cm-content').click()
      await page.keyboard.press('Control+Enter')
      assert.equal(await page.evaluate(() => window.f.live().view.state.doc.childCount), 2, 'reuse the existing trailing paragraph')
      await page.keyboard.insertText('Shortcut')
      assert.equal(await source(), text + '\n\nShortcut')
      await reset(text)
      await page.evaluate(() => window.f.split()); await ready()
      await page.locator('[data-pane="main"] .md-prose > p:last-child').click()
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
      await page.keyboard.insertText('After empty lines'); await ready()
      assert.equal(await source(), text + '\n\n\n\n\n\nAfter empty lines')
      const docs = await page.evaluate(() => { const f = window.f; return f.panes.map(pane => f.live(pane).view.state.doc.toJSON()) })
      assert.deepEqual(docs[0], docs[1])
      await reset('')
      await page.evaluate(() => window.f.split()); await ready()
      await page.evaluate(() => window.f.live('main').format('code-block')); await ready()
      const inserted = await page.evaluate(() => { const f = window.f; return f.panes.map(pane => f.live(pane).view.state.doc.toJSON()) })
      assert.deepEqual(inserted[0], inserted[1])
      await page.evaluate(() => window.f.undo()); await ready()
      assert.equal(await source(), '')
    })
    await test('source fidelity: untouched Live/source switches preserve all fixture syntax, blank lines and final newlines', async () => {
      await reset(rich)
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'source', 'main') })
        await page.locator('[data-pane="main"] > .cm-editor').waitFor()
        assert.equal(await source(), rich)
        await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'live', 'main') }); await ready()
        assert.equal(await source(), rich)
      }
      assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), rich)
    })
    await test('local edit: unrelated raw blocks, fence info, HTML and source tail remain exact; save/undo/redo share canonical history', async () => {
      await reset(rich)
      const after = await historyRoundTrip(rich, async () => {
        await page.evaluate(() => { window.f.caret('Alpha paragraph target'); window.f.insert(' EDIT') })
      })
      const unaffected = rich.slice(rich.indexOf('\n\n\n> quote'))
      assert(after.endsWith(unaffected))
      const publications = await page.evaluate(() => window.f.publications)
      assert.equal(publications.length, 1)
      assert(publications[0].patch.from > rich.indexOf('Alpha'))
      assert(publications[0].patch.to < rich.indexOf('> quote'))
      assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), after)
    })
    for (const operation of ['typing', 'delete', 'join']) {
      await test(`${operation}: canonical undo groups one user action and redo restores it`, async () => {
        const before = 'First paragraph\n\nSecond paragraph\n\nThird paragraph\n'
        await reset(before)
        if (operation === 'typing') {
          await page.evaluate(() => window.f.caret('First paragraph'))
          // Separate native key events exercise history grouping; a single
          // insertText('abc') transaction cannot detect fragmented typing undo.
          await page.keyboard.type('abc')
          await page.waitForFunction(() => window.f.source().includes('First paragraphabc'))
          const typed = await source()
          assert.equal(await page.evaluate(() => window.f.history().undo), 1)
          await page.evaluate(() => window.f.undo()); assert.equal(await source(), before)
          await page.evaluate(() => window.f.redo()); assert.equal(await source(), typed)
          return
        }
        await historyRoundTrip(before, async () => {
          await page.evaluate(operation => {
            const f = window.f, view = f.live().view
            if (operation === 'delete') { const { node, pos } = f.node('paragraph', 1); view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).setMeta('isolated', true)) }
            else { const { pos } = f.node('paragraph', 1); view.dispatch(view.state.tr.join(pos).setMeta('isolated', true)) }
          }, operation)
        })
      })
    }
    await test('consecutive native Backspace input forms one shared delete history event', async () => {
      const before = 'First paragraph\n\nTail paragraph\n'
      await reset(before)
      await page.evaluate(() => window.f.caret('First paragraph'))
      for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
      const deleted = before.replace('First paragraph', 'First paragraph'.slice(0, -3))
      await page.waitForFunction(text => window.f.source() === text, deleted)
      assert.equal(await page.evaluate(() => window.f.history().undo), 1)
      assert.deepEqual(await page.evaluate(() => window.f.publications.map(item => item.userEvent)), Array(3).fill('delete.markdown'))
      await page.evaluate(() => window.f.undo()); await ready(); assert.equal(await source(), before)
      await page.evaluate(() => window.f.redo()); await ready(); assert.equal(await source(), deleted)
    })
    for (const action of ['format', 'paste']) {
      await test(`${action} remains isolated from native typing on both sides in canonical history`, async () => {
        const before = 'First target\n\nTail paragraph\n'
        await reset(before)
        await page.evaluate(() => window.f.caret('First target'))
        await page.keyboard.type('abc')
        await page.waitForFunction(() => window.f.source().includes('targetabc'))
        const typed = await source()
        assert.equal(await page.evaluate(() => window.f.history().undo), 1)
        await page.evaluate(async action => {
          const f = window.f
          if (action === 'format') { f.range('target'); f.live().format('bold') }
          else await f.paste('PASTED')
        }, action)
        const isolated = await source()
        assert.notEqual(isolated, typed)
        assert.equal(await page.evaluate(() => window.f.history().undo), 2)
        await page.evaluate(text => window.f.caret(text), action === 'format' ? 'abc' : 'PASTED')
        await page.keyboard.type('xyz')
        await page.waitForFunction(() => window.f.source().includes('xyz'))
        const final = await source()
        assert.equal(await page.evaluate(() => window.f.history().undo), 3, 'Typing after an isolated command must form a new group')
        assert.deepEqual(await page.evaluate(() => window.f.publications.map(item => item.userEvent)), [
          ...Array(3).fill('input.type.markdown'), 'input.markdown', ...Array(3).fill('input.type.markdown'),
        ])
        for (const expected of [isolated, typed, before]) {
          await page.evaluate(() => window.f.undo()); await ready(); assert.equal(await source(), expected)
        }
        for (const expected of [typed, isolated, final]) {
          await page.evaluate(() => window.f.redo()); await ready(); assert.equal(await source(), expected)
        }
      })
    }
    await test('bold, italic, link and inserted table each undo in one step across Live/source mode changes', async () => {
      for (const format of ['bold', 'italic', 'link', 'table']) {
        const before = 'Format target\n'
        await reset(before)
        await historyRoundTrip(before, async () => { await page.evaluate(format => { window.f.range('target'); window.f.live().format(format) }, format) })
        const edited = await source()
        await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'source', 'main'); f.manager.command('undo') })
        assert.equal(await source(), before)
        await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'live', 'main') }); await ready()
        await page.evaluate(() => window.f.redo()); await ready(); assert.equal(await source(), edited)
      }
    })
    await test('real table toolbar: alignment, add/delete rows and columns, delete table; menu closes and every action is isolated', async () => {
      for (const action of ['居中对齐', '前插行', '后插行', '删除行', '前插列', '后插列', '删除列', '删除表格']) {
        await reset(tableSource)
        await page.locator('.md-prose td').first().click()
        await activeBar().waitFor({ state: 'visible' })
        await historyRoundTrip(tableSource, async () => {
          if (!['居中对齐', '删除表格'].includes(action)) {
            await activeBar().getByRole('button', { name: '表格行列操作', exact: true }).click()
            await activeBar().getByRole('button', { name: action, exact: true }).click()
          } else await activeBar().getByRole('button', { name: action, exact: true }).click()
          assert.equal(await page.locator('.md-table-menu:not([hidden])').count(), 0)
        })
      }
    })
    await test('toolbar geometry, outside/Escape closing, preserved cell selection and multiple tables after position mapping', async () => {
      await reset(tableSource + '\n' + tableSource.replaceAll('one', 'other'))
      const before = await page.locator('.md-prose table').evaluateAll(tables => tables.map(table => table.getBoundingClientRect().top))
      await page.locator('.md-prose td').nth(2).click()
      await activeBar().waitFor({ state: 'visible' })
      assert.equal(await activeBar().count(), 1)
      assert.deepEqual(await page.locator('.md-prose table').evaluateAll(tables => tables.map(table => table.getBoundingClientRect().top)), before)
      const selection = await page.evaluate(() => window.f.live().view.state.selection.toJSON())
      await activeBar().getByRole('button', { name: '更多操作', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.f.live().view.state.selection.toJSON()), selection)
      await page.keyboard.press('Escape')
      assert.equal(await activeBar().getByRole('button', { name: '更多操作', exact: true }).getAttribute('aria-expanded'), 'false')
      await activeBar().getByRole('button', { name: '更多操作', exact: true }).click()
      await page.locator('.md-prose h1').first().click()
      assert.equal(await page.locator('.md-table-menu:not([hidden])').count(), 0)
      await page.evaluate(() => { window.f.caret('Anchor paragraph.', false); window.f.insert('prefix ') })
      await page.locator('.md-prose td').nth(2).click()
      await activeBar().getByRole('button', { name: '表格行列操作', exact: true }).click()
      await activeBar().getByRole('button', { name: '后插行', exact: true }).click()
      const rows = await page.locator('.md-prose table').evaluateAll(tables => tables.map(table => table.rows.length))
      assert.deepEqual(rows, [2, 3])
      assert.equal(await page.evaluate(() => window.f.snapshot().toolbars), 2)
    })
    for (const modes of [['live', 'live'], ['source', 'live'], ['live', 'source']]) {
      await test(`multi-pane ${modes.join('/')}: one publish, remote selection/focus, shared undo, tag restore and surviving state`, async () => {
        await reset('First target\n\nSecond target\n')
        const secondary = await page.evaluate(() => window.f.split()); await ready()
        await page.evaluate(({ modes, secondary }) => {
          const f = window.f
          f.manager.setMarkdownMode(f.id, modes[0], 'main'); f.manager.setMarkdownMode(f.id, modes[1], secondary)
        }, { modes, secondary }); await ready()
        const editing = modes[0] === 'live' ? 'main' : secondary
        const remote = editing === 'main' ? secondary : 'main'
        const remoteBefore = await page.evaluate(remote => {
          const f = window.f
          if (f.live(remote)) { f.caret('Second target', true, remote); return f.live(remote).view.state.selection.toJSON() }
          const view = f.manager.paneView(remote)
          view.dispatch({ selection: { anchor: f.source().indexOf('Second target') + 'Second target'.length } })
          return { head: view.state.selection.main.head }
        }, remote)
        await historyRoundTrip('First target\n\nSecond target\n', async () => {
          await page.evaluate(editing => { window.f.caret('First target', true, editing); window.f.insert(' changed', editing) }, editing)
          await ready()
          assert.equal(await page.evaluate(() => window.f.publications.length), 1)
          assert.equal(await page.evaluate(editing => window.f.live(editing).view.hasFocus(), editing), true)
          if (modes.includes('source')) {
            assert.equal(await page.evaluate(remote => window.f.manager.paneView(remote).state.doc.toString(), remote), await source(), 'Live edit must immediately reach the source pane')
            assert.equal(await page.evaluate(remote => window.f.manager.paneView(remote).state.selection.main.head, remote), remoteBefore.head + ' changed'.length, 'Source caret must map through the Live patch')
            assert.equal(await page.evaluate(remote => window.f.manager.paneView(remote).hasFocus, remote), false, 'Publishing must not steal focus from Live')
          }
          if (modes.every(mode => mode === 'live')) {
            const after = await page.evaluate(remote => window.f.live(remote).view.state.selection.toJSON(), remote)
            assert.equal(after.anchor - remoteBefore.anchor, ' changed'.length)
          }
        })
        // A source-pane edit propagates to the Live sibling through the same record.
        if (modes.includes('source')) {
          const text = await source()
          assert.equal(await page.evaluate(remote => window.f.manager.paneView(remote).state.doc.toString(), remote), text, 'Source pane must reflect the canonical document after Live edit and shared undo/redo')
          await historyRoundTrip(text, async () => {
            await page.evaluate(remote => {
              const f = window.f
              f.manager.focusPane(remote)
              f.manager.paneView(remote).dispatch({ selection: { anchor: 0 } })
            }, remote)
            // Actual browser input after the Live edit catches stale source
            // View/change-set lengths, rather than dispatching only via manager.
            await page.keyboard.insertText('S ')
            await ready()
            assert.equal(await source(), 'S ' + text)
            assert.equal(await page.evaluate(remote => window.f.manager.paneView(remote).state.doc.toString(), remote), 'S ' + text)
            assert.equal(await page.evaluate(remote => window.f.manager.paneView(remote).hasFocus, remote), true)
            assert.equal(await page.evaluate(() => window.f.publications.length), 1, 'Source input must not trigger a second Live publication')
          })
          assert.equal(await page.evaluate(remote => window.f.manager.paneView(remote).state.doc.toString(), remote), await source(), 'Both source undo and redo must keep the source View current')
        }
        const saved = await source()
        await page.evaluate(editing => {
          const f = window.f, other = f.manager.createUntitled('txt')
          f.manager.select(other, editing); f.manager.select(f.id, editing)
        }, editing); await ready(); assert.equal(await source(), saved)
        await page.evaluate(secondary => { const f = window.f; f.manager.closePane(secondary); f.panes.splice(f.panes.indexOf(secondary), 1) }, secondary)
        assert.equal(await source(), saved)
        assert.equal(await page.evaluate(() => !!window.f.manager.getState(window.f.id)), true)
      })
    }
    for (const modes of [['source', 'live'], ['live', 'source']]) {
      await test(`native typing in ${modes.join('/')} shares one undo group with source keyboard undo and Live keyboard redo`, async () => {
        const before = 'First target\n\nSecond target\n'
        await reset(before)
        const secondary = await page.evaluate(() => window.f.split()); await ready()
        await page.evaluate(({ modes, secondary }) => {
          const f = window.f
          f.manager.setMarkdownMode(f.id, modes[0], 'main'); f.manager.setMarkdownMode(f.id, modes[1], secondary)
        }, { modes, secondary }); await ready()
        const livePane = modes[0] === 'live' ? 'main' : secondary
        const sourcePane = livePane === 'main' ? secondary : 'main'
        await page.evaluate(pane => window.f.caret('First target', true, pane), livePane)
        await page.keyboard.type('abc')
        const typed = before.replace('First target', 'First targetabc')
        await page.waitForFunction(text => window.f.source() === text, typed)
        assert.equal(await page.evaluate(pane => window.f.manager.paneView(pane).state.doc.toString(), sourcePane), typed)
        assert.equal(await page.evaluate(() => window.f.history().undo), 1)
        await page.evaluate(pane => window.f.manager.focusPane(pane), sourcePane)
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
        await page.waitForFunction(text => window.f.source() === text, before); await ready()
        assert.equal(await page.evaluate(pane => window.f.manager.paneView(pane).state.doc.toString(), sourcePane), before)
        await page.evaluate(pane => window.f.manager.focusPane(pane), livePane)
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
        await page.waitForFunction(text => window.f.source() === text, typed); await ready()
        assert.equal(await page.evaluate(pane => window.f.manager.paneView(pane).state.doc.toString(), sourcePane), typed)
        assert.equal(await page.evaluate(() => window.f.history().undo), 1)
        assert.deepEqual(await page.evaluate(() => window.f.publications.map(item => item.userEvent)), Array(3).fill('input.type.markdown'))
      })
    }
    await test('IME blocks mode switches and unmount cancels pending inline-entry work and embedded editors', async () => {
      await reset('Compose **target**\n\n```js\nconst value = 1\n```\n')
      const globalBefore = await page.evaluate(() => window.f.snapshot().globalListeners)
      const value = await page.evaluate(() => {
        const f = window.f, editor = f.live()
        editor.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        const blocked = f.manager.setMarkdownMode(f.id, 'source', 'main')
        const mode = f.manager.getMarkdownMode(f.id, 'main')
        editor.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        return { blocked, mode }
      })
      assert.deepEqual(value, { blocked: false, mode: 'live' })
      const disposed = await page.evaluate(async () => { const f = window.f; f.caret('target'); const result = f.dispose(); await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(resolve)); return { ...result, globalsAfter: f.snapshot().globalListeners } })
      assert.equal(disposed.pmDestroyed, true); assert.equal(disposed.cmDestroyed, true); assert.equal(disposed.rootsRemoved, true); assert.equal(disposed.remaining, 0)
      assert(disposed.globalsAfter < globalBefore, 'Code language selector global listeners must be removed')
    })
    if (codeMetrics.toolbar) await test('extracted toolbar owns one listener across table remapping; destroy is repeatable and stale buttons are inert', async () => {
      await reset(tableSource)
      const res = await page.evaluate(() => {
        const f = window.f, editor = f.live(), root = editor.dom, toolbar = editor.tableToolbar
        const button = root.querySelector('.md-table-tools button')
        const before = f.listenerCount(root, 'mousedown')
        for (let i = 0; i < 30; i++) { f.caret('Anchor paragraph.'); f.insert('x') }
        const after = f.listenerCount(root, 'mousedown')
        f.dispose()
        toolbar.destroy(); toolbar.destroy(); button.click()
        toolbar.forTable(1)
        return { before, after, disposed: f.listenerCount(root, 'mousedown'), attached: root.isConnected, remaining: document.querySelectorAll('.md-table-tools').length }
      })
      assert.deepEqual(res, { before: 1, after: 1, disposed: 0, attached: false, remaining: 0 })
    })
  }

  if (full && !profile) {
    await test('code NodeView: visible floating language selector, language edit and embedded CM undo', async () => {
      const before = 'Intro\n\n```js\nconst value = 1\n```\n\nTail\n'
      await reset(before)
      const block = page.locator('.md-code-block')
      const geometry = await block.boundingBox()
      await block.locator('.cm-content').click()
      const language = block.getByRole('button', { name: /^代码语言：/ })
      await language.waitFor({ state: 'visible' }); await language.click()
      const input = block.getByRole('combobox')
      await input.fill('python'); await input.press('Enter')
      await page.waitForFunction(() => window.f.source().includes('```python'))
      assert.equal((await block.boundingBox()).height, geometry.height)
      const languageChanged = await source()
      await historyRoundTrip(languageChanged, async () => {
        await block.locator('.cm-content').click(); await page.keyboard.press('End'); await page.keyboard.insertText(' # edit')
      })
    })
    await test('code block multiline paste stays raw, one undo, selection/empty/long/unicode/fence safe and mode/save stable', async () => {
      const before = 'Intro\n\n```js\nstart\n```\n\nTail\n'
      await reset(before)
      const block = page.locator('.md-code-block')
      await block.locator('.cm-content').click()
      await page.keyboard.press('End')
      const pasted = 'line1\n  line2\n\nline4\n\tconst x = "值 😀" # markdown `inline`\n\n```\nfenced-looking\n```'
      const after = await historyRoundTrip(before, async () => { await page.evaluate(text => window.f.paste(text), pasted) })
      assert(after.includes('```js\nstartline1\n  line2\n\nline4\n\tconst x = "值 😀" # markdown `inline`\n\n```\nfenced-looking\n```\n```'))
      assert.equal(await page.evaluate(() => window.f.CMView.findFromDOM(document.querySelector('.md-code-block .cm-editor')).state.doc.toString()), 'start' + pasted)
      assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), after)

      // Replace a real multi-line selection inside the code block, not just an
      // empty caret. The operation must remain one canonical transaction.
      await page.evaluate(() => {
        const f = window.f, cm = f.CMView.findFromDOM(document.querySelector('.md-code-block .cm-editor'))
        cm.dispatch({ selection: { anchor: 5, head: 5 + 'line1\n  line2'.length } })
        cm.focus()
      })
      const selectedBefore = await source()
      const selectedAfter = await historyRoundTrip(selectedBefore, async () => { await page.evaluate(() => window.f.paste('A\n\nB')) })
      assert(selectedAfter.includes('startA\n\nB\n\nline4'))

      // Empty fence and long content.
      await reset('Intro\n\n```\n```\n\nTail\n')
      await page.locator('.md-code-block .cm-content').click()
      const long = Array.from({ length: 120 }, (_, i) => `row ${i}\tvalue \`${i}\``).join('\n')
      const emptyAfter = await historyRoundTrip('Intro\n\n```\n```\n\nTail\n', async () => { await page.evaluate(text => window.f.paste(text), long) })
      assert(emptyAfter.includes('```\n' + long + '\n```'))
      await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'source', 'main') })
      await page.locator('[data-pane="main"] > .cm-editor').waitFor()
      assert.equal(await source(), emptyAfter)
      await page.evaluate(() => { const f = window.f; f.manager.setMarkdownMode(f.id, 'live', 'main') }); await ready()
      assert.equal(await source(), emptyAfter)
    })
    await test('code block paste keeps blank lines and unicode while ordinary Markdown paste keeps rich parsing', async () => {
      const before = 'Intro\r\n\r\n```js\r\nstart\r\n```\r\n\r\nTail\r\n'
      await reset(before)
      await page.locator('.md-code-block .cm-content').click()
      await page.keyboard.press('End')
      const normalizedBefore = before.replace(/\r\n/g, '\n')
      const after = await historyRoundTrip(normalizedBefore, async () => { await page.evaluate(() => window.f.paste('a\r\nb')) })
      assert(after.includes('starta\nb'))
      await reset('Intro\n\nTail\n')
      await page.evaluate(() => window.f.caret('Intro'))
      await page.evaluate(() => window.f.paste('**bold** 中文'))
      assert((await source()).includes('Intro**bold** 中文'))
    })
    await test('removed selection bubble leaves selection, keyboard formatting and context menu intact', async () => {
      await reset('Alpha target here.\n\n```js\ncode here\n```\n')
      await page.evaluate(() => window.f.range('target'))
      await page.waitForTimeout(40)
      assert.equal(await page.locator('.md-selection-bubble').count(), 0)
      const before = await source()
      await page.evaluate(() => window.f.live().format('bold'))
      await ready()
      assert.equal(await source(), before.replace('target', '**target**'))
      await page.locator('.md-code-block .cm-content').click()
      await page.keyboard.press('Control+a')
      await page.waitForTimeout(30)
      assert.equal(await page.locator('.md-selection-bubble').count(), 0)
      await page.locator('.md-prose p').first().click({ button: 'right' })
      await page.locator('.md-context-menu').waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
    })
    await test('image paste and complete source: relative destination and shared document undo', async () => {
      await reset('Intro\n\nTail\n')
      const before = await source()
      await historyRoundTrip(before, async () => {
          await page.evaluate(async () => {
          const f = window.f; f.caret('Intro')
          await f.paste('![pasted](./assets/pixel.png)')
        })
      })
      await page.locator('.md-live-image img').waitFor()
      await page.locator('.md-live-image img').click()
      await page.getByRole('textbox', { name: '图片局部源码', exact: true }).waitFor()
      const selected = await page.evaluate(() => window.f.manager.getState(window.f.id).selection.main.head)
      assert(selected >= (await source()).indexOf('![pasted]'))
      const initial = await source()
      await historyRoundTrip(initial, async () => {
        await page.getByRole('textbox', { name: '图片局部源码', exact: true }).fill('![changed alt](./assets/pixel.png)')
      })
      assert((await source()).includes('./assets/pixel.png'))
    })
    await test('inline source, link properties, HTML block source and protected YAML expand/collapse preserve unrelated blocks', async () => {
      await reset(rich)
      await page.locator('.md-prose strong').click()
      const inline = page.getByRole('textbox', { name: '行内 Markdown 源码', exact: true })
      await inline.waitFor()
      await inline.fill('**bold changed**')
      await page.waitForFunction(() => window.f.source().includes('**bold changed**'))
      await inline.press('Escape')
      // Leave the inline source gesture before opening another target's menu.
      await page.locator('.md-prose h1').click()
      await page.locator('.md-prose a').first().click()
      await page.getByRole('textbox', { name: '行内 Markdown 源码', exact: true }).press('Escape')
      await page.locator('.md-source-link').waitFor({ state: 'detached' })
      const linkBox = await page.locator('.md-prose a').first().boundingBox()
      // Use a real MouseEvent at the visible link to exercise the production
      // menu handler without repeating the separate inline-entry pointer gesture.
      await page.locator('.md-prose a').first().evaluate((link, box) => link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.x + 2, clientY: box.y + 2 })), linkBox)
      await page.getByRole('menuitem', { name: '链接属性…', exact: true }).click()
      await page.getByRole('textbox', { name: '链接 URL', exact: true }).fill('./updated.md')
      await page.getByRole('button', { name: '应用链接', exact: true }).click()
      assert((await source()).includes('./updated.md'))
      const html = page.locator('.md-html-block-view')
      await html.click(); await html.locator('.cm-editor').waitFor()
      const before = await source()
      await historyRoundTrip(before, async () => {
        await html.locator('.cm-content').click(); await page.keyboard.press('End'); await page.keyboard.insertText('<!--keep-->')
      })
      // Undo/redo can recreate the NodeView in preview mode.
      if (await html.locator('.cm-editor').count() === 0) await html.click()
      await html.getByRole('button', { name: '完成', exact: true }).click()
      await page.locator('.md-frontmatter-edit-raw').click()
      const yaml = page.getByRole('textbox', { name: 'YAML Front Matter', exact: true })
      await yaml.waitFor(); await yaml.press('Escape')
      await page.locator('.md-frontmatter-card').waitFor()
      assert((await source()).startsWith(rich.slice(0, rich.indexOf('# Title'))))
      assert((await source()).endsWith('[ref]: ./reference.md "keep definition"\n\n'))
    })
    await test('rapid tab changes and close while Live module is still loading never resurrect a closed pane', async () => {
      // A fresh page/network gate actually pauses DocumentManager's lazy import.
      const pendingPage = await browser.newPage()
      pendingPage.on('pageerror', error => errors.push(error.message))
      let release, requested
      const gate = new Promise(resolve => { release = resolve }), reached = new Promise(resolve => { requested = resolve })
      await pendingPage.route('**/MarkdownEditorController.ts*', async route => { requested(); await gate; await route.continue() })
      try {
        await pendingPage.goto(`http://127.0.0.1:1452/${output}/index.html`)
        await pendingPage.evaluate(() => window.f.reset('Delayed\n'))
        await reached
        await pendingPage.evaluate(() => window.f.dispose())
        release()
        await pendingPage.waitForFunction(() => window.f.manager.liveLoads.size === 0)
        assert.equal(await pendingPage.locator('.markdown-live,.cm-editor').count(), 0)
        assert.deepEqual(await pendingPage.evaluate(() => window.notices), [])
      } finally { release(); await pendingPage.close() }
      for (let i = 0; i < 8; i++) { await reset(tableSource); await page.evaluate(() => window.f.dispose()) }
      assert.equal(await page.locator('.markdown-live,.md-table-tools,.md-properties,.md-context-menu').count(), 0)
    })
  }

  if (profile) {
    const fixtures = {
      normal: tableSource + '\n' + 'Paragraph normal words.\n\n'.repeat(20),
      codeHeavy: '# Code heavy\n\n' + Array.from({ length: 30 }, (_, i) => `\`\`\`js\nconst value${i} = ${i}\n\`\`\`\n\n`).join(''),
      long: '# Long\n\n' + Array.from({ length: 900 }, (_, i) => `Paragraph ${i} ${'long text '.repeat(8)}\n\n`).join(''),
      dualPane: tableSource, modeSwitch: tableSource + '\n```js\nconst n = 1\n```\n', toolbarCycles: tableSource,
    }
    // One untimed warm-up per scenario; seven measured repetitions, same process.
    for (const [scenario, text] of Object.entries(fixtures)) {
      const samples = []
      for (let repetition = -1; repetition < 7; repetition++) {
        const started = performance.now()
        await reset(text)
        if (scenario === 'dualPane') { await page.evaluate(() => window.f.split()); await ready() }
        const initMs = performance.now() - started
        const sample = await page.evaluate(async scenario => {
          const f = window.f, view = f.live('main').view
          view.focus()
          const before = f.snapshot(), edits = []
          for (let i = 0; i < 12; i++) {
            const start = performance.now()
            view.dispatch(view.state.tr.insertText('x', 1).setMeta('isolated', true))
            edits.push(performance.now() - start)
          }
          const cycleStart = performance.now()
          if (scenario === 'modeSwitch') {
            for (let i = 0; i < 8; i++) {
              f.manager.setMarkdownMode(f.id, 'source', 'main')
              f.manager.setMarkdownMode(f.id, 'live', 'main')
              while (!f.ready()) await new Promise(resolve => setTimeout(resolve, 0))
            }
          }
          if (scenario === 'toolbarCycles') {
            const { pos } = f.node('table')
            const v = f.live().view
            v.dispatch(v.state.tr.setSelection(f.TextSelection.near(v.state.doc.resolve(pos + 3))))
            for (let i = 0; i < 80; i++) {
              const button = document.querySelector('.md-table-tools.is-active [aria-label="更多操作"]')
              button.click(); button.click()
            }
          }
          const cycleMs = performance.now() - cycleStart, after = f.snapshot()
          const disposed = f.dispose()
          await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(resolve))
          return { edits, cycleMs, before, after, disposed }
        }, scenario)
        assert.equal(sample.disposed.pmDestroyed, true); assert.equal(sample.disposed.cmDestroyed, true); assert.equal(sample.disposed.remaining, 0)
        if (repetition >= 0) samples.push({ initMs, ...sample })
      }
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
      const edits = samples.flatMap(sample => sample.edits).sort((a, b) => a - b)
      const result = { scenario, sourceBytes: Buffer.byteLength(text), repetitions: samples.length, initMedianMs: median(samples.map(sample => sample.initMs)),
        editMedianMs: median(edits), editP95Ms: edits[Math.floor(edits.length * .95)], cycleMedianMs: median(samples.map(sample => sample.cycleMs)),
        mounted: samples[0].before, afterCycles: samples[0].after, disposed: samples[0].disposed }
      performanceResults.push(result); console.log('PROFILE ' + JSON.stringify(result))
    }
  }
  notices.push(...await page.evaluate(() => window.notices))
  assert.deepEqual(errors, [])
  assert.deepEqual(notices, [], 'Product error notices must not conceal rejected edits or late callback failures')
  if (failures.length) throw Error(`${failures.length} Markdown Live baseline/regression case(s) failed; see ${output}/${label}-${full ? 'full' : 'smoke'}.json`)
  console.log(`PASS all ${results.length} Markdown Live controller regressions${profile ? ' and 6 performance scenarios' : ''}`)
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: `${output}/${label}-failure.png` }).catch(() => {})
  throw error
} finally {
  fs.writeFileSync(`${output}/${label}-${profile ? 'performance' : full ? 'full' : 'smoke'}.json`, JSON.stringify({ label, full, profile, controllerHash: createHash('sha256').update(controllerSource).digest('hex'), codeMetrics, results, failures, errors, notices, performanceResults }, null, 2))
  await browser?.close(); await server.close()
}
