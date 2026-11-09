import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectRawCDP } from '../../scripts/p01-raw-cdp.mjs'

const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const label = process.argv[2], rejected = process.argv.includes('--expect-rejected')
const build = JSON.parse(fs.readFileSync(`test-results/phase042/build-${label}.json`))
const config = JSON.parse(fs.readFileSync(`test-results/phase042/config-${label}.json`))
const binary = process.env.INSTALLED_BINARY || build.binary
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
assert.equal(digest(build.binary), build.sha256, 'Build binary must match its manifest')
const original = fs.readFileSync(build.binary), installed = fs.readFileSync(binary), changed = []
assert.equal(installed.length, original.length)
for (let i = 0; i < original.length; i++) if (original[i] !== installed[i]) changed.push(i)
assert(!changed.length || (changed.length === 3 && changed[2] === changed[0] + 2 && original.subarray(changed[0],changed[0]+3).toString() === 'UNK' && installed.subarray(changed[0],changed[0]+3).toString() === 'NSS'), 'Installed payload must match the build except for Tauri bundle type')
const profile = path.resolve(config.app.appDirectoriesOverride)
assert(profile.startsWith(path.resolve('test-results') + path.sep), 'Test profile must stay in test-results')
const payload = JSON.parse(fs.readFileSync('tests/settings/default-settings.json'))
const output = path.resolve(`test-results/settings-${label}.json`)
const report = {label, build, binary, installedSHA: digest(binary), checks: []}
let child, browser, page
async function start() {
  const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port))})})
  child = spawn(binary, [], {windowsHide: true, env: {...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: path.join(profile, `settings-webview-${Date.now()}`)}, stdio: 'ignore'})
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {try {if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break} catch {} await wait(100)}
  browser = await connectRawCDP(`http://127.0.0.1:${port}`); page = browser.contexts()[0].pages()[0]
  await page.waitForFunction(() => window.__nativeManager && !document.querySelector('.startup-overlay'))
  if (!rejected) await page.waitForFunction(() => window.__nativeSettingsProbe?.ready())
}
async function stop() {
  await browser?.close().catch(() => {})
  if (child?.exitCode === null) await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true}).catch(() => {})
  browser = child = undefined
}
try {
  fs.mkdirSync(profile, {recursive: true})
  const initial = {...payload, autoCheckUpdates: false, theme: 'dark', fontSize: 18}
  delete initial.primaryStatistic
  fs.writeFileSync(path.join(profile, 'editor-settings.json'), JSON.stringify(initial))
  fs.writeFileSync(path.join(profile, 'last-session.json'), JSON.stringify({schemaVersion:1,kind:'single',roots:[],tabs:[],active:null}))
  await start()
  const initialBytes = fs.readFileSync(path.join(profile, 'editor-settings.json'))
  if (rejected) {
    const error = await page.evaluate(async settings => {try {await window.__TAURI_INTERNALS__.invoke('save_editor_settings', {settings}); return null} catch (error) {return String(error)}}, payload)
    assert.match(error, /unknown field.*primaryStatistic/)
    assert.deepEqual(fs.readFileSync(path.join(profile, 'editor-settings.json')), initialBytes)
    report.checks.push({name:'before: exact unknown primaryStatistic rejection, original settings intact', error})
  } else {
    assert.equal(await page.evaluate(() => window.__nativeSettingsProbe.preferences.primaryStatistic.value), 'words')
    for (const kind of ['words','characters','lines','english','reading']) {
      const loaded = await page.evaluate(async kind => {
        const probe = window.__nativeSettingsProbe
        probe.preferences.primaryStatistic.value = kind
        await probe.preferences.flushSettings(true)
        return window.__TAURI_INTERNALS__.invoke('load_editor_settings')
      }, kind)
      assert.equal(loaded.primaryStatistic, kind); assert.equal(loaded.theme, 'dark'); assert.equal(loaded.fontSize, 18)
      report.checks.push({name:'native strict flush and disk reload', kind})
    }
    async function prepare(invalid) {
      return page.evaluate(async invalid => {
        const probe = window.__nativeSettingsProbe
        if (invalid) probe.preferences.primaryStatistic.value = 'invalid'
        await window.__TAURI_INTERNALS__.invoke('begin_update_install')
        try {return {allowed:await probe.prepareUpdate()}} catch (error) {return {allowed:false,error:String(error),locked:probe.updateInstalling.value}}
        finally {probe.updateInstalling.value = false; await window.__TAURI_INTERNALS__.invoke('end_update_install')}
      }, invalid)
    }
    const failed = await prepare(true)
    assert.equal(failed.allowed, false); assert.equal(failed.locked, false); assert.match(failed.error, /不支持的文档统计类型/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'editor-settings.json'))).primaryStatistic, 'reading')
    report.checks.push({name:'real update preflight rejects failed settings save and unlocks', ...failed})
    await page.evaluate(() => window.__nativeSettingsProbe.preferences.primaryStatistic.value = 'reading')
    assert.deepEqual(await prepare(false), {allowed:true})
    assert(fs.existsSync(path.join(profile, 'last-session.json')))
    report.checks.push({name:'real native lease + strict settings/session update preflight passes on retry'})
    await stop(); await start()
    assert.equal(await page.evaluate(() => window.__nativeSettingsProbe.preferences.primaryStatistic.value), 'reading')
    report.checks.push({name:'statistic preference survives application restart'})
  }
  report.passed = true
  console.log('PASS', label, report.checks)
} catch (error) {
  report.failure=String(error)
  if(page)report.state=await page.evaluate(()=>({body:document.body.innerText.slice(-3000),probe:!!window.__nativeSettingsProbe})).catch(()=>null)
  throw error
}
finally {await stop();fs.writeFileSync(output,JSON.stringify(report,null,2))}
