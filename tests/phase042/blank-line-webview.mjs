// Run against an isolated build from memory-release-build.mjs. Uses production
// Ctrl+S/tab close handlers and native Tauri file I/O, with no replacement gateway.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) || 'blank-lines'
assert(/^[\w-]+$/.test(label))
const baseline = process.argv.includes('--baseline')
const root = path.resolve('test-results/phase042')
const binary = path.join(root, `markumo-${label}.exe`)
assert(fs.existsSync(binary), `Build first: node scripts/memory-release-build.mjs --label=${label}`)
const config = JSON.parse(fs.readFileSync(path.join(root, `config-${label}.json`), 'utf8'))
const profile = path.resolve(config.app.appDirectoriesOverride)
assert.equal(profile, path.join(root, `native-profile-${label}`), 'Only the isolated workspace test profile may be rotated')
if(fs.existsSync(profile)){
  const backup=path.join(root,`native-profile-${label}-blank-backup-${Date.now()}`)
  assert.equal(path.dirname(backup),root)
  fs.renameSync(profile,backup)
}
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, 'editor-settings.json'), JSON.stringify({ settingsVersion: 6, autoCheckUpdates: false, autoDownloadUpdates: false }))
fs.writeFileSync(path.join(profile, 'files.json'), JSON.stringify({
  recent: [1, 2].map(length => ({ path: path.join(root, `blank-native-${length}.md`), name: `blank-native-${length}.md` })),
  layout: { mode: 'single', sidebarVisible: false, sidebarWidth: 240 },
}))
fs.writeFileSync(path.join(profile,'last-session.json'),JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],activePath:null,layout:{mode:'single',sidebarVisible:false,sidebarWidth:240}}))
const results = [], errors = []
const port = 9681
const child = spawn(binary, [], { windowsHide: true, env: {
  ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(root, `wv-blank-${Date.now()}`),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} })
let browser
const fence = '```js\nconst a = 1;\n\n```'
try {
  const deadline = Date.now() + 45000
  while (true) {
    assert(child.exitCode === null, `App exited: ${child.exitCode}`)
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break } catch {}
    assert(Date.now() < deadline, 'WebView2 CDP timeout')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:'))
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => !!window.__nativeManager && !document.querySelector('.startup-overlay'))
  await page.evaluate(() => {
    const invoke=window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__)
    window.__blankPending=0
    window.__TAURI_INTERNALS__.invoke=(...args)=>{
      window.__blankPending++
      return invoke(...args).finally(()=>{ window.__blankPending-- })
    }
  })
  await page.evaluate(() => {
    const m = window.__nativeManager
    for (const d of [...m.openedDocuments]) m.close(d.id, true)
  })
  const ready = () => page.waitForFunction(() => {
    const m = window.__nativeManager, e = m.activeLiveEditor
    return e && e.bridge.source === m.getText(m.activeId)
  })
  const snap = () => page.evaluate(() => {
    const m = window.__nativeManager, e = m.activeLiveEditor
    return { source: m.getText(m.activeId), serialized: m.saveSnapshot(m.activeId)?.text,
      nodes: e.view.state.doc.toJSON(), dirty: m.activeDocument.dirty,
      blanks: e.view.state.doc.content.content.filter(n => n.type.name === 'paragraph' && !n.content.size && !n.attrs.editorTrailing).length,
      embedded: document.querySelectorAll('.md-code-block .cm-editor').length }
  })
  const caret = async (blank = false) => {
    await page.evaluate(blank => {
      const v = window.__nativeManager.activeLiveEditor.view
      let pos = v.state.doc.firstChild.nodeSize - 1
      if (blank) v.state.doc.forEach((n, at) => { if (n.type.name === 'paragraph' && !n.content.size && !n.attrs.editorTrailing) pos = at + 1 })
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(pos))))
      v.focus()
    }, blank)
  }
  for (const eol of ['\n', '\r\n']) {
    const disk = path.join(root, `blank-native-${eol.length}.md`)
    const original = `${fence}\n\n${fence}\n`.replaceAll('\n', eol)
    fs.writeFileSync(disk, original)
    const open = async () => {
      await page.evaluate(async path => {
        const file = await window.__TAURI_INTERNALS__.invoke('open_recent', { path, encoding: null }).catch(error => { throw Error(JSON.stringify(error)) })
        window.__nativeManager.openFile(file, false)
      }, disk)
      await ready()
    }
    const save = async expected => {
      await page.waitForFunction(() => window.__blankPending===0)
      await page.waitForTimeout(100)
      await page.keyboard.press('Control+s')
      try { await page.waitForFunction(() => !window.__nativeManager.activeDocument.dirty && window.__blankPending===0) }
      catch(error){ throw Error(`${error.message}: ${JSON.stringify(await page.evaluate(()=>({ body:document.body.innerText.slice(-2000),pending:window.__blankPending,composing:window.__nativeManager.isComposing,source:window.__nativeManager.getText(window.__nativeManager.activeId) })))}`) }
      await page.waitForTimeout(200)
      assert.deepEqual(fs.readFileSync(disk), Buffer.from(expected))
    }
    const close = async () => {
      // Saving also schedules recovery/history work; wait for the application
      // to release its close guard before using the visible tab close button.
      await page.waitForFunction(() => !document.querySelector('.tab .unsaved.is-unsaved'))
      await page.waitForTimeout(400)
      await page.locator('.tab .tinyclose').first().click()
      try { await page.waitForFunction(() => window.__nativeManager.openedDocuments.length === 0, null, { timeout: 5000 }) }
      catch (error) { throw Error(`${error.message}: ${JSON.stringify(await page.evaluate(() => ({ body: document.body.innerText.slice(-2500), docs: window.__nativeManager.openedDocuments })))}`) }
    }
    await open()
    const before = await snap()
    await caret()
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Enter')
    const inserted = await snap()
    const expected = baseline ? inserted.serialized : `${fence}\n\n\n\n\n\n${fence}\n`.replaceAll('\n', eol)
    assert.equal(inserted.serialized, expected)
    await save(expected)
    const diskHex = fs.readFileSync(disk).toString('hex')
    const reopenings = []
    for (let i = 0; i < 2; i++) {
      await close(); await open()
      const reopened = await snap(); reopenings.push(reopened)
      assert.equal(reopened.serialized, expected)
      assert.equal(reopened.blanks, baseline ? 0 : 2)
      if (!baseline) {
        await caret(true)
        await page.keyboard.insertText('中文')
        await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
        assert.equal((await snap()).serialized, expected)
      }
      await save(expected)
    }
    if (!baseline) {
      await caret(true); await page.keyboard.press('Backspace')
      const deleted = `${fence}\n\n\n\n${fence}\n`.replaceAll('\n', eol)
      await save(deleted); await close(); await open()
      assert.equal((await snap()).blanks, 1)
      assert.equal((await snap()).serialized, deleted)
      // Source / Split are real production views; switching preserves bytes.
      for (const mode of ['source', 'split', 'live']) {
        await page.evaluate(mode => { const m = window.__nativeManager; m.setMarkdownMode(m.activeId, mode) }, mode)
        if (mode === 'split') { await page.locator('.md-blank-line').waitFor(); assert.equal(await page.locator('.md-blank-line').count(), 1) }
      }
      await ready()
      assert.equal((await snap()).serialized, deleted)
    }
    results.push({ eol: eol.length === 1 ? 'LF' : 'CRLF', before, inserted, diskHex, reopenings })
    await close()
    console.log(`PASS Windows WebView2 ${eol.length === 1 ? 'LF' : 'CRLF'}: native save/disk/close/reopen × 2${baseline ? ' (confirmed original loss)' : ', editable blanks, deletion and modes'}`)
  }
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(root, `blank-lines-webview-${baseline ? 'before' : 'after'}.json`), JSON.stringify({ label, results, errors }, null, 2))
} finally {
  await browser?.close()
  if (child.exitCode === null) child.kill()
}
