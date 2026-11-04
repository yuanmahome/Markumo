import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 1474, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-phase042-p4',
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))

try {
  await page.goto('http://127.0.0.1:1474/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  const checkResult = await page.evaluate(async () => {
    window.f.reset('# Init\n')
    const m = window.f.manager
    m.close(window.f.id, true)
    const releasedTokens = []
    m.onFileRelease(token => releasedTokens.push(token))

    let diskReads = 0
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'open_recent' || cmd === 'read_external') diskReads++
      window.f.requests.push({ kind: 'ipc', command: cmd, args })
    }

    // 1. Open Doc A & Doc B; switching tabs destroys inactive Live editor without disk re-reads, preserving undo/dirty/baseline
    const idA = m.openFile({
      token: 'tok-a',
      path: 'C:/workspace/docA.md',
      name: 'docA.md',
      text: '# Doc A\n\nParagraph A.\n\n```js\nconst a = 1;\n```\n',
      version: 'v1',
      encoding: 'UTF-8',
      bom: false,
      eol: 'LF',
      readOnly: false,
    })
    while (!window.f.live('main') || window.f.live('main').bridge.source !== m.getText(idA)) {
      await new Promise(r => setTimeout(r, 10))
    }
    const liveEditorA1 = window.f.live('main')
    m.dispatch(idA, { changes: { from: 0, insert: '<!-- edit -->\n' } })
    const baselineA = m.getBaselineText(idA)
    const dirtyA = m.metadata(idA)?.dirty

    const idB = m.openFile({
      token: 'tok-b',
      path: 'C:/workspace/docB.md',
      name: 'docB.md',
      text: '# Doc B\n\nParagraph B.\n',
      version: 'v1',
      encoding: 'UTF-8',
      bom: false,
      eol: 'LF',
      readOnly: false,
    })
    while (!window.f.live('main') || window.f.live('main').bridge.source !== m.getText(idB)) {
      await new Promise(r => setTimeout(r, 10))
    }
    const oldLiveDisposedOnTabSwitch = liveEditorA1.disposed === true && !liveEditorA1.dom.isConnected

    // Switch back and forth 10 times -> 0 disk reads, undo history intact
    for (let i = 0; i < 10; i++) {
      m.select(idA, 'main')
      m.select(idB, 'main')
    }
    m.select(idA, 'main')
    while (!window.f.live('main') || window.f.live('main').bridge.source !== m.getText(idA)) {
      await new Promise(r => setTimeout(r, 10))
    }
    m.command('undo')
    const afterUndoDirty = m.metadata(idA)?.dirty
    m.command('redo')
    const afterRedoDirty = m.metadata(idA)?.dirty

    // 2. Multi-pane sharing single canonical state + cleaning up pane entries on closeSplit
    const rightPane = m.splitPane('right', 'main', idA)
    const rightHost = document.createElement('section')
    rightHost.dataset.pane = rightPane
    document.querySelector('#app').append(rightHost)
    m.mountPane(rightHost, rightPane)
    while (!window.f.live(rightPane)) await new Promise(r => setTimeout(r, 10))
    const recordsSizeWithTwoPanes = m['records'].size
    const hasRightPaneEntryBeforeClose = !!m['records'].get(idA)?.panes[rightPane]

    // Closing tab in one pane does NOT release canonical record or token while still open in primary pane
    m.close(idA, true, rightPane)
    rightHost.remove()
    const releasedWhileStillInMain = [...releasedTokens]

    // Split again and mergeAllPanes -> secondary pane entry must be purged from record.panes
    const splitAgain = m.splitPane('right', 'main', idA)
    m.closeSplit()
    const hasSplitPaneEntryAfterMerge = !!m['records'].get(idA)?.panes[splitAgain]

    // 3. Recovered document does not retain duplicate full text in seeds map
    const recId = m.createRecoveredDocument({
      id: 'untitled-recovered-99',
      name: 'Untitled-99.md',
      text: '# Recovered\n\n' + 'Body text.\n'.repeat(500),
      mode: 'source',
    })
    const seedRetainedAfterCreate = m['seeds'].has('untitled-recovered-99')

    // 4. Close all documents -> records cleared and file tokens released
    m.close(recId, true)
    m.close(idB, true)
    m.close(idA, true)

    return {
      baselinePreserved: baselineA.startsWith('# Doc A'),
      dirtyA,
      oldLiveDisposedOnTabSwitch,
      diskReads,
      afterUndoDirty,
      afterRedoDirty,
      recordsSizeWithTwoPanes,
      hasRightPaneEntryBeforeClose,
      releasedWhileStillInMain,
      hasSplitPaneEntryAfterMerge,
      seedRetainedAfterCreate,
      finalRecordsSize: m['records'].size,
      finalLiveViewsSize: m['liveViews'].size,
      releasedTokens,
    }
  })

  assert.equal(checkResult.baselinePreserved, true)
  assert.equal(checkResult.dirtyA, true)
  assert.equal(checkResult.oldLiveDisposedOnTabSwitch, true, 'Switching tabs must destroy old Live editor')
  assert.equal(checkResult.diskReads, 0, 'Switching tabs must never re-read from disk')
  assert.equal(checkResult.afterUndoDirty, false, 'Undo history must stay intact across tab switches')
  assert.equal(checkResult.afterRedoDirty, true, 'Redo history must stay intact across tab switches')
  assert.equal(checkResult.recordsSizeWithTwoPanes, 2, 'Multi-pane must share single DocumentManager record')
  assert.equal(checkResult.hasRightPaneEntryBeforeClose, true)
  assert.deepEqual(checkResult.releasedWhileStillInMain, [], 'Must not release shared document while open in another pane')
  assert.equal(checkResult.hasSplitPaneEntryAfterMerge, false, 'Removed pane state must be purged from record.panes')
  assert.equal(checkResult.seedRetainedAfterCreate, false, 'Recovered document must not retain duplicate text in seeds')
  assert.equal(checkResult.finalRecordsSize, 0, 'Closing last reference must release canonical record')
  assert.equal(checkResult.finalLiveViewsSize, 0, 'Closing all tabs must leave 0 live views')
  assert.deepEqual(checkResult.releasedTokens.sort(), ['tok-a', 'tok-b'], 'Closing last reference must notify file token release')
  assert.deepEqual(errors, [])
  console.log('ALL PHASE 4 TAB/PANE/DOCUMENT LIFECYCLE CHECKS PASSED!')
} finally {
  await browser.close()
  await server.close()
}
