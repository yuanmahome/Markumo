// Actual App mount with mocked Tauri IPC: Nomo-inspired toolbar geometry,
// mode switch, formatting, table picker, width/search/outline, collapse,
// responsive pane routing, read-only and code-block isolation.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const output = 'test-results/markdown-toolbar'
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(`${output}/results.json`, JSON.stringify({ passed: false, status: 'running' }))
fs.writeFileSync(`${output}/index.html`, '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="app"></div><script type="module" src="./fixture.js"></script>')
fs.writeFileSync(`${output}/fixture.js`, `
import '/src/styles/reset.css';
import '/src/styles/variables.css';
import '/src/styles/main.css';
import '/src/editor/markdown/styles.css';
import '/src/editor/core/searchPanel.css';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { createApp } from 'vue';
import { EditorSelection } from '@codemirror/state';
import { undoDepth, redoDepth } from '@codemirror/commands';
import App from '/src/App.vue';
window.isTauri = true;
mockWindows('main');
window.savedSettings = [];
const launch = { kind: 'app', ownsSession: true, files: { files: [], errors: [] }, roots: [], activePath: null,
  layout: { mode: 'single', sidebarWidth: 254, sidebarVisible: false }, warnings: [] };
mockIPC((command, args) => {
  if (command === 'plugin:event|listen') return args.handler;
  if (command === 'plugin:event|unlisten') return;
  if (command === 'load_editor_settings') return {};
  if (command === 'initialize_launch') return launch;
  if (command === 'get_recent_workspaces') return [];
  if (command === 'file_preferences') return { recent: [], layout: launch.layout };
  if (command === 'drain_pending') return { files: [], errors: [] };
  if (command === 'release_file') return;
  if (command === 'watch_external_files') return { watcherCount: 0, directoryCount: 0, fileCount: 0 };
  if (command === 'recovery_list') return { records: [], warnings: [] };
  if (command === 'save_editor_settings') { window.savedSettings.push(structuredClone(args)); return; }
  if (command === 'persist_session' || command === 'save_editor_settings' || command === 'persist_layout' ||
      command === 'plugin:window|set_theme' || command === 'plugin:window|destroy' || command === 'report_update_window') return;
  if (command === 'update_runtime') return { version: '1.0.4', platform: 'win32', installSupported: false };
  if (command === 'confirm_update_startup') return null;
  throw Error('Unapproved test IPC: ' + command);
});
const app = createApp(App);
app.mount('#app');
window.appTest = { app, setup: app._instance.setupState };
window.toolbarTools = { EditorSelection, undoDepth, redoDepth };
`)

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null } })
await server.listen()
const port = server.httpServer.address().port
const browser = await chromium.launch({ executablePath: process.env.MARKUMO_CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const results = []
let passed = false
const test = async (name, work) => {
  try { await work(); results.push(name); console.log('PASS ' + name) }
  catch (error) { console.error('FAIL ' + name, error); throw error }
}
const source = () => page.evaluate(() => window.appTest.setup.manager.getText(window.appTest.setup.manager.activeId))
const newDoc = async text => {
  const id = await page.evaluate(async text => {
    const manager = window.appTest.setup.manager
    const id = manager.createUntitled('md')
    manager.dispatch(id, { changes: { from: 0, insert: text } })
    manager.setMarkdownMode(id, 'live', 'main')
    for (let i = 0; i < 120 && !manager.liveReady('main'); i++) await new Promise(resolve => setTimeout(resolve, 25))
    await new Promise(resolve => setTimeout(resolve, 80))
    return id
  }, text)
  await page.locator('[data-pane-id="main"] .md-live-toolbar').waitFor()
  return id
}
const closeMain = id => page.evaluate(id => window.appTest.setup.manager.close(id, true, 'main'), id)
const activeSelection = () => page.evaluate(() => {
  const selection = window.appTest.setup.manager.getState(window.appTest.setup.manager.activeId).selection.main
  return { from: selection.from, to: selection.to, empty: selection.empty }
})
const sourceSelection = (pane, from, to = from) => page.evaluate(({ pane, from, to }) => {
  const manager = window.appTest.setup.manager
  manager.focusPane(pane, false)
  manager.paneView(pane).dispatch({ selection: { anchor: from, head: to } })
}, { pane, from, to })
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

try {
  await page.goto(`http://127.0.0.1:${port}/${output}/index.html`)
  await page.waitForFunction(() => window.appTest?.setup?.settingsReady, null, { timeout: 30000 })

  await test('Source formatting works before the language module loads and still protects code blocks', async () => {
    for (const text of ['## title\ntext', '```md\n## title\n```', '> ```md\n> ## title', '    ## title']) {
      const result = await page.evaluate(text => {
        const manager = window.appTest.setup.manager
        const id = manager.createUntitled('md')
        manager.setMarkdownMode(id, 'source', 'main')
        manager.dispatch(id, { changes: { from: 0, insert: text }, selection: { anchor: text.indexOf('title') } })
        const loading = manager.metadata(id).languageStatus
        const changed = manager.formatMarkdown('heading-0', 'main')
        const after = manager.getText(id)
        manager.close(id, true, 'main')
        return { loading, changed, after }
      }, text)
      assert.equal(result.loading, 'loading')
      assert.equal(result.changed, text.startsWith('##'), text)
      assert.equal(result.after, text.startsWith('##') ? 'title\ntext' : text)
    }
  })

  await test('toolbar uses a 44px full-width Nomo-style row with left groups and right utilities', async () => {
    const id = await newDoc('# Title\n\nTarget paragraph.\n\n```js\ncode\n```\n')
    const geometry = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-pane-id="main"] .md-live-toolbar')
      const documentArea = document.querySelector('[data-pane-id="main"] .pane-document')
      const buttons = [...toolbar.querySelectorAll('.md-toolbar-btn')]
      const icons = [...toolbar.querySelectorAll('.md-toolbar-icon')]
      const rect = toolbar.getBoundingClientRect(), next = documentArea.getBoundingClientRect()
      return {
        height: rect.height,
        width: Math.round(rect.width),
        paneWidth: Math.round(documentArea.getBoundingClientRect().width),
        beforeEditor: toolbar.parentElement?.nextElementSibling === documentArea,
        toolbarAbove: rect.bottom <= next.top + 1,
        modeInToolbar: !!toolbar.querySelector('.md-mode-switcher'),
        oldModeControl: document.querySelectorAll('.pane-mode-control').length,
        minButton: Math.min(...buttons.map(button => button.getBoundingClientRect().width)),
        minButtonHeight: Math.min(...buttons.map(button => button.getBoundingClientRect().height)),
        iconSize: toolbar.querySelector('.md-toolbar-format .md-toolbar-icon')?.getBoundingClientRect().width,
        overflow: toolbar.scrollWidth <= toolbar.clientWidth + 1,
        groups: [...toolbar.children].filter(element => element.classList.contains('md-toolbar-group')).map(element => element.className),
        utilityClasses: [...toolbar.querySelector('.md-toolbar-utilities').children].map(element => element.className),
        headingText: toolbar.querySelector('.md-toolbar-heading-btn')?.textContent?.trim(),
      }
    })
    assert.equal(geometry.height, 44)
    assert.equal(geometry.width, geometry.paneWidth)
    assert.equal(geometry.beforeEditor, true)
    assert.equal(geometry.toolbarAbove, true)
    assert.equal(geometry.modeInToolbar, true)
    assert.equal(geometry.oldModeControl, 0)
    assert.equal(geometry.minButton, 32)
    assert.equal(geometry.minButtonHeight, 32)
    assert.equal(geometry.iconSize, 17)
    assert.equal(geometry.overflow, true)
    assert.equal(geometry.headingText, 'H1')
    assert(geometry.groups.some(value => value.includes('md-toolbar-format')))
    assert(geometry.groups.some(value => value.includes('md-toolbar-lists')))
    assert(geometry.groups.some(value => value.includes('md-toolbar-insert')))
    assert(geometry.groups.some(value => value.includes('md-toolbar-more-group')))
    assert(geometry.utilityClasses.some(value => value.includes('md-toolbar-search')))
    assert(geometry.utilityClasses.some(value => value.includes('md-toolbar-width')))
    assert(geometry.utilityClasses.some(value => value.includes('md-mode-switcher')))
    assert(geometry.utilityClasses.some(value => value.includes('md-toolbar-outline')))
    assert(geometry.utilityClasses.some(value => value.includes('md-toolbar-collapse')))
    assert.equal(await page.locator('.md-live-toolbar button[aria-label="撤销"],.md-live-toolbar button[aria-label="重做"]').count(), 0)

    const a11y = await page.evaluate(() => {
      const toolbar = document.querySelector('.md-live-toolbar')
      return {
        heading: toolbar.querySelector('.md-toolbar-heading-btn')?.getAttribute('aria-label'),
        emptyLabels: [...toolbar.querySelectorAll('button')].filter(button => !button.getAttribute('aria-label')).length,
        moreHaspopup: toolbar.querySelector('button[aria-label="更多 Markdown 操作"]')?.getAttribute('aria-haspopup'),
        moreExpanded: toolbar.querySelector('button[aria-label="更多 Markdown 操作"]')?.getAttribute('aria-expanded'),
        shortcutTitles: [...toolbar.querySelectorAll('button[title]')].filter(button => /\(.*\)/.test(button.getAttribute('title'))).length,
        modeLabels: [...toolbar.querySelectorAll('.md-mode-switcher button')].map(button => button.getAttribute('aria-label')),
      }
    })
    assert.equal(a11y.heading, '段落样式')
    assert.equal(a11y.emptyLabels, 0)
    assert.equal(a11y.moreHaspopup, 'menu')
    assert.equal(a11y.moreExpanded, 'false')
    assert(a11y.shortcutTitles >= 8)
    assert.deepEqual(a11y.modeLabels, ['实时排版模式', '源码模式', '双栏模式'])
    await page.locator('.md-live-toolbar button[aria-label="加粗"]').focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '斜体')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '加粗')

    await page.locator('.md-live-toolbar [aria-label="源码模式"]').click()
    await page.waitForFunction(() => window.appTest.setup.manager.getMarkdownMode(window.appTest.setup.manager.activeId) === 'source')
    const sourceSlider = await page.locator('.md-mode-slider').evaluate(el => getComputedStyle(el).transform)
    assert.notEqual(sourceSlider, 'none')
    assert.equal(await page.locator('.md-live-toolbar').count(), 1)
    assert.equal(await page.locator('.md-live-toolbar button[aria-label="加粗"]').isDisabled(), false)
    assert.equal(await page.locator('.md-live-toolbar [aria-label="源码模式"]').getAttribute('aria-pressed'), 'true')
    await page.locator('.md-live-toolbar [aria-label="实时排版模式"]').click()
    await page.waitForFunction(() => window.appTest.setup.manager.liveReady('main'), null, { timeout: 60000 })
    await closeMain(id)
  })

  await test('settings checkbox hides and restores the Markdown toolbar', async () => {
    const id = await newDoc('Target paragraph.\n')
    await page.evaluate(() => window.appTest.setup.openSettings())
    const setting = page.locator('#settings-md-toolbar')
    await setting.waitFor()
    assert.equal(await setting.isChecked(), true)
    await setting.uncheck()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.md-live-toolbar'))
    await page.evaluate(() => window.appTest.setup.openSettings())
    await page.locator('#settings-md-toolbar').waitFor()
    assert.equal(await page.locator('#settings-md-toolbar').isChecked(), false)
    await page.locator('#settings-md-toolbar').check()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.locator('.md-live-toolbar').waitFor()
    await closeMain(id)
  })

  await test('selection, heading menu, active state, focus and keyboard undo/redo stay canonical', async () => {
    const id = await newDoc('# Title\n\nSelect target here.\n\nTail paragraph.\n')
    await page.locator('.md-prose h1').click()
    assert.equal((await page.locator('.md-toolbar-heading-btn').textContent()).trim(), 'H1')
    await page.locator('.md-toolbar-heading-btn').click()
    await page.getByRole('menuitemradio', { name: '正文', exact: true }).click()
    assert.equal((await page.locator('.md-toolbar-heading-btn').textContent()).trim(), '正文')
    await page.locator('.md-toolbar-heading-btn').click()
    await page.getByRole('menuitemradio', { name: 'H1', exact: true }).click()
    assert.equal((await page.locator('.md-toolbar-heading-btn').textContent()).trim(), 'H1')
    await page.locator('.md-prose p').nth(1).click()
    await page.keyboard.press('Control+a')
    const before = await source()
    assert.equal((await activeSelection()).empty, false)
    await page.locator('.md-live-toolbar button[aria-label="加粗"]').click()
    const formatted = await source()
    assert(formatted !== before && formatted.includes('**'))
    assert.equal(await page.locator('.md-live-toolbar button[aria-label="加粗"]').getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.md-prose')), true)
    assert.equal((await activeSelection()).empty, false)
    await page.keyboard.press('Control+z')
    assert.equal(await source(), before)
    await page.keyboard.press('Control+Shift+z')
    assert.equal(await source(), formatted)
    const topBefore = await page.locator('.md-live-toolbar').evaluate(el => el.getBoundingClientRect().top)
    await page.evaluate(() => { const root = document.querySelector('.markdown-live'); if (root) root.scrollTop = root.scrollHeight })
    assert.equal(await page.locator('.md-live-toolbar').evaluate(el => el.getBoundingClientRect().top), topBefore)
    await closeMain(id)
  })

  await test('visual table picker inserts the hovered row/column size as one isolated edit', async () => {
    const id = await newDoc('Intro\n\nTail\n')
    const before = await source()
    await page.locator('.md-live-toolbar button[aria-label="插入表格"]').click()
    await page.locator('.md-table-picker').waitFor()
    assert.equal(await page.locator('.md-table-picker-grid .md-table-picker-cell').count(), 30)
    await page.locator('.md-table-picker-cell[aria-label="插入 4 行 5 列表格"]').hover()
    assert.equal((await page.locator('.md-table-picker-head strong').textContent()).trim(), '4 × 5')
    await page.locator('.md-table-picker-cell[aria-label="插入 4 行 5 列表格"]').click()
    const table = await source()
    const tableLines = table.split('\n').filter(line => line.startsWith('|'))
    assert.equal(tableLines.length, 5)
    assert.equal(tableLines[0].split('|').length, 7)
    assert(/^\| --- \| --- \| --- \| --- \| --- \|$/m.test(table))
    await page.keyboard.press('Control+z')
    assert.equal(await source(), before)
    await closeMain(id)
  })

  await test('code blocks disable rich formatting but keep mode/search/collapse and the language selector unobstructed', async () => {
    const id = await newDoc('Intro\n\n```js\nconst x = 1\n```\n\nTail\n')
    const before = await source()
    await page.locator('.md-code-block .cm-content').click()
    await page.waitForTimeout(80)
    for (const label of ['加粗', '斜体', '删除线', '行内代码', '插入链接', '插入图片', '插入表格', '插入代码块', '插入数学公式']) {
      assert.equal(await page.locator(`.md-live-toolbar button[aria-label="${label}"]`).isDisabled(), true, label)
    }
    assert.equal(await page.locator('.md-toolbar-heading-btn').isDisabled(), true)
    assert.equal(await page.locator('.md-live-toolbar [aria-label="实时排版模式"]').isDisabled(), false)
    assert.equal(await page.locator('.md-code-block').getByRole('button', { name: /^代码语言：/ }).isVisible(), true)
    const rects = await page.evaluate(() => ({ toolbar: document.querySelector('.md-live-toolbar').getBoundingClientRect(), language: document.querySelector('.md-code-block button[aria-label^="代码语言"]')?.getBoundingClientRect() }))
    assert(rects.language && rects.toolbar.bottom <= rects.language.top)
    await page.locator('.md-live-toolbar button[aria-label="加粗"]').click({ force: true })
    assert.equal(await source(), before)
    await closeMain(id)
  })

  await test('read-only Markdown keeps navigation utilities available and disables mutations', async () => {
    const id = await page.evaluate(async () => {
      const manager = window.appTest.setup.manager
      const id = manager.openFile({ token: 'readonly-toolbar', path: '/fixtures/readonly.md', name: 'readonly.md', kind: 'text', text: '# Read only\n\nTarget.\n', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: true, version: 'v1' }, false, 'main')
      manager.setMarkdownMode(id, 'live', 'main')
      for (let i = 0; i < 120 && !manager.liveReady('main'); i++) await new Promise(resolve => setTimeout(resolve, 25))
      await new Promise(resolve => setTimeout(resolve, 80))
      return id
    })
    await page.locator('.md-live-toolbar').waitFor()
    assert.equal(await page.locator('.md-live-toolbar button[aria-label="加粗"]').isDisabled(), true)
    assert.equal(await page.locator('.md-toolbar-heading-btn').isDisabled(), true)
    assert.equal(await page.locator('.md-live-toolbar button[aria-label="搜索与替换"]').isDisabled(), false)
    assert.equal(await page.locator('.md-live-toolbar [aria-label="实时排版模式"]').isDisabled(), false)
    await page.locator('.md-live-toolbar button[aria-label="更多 Markdown 操作"]').click()
    assert.equal(await page.locator('.md-more-menu button').first().isDisabled(), true)
    await page.keyboard.press('Escape')
    await closeMain(id)
  })

  await test('table picker and width popover close on viewport resize and window blur without losing selection', async () => {
    const id = await newDoc('Target paragraph.\n')
    await page.locator('.md-prose p').click()
    await page.keyboard.press('Control+a')
    const selection = await activeSelection()
    await page.locator('.md-live-toolbar button[aria-label="插入表格"]').click()
    await page.locator('.md-table-picker').waitFor()
    await page.setViewportSize({ width: 980, height: 700 })
    await page.waitForFunction(() => !document.querySelector('.md-table-picker'))
    await page.setViewportSize({ width: 1200, height: 850 })
    await page.locator('.md-live-toolbar button[aria-label="内容宽度"]').click()
    await page.locator('.md-width-popover').waitFor()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForFunction(() => !document.querySelector('.md-width-popover'))
    assert.deepEqual(await activeSelection(), selection)
    await closeMain(id)
  })

  await test('right-side search, width, outline and collapse work without moving the editor selection', async () => {
    const id = await newDoc('# Title\n\nTarget paragraph.\n')
    await page.locator('.md-live-toolbar button[aria-label="内容宽度"]').click()
    const range = page.locator('.md-width-popover input[type="range"]')
    await range.evaluate(input => { input.value = '1020'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    await page.waitForFunction(() => window.appTest.setup.manager.getMarkdownTypography().width === 1020)
    assert.equal(await page.evaluate(() => window.appTest.setup.manager.getMarkdownTypography().width), 1020)
    await page.keyboard.press('Escape')
    await page.locator('.md-live-toolbar button[aria-label="搜索与替换"]').click()
    await page.waitForFunction(() => !!(document.querySelector('.md-live-search') || document.querySelector('.fleet-search')))
    await page.keyboard.press('Escape')
    await page.locator('.md-live-toolbar button[aria-label="显示大纲"]').click()
    await page.locator('.outline-sidebar').waitFor()
    await page.evaluate(() => { window.outlineBeforeHide = document.querySelector('.outline-container') })
    await page.locator('.md-live-toolbar button[aria-label="隐藏大纲"]').click()
    await page.locator('.outline-sidebar').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.outlineBeforeHide === document.querySelector('.outline-container')), true)
    await page.locator('.md-prose p').click()
    await page.keyboard.press('Control+a')
    const selection = await activeSelection()
    await page.locator('.md-live-toolbar button[aria-label="折叠 Markdown 工具栏"]').click()
    await page.waitForFunction(() => !document.querySelector('.md-live-toolbar'))
    assert.equal(await page.locator('.md-toolbar-reveal').isVisible(), true)
    assert.deepEqual(await activeSelection(), selection)
    await page.locator('.md-toolbar-reveal').click()
    await page.locator('.md-live-toolbar').waitFor()
    assert.deepEqual(await activeSelection(), selection)
    await closeMain(id)
  })

  await test('link and image insert editable Markdown syntax instead of plain placeholder text', async () => {
    const id = await newDoc('# Title\n\nStart\n')
    await page.locator('.md-prose p').last().click()
    await page.keyboard.press('End')
    await page.locator('.md-live-toolbar button[aria-label="插入链接"]').click()
    await page.locator('.md-inline-source-input').waitFor()
    assert.match(await page.locator('.md-inline-source-input').innerText(), /\[链接\]\(https:\/\/example\.com\)/)
    assert.match(await source(), /\[链接\]\(https:\/\/example\.com\)/)
    assert.equal(await page.locator('.md-prose a[data-href="https://example.com"]').count(), 1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(80)
    await page.locator('.md-prose a').last().click()
    await page.locator('.md-inline-source-input').waitFor()
    assert.match(await page.locator('.md-inline-source-input').innerText(), /\[链接\]/)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(80)
    await page.locator('.md-live-toolbar button[aria-label="插入图片"]').click()
    await page.locator('.md-inline-source-input').waitFor()
    assert.match(await page.locator('.md-inline-source-input').innerText(), /!\[\]\(\)/)
    assert.match(await source(), /!\[\]\(\)/)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(80)
    await page.locator('.md-live-image').click()
    await page.locator('.md-inline-source-input').waitFor()
    assert.match(await page.locator('.md-inline-source-input').innerText(), /!\[\]\(\)/)
    await page.keyboard.press('Escape')
    await closeMain(id)
  })

  await test('math button opens a real secondary menu with only the supported block formula', async () => {
    const id = await newDoc('Target paragraph.\n')
    const before = await source()
    await page.locator('.md-live-toolbar button[aria-label="插入数学公式"]').click()
    await page.locator('.md-math-menu').waitFor()
    assert.equal(await page.locator('.md-math-menu [role="menuitem"]').count(), 1)
    assert.match(await page.locator('.md-math-menu').innerText(), /公式块/)
    await page.locator('.md-math-menu [role="menuitem"]').click()
    await page.waitForFunction(() => window.appTest.setup.manager.getText(window.appTest.setup.manager.activeId).includes('$$'))
    await page.keyboard.press('Control+z')
    assert.equal(await source(), before)
    await page.locator('.md-live-toolbar [aria-label="源码模式"]').click()
    await page.waitForFunction(() => window.appTest.setup.manager.getMarkdownMode(window.appTest.setup.manager.activeId) === 'source')
    assert.equal(await page.locator('.md-live-toolbar button[aria-label="插入数学公式"]').isDisabled(), true)
    await page.locator('.md-live-toolbar [aria-label="实时排版模式"]').click()
    await page.waitForFunction(() => window.appTest.setup.manager.liveReady('main'), null, { timeout: 60000 })
    await closeMain(id)
  })

  await test('two Markdown panes keep independent segmented modes, responsive groups and target routing', async () => {
    const a = await newDoc('Alpha target here.\n')
    const secondary = await page.evaluate(() => window.appTest.setup.manager.splitPane('right', 'main'))
    const b = await page.evaluate(secondary => {
      const manager = window.appTest.setup.manager
      const id = manager.openFile({ token: 'beta-toolbar', path: '/fixtures/beta.md', name: 'beta.md', kind: 'text', text: 'Beta target here.\n', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: false, version: 'v1' }, false, secondary)
      manager.setMarkdownMode(id, 'live', secondary)
      return { id, secondary }
    }, secondary)
    await page.waitForFunction(secondary => window.appTest.setup.manager.liveReady(secondary), secondary)
    await page.locator('[data-pane-id="secondary"] .md-live-toolbar').waitFor()
    assert.equal(await page.locator('.md-live-toolbar').count(), 2)
    const responsive = await page.evaluate(() => {
      const pane = document.querySelector('[data-pane-id="secondary"]')
      return {
        lists: getComputedStyle(pane.querySelector('.md-toolbar-lists')).display,
        insert: getComputedStyle(pane.querySelector('.md-toolbar-insert')).display,
        format: getComputedStyle(pane.querySelector('.md-toolbar-format')).display,
        overflow: pane.querySelector('.md-live-toolbar').scrollWidth <= pane.querySelector('.md-live-toolbar').clientWidth + 1,
      }
    })
    assert.deepEqual(responsive, { lists: 'none', insert: 'none', format: 'flex', overflow: true })
    await page.locator('[data-pane-id="secondary"] .md-live-toolbar [aria-label="源码模式"]').click()
    await page.waitForFunction(secondary => window.appTest.setup.manager.getMarkdownMode(window.appTest.setup.manager.activeId, secondary) === 'source', secondary)
    await page.locator('[data-pane-id="secondary"] .md-live-toolbar [aria-label="实时排版模式"]').click()
    await page.waitForFunction(secondary => window.appTest.setup.manager.liveReady(secondary), secondary)
    await page.locator('[data-pane-id="secondary"] .md-prose p').first().click()
    await page.keyboard.press('Control+a')
    await page.locator('[data-pane-id="secondary"] .md-live-toolbar button[aria-label="加粗"]').click()
    const changed = await page.evaluate(({ a, b }) => ({ a: window.appTest.setup.manager.getText(a), b: window.appTest.setup.manager.getText(b.id) }), { a, b })
    assert(changed.b.includes('**Beta target here.**') || changed.b.includes('**Beta target here**'))
    assert.equal(changed.a, 'Alpha target here.\n')
    await page.keyboard.press('Control+z')
    assert.equal(await page.evaluate(id => window.appTest.setup.manager.getText(id), b.id), 'Beta target here.\n')
    await page.evaluate(id => window.appTest.setup.manager.close(id, true, 'secondary'), b.id)
    await page.evaluate(secondary => window.appTest.setup.manager.closePane(secondary), secondary)
    await closeMain(a)
  })

  await test('More exposes only supported commands and keeps a bounded, blur-safe popover', async () => {
    const id = await newDoc('Target paragraph.\n')
    const before = await source()
    const cases = [
      ['脚注', '[^1]'],
      ['链接引用', '[1]:'],
      ['公式块', '$$'],
      ['内容目录', '[TOC]'],
      ['YAML Front Matter', 'title: ""'],
    ]
    for (const [label, marker] of cases) {
      await page.locator('.md-live-toolbar button[aria-label="更多 Markdown 操作"]').click()
      const items = await page.locator('.md-more-menu button').allTextContents()
      for (const expected of ['脚注', '链接引用', '公式块', '内容目录', 'YAML Front Matter']) assert(items.some(item => item.includes(expected)), expected)
      const rect = await page.locator('.md-more-menu').boundingBox()
      assert(rect && rect.x >= 0 && rect.x + rect.width <= 1200)
      await page.getByRole('menuitem', { name: label, exact: true }).click()
      await page.waitForFunction(marker => window.appTest.setup.manager.getText(window.appTest.setup.manager.activeId).includes(marker), marker)
      await page.keyboard.press('Control+z')
      assert.equal(await source(), before)
    }
    await page.locator('.md-live-toolbar button[aria-label="更多 Markdown 操作"]').click()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForFunction(() => !document.querySelector('.md-more-menu'))
    await closeMain(id)
  })

  await test('Source/Split use Markdown syntax for fences, boundaries, nested blocks and crossing/multiple selections', async () => {
    const cases = [
      'Intro\n\n```ts\n# code heading\n- item\n```\n\nTail\n',
      'Intro\n\n~~~js\n# code heading\n~~~\n\nTail\n',
      'Intro\n\n````md\n```js\n# code heading\n```\n````\n\nTail\n',
      'Intro\n\n> ```js\n> # code heading\n> ```\n\nTail\n',
      'Intro\n\n    # code heading\n\nTail\n',
      'Intro\n\nTail\n\n```ts\n# code heading', // unterminated fence at EOF
    ]
    for (const mode of ['source', 'split']) for (const text of cases) {
      const id = await newDoc(text)
      await page.evaluate(({ id, mode }) => window.appTest.setup.manager.setMarkdownMode(id, mode, 'main'), { id, mode })
      await page.waitForFunction(id => window.appTest.setup.manager.metadata(id).languageStatus === 'ready', id)
      const codeAt = text.indexOf('code heading')
      for (const [from, to] of [[codeAt, codeAt], [0, codeAt + 2], [codeAt, text.length]]) {
        await sourceSelection('main', from, to)
        const state = await page.evaluate(() => window.appTest.setup.manager.markdownToolbarState('main'))
        assert.equal(state.inCodeBlock, true, mode + ': ' + text)
        assert.equal(state.codeBlock, true)
        assert.equal(state.heading, 0)
        assert.equal(await page.locator('.md-live-toolbar button[aria-label="加粗"]').isDisabled(), true)
        assert.equal(await page.evaluate(() => window.appTest.setup.manager.formatMarkdown('bold', 'main')), false)
        assert.equal(await page.evaluate(() => window.appTest.setup.manager.insertMarkdownTable(2, 2, 'main')), false)
        assert.equal(await source(), text)
      }
      const tailAt = text.indexOf('Tail')
      await sourceSelection('main', tailAt, tailAt + 4)
      assert.equal(await page.locator('.md-live-toolbar button[aria-label="加粗"]').isDisabled(), false)
      await page.locator('.md-live-toolbar button[aria-label="加粗"]').click()
      assert.equal(await source(), text.replace('Tail', '**Tail**'))
      await page.keyboard.press('Control+z')
      assert.equal(await source(), text)
      await page.keyboard.press('Control+Shift+z')
      assert.equal(await source(), text.replace('Tail', '**Tail**'))
      await page.keyboard.press('Control+z')
      // A range ending exactly at the block start must not select that block.
      const blockStart = text.includes('> ```') ? text.indexOf('> ```') : text.includes('    #') ? text.indexOf('    #')
        : text.includes('~~~') ? text.indexOf('~~~') : text.indexOf('```')
      await sourceSelection('main', 0, blockStart)
      assert.equal(await page.evaluate(() => window.appTest.setup.manager.markdownToolbarState('main').inCodeBlock), false)
      await sourceSelection('main', blockStart)
      assert.equal(await page.evaluate(() => window.appTest.setup.manager.markdownToolbarState('main').inCodeBlock), true, mode + ': fence start ' + text)
      await page.evaluate(({ codeAt, tailAt }) => {
        const view = window.appTest.setup.manager.paneView('main'), { EditorSelection } = window.toolbarTools
        view.dispatch({ selection: EditorSelection.create([EditorSelection.range(codeAt, codeAt + 2), EditorSelection.range(tailAt, tailAt + 4)].sort((a, b) => a.from - b.from), 1) })
      }, { codeAt, tailAt })
      assert.equal(await page.evaluate(() => window.appTest.setup.manager.markdownToolbarState('main').inCodeBlock), true)
      await closeMain(id)
    }
  })

  await test('the same file in two panes reads each pane selection and keeps state/format/history independent', async () => {
    const text = '# Heading\n\n- bullet\n\n> quote\n\n1. ordered\n\n- [ ] task\n\n```js\ncode\n```\n'
    const id = await newDoc(text)
    await page.evaluate(id => window.appTest.setup.manager.setMarkdownMode(id, 'source', 'main'), id)
    const secondary = await page.evaluate(() => window.appTest.setup.manager.splitPane('right', 'main'))
    await page.waitForFunction(pane => !!window.appTest.setup.manager.paneView(pane), secondary)
    await sourceSelection('main', text.indexOf('Heading'))
    for (const [word, field] of [['bullet', 'bullet'], ['quote', 'quote'], ['ordered', 'ordered'], ['task', 'task'], ['code', 'inCodeBlock']]) {
      await sourceSelection(secondary, text.indexOf(word))
      for (const active of ['main', secondary]) {
        const state = await page.evaluate(({ active, secondary }) => {
          const manager = window.appTest.setup.manager; manager.focusPane(active, false)
          return { main: manager.markdownToolbarState('main'), other: manager.markdownToolbarState(secondary) }
        }, { active, secondary })
        assert.equal(state.main.heading, 1)
        assert.equal(state.main[field], false)
        assert.equal(state.other.heading, 0)
        assert.equal(state.other[field], true, field)
        assert.equal((await page.locator('[data-pane-id="main"] .md-toolbar-heading-btn').textContent()).trim(), 'H1')
      }
    }
    await sourceSelection(secondary, text.indexOf('quote'))
    await page.evaluate(() => window.appTest.setup.manager.formatMarkdown('heading-2', 'main'))
    assert.equal(await source(), text.replace('# Heading', '## Heading'))
    assert.equal(await page.evaluate(pane => window.appTest.setup.manager.markdownToolbarState(pane).quote, secondary), true)
    await page.evaluate(() => window.appTest.setup.manager.markdownHistory(false, 'main'))
    assert.equal(await source(), text)
    await page.evaluate(() => window.appTest.setup.manager.markdownHistory(true, 'main'))
    assert.equal(await source(), text.replace('# Heading', '## Heading'))
    await page.evaluate(() => window.appTest.setup.manager.markdownHistory(false, 'main'))
    await page.evaluate(pane => window.appTest.setup.manager.closePane(pane), secondary)
    await closeMain(id)
  })

  await test('continuous width inputs coalesce once per frame, flush the last value and persist without replacing the editor', async () => {
    const id = await newDoc(Array.from({ length: 90 }, (_, i) => `Paragraph ${i} target text.`).join('\n\n') + '\n')
    await page.locator('.md-prose p').nth(20).click()
    // Use the editing surface's actual keyboard selection. selectText() writes
    // only the browser Range and can race PM's focus/scroll selection observer.
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.waitForFunction(() => !window.appTest.setup.manager.getState(window.appTest.setup.manager.activeId).selection.main.empty)
    const selection = await activeSelection()
    await page.evaluate(() => { document.querySelector('.markdown-live').scrollTop = 500 })
    await frames()
    await page.locator('.md-live-toolbar button[aria-label="内容宽度"]').click()
    await page.evaluate(() => {
      const manager = window.appTest.setup.manager, { undoDepth, redoDepth } = window.toolbarTools
      const view = manager.liveViews.get('main').editor.view
      const root = document.querySelector('.markdown-live')
      window.widthCheck = { root, view, top: root.scrollTop, doc: view.state.doc,
        undo: undoDepth(manager.getState(manager.activeId)), redo: redoDepth(manager.getState(manager.activeId)),
        updates: [], original: manager.setMarkdownTypography }
      manager.setMarkdownTypography = function (settings) { window.widthCheck.updates.push(settings.width); return window.widthCheck.original.call(this, settings) }
      window.savedSettings.length = 0
    })
    const range = page.locator('.md-width-popover input')
    for (const final of [1100, 980, 1200]) {
      await range.evaluate((input, final) => {
        for (let value = 480; value <= final; value += 20) { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })) }
      }, final)
      await frames()
    }
    await range.evaluate(input => {
      input.value = '1140'; input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(() => window.appTest.setup.manager.getMarkdownTypography().width === 1140)
    await page.waitForFunction(() => window.savedSettings.some(args => args.settings?.markdownTypography?.width === 1140))
    const result = await page.evaluate(() => {
      const manager = window.appTest.setup.manager, check = window.widthCheck, { undoDepth, redoDepth } = window.toolbarTools
      const current = manager.liveViews.get('main').editor.view
      manager.setMarkdownTypography = check.original
      return { updates: check.updates, sameView: current === check.view, sameDoc: current.state.doc === check.doc,
        scrollDelta: Math.abs(check.root.scrollTop - check.top), undo: undoDepth(manager.getState(manager.activeId)) === check.undo,
        redo: redoDepth(manager.getState(manager.activeId)) === check.redo }
    })
    assert.deepEqual(result.updates, [1100, 980, 1200, 1140])
    assert.equal(result.sameView, true); assert.equal(result.sameDoc, true)
    assert(result.scrollDelta <= 1, JSON.stringify(result))
    assert.equal(result.undo, true); assert.equal(result.redo, true)
    assert.deepEqual(await activeSelection(), selection)
    // Close before the next animation frame: the final pending input must flush.
    await range.evaluate(input => { input.value = '1000'; input.dispatchEvent(new Event('input', { bubbles: true })); window.dispatchEvent(new Event('blur')) })
    await page.waitForFunction(() => window.appTest.setup.manager.getMarkdownTypography().width === 1000)
    await page.waitForFunction(() => window.savedSettings.some(args => args.settings?.markdownTypography?.width === 1000))
    await page.locator('.md-live-toolbar button[aria-label="内容宽度"]').click()
    const box = await range.boundingBox()
    await page.mouse.move(box.x + 8, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2, { steps: 40 })
    await page.mouse.up()
    const dragged = Number(await range.inputValue())
    assert.notEqual(dragged, 1000)
    await page.waitForFunction(width => window.appTest.setup.manager.getMarkdownTypography().width === width, dragged)
    await page.waitForFunction(width => window.savedSettings.some(args => args.settings?.markdownTypography?.width === width), dragged)
    assert.deepEqual(await activeSelection(), selection)
    await page.keyboard.press('Escape')
    for (const mode of ['source']) {
      await page.evaluate(({ id, mode }) => {
        window.appTest.setup.manager.setMarkdownMode(id, mode, 'main')
        window.appTest.setup.manager.notify()
      }, { id, mode })
      await page.waitForFunction(() => !!window.appTest.setup.manager.paneView('main'))
      await sourceSelection('main', 10, 20)
      await page.evaluate(() => { window.appTest.setup.manager.paneView('main').scrollDOM.scrollTop = 400 })
      await frames()
      const selected = await activeSelection()
      await page.locator('.md-live-toolbar button[aria-label="内容宽度"]').click()
      await page.evaluate(() => {
        const manager = window.appTest.setup.manager, view = manager.paneView('main')
        window.sourceWidthCheck = { view, doc: view.state.doc, top: view.scrollDOM.scrollTop, undo: window.toolbarTools.undoDepth(manager.getState(manager.activeId)) }
      })
      await range.evaluate(input => { input.value = '1040'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
      await frames()
      assert.deepEqual(await page.evaluate(() => {
        const manager = window.appTest.setup.manager, view = manager.paneView('main'), check = window.sourceWidthCheck
        return { sameView: view === check.view, sameDoc: view.state.doc === check.doc, sameTop: view.scrollDOM.scrollTop === check.top,
          sameHistory: window.toolbarTools.undoDepth(manager.getState(manager.activeId)) === check.undo }
      }), { sameView: true, sameDoc: true, sameTop: true, sameHistory: true })
      assert.deepEqual(await activeSelection(), selected)
      await page.keyboard.press('Escape')
    }
    await closeMain(id)
  })

  await test('240/320/480/768/1024px panes progressively pack a stable 44px row and show unclipped menus', async () => {
    const id = await newDoc('# Heading\n\nTarget paragraph.\n')
    const levels = []
    for (const width of [1024, 768, 480, 320, 240]) {
      await page.evaluate(width => {
        const pane = document.querySelector('[data-pane-id="main"]')
        pane.style.width = `${width}px`; pane.style.maxWidth = `${width}px`; pane.style.flex = 'none'
      }, width)
      await frames()
      const geometry = await page.evaluate(() => {
        const row = document.querySelector('.md-live-toolbar'), rect = row.getBoundingClientRect()
        return { height: rect.height, width: rect.width, overflow: row.scrollWidth > row.clientWidth + 1,
          classes: row.className, visible: [...row.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => button.getAttribute('aria-label')) }
      })
      assert.equal(geometry.height, 44); assert.equal(geometry.width, width); assert.equal(geometry.overflow, false)
      assert(geometry.visible.includes('更多 Markdown 操作')); assert(geometry.visible.includes('实时排版模式'))
      levels.push(geometry.classes.split('compact-').length - 1)
      await page.locator('.md-live-toolbar button[aria-label="更多 Markdown 操作"]').click()
      await frames()
      const popover = await page.locator('.md-more-menu').evaluate(menu => {
        const rect = menu.getBoundingClientRect()
        const x = rect.right - 10, y = rect.top + 20
        return { portalled: menu.parentElement === document.body, left: rect.left, right: rect.right, bottom: rect.bottom,
          visibleAtEdge: menu.contains(document.elementFromPoint(x, y)), noHorizontalScroll: menu.scrollWidth <= menu.clientWidth + 1,
          neutralText: getComputedStyle(menu.querySelector('.md-more-format-grid button')).color === getComputedStyle(document.querySelector('.md-toolbar-format button')).color }
      })
      assert.equal(popover.portalled, true); assert.equal(popover.visibleAtEdge, true)
      assert(popover.left >= 8 && popover.right <= 1192 && popover.bottom <= 842)
      assert.equal(popover.noHorizontalScroll, true)
      assert.equal(popover.neutralText, true)
      await page.locator('.md-more-menu').evaluate(menu => Promise.all(menu.getAnimations().map(animation => animation.finished)))
      await page.screenshot({ path: `${output}/pane-${width}.png` })
      await page.keyboard.press('Escape')
    }
    assert.deepEqual([...levels].sort((a, b) => a - b), levels)
    assert(new Set(levels).size >= 3, 'commands should collapse progressively')
    // Menus must also fit the viewport when it is as narrow as the pane.
    await page.setViewportSize({ width: 240, height: 600 })
    await frames()
    await page.locator('.md-live-toolbar button[aria-label="更多 Markdown 操作"]').click()
    const bounds = await page.locator('.md-more-menu').boundingBox()
    assert(bounds.x >= 8 && bounds.x + bounds.width <= 232)
    await page.keyboard.press('End')
    assert.deepEqual(await page.locator('.md-more-menu').evaluate(menu => {
      const focused = document.activeElement, item = focused.getBoundingClientRect(), rect = menu.getBoundingClientRect()
      return { last: focused.textContent.trim() === '1200', visible: item.top >= rect.top && item.bottom <= rect.bottom,
        scrolled: menu.scrollTop > 0 }
    }), { last: true, visible: true, scrolled: true })
    await page.keyboard.press('Home')
    assert.equal(await page.locator('.md-more-menu').evaluate(menu => {
      const item = document.activeElement.getBoundingClientRect(), rect = menu.getBoundingClientRect()
      return item.top >= rect.top && item.bottom <= rect.bottom
    }), true)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1200, height: 850 })
    // Oscillating a pixel at a threshold should not repeatedly toggle groups.
    const transitions = await page.evaluate(async () => {
      const pane = document.querySelector('[data-pane-id="main"]'), row = pane.querySelector('.md-live-toolbar')
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      let previous = '', at = 0
      for (let width = 240; width <= 1024; width += 4) {
        pane.style.width = pane.style.maxWidth = `${width}px`; await frame()
        if (previous && previous !== row.className) { at = width; break }
        previous = row.className
      }
      let changes = 0
      for (let i = 0; i < 8; i++) {
        pane.style.width = pane.style.maxWidth = `${at + (i % 2)}px`; await frame()
        if (previous !== row.className) changes++
        previous = row.className
      }
      return { at, changes }
    })
    assert(transitions.at > 240); assert(transitions.changes <= 1, JSON.stringify(transitions))
    await page.evaluate(() => document.querySelector('[data-pane-id="main"]').removeAttribute('style'))
    await frames()
    await closeMain(id)
  })

  await test('popup arrows/Home/End/Tab/Escape navigate enabled items and preserve selection and undo', async () => {
    const id = await newDoc('Target paragraph.\n')
    await page.locator('.md-prose p').click()
    await page.keyboard.press('Control+a')
    const before = await source(), selection = await activeSelection()
    await page.locator('.md-toolbar-heading-btn').focus()
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '正文')
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'H6')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'H1')
    await page.keyboard.press('Enter')
    assert.match(await source(), /^# /)
    await page.keyboard.press('Control+z'); assert.equal(await source(), before)
    await page.keyboard.press('Control+Shift+z'); assert.match(await source(), /^# /)
    await page.keyboard.press('Control+z'); assert.equal(await source(), before)
    await page.locator('.md-live-toolbar button[aria-label="插入表格"]').focus()
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '插入 1 行 1 列表格')
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '插入 2 行 2 列表格')
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '插入表格')
    await page.locator('.md-live-toolbar button[aria-label="更多 Markdown 操作"]').focus()
    await page.keyboard.press('ArrowUp')
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '1200')
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowUp')
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '1200')
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('.md-more-menu').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '搜索与替换')
    assert.deepEqual(await activeSelection(), selection)
    await closeMain(id)
  })

  await test('Chinese composition guards Live/Source/Split toolbar operations and repeated mode changes retain selection/history', async () => {
    const text = '# Heading\n\n中文 target paragraph.\n'
    const id = await newDoc(text)
    for (const mode of ['source', 'split', 'live', 'source', 'split', 'live']) {
      await page.evaluate(({ id, mode }) => window.appTest.setup.manager.setMarkdownMode(id, mode, 'main'), { id, mode })
      if (mode === 'live') await page.waitForFunction(() => window.appTest.setup.manager.liveReady('main'))
      else await page.waitForFunction(() => !!window.appTest.setup.manager.paneView('main'))
      await frames()
      if (mode === 'live') {
        await page.locator('.md-prose p').click()
        await page.locator('.md-prose p').selectText()
      } else await sourceSelection('main', text.indexOf('中文'), text.indexOf('中文') + 2)
      await page.waitForFunction(() => !window.appTest.setup.manager.getState(window.appTest.setup.manager.activeId).selection.main.empty)
      const before = await source(), selection = await activeSelection()
      const check = await page.evaluate(() => {
        const manager = window.appTest.setup.manager, cm = manager.paneView('main')
        const content = cm?.contentDOM || document.querySelector('.md-prose')
        const target = content.editContext || content
        window.compositionTarget = target
        target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))
        return { composing: manager.isComposing, format: manager.formatMarkdown('bold', 'main'),
          modeChange: manager.setMarkdownMode(manager.activeId, 'source', 'main'), table: manager.insertMarkdownTable(2, 2, 'main') }
      })
      assert.deepEqual(check, { composing: true, format: false, modeChange: false, table: false })
      await frames()
      assert.equal(await page.locator('.md-live-toolbar button[aria-label="加粗"]').isDisabled(), true)
      assert.equal(await page.locator('.md-live-toolbar [aria-label="源码模式"]').isDisabled(), true)
      assert.equal(await source(), before); assert.deepEqual(await activeSelection(), selection)
      await page.evaluate(() => window.compositionTarget.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
      await page.waitForFunction(() => !window.appTest.setup.manager.isComposing)
      await page.locator('.md-live-toolbar button[aria-label="加粗"]').click()
      const formatted = await source(); assert(formatted.includes('**'), JSON.stringify({ mode, formatted, selection: await activeSelection() }))
      await page.keyboard.press('Control+z'); assert.equal(await source(), before)
      await page.keyboard.press('Control+Shift+z'); assert.equal(await source(), formatted)
      await page.keyboard.press('Control+z'); assert.equal(await source(), before)
      // A source selection survives Source -> Split -> Source exactly.
      if (mode !== 'live') {
        await sourceSelection('main', text.indexOf('中文'), text.indexOf('中文') + 2)
        const selected = await activeSelection()
        await page.evaluate(id => { const m = window.appTest.setup.manager; m.setMarkdownMode(id, 'split', 'main'); m.setMarkdownMode(id, 'source', 'main') }, id)
        assert.deepEqual(await activeSelection(), selected)
      }
    }
    await closeMain(id)
  })

  assert.deepEqual(errors, [])
  passed = true
  console.log(`PASS all ${results.length} Markdown toolbar regressions`)
} finally {
  fs.writeFileSync(`${output}/results.json`, JSON.stringify({ passed, cases: results, errors }, null, 2))
  await browser.close()
  await server.close()
}
