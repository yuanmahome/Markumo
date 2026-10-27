import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Exercise the real App, preferences, menus, commands, panes and outline view.
// Only expose the existing shell and inject the existing language-loader seam.
const results = [], errors = []
const server = await createServer({ server: { host: '127.0.0.1', port: 1482, strictPort: true, hmr: false, watch: null }, cacheDir: 'node_modules/.vite-outline', plugins: [{
  name: 'outline-ui-test-observation', enforce: 'pre', load(id) {
    const name = id.replaceAll('\\', '/')
    if (name.endsWith('/app/useAppShell.ts')) {
      let code = fs.readFileSync(id, 'utf8')
      code = "import { loadLanguage as __outlineLoadLanguage } from '../editor/languages'\n" + code
      code = code.replace('new DocumentManager(demo ? sampleDocuments : [])', 'new DocumentManager(demo ? sampleDocuments : [], name => (window as any).__outlineLoader(name, __outlineLoadLanguage))')
      code = code.replace('\n  return {', '\n  const shellForOutlineTest = {')
      const end = code.lastIndexOf('}')
      return code.slice(0, end) + '\n  ;(window as any).__outlineShell = shellForOutlineTest\n  return shellForOutlineTest\n' + code.slice(end)
    }
    if (name.endsWith('/outline/outlineService.ts')) return fs.readFileSync(id, 'utf8').replace('function markdownOutline(text: Text): OutlineItem[] {', 'function markdownOutline(text: Text): OutlineItem[] {\n (window as any).__outlineExtractions++;')
    if (name.endsWith('/outline/codeAdapters.ts')) return fs.readFileSync(id, 'utf8').replace('const adapter=codeAdapters[language]', '(window as any).__outlineExtractions++;\n  const adapter=codeAdapters[language]')
  },
} ] })
await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}) })
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(() => {
  if (!localStorage.getItem('markumo.settings.v1')) localStorage.setItem('markumo.settings.v1', JSON.stringify({ showOutline: true, outlineWidth: 310, autoCheckUpdates: false }))
  window.__outlineExtractions = 0; window.__outlineGate = 'normal'; window.__outlineSerial = 0
  window.__outlineLoader = (name, base) => {
    if (name !== 'Java' || window.__outlineGate === 'normal') return base(name)
    if (window.__outlineGate === 'fail') return Promise.reject(Error('Controlled parser load failure'))
    return new Promise((resolve, reject) => { window.__outlinePending = { resolve: () => resolve(base(name)), reject } })
  }
})
const aside = page.locator('.outline-sidebar')
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const pref = () => page.evaluate(() => window.__outlineShell.showOutline.value)
const outlineShortcut = async () => page.keyboard.press(await page.evaluate(() => window.__outlineShell.shortcuts.value['toggle-outline'].replace('Mod', 'Control')))
const snapshot = () => page.evaluate(() => {
  const s = window.__outlineShell, panel = document.querySelector('.outline-sidebar')
  return { preference: s.showOutline.value, supported: s.outlineSupported.value, capability: panel?.dataset.capability,
    status: panel?.dataset.parseStatus, shown: panel && getComputedStyle(panel).display !== 'none',
    width: document.querySelector('.editor-main')?.getBoundingClientRect().width,
    savedWidth: s.outlineWidth.value, position: s.effectiveOutlinePosition.value, symbols: [...document.querySelectorAll('.outline-item')].map(el => el.textContent),
    activePane: s.manager.activePane, text: s.manager.getText(s.manager.activeId), extractions: window.__outlineExtractions }
})
async function open(name, text, language) {
  await page.evaluate(({ name, text, language }) => {
    const s = window.__outlineShell, serial = ++window.__outlineSerial
    const id = s.manager.openFile({ token: `outline-${serial}`, path: `C:/outline-tests/${serial}/${name}`, name, text, encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: false, version: 'test' })
    if (language) void s.manager.setLanguage(id, language)
  }, { name, text, language })
  await settle()
}
async function parsed(status = 'ready') { await page.waitForFunction(status => document.querySelector('.outline-sidebar')?.dataset.parseStatus === status, status) }
async function shown(expected) { await page.waitForFunction(expected => (getComputedStyle(document.querySelector('.outline-sidebar')).display !== 'none') === expected, expected) }
async function check(name, task) { await task(); results.push({ name, passed: true }); console.log('PASS', name) }
try {
  await page.goto('http://127.0.0.1:1482/')
  await page.waitForFunction(() => window.__outlineShell?.settingsReady.value)
  await check('1 Markdown headings; 2 Markdown empty; 3 Markdown user disabled', async () => {
    await open('README.md', '# Parent\n\n## Child\n\nText\n')
    await shown(true); await parsed(); assert.equal(await page.locator('.outline-item').count(), 2)
    await open('empty.md', '普通正文，没有标题。')
    await shown(true); await parsed('empty'); assert.match(await aside.innerText(), /当前 Markdown 文件未发现标题结构/)
    await page.evaluate(() => window.__outlineShell.toggleOutline())
    await shown(false); assert.equal(await pref(), false)
    await open('headings.md', '# Heading'); await shown(false)
    await page.evaluate(() => window.__outlineShell.toggleOutline()); await shown(true)
  })
  await check('4 Java symbols; 5 Java empty; 6 Java user disabled and command enabled', async () => {
    await open('App.java', 'class App { void run() {} }'); await shown(true); await parsed()
    assert.match(await aside.innerText(), /App/)
    assert.equal(await page.evaluate(() => window.__outlineShell.commandRegistry.value.get('toggle-outline').enabled), true)
    await page.locator('.cm-content').click(); await outlineShortcut(); await shown(false)
    await outlineShortcut(); await shown(true); await parsed()
    await page.getByRole('menuitem', { name: '视图', exact: true }).click()
    assert.equal(await page.getByRole('menuitemcheckbox', { name: /显示文档大纲/ }).isEnabled(), true)
    await page.getByRole('menuitemcheckbox', { name: /显示文档大纲/ }).click(); await shown(false)
    await page.evaluate(() => window.__outlineShell.executeCommand('toggle-outline')); await shown(true)
    await open('Empty.java', '// No declarations\n'); await parsed('empty'); await shown(true)
    assert.match(await aside.innerText(), /当前文件暂无可提取的代码结构/)
    await page.evaluate(() => window.__outlineShell.executeCommand('toggle-outline')); await shown(false)
    await open('Disabled.java', 'class Disabled {}'); await shown(false); assert.equal(await pref(), false)
    await page.evaluate(() => window.__outlineShell.executeCommand('toggle-outline')); await shown(true); await parsed()
  })
  await check('7 Lezer without adapter; 8 StreamLanguage; 9 TXT; 10 LOG, disabled UI and no extraction', async () => {
    for (const [name, body] of [['index.html', '<h1>HTML</h1>'], ['script.sh', 'function run() { echo test; }'], ['app密钥.txt', 'class Secret {}'], ['server.log', 'INFO class Service {}']]) {
      const before = await page.evaluate(() => window.__outlineExtractions)
      await open(name, body); await shown(false); await page.waitForTimeout(120)
      assert.equal(await pref(), true)
      assert.equal((await snapshot()).extractions, before)
      assert.equal(await page.locator('.outline-resizer').isVisible(), false)
      assert.equal(await page.evaluate(() => window.__outlineShell.commandRegistry.value.get('toggle-outline').enabled), false)
      await page.evaluate(() => window.__outlineShell.executeCommand('toggle-outline'))
      assert.equal(await pref(), true)
    }
    await page.evaluate(() => window.__outlineShell.setMode('workspace'))
    const button = page.getByTitle('当前文件不支持大纲', { exact: true })
    assert.equal(await button.isDisabled(), true)
    await page.getByRole('menuitem', { name: '视图', exact: true }).click()
    assert.equal(await page.getByRole('menuitemcheckbox', { name: /显示文档大纲/ }).isDisabled(), true)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__outlineShell.openPalette('action'))
    await page.getByRole('textbox', { name: '搜索文件或命令' }).fill('> 大纲')
    assert.equal(await page.getByRole('option').filter({ hasText: '显示/隐藏大纲' }).isDisabled(), true)
    await page.keyboard.press('Escape')
    await page.locator('.cm-content').click(); await outlineShortcut()
    assert.equal(await pref(), true); await shown(false)
  })
  await check('11 loading; 12 error/retry; 23 pending parse does not unmount or flicker', async () => {
    await page.evaluate(() => { window.__outlineGate = 'hold' })
    await open('Loading.java', 'class Loading { void pending() {} }')
    await shown(true); await parsed('loading'); assert.match(await aside.innerText(), /正在加载代码结构…/)
    assert.equal(await page.getByTitle('文档大纲', { exact: true }).isEnabled(), true)
    await page.evaluate(() => {
      window.__outlinePanel = document.querySelector('.outline-sidebar'); window.__outlineFrames = []; window.__outlineTrack = true
      const frame = () => { if (!window.__outlineTrack) return; window.__outlineFrames.push(getComputedStyle(window.__outlinePanel).display); requestAnimationFrame(frame) }; frame()
    })
    await page.waitForTimeout(160)
    await page.evaluate(() => { window.__outlineGate = 'normal'; window.__outlinePending.resolve() }); await parsed()
    await page.evaluate(async () => { window.__outlineGate = 'fail'; const s = window.__outlineShell; await s.manager.setLanguage(s.manager.activeId, 'Java') })
    await parsed('error'); await shown(true); assert.match(await aside.innerText(), /加载失败/)
    assert.equal(await page.getByTitle('文档大纲', { exact: true }).isEnabled(), true)
    assert.equal(await page.evaluate(() => window.__outlineShell.commandRegistry.value.get('toggle-outline').enabled), true)
    await page.evaluate(() => { window.__outlineGate = 'normal' }); await page.getByRole('button', { name: '重新加载代码结构', exact: true }).click(); await parsed()
    assert.equal(await page.evaluate(() => { window.__outlineTrack = false; return window.__outlineFrames.every(value => value !== 'none') && window.__outlinePanel === document.querySelector('.outline-sidebar') }), true)
  })
  await check('13 Markdown→TXT→Markdown; 14 Java→TXT→Java; 15 language selection', async () => {
    for (const [name, body] of [['Cycle.md', '# Cycle'], ['Cycle.java', 'class Cycle {}']]) {
      await open(name, body); await shown(true); await parsed()
      const id = await page.evaluate(() => window.__outlineShell.manager.activeId)
      await open('switch.txt', 'plain'); await shown(false); assert.equal(await pref(), true)
      await page.evaluate(id => window.__outlineShell.manager.select(id), id); await shown(true); await parsed()
    }
    await page.evaluate(async () => { const m = window.__outlineShell.manager; await m.setLanguage(m.activeId, 'Plain Text') }); await shown(false)
    await page.evaluate(async () => { const m = window.__outlineShell.manager; await m.setLanguage(m.activeId, 'Java') }); await shown(true); await parsed()
    await open('misleading.md', 'class LanguageMode {}', 'Java'); await parsed(); assert.equal((await snapshot()).capability, 'code')
    await page.evaluate(async () => { const m = window.__outlineShell.manager; await m.setLanguage(m.activeId, 'Plain Text') }); await shown(false)
  })
  await check('paused keeps supported panel and original code extraction budget', async () => {
    const before = await page.evaluate(() => window.__outlineExtractions)
    await open('Large.java', '// padding\n'.repeat(28000)); await shown(true); await parsed('paused')
    assert.match(await aside.innerText(), /文档较大，大纲已暂停/)
    assert.equal((await snapshot()).extractions, before); assert.equal(await pref(), true)
  })
  await check('16 active Pane decides capability and navigation', async () => {
    await open('Left.java', 'class Left { void method() {} }'); await parsed()
    await page.evaluate(() => { const m = window.__outlineShell.manager; window.__outlineLeftId = m.activeId; window.__outlineRight = m.splitPane('right', 'main'); m.focusPane(window.__outlineRight) })
    await open('Right.txt', 'right pane'); await shown(false)
    await page.evaluate(() => window.__outlineShell.manager.focusPane('main')); await shown(true); await parsed()
    assert.match(await aside.innerText(), /Left/)
    await page.locator('.outline-item').filter({ hasText: 'method' }).click()
    assert.equal(await page.evaluate(() => window.__outlineShell.manager.activePane), 'main')
    await page.evaluate(() => window.__outlineShell.manager.focusPane(window.__outlineRight)); await shown(false)
    await page.evaluate(() => { window.__outlineShell.manager.focusPane('main'); window.__outlineShell.manager.mergeAllPanes() })
  })
  await check('17 single; 18 workspace; 19 auto dock; 21 width released and restored', async () => {
    await open('Layout.java', 'class Layout {}'); await parsed()
    await page.evaluate(() => window.__outlineShell.setMode('single')); await shown(true)
    assert.equal((await snapshot()).position, 'left')
    await page.evaluate(() => window.__outlineShell.setMode('workspace')); await shown(true)
    assert.equal((await snapshot()).position, 'right')
    await page.evaluate(() => {window.__outlineShell.handleSelectPanel('search');window.__outlineShell.workspace.closeSearchDialog(false)}); await settle(); assert.equal((await snapshot()).position, 'right')
    await page.evaluate(() => window.__outlineShell.toggleSidebar()); await settle(); assert.equal((await snapshot()).position, 'left')
    await page.evaluate(() => window.__outlineShell.outlineWidth.value = 330); await settle()
    const before = await snapshot()
    const id = await page.evaluate(() => window.__outlineShell.manager.activeId)
    await open('width.txt', 'width'); await shown(false)
    assert((await snapshot()).width > before.width + 300)
    await page.evaluate(id => window.__outlineShell.manager.select(id), id); await shown(true)
    assert.equal((await snapshot()).savedWidth, 330)
    assert(Math.abs((await snapshot()).width - before.width) < 2)
    await page.setViewportSize({ width: 440, height: 900 }); await shown(false); assert.equal(await pref(), true)
    await page.setViewportSize({ width: 1500, height: 900 }); await shown(true)
    await page.evaluate(() => window.__outlineShell.toggleFocus()); await shown(false)
    await page.evaluate(() => window.__outlineShell.toggleFocus()); await shown(true)
  })
  await check('20 user off never auto-enabled, no hidden extraction; 22 persisted on restart', async () => {
    await page.evaluate(() => window.__outlineShell.toggleOutline()); await shown(false)
    const count = await page.evaluate(() => window.__outlineExtractions)
    await open('Off.md', '# Off'); await open('Off.java', 'class Off {}'); await open('Off.txt', 'off')
    await page.waitForTimeout(160); assert.equal(await pref(), false); assert.equal((await snapshot()).extractions, count)
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('markumo.settings.v1')).showOutline === false)
    await page.reload(); await page.waitForFunction(() => window.__outlineShell?.settingsReady.value)
    assert.equal(await pref(), false); assert.equal((await snapshot()).savedWidth, 330)
    await open('Restart.md', '# Restart'); await shown(false)
    await page.evaluate(() => window.__outlineShell.toggleOutline()); await shown(true)
    await open('Remember.txt', 'remember'); await shown(false)
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('markumo.settings.v1')).showOutline === true)
    await page.reload(); await page.waitForFunction(() => window.__outlineShell?.settingsReady.value)
    assert.equal(await pref(), true)
    await open('Restart.java', 'class Restart {}'); await shown(true); await parsed()
  })
  await check('24 outline fold/scroll/navigation/reorder and editor history/caret', async () => {
    const source = '# Parent\n\n## Child\n\nBody\n\n' + Array.from({ length: 60 }, (_, i) => `## Heading ${i}\n\nText ${i}\n\n`).join('')
    await open('Navigation.md', source); await parsed()
    await page.getByRole('button', { name: '全部收起大纲', exact: true }).click(); assert.equal(await page.locator('.outline-item').count(), 1)
    await page.getByRole('button', { name: '全部展开大纲', exact: true }).click(); assert.equal(await page.locator('.outline-item').count(), 62)
    await page.locator('.outline-item').last().scrollIntoViewIfNeeded(); await page.locator('.outline-item').last().click()
    assert((await page.evaluate(() => window.__outlineShell.manager.activeLiveEditor.selection.head)) > source.indexOf('## Heading 58'))
    assert((await page.locator('.outline-container').evaluate(el => el.scrollTop)) > 0)
    await page.evaluate(() => window.__outlineShell.manager.setMarkdownMode(window.__outlineShell.manager.activeId, 'source'))
    await settle()
    const before = await page.evaluate(() => { const s = window.__outlineShell, v = s.manager.activeEditorView; return { selection: v.state.selection.toJSON(), scroll: v.scrollDOM.scrollTop, source: s.manager.getText(s.manager.activeId) } })
    await page.evaluate(() => window.__outlineShell.toggleOutline()); await shown(false)
    await page.evaluate(() => window.__outlineShell.toggleOutline()); await shown(true); await parsed()
    const after = await page.evaluate(() => { const s = window.__outlineShell, v = s.manager.activeEditorView; return { selection: v.state.selection.toJSON(), scroll: v.scrollDOM.scrollTop, source: s.manager.getText(s.manager.activeId) } })
    assert.deepEqual(after.selection, before.selection); assert.equal(after.source, before.source); assert(Math.abs(after.scroll - before.scroll) < 100)
    await page.locator('.outline-item').nth(1).dragTo(page.locator('.outline-item').nth(3))
    await page.waitForFunction(source => window.__outlineShell.manager.getText(window.__outlineShell.manager.activeId) !== source, source)
    await page.evaluate(() => window.__outlineShell.manager.command('undo')); assert.equal((await snapshot()).text, source)
    await page.evaluate(() => window.__outlineShell.manager.command('redo')); assert.notEqual((await snapshot()).text, source)
  })
  assert.deepEqual(errors, [])
  fs.mkdirSync('test-results/outline', { recursive: true })
  fs.writeFileSync('test-results/outline/visibility.json', JSON.stringify({ results, errors, final: await snapshot() }, null, 2))
  console.log(`OUTLINE UI: ${results.length}/${results.length} groups passed, scenarios 1–24 covered`)
} finally { await browser.close(); await server.close() }
