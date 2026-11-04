// Run against the isolated release app after authorizing desktop-fixtures via
// its native folder picker. Navigation requests are observed at the existing
// event boundary; the app and native authorization backend run unchanged.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9473')
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://tauri.localhost'))
assert(page, 'Start the isolated desktop verification app with remote debugging on port 9473')
const results = []
async function check(name, work) { await work(); results.push(name); console.log('PASS desktop: ' + name) }
const main = () => page.getByRole('tab', { name: 'main.md', exact: true }).first()
const anchor = label => page.locator('.md-prose a[data-href]').filter({ hasText: label }).first()
async function modifiedClick(label) {
  await page.keyboard.down('Control'); await anchor(label).click(); await page.keyboard.up('Control')
}
try {
  if (await page.locator('.pane[data-pane-id]').count() > 1) {
    await page.getByRole('menuitem', { name: '视图', exact: true }).click()
    await page.getByRole('menuitem', { name: '编辑器布局', exact: true }).hover()
    await page.getByRole('menuitem', { name: '合并所有分栏', exact: true }).click()
  }
  await page.locator('.treenode').filter({ hasText: 'main.md' }).last().dblclick()
  await anchor('定制项目').waitFor()
  await page.evaluate(() => {
    window.linkVerification = { requests: [], sourceEntries: 0 }
    window.addEventListener('markdown-open-relative', event => window.linkVerification.requests.push(event.detail))
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) {
        window.linkVerification.sourceEntries += Number(node.matches('.md-source-link')) + node.querySelectorAll('.md-source-link').length
      }
    }).observe(document.querySelector('.editor-container') || document.body, { childList: true, subtree: true })
  })
  await check('ordinary click opens complete source and prose click closes it', async () => {
    await anchor('定制项目').click()
    assert.equal(await page.locator('.md-source-link .md-inline-source-input').innerText(), '[定制项目配套代码讲解文档](codeExplain.md)')
    await page.locator('.md-prose p').filter({ hasText: 'Start plain text.' }).click()
    await page.waitForFunction(() => !document.querySelector('.md-source-link'))
  })
  await page.evaluate(() => { window.linkVerification.sourceEntries = 0 })
  await check('first Ctrl-click opens the real authorized file once, keeping both tabs clean', async () => {
    await modifiedClick('定制项目')
    await page.locator('.md-prose h1').filter({ hasText: 'Target heading' }).waitFor()
    const calls = await page.evaluate(() => window.linkVerification.requests)
    assert.equal(calls.length, 1); assert.equal(calls[0].href, 'codeExplain.md')
    assert.equal(await page.locator('.is-unsaved').count(), 0)
    assert.equal(await page.evaluate(() => window.linkVerification.sourceEntries), 0)
  })
  await main().click(); await anchor('带锚点文件').waitFor()
  await check('file query and fragment navigate through the same native file authorization', async () => {
    await modifiedClick('带锚点文件')
    await page.locator('.md-prose h1').filter({ hasText: 'Target heading' }).waitFor()
    assert.equal((await page.evaluate(() => window.linkVerification.requests)).length, 2)
    assert.equal(await page.getByRole('tab', { name: 'codeExplain.md', exact: true }).count(), 1)
  })
  await main().click(); await anchor('缺失文件').waitFor()
  for (const label of ['缺失文件', '未授权文件']) await check(label + ' shows a bounded error without changing the rendered link', async () => {
    const href = await anchor(label).getAttribute('data-href')
    await modifiedClick(label)
    await page.locator('.toast').filter({ hasText: '无法打开相对链接' }).waitFor()
    assert.equal(await anchor(label).getAttribute('data-href'), href)
    assert.equal(await page.locator('.md-source-link').count(), 0)
    assert.equal(await page.evaluate(() => window.linkVerification.sourceEntries), 0)
  })
  await check('in-document anchor navigates without issuing native file requests', async () => {
    const before = (await page.evaluate(() => window.linkVerification.requests)).length
    await modifiedClick('内部锚点')
    await page.waitForFunction(() => document.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent === 'Local heading')
    assert.equal((await page.evaluate(() => window.linkVerification.requests)).length, before)
  })
  await check('Ctrl-click in an inactive pane opens the target in that pane only', async () => {
    await page.keyboard.press('Control+Backslash')
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane-id]').length === 2)
    const panes = page.locator('.pane[data-pane-id]'), first = panes.first(), second = panes.last()
    await first.locator('.md-prose p').filter({ hasText: 'Start plain text.' }).click()
    await page.keyboard.down('Control')
    await second.locator('a[data-href]').filter({ hasText: '定制项目' }).click()
    await page.keyboard.up('Control')
    await second.locator('.md-prose h1').filter({ hasText: 'Target heading' }).waitFor()
    await first.locator('a[data-href]').filter({ hasText: '定制项目' }).waitFor()
    assert.equal(await page.locator('.is-unsaved').count(), 0)
  })
  fs.mkdirSync('test-results/markdown-links', { recursive: true })
  await page.screenshot({ path: 'test-results/markdown-links/desktop.png' })
  fs.writeFileSync('test-results/markdown-links/desktop-results.json', JSON.stringify({ tests: results }, null, 2))
  console.log(`PASS: ${results.length} desktop WebView checks`)
} finally { await browser.close() }
