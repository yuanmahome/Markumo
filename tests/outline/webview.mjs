import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const label = 'outline-visibility', root = path.resolve('test-results/phase042')
const output = path.resolve('test-results/outline')
const binary = path.join(root, `markumo-${label}.exe`)
assert(fs.existsSync(binary), `Build first: node scripts/memory-release-build.mjs --label=${label}`)
const config = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`), 'utf8'))
const profile = path.resolve(config.app.appDirectoriesOverride)
assert.equal(profile, path.join(root, `native-profile-${label}`), 'Only the isolated test profile may be rotated')
if (fs.existsSync(profile)) {
  const backup = path.join(root, `native-profile-${label}-outline-backup-${Date.now()}`)
  assert.equal(path.dirname(backup), root)
  fs.renameSync(profile, backup)
}
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(output, { recursive: true })
const fixtures = new Map([
  ['README.md', '# Native heading\n\n## Child\n'], ['empty.md', 'No headings\n'],
  ['App.java', 'class App { void run() {} }'], ['Empty.java', '// No declarations\n'],
  ['app密钥.txt', 'Plain fixture text'], ['server.log', 'INFO fixture'],
  ['index.html', '<h1>HTML without outline adapter</h1>'], ['script.sh', 'echo lexical'],
])
for (const [name, body] of fixtures) fs.writeFileSync(path.join(output, name), body)
const settings = path.join(profile, 'editor-settings.json')
fs.writeFileSync(settings, JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false, showOutline: true, outlineWidth: 310 }))
fs.writeFileSync(path.join(profile, 'files.json'), JSON.stringify({ recent: [...fixtures.keys()].map(name => ({ path: path.join(output, name), name })), layout: { mode: 'single', sidebarVisible: false, sidebarWidth: 254 } }))
fs.writeFileSync(path.join(profile, 'last-session.json'), JSON.stringify({ schemaVersion: 1, kind: 'single', roots: [], tabs: [], activePath: null, layout: { mode: 'single', sidebarVisible: false, sidebarWidth: 254 } }))
let child, browser, page
const results = [], errors = [], port = 9682
async function launch() {
  child = spawn(binary, [], { windowsHide: true, env: { ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(output, `wv-${Date.now()}`), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  } })
  const deadline = Date.now() + 45000
  while (true) {
    assert(child.exitCode === null, `App exited: ${child.exitCode}`)
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break } catch {}
    assert(Date.now() < deadline, 'WebView2 timeout'); await new Promise(resolve => setTimeout(resolve, 200))
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  page = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:'))
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => !!window.__nativeManager && !document.querySelector('.startup-overlay'))
}
async function shutdown() {
  const exited = new Promise(resolve => child.once('exit', resolve))
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Application did not close cleanly')), 10000) })]) }
  finally { clearTimeout(timer) }
  await browser.close().catch(() => {}); browser = undefined
}
async function open(name) {
  await page.evaluate(async path => {
    const file = await window.__TAURI_INTERNALS__.invoke('open_recent', { path, encoding: null })
    window.__nativeManager.openFile(file, false)
  }, path.join(output, name))
}
async function shown(expected) { await page.waitForFunction(expected => (getComputedStyle(document.querySelector('.outline-sidebar')).display !== 'none') === expected, expected) }
async function status(expected) { await page.waitForFunction(expected => document.querySelector('.outline-sidebar').dataset.parseStatus === expected, expected) }
async function diskPreference(expected) {
  const deadline = Date.now() + 5000
  while (JSON.parse(fs.readFileSync(settings, 'utf8')).showOutline !== expected) {
    assert(Date.now() < deadline, 'Preference did not persist'); await new Promise(resolve => setTimeout(resolve, 100))
  }
}
const snap = () => page.evaluate(() => {
  const panel = document.querySelector('.outline-sidebar')
  return { language: window.__nativeManager.activeDocument?.language, capability: panel.dataset.capability, status: panel.dataset.parseStatus,
    visible: getComputedStyle(panel).display !== 'none', position: document.querySelector('.editor-container').dataset.outlinePosition,
    editorWidth: document.querySelector('.editor-main').getBoundingClientRect().width, panelWidth: panel.getBoundingClientRect().width }
})
try {
  await launch()
  for (const [name, expected] of [['README.md', 'ready'], ['empty.md', 'empty'], ['App.java', 'ready'], ['Empty.java', 'empty']]) {
    await open(name); await shown(true); await status(expected)
    results.push({ name, ...await snap() })
  }
  const supported = await snap()
  for (const name of ['app密钥.txt', 'server.log', 'index.html', 'script.sh']) {
    await open(name); await shown(false); await diskPreference(true)
    assert.equal(await page.locator('.outline-resizer').isVisible(), false)
    assert((await snap()).editorWidth > supported.editorWidth + 300)
    results.push({ name, ...await snap() })
  }
  await open('App.java'); await shown(true); await status('ready')
  assert.equal((await snap()).panelWidth, 310)
  await page.getByRole('button', { name: '关闭大纲', exact: true }).click(); await shown(false); await diskPreference(false)
  await open('README.md'); await shown(false)
  await shutdown(); await launch()
  await open('App.java'); await shown(false); await diskPreference(false)
  await page.evaluate(() => window.__nativeManager.activeEditorView.focus())
  await page.keyboard.press('Control+Shift+O'); await shown(true); await status('ready'); await diskPreference(true)
  await open('app密钥.txt'); await shown(false); await diskPreference(true)
  await shutdown(); await launch()
  await open('README.md'); await shown(true); await status('ready'); await diskPreference(true)
  assert.equal((await snap()).panelWidth, 310)
  results.push({ restartFalseAndTrue: true, ...await snap() })
  await shutdown()
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'webview.json'), JSON.stringify({ label, results, errors }, null, 2))
  console.log('PASS Windows WebView2: Markdown/code/empty/unsupported UI, width released, user close, Java shortcut, native JSON preferences and application restart twice')
} finally {
  await browser?.close().catch(() => {})
  if (child?.exitCode === null) child.kill()
}
