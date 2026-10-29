// Functional validation in an isolated Windows Release, separate from memory sampling.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectRawCDP } from '../../scripts/p01-raw-cdp.mjs'

const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'v114-candidate'
assert(/^[\w-]+$/.test(label))
const root = path.resolve('test-results/phase042'), output = path.resolve(`test-results/p03/native-link-${Date.now()}`)
fs.mkdirSync(output, { recursive: true })
const build = JSON.parse(fs.readFileSync(path.join(root, `build-${label}.json`)))
assert.equal(createHash('sha256').update(fs.readFileSync(build.binary)).digest('hex'), build.sha256)
const profile = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`))).app.appDirectoriesOverride
assert.equal(path.resolve(profile), path.join(root, 'native-profile-' + label))
if (fs.existsSync(profile)) fs.renameSync(profile, profile + '-link-backup-' + Date.now())
fs.mkdirSync(profile)
fs.writeFileSync(path.join(profile, 'editor-settings.json'), JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false }))
const server = net.createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const child = spawn(build.binary, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'udf'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
const exec = promisify(execFile), errors = [], results = []
let browser
try {
  for (const deadline = Date.now() + 60000;;) {
    assert.equal(child.exitCode, null)
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break } catch {}
    assert(Date.now() < deadline, 'Release startup timeout')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  browser = await connectRawCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0].pages()[0], cdp = await page.context().newCDPSession(page)
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForFunction(() => !!window.__nativeManager && !document.querySelector('.startup-overlay'))
  const key = async (name, code) => {
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code })
  }
  for (const destinationFirst of [false, true]) {
    const id = await page.evaluate(() => {
      const m = window.__nativeManager
      for (const doc of [...m.openedDocuments]) m.close(doc.id, true)
      return m.createUntitled('md')
    })
    await page.waitForFunction(() => window.__nativeManager.liveViews.size === 1)
    await page.evaluate(() => [...window.__nativeManager.liveViews.values()][0].editor.view.focus())
    for (const text of '[]()') await cdp.send('Input.insertText', { text })
    if (destinationFirst) {
      await key('ArrowLeft', 37)
      for (const text of 'http://129.com') await cdp.send('Input.insertText', { text })
    }
    await key('Home', 36)
    await key('ArrowRight', 39)
    for (const text of destinationFirst ? ['链接👩‍💻'] : ['1', '1']) await cdp.send('Input.insertText', { text })
    if (!destinationFirst) {
      await key('ArrowRight', 39)
      await key('ArrowRight', 39)
      for (const text of '111') await cdp.send('Input.insertText', { text })
    }
    await page.evaluate(() => [...window.__nativeManager.liveViews.values()][0].editor.view.focus())
    await page.waitForFunction(() => !document.querySelector('.md-source-link'))
    const result = await page.evaluate(id => ({ source: window.__nativeManager.getText(id), links: [...document.querySelectorAll('.md-prose a[data-href]')].map(el => ({ text: el.textContent, href: el.dataset.href })) }), id)
    const text = destinationFirst ? '链接👩‍💻' : '11', href = destinationFirst ? 'http://129.com' : '111'
    assert.equal(result.source.trimEnd(), `[${text}](${href})`)
    assert.deepEqual(result.links, [{ text, href }])
    await page.evaluate(() => window.__nativeManager.command('undo'))
    await page.evaluate(() => window.__nativeManager.command('redo'))
    assert.equal((await page.evaluate(id => window.__nativeManager.getText(id), id)).trimEnd(), `[${text}](${href})`)
    results.push({ name: destinationFirst ? 'template: destination before Unicode label' : 'template: brackets before label and destination', passed: true, ...result })
  }
  for (const singleInput of [false, true]) {
    const id = await page.evaluate(() => {
      const m = window.__nativeManager
      for (const doc of [...m.openedDocuments]) m.close(doc.id, true)
      return m.createUntitled('md')
    })
    await page.waitForFunction(() => window.__nativeManager.liveViews.size === 1)
    await page.evaluate(() => [...window.__nativeManager.liveViews.values()][0].editor.view.focus())
    const text = '[链接](http://129.com)'
    for (const part of singleInput ? [text] : [...text]) await cdp.send('Input.insertText', { text: part })
    const result = await page.evaluate(id => ({ source: window.__nativeManager.getText(id), links: [...document.querySelectorAll('.md-prose a[data-href]')].map(el => ({ text: el.textContent, href: el.dataset.href })) }), id)
    assert.equal(result.source.trimEnd(), text)
    assert.deepEqual(result.links, [{ text: '链接', href: 'http://129.com' }])
    await page.evaluate(() => window.__nativeManager.command('undo'))
    await page.evaluate(() => window.__nativeManager.command('redo'))
    assert.equal((await page.evaluate(id => window.__nativeManager.getText(id), id)).trimEnd(), text)
    results.push({ name: singleInput ? 'one input' : 'character input', passed: true, ...result })
  }
  const screenshotId = await page.evaluate(() => {
    const m = window.__nativeManager
    for (const doc of [...m.openedDocuments]) m.close(doc.id, true)
    return m.createRecoveredDocument({ id: 'link-after-rule', name: 'link-check.md', text: '***asdjf***\n\n---', mode: 'live' })
  })
  await page.waitForFunction(() => window.__nativeManager.liveViews.size === 1)
  await page.evaluate(() => {
    const v = [...window.__nativeManager.liveViews.values()][0].editor.view
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.atEnd(v.state.doc)))
    v.focus()
  })
  for (const text of '[111](jkasdfkdsakf)') await cdp.send('Input.insertText', { text })
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  for (const text of '[链接](http://129.com)') await cdp.send('Input.insertText', { text })
  const screenshotResult = await page.evaluate(id => ({ source: window.__nativeManager.getText(id), links: [...document.querySelectorAll('.md-prose a[data-href]')].map(el => ({ text: el.textContent, href: el.dataset.href })) }), screenshotId)
  assert.deepEqual(screenshotResult.links, [{ text: '111', href: 'jkasdfkdsakf' }, { text: '链接', href: 'http://129.com' }])
  assert(screenshotResult.source.startsWith('***asdjf***\n\n---'))
  assert(!screenshotResult.source.includes('\\['))
  results.push({ name: 'screenshot: new paragraphs after horizontal rule', passed: true, ...screenshotResult })
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ build, runtime: browser.version(), results, errors }, null, 2))
  console.log(`PASS Windows Release explicit-link input and Undo/Redo, ${results.length}/${results.length}`)
  console.log(path.join(output, 'results.json'))
} finally {
  if (child.exitCode === null) await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
  await browser?.close().catch(() => {})
}
