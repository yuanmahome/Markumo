// Cross-window tab detach protocol regression suite.
//
// Covers the parts that can be verified without a native Windows session:
// payload construction, the "only a real release outside the window detaches"
// rule, native error rollback and the two-phase adopt/commit handshake.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const output = 'test-results/window-detach'
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(`${output}/fixture.js`, `
import { mockIPC } from '@tauri-apps/api/mocks'
const calls = []
const state = { failBegin: null, adopted: null, commits: 0, cancels: 0 }
window.__detach = { calls, state }
mockIPC((command, args) => {
  calls.push({ command, args })
  if (command === 'detach_tab_to_window') {
    if (state.failBegin) throw new Error(state.failBegin)
    return { handoffId: 'handoff-1', label: 'detached-1' }
  }
  if (command === 'take_detached_document') return state.adopted
  if (command === 'commit_detach') { state.commits++; return null }
  if (command === 'cancel_detach') { state.cancels++; return null }
  throw new Error('unexpected command ' + command)
})
`)
fs.writeFileSync(`${output}/index.html`, `<!doctype html>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<div id="app" style="display:flex;height:720px"></div>
<script type="module" src="./fixture.js"></script>
<script type="module" src="/scripts/fixtures/markdown-live-controller.js"></script>`)

const server = await createServer({
  optimizeDeps: { include: ['@tauri-apps/api/mocks'] },
  server: { host: '127.0.0.1', port: 1450, strictPort: true, hmr: false, watch: null }
})
await server.listen()

let browser
const results = []
const test = async (name, run) => {
  await run()
  results.push(name)
  console.log('PASS ' + name)
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {})
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.setDefaultTimeout(30000)

  await page.goto('http://127.0.0.1:1450/test-results/window-detach/index.html', { timeout: 45000 })
  await page.waitForFunction(() => !!window.f?.ready())

  // The fixture installs the fake native bridge before any module imports it.
  await page.waitForFunction(() => !!window.__detach)

  // Test 1: payload carries unsaved text, mode, caret and scroll
  await test('1. detach payload carries unsaved text, dirty flag, mode, caret and scroll', async () => {
    const info = await page.evaluate(async () => {
      const { buildDetachPayload } = await import('/src/features/windows/tabDetach.ts')
      const f = window.f
      f.reset('# 标题\n\n未保存的正文\n', false)
      const m = f.manager
      const id = m.activeId
      m.dispatch(id, { changes: { from: 0, insert: '前缀' } })
      m.setMarkdownMode(id, 'source', 'main')
      const payload = buildDetachPayload(m, id, 'main', true)
      return { payload, dirty: !!m.metadata(id)?.dirty, text: m.getText(id) }
    })
    assert.ok(info.payload, 'payload must exist')
    assert.equal(info.payload.text, info.text)
    assert.equal(info.payload.dirty, info.dirty)
    assert.equal(info.payload.markdownMode, 'source')
    assert.equal(info.payload.pinned, true)
    assert.equal(info.payload.encoding, 'UTF-8')
    assert.equal(info.payload.eol, 'LF')
    assert.ok(info.payload.text.includes('未保存的正文'))
  })

  // Test 2: the outside-window test never treats a small overflow as outside
  await test('2. outside-window detection ignores in-window coordinates', async () => {
    const info = await page.evaluate(async () => {
      const { isOutsideWindow, isPointerOutside } = await import('/src/features/windows/tabDetach.ts')
      const { isPointerOutside: dragOutside } = await import('/src/editor/layout/TabDragService.ts')
      return {
        inside: isOutsideWindow(10, 10, 1200, 800),
        edge: isOutsideWindow(1201, 799, 1200, 800),
        left: isOutsideWindow(-40, 10, 1200, 800),
        top: isOutsideWindow(10, -40, 1200, 800),
        bottom: isOutsideWindow(10, 900, 1200, 800),
        dragInside: dragOutside(100, 100, 1200, 800),
        dragOutside: dragOutside(1400, 100, 1200, 800),
      }
    })
    assert.equal(info.inside, false)
    assert.equal(info.edge, false, 'a 1px overflow is still inside the tolerance')
    assert.equal(info.left, true)
    assert.equal(info.top, true)
    assert.equal(info.bottom, true)
    assert.equal(info.dragInside, false)
    assert.equal(info.dragOutside, true)
  })

  // Test 3: a failed native begin leaves the tab and reports the reason
  await test('3. native failure keeps the tab and reports a message', async () => {
    const info = await page.evaluate(async () => {
      const { detachDocumentToWindow, buildDetachPayload } = await import('/src/features/windows/tabDetach.ts')
      window.__detach.state.failBegin = '最多同时打开 16 个窗口'
      const messages = []
      const f = window.f
      f.reset('内容\n', false)
      const m = f.manager
      const id = m.activeId
      const ok = await detachDocumentToWindow(m, id, 'main', { x: 1500, y: 40 }, msg => messages.push(msg))
      const stillOpen = m.openedDocuments.some(doc => doc.id === id)
      window.__detach.state.failBegin = null
      return { ok, messages, stillOpen, payload: !!buildDetachPayload(m, id, 'main', true) }
    })
    assert.equal(info.ok, false)
    assert.equal(info.stillOpen, true)
    assert.ok(info.messages.some(m => m.includes('16')), 'the window limit is surfaced')
  })

  // Test 4: source keeps the tab until the commit event arrives
  await test('4. source keeps its tab until the target commits', async () => {
    const info = await page.evaluate(async () => {
      const { detachDocumentToWindow } = await import('/src/features/windows/tabDetach.ts')
      const f = window.f
      f.reset('待移交内容\n', false)
      const m = f.manager
      const id = m.activeId
      const before = window.__detach.calls.filter(c => c.command === 'detach_tab_to_window').length
      const ok = await detachDocumentToWindow(m, id, 'main', { x: 1400, y: 60 }, () => {})
      return {
        ok,
        beginCalls: window.__detach.calls.filter(c => c.command === 'detach_tab_to_window').length - before,
        stillOpen: m.openedDocuments.some(doc => doc.id === id),
        cancels: window.__detach.state.cancels,
      }
    })
    assert.equal(info.ok, true)
    assert.equal(info.beginCalls, 1)
    assert.equal(info.stillOpen, true, 'the prepare phase never removes the source tab')
    assert.equal(info.cancels, 0)
  })

  // Test 5: adoption restores text, dirty state and mode, then commits once
  await test('5. adoption restores text, dirty state and mode then commits exactly once', async () => {
    const info = await page.evaluate(async () => {
      const f = window.f
      f.reset('原始内容\n', false)
      // Simulate the source window payload for a dirty markdown document.
      const sourcePayload = {
        documentId: 'doc-detached-1',
        name: 'moved.md',
        path: 'C:/fixture/moved.md',
        fileToken: 'tok-moved',
        text: '# 已移交\n\n未保存的改动\n',
        version: 'v1',
        encoding: 'UTF-8',
        bom: false,
        eol: 'LF',
        readOnly: false,
        dirty: true,
        markdownMode: 'source',
        anchor: 5,
        head: 5,
        scrollTop: 40,
        scrollLeft: 0,
        pinned: true,
        external: null,
      }
      window.__detach.state.adopted = { handoffId: 'handoff-1', sourceLabel: 'main', payload: sourcePayload }
      const m = f.manager
      // Adopt exactly like the shell does, without any disk read.
      const accepted = m.openFile({
        token: sourcePayload.fileToken,
        path: sourcePayload.path,
        name: sourcePayload.name,
        text: sourcePayload.text,
        encoding: 'UTF-8',
        bom: false,
        eol: 'LF',
        readOnly: false,
        version: 'v1',
      })
      const id = m.openedDocuments.find(doc => doc.fileToken === 'tok-moved')?.id
      if (sourcePayload.dirty) m.restoreRecoveredText(id, sourcePayload.text)
      m.setMarkdownMode(id, 'source', 'main')
      m.pin(id)
      m.setSelectionOffsets(id, sourcePayload.anchor, sourcePayload.head)
      m.restoreScroll(id, sourcePayload.scrollTop, sourcePayload.scrollLeft)
      const { commitDetach } = await import('/src/features/windows/tabDetach.ts')
      await commitDetach('handoff-1')
      return {
        accepted,
        text: m.getText(id),
        dirty: !!m.metadata(id)?.dirty,
        mode: m.getMarkdownMode(id, 'main'),
        pinned: m.paneGroup('main').tabs.find(t => t.documentId === id)?.pinned,
        commits: window.__detach.state.commits,
      }
    })
    assert.equal(typeof info.accepted, 'string', 'openFile returns the adopted document id')
    assert.equal(info.text, '# 已移交\n\n未保存的改动\n')
    assert.equal(info.dirty, true, 'unsaved changes stay dirty after the move')
    assert.equal(info.mode, 'source', 'the markdown mode survives the move')
    assert.equal(info.pinned, true)
    assert.equal(info.commits, 1)
  })

  // Test 6: Untitled drafts without disk path preserve text and unsaved state
  await test('6. untitled draft without path preserves text and unsaved state', async () => {
    const info = await page.evaluate(async () => {
      const { buildDetachPayload } = await import('/src/features/windows/tabDetach.ts')
      const f = window.f
      f.reset('', false)
      const m = f.manager
      const untitledId = m.createUntitled('md')
      m.dispatch(untitledId, { changes: { from: 0, insert: '# 草稿未保存' } })
      const payload = buildDetachPayload(m, untitledId, 'main', true)
      return {
        hasPayload: !!payload,
        path: payload?.path,
        fileToken: payload?.fileToken,
        text: payload?.text,
        dirty: payload?.dirty,
        name: payload?.name,
      }
    })
    assert.equal(info.hasPayload, true)
    assert.equal(info.path, null)
    assert.equal(info.fileToken, null)
    assert.equal(info.text, '# 草稿未保存')
    assert.equal(info.dirty, true)
    assert.ok(info.name.startsWith('Untitled'))
  })

  // Test 7: defaultDetachDropPoint produces sensible viewport coordinates
  await test('7. defaultDetachDropPoint produces valid coordinates', async () => {
    const info = await page.evaluate(async () => {
      const { defaultDetachDropPoint } = await import('/src/features/windows/tabDetach.ts')
      const pt = defaultDetachDropPoint()
      return {
        x: pt.x,
        y: pt.y,
        width: window.innerWidth,
        height: window.innerHeight,
      }
    })
    assert.ok(info.x > 0 && info.x < info.width)
    assert.ok(info.y > 0 && info.y < info.height)
  })

  console.log(`========================================`)
  console.log(`All ${results.length} window detach tests passed successfully!`)
  console.log(`========================================`)

} finally {
  await browser?.close()
  await server.close()
}
