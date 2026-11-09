import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const fixture = new URL('./default-settings.json', import.meta.url)
const server = await createServer({server: {host: '127.0.0.1', port: 1558, strictPort: true, hmr: false, watch: null}})
await server.listen()
const browser = await chromium.launch({headless: true})
const page = await browser.newPage()
try {
  await page.goto('http://127.0.0.1:1558/tests/settings/fixture.html')
  await page.waitForFunction(() => window.settingsAPI)
  const payload = await page.evaluate(() => {
    const api = window.settingsAPI
    return api.persistedSettings(api.defaultSettings())
  })
  if (process.argv.includes('--update-fixture')) fs.writeFileSync(fixture, JSON.stringify(payload, null, 2) + '\n')
  assert.deepEqual(payload, JSON.parse(fs.readFileSync(fixture, 'utf8')), 'Actual frontend payload must match the fixture consumed by Rust serde tests')
  const preferences = await page.evaluate(async () => {
    const api = window.settingsAPI, restored = []
    for (const kind of api.statisticKinds) {
      const settings = api.defaultSettings()
      settings.primaryStatistic = kind; settings.theme = 'dark'; settings.fontSize = 18
      await api.saveEditorSettings(settings)
      const next = await api.loadEditorSettings()
      restored.push({kind: next.primaryStatistic, theme: next.theme, fontSize: next.fontSize})
    }
    return restored
  })
  assert.deepEqual(preferences, ['words','characters','lines','english','reading'].map(kind => ({kind, theme: 'dark', fontSize: 18})))
  // The update preflight must continue to reject real persistence failures.
  const failure = await page.evaluate(async () => {
    const locks = []
    try {
      await window.settingsAPI.prepareInstallation({status: () => ({dirtyIds: [], busy: false, composing: false}), validateWindows: async () => {}, confirmSave: async () => true, save: async () => true, lock: value => locks.push(value), persist: async () => {throw Error('disk full')}})
      return {allowed: true, locks}
    } catch (error) {return {allowed: false, locks, error: String(error)}}
  })
  assert.deepEqual(failure, {allowed: false, locks: [true,false], error: 'Error: disk full'})
  console.log('PASS full frontend/Rust settings contract; five persisted statistic kinds; update persistence errors remain blocking')
} finally {
  await browser.close(); await server.close()
}
