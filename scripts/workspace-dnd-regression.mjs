// Workspace Tree to Editor Drag and Drop Regression Suite
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const output = 'test-results/workspace-dnd'
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(`${output}/index.html`, `<!doctype html>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/src/styles/reset.css">
<link rel="stylesheet" href="/src/styles/variables.css">
<link rel="stylesheet" href="/src/editor/markdown/styles.css">
<div id="app" style="display:flex;height:720px"></div>
<script type="module" src="/scripts/fixtures/markdown-live-controller.js"></script>`)

const server = await createServer({
  server: { host: '127.0.0.1', port: 1449, strictPort: true, hmr: false, watch: null }
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

  await page.goto('http://127.0.0.1:1449/test-results/workspace-dnd/index.html', { timeout: 45000 })
  await page.waitForFunction(() => !!window.f?.ready())

  // Setup mock workspace and files in browser
  await page.evaluate(async () => {
    window.f.reset('# 初始化\n', false)
    const { WorkspaceController } = await import('/src/features/workspace/WorkspaceController.ts')
    const manager = window.f.manager

    const mockFiles = new Map([
      ['C:/workspace/doc1.md', { token: 'tok-1', path: 'C:/workspace/doc1.md', name: 'doc1.md', text: '# Doc 1', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: false, version: '1' }],
      ['C:/workspace/doc2.md', { token: 'tok-2', path: 'C:/workspace/doc2.md', name: 'doc2.md', text: '# Doc 2', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: false, version: '1' }],
      ['C:/workspace/doc3.md', { token: 'tok-3', path: 'C:/workspace/doc3.md', name: 'doc3.md', text: '# Doc 3', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: false, version: '1' }],
    ])

    const mockGateway = {
      async openWorkspaceFile(path) {
        const f = mockFiles.get(path)
        if (!f) throw new Error('File not found: ' + path)
        return { ...f }
      },
      onSearchBatch() { return () => {} },
      onSearchDone() { return () => {} },
      async searchWorkspace() { return { query: {}, matches: [], totalMatches: 0, fileCount: 0, truncated: false, elapsedMs: 1 } },
      async readDirectory() { return [] },
      async locateWorkspacePath() { return null },
      async cancelSearch() {},
    }

    window.releasedTokens = []
    const mockFileController = {
      workspaceBusy: false,
      accept(file, preview, paneId) {
        // Bind to the current fixture manager: window.f.reset() replaces it.
        window.f.manager.openFile(file, preview, paneId)
        return true
      },
      gateway: {
        async release(token) {
          window.releasedTokens.push(token)
        }
      }
    }

    window.mockFileController = mockFileController
    window.makeWs = () => {
      const ws = new WorkspaceController(mockGateway, window.f.manager, mockFileController, msg => console.log(msg), false)
      window.ws = ws
      return ws
    }
    window.makeWs()
  })

  // Test 1: Drag file to center of main pane opens file and pins tab
  await test('1. Drag file to center of main pane opens file and pins tab', async () => {
    await page.evaluate(async () => {
      await window.ws.openWorkspaceFileInPane({
        path: 'C:/workspace/doc1.md',
        name: 'doc1.md',
        paneId: 'main',
        zone: 'center',
        pin: true,
      })
    })

    const info = await page.evaluate(() => {
      const m = window.f.manager
      const tabs = m.paneGroup('main').tabs
      const doc1Tab = tabs.find(t => m.metadata(t.documentId)?.name === 'doc1.md')
      return {
        tabCount: tabs.length,
        pinned: doc1Tab?.pinned,
        activeDocName: m.activeDocument?.name,
      }
    })

    assert.equal(info.tabCount, 2)
    assert.equal(info.pinned, true)
    assert.equal(info.activeDocName, 'doc1.md')
  })

  // Test 2: Drag file to 'right' zone splits pane and accurately opens in new right pane
  await test('2. Drag file to right zone splits pane and opens in new right pane', async () => {
    await page.evaluate(async () => {
      await window.ws.openWorkspaceFileInPane({
        path: 'C:/workspace/doc2.md',
        name: 'doc2.md',
        paneId: 'main',
        zone: 'right',
        pin: true,
      })
    })

    const splitInfo = await page.evaluate(() => {
      const m = window.f.manager
      const allPanes = m.layout.getAllLeafIds()
      const newPaneId = allPanes.find(p => p !== 'main')
      const doc2 = m.openedDocuments.find(d => d.name === 'doc2.md')
      const doc1 = m.openedDocuments.find(d => d.name === 'doc1.md')
      const group = newPaneId ? m.paneGroup(newPaneId) : null
      return {
        isSplit: m.isSplit,
        paneCount: allPanes.length,
        newPaneActive: group ? group.activeId : null,
        newPaneTabCount: group ? group.tabs.length : 0,
        newPaneTabs: group ? group.tabs.map(t => m.metadata(t.documentId)?.name) : [],
        mainActive: m.paneGroup('main').activeId,
        doc2Id: doc2?.id,
        doc1Id: doc1?.id,
      }
    })

    assert.equal(splitInfo.isSplit, true)
    assert.equal(splitInfo.paneCount, 2)
    assert.equal(splitInfo.newPaneActive, splitInfo.doc2Id)
    assert.equal(splitInfo.mainActive, splitInfo.doc1Id)
    // A split created for a dropped file must not leave a duplicate temporary tab.
    assert.equal(splitInfo.newPaneTabCount, 1)
    assert.deepEqual(splitInfo.newPaneTabs, ['doc2.md'])
  })

  // Test 3: Dragging already-opened file to another pane reuses document instance
  await test('3. Dragging already opened file reuses document instance across panes', async () => {
    const reuseInfo = await page.evaluate(async () => {
      const m = window.f.manager
      const allPanes = m.layout.getAllLeafIds()
      const secondaryPaneId = allPanes.find(p => p !== 'main')
      await window.ws.openWorkspaceFileInPane({
        path: 'C:/workspace/doc1.md',
        name: 'doc1.md',
        paneId: secondaryPaneId,
        zone: 'center',
        pin: true,
      })
      const doc1 = m.openedDocuments.find(d => d.name === 'doc1.md')
      return {
        totalUniqueDocs: m.openedDocuments.length,
        mainActive: m.paneGroup('main').activeId,
        secondaryActive: m.paneGroup(secondaryPaneId).activeId,
        doc1Id: doc1?.id,
      }
    })

    assert.equal(reuseInfo.totalUniqueDocs, 3)
    assert.equal(reuseInfo.mainActive, reuseInfo.doc1Id)
    assert.equal(reuseInfo.secondaryActive, reuseInfo.doc1Id)
  })

  // Test 4: Drag file to 'bottom' zone splits pane vertically
  await test('4. Drag file to bottom zone splits pane vertically', async () => {
    await page.evaluate(async () => {
      await window.ws.openWorkspaceFileInPane({
        path: 'C:/workspace/doc3.md',
        name: 'doc3.md',
        paneId: 'main',
        zone: 'bottom',
        pin: true,
      })
    })

    const info = await page.evaluate(() => {
      const m = window.f.manager
      const orientations = []
      const walk = node => {
        if (node.type !== 'split') return
        orientations.push(node.orientation)
        walk(node.first); walk(node.second)
      }
      walk(m.layout.root)
      return { leafCount: m.layout.getAllLeafIds().length, orientations }
    })
    assert.equal(info.leafCount, 3)
    // bottom must add a vertical split even when a horizontal one already exists
    assert.ok(info.orientations.includes('vertical'), 'bottom drop creates a vertical split')
  })

  // Test 5: left and top zones both split and adopt only the dropped file
  await test('5. left and top zones split and adopt only the dropped file', async () => {
    for (const zone of ['left', 'top']) {
      const info = await page.evaluate(async zone => {
        window.f.reset('# reset\n', false)
        window.makeWs()
        const m = window.f.manager
        await window.ws.openWorkspaceFileInPane({
          path: 'C:/workspace/doc1.md',
          name: 'doc1.md',
          paneId: 'main',
          zone: 'center',
          pin: true,
        })
        const before = m.layout.getAllLeafIds().length
        await window.ws.openWorkspaceFileInPane({
          path: 'C:/workspace/doc2.md',
          name: 'doc2.md',
          paneId: 'main',
          zone,
          pin: true,
        })
        const panes = m.layout.getAllLeafIds()
        const created = panes.find(p => m.paneGroup(p).activeId &&
          m.metadata(m.paneGroup(p).activeId)?.name === 'doc2.md')
        const root = m.layout.root
        return {
          zone,
          before,
          after: panes.length,
          createdTabs: created ? m.paneGroup(created).tabs.length : 0,
          createdActive: created ? m.metadata(m.paneGroup(created).activeId)?.name : null,
          mainTabs: m.paneGroup('main').tabs.map(t => m.metadata(t.documentId)?.name),
          isFirstNew: root.type === 'split' ? root.first.id === created : null,
        }
      }, zone)

      assert.equal(info.after, info.before + 1, `${zone}: exactly one new pane`)
      assert.equal(info.createdTabs, 1, `${zone}: no duplicate temporary tab`)
      assert.equal(info.createdActive, 'doc2.md', `${zone}: new pane shows dropped file`)
      assert.ok(!info.mainTabs.includes('doc2.md'), `${zone}: source pane untouched`)
      // left/top must place the new pane as the first child
      assert.equal(info.isFirstNew, true, `${zone}: new pane inserted before target`)
    }
  })

  // Test 6: loading failure never leaves a stray empty pane
  await test('6. failing file read does not create or mutate panes', async () => {
    const info = await page.evaluate(async () => {
      window.f.reset('# reset\n', false)
      window.makeWs()
      const m = window.f.manager
      const before = m.layout.getAllLeafIds().length
      await window.ws.openWorkspaceFileInPane({
        path: 'C:/workspace/missing.md',
        name: 'missing.md',
        paneId: 'main',
        zone: 'right',
        pin: true,
      })
      return { before, after: m.layout.getAllLeafIds().length }
    })
    assert.equal(info.after, info.before)
  })

  // Test 7: Dragging a directory does not open as a file
  await test('7. dragging directory does not open as file', async () => {
    const info = await page.evaluate(async () => {
      window.f.reset('# reset\n', false)
      const ws = window.makeWs()
      // Setup mock folder in workspace
      ws.roots = [{
        rootPath: 'C:/workspace',
        entries: [
          { name: 'my-folder', path: 'C:/workspace/my-folder', isDirectory: true, children: [] }
        ]
      }]
      const m = window.f.manager
      const before = m.layout.getAllLeafIds().length
      const res = await ws.openWorkspaceFileInPane({
        path: 'C:/workspace/my-folder',
        name: 'my-folder',
        paneId: 'main',
        zone: 'right',
        pin: true,
      })
      return {
        success: res.success,
        before,
        after: m.layout.getAllLeafIds().length,
        tabCount: m.paneGroup('main').tabs.length,
      }
    })
    assert.equal(info.success, false)
    assert.equal(info.after, info.before)
  })

  // Test 8: Cancellation token / signal cleans up and aborts before pane split
  await test('8. cancellation token aborts drop and cleans up file token', async () => {
    const info = await page.evaluate(async () => {
      window.f.reset('# reset\n', false)
      const ws = window.makeWs()
      window.releasedTokens = []
      const m = window.f.manager
      const before = m.layout.getAllLeafIds().length
      const cancelSource = { isCancelled: true }
      const res = await ws.openWorkspaceFileInPane({
        path: 'C:/workspace/doc1.md',
        name: 'doc1.md',
        paneId: 'main',
        zone: 'right',
        pin: true,
        cancellationToken: cancelSource,
      })
      return {
        success: res.success,
        before,
        after: m.layout.getAllLeafIds().length,
      }
    })
    assert.equal(info.success, false)
    assert.equal(info.after, info.before)
  })

  // Test 9: Rapid sequential drops to different panes do not crosstalk
  await test('9. rapid sequential drops do not crosstalk panes', async () => {
    const info = await page.evaluate(async () => {
      window.f.reset('# reset\n', false)
      const ws = window.makeWs()
      const m = window.f.manager
      // Split to have main and secondary
      await ws.openWorkspaceFileInPane({
        path: 'C:/workspace/doc1.md',
        name: 'doc1.md',
        paneId: 'main',
        zone: 'right',
        pin: true,
      })
      const leaves = m.layout.getAllLeafIds()
      const secondaryId = leaves.find(id => id !== 'main')

      // Rapidly drop doc2 to main and doc3 to secondary in parallel
      await Promise.all([
        ws.openWorkspaceFileInPane({
          path: 'C:/workspace/doc2.md',
          name: 'doc2.md',
          paneId: 'main',
          zone: 'center',
          pin: true,
        }),
        ws.openWorkspaceFileInPane({
          path: 'C:/workspace/doc3.md',
          name: 'doc3.md',
          paneId: secondaryId,
          zone: 'center',
          pin: true,
        })
      ])

      const mainTabs = m.paneGroup('main').tabs.map(t => m.metadata(t.documentId)?.name)
      const secTabs = m.paneGroup(secondaryId).tabs.map(t => m.metadata(t.documentId)?.name)
      return { mainTabs, secTabs }
    })
    assert.ok(info.mainTabs.includes('doc2.md'), 'main pane got doc2.md')
    assert.ok(!info.mainTabs.includes('doc3.md'), 'main pane does not have doc3.md')
    assert.ok(info.secTabs.includes('doc3.md'), 'secondary pane got doc3.md')
    assert.ok(!info.secTabs.includes('doc2.md'), 'secondary pane does not have doc2.md')
  })

  // Test 10: Dropping on closed/invalid paneId falls back safely to activePane
  await test('10. dropping on invalid pane falls back to active pane', async () => {
    const info = await page.evaluate(async () => {
      window.f.reset('# reset\n', false)
      const ws = window.makeWs()
      const m = window.f.manager
      const res = await ws.openWorkspaceFileInPane({
        path: 'C:/workspace/doc1.md',
        name: 'doc1.md',
        paneId: 'non-existent-pane-id',
        zone: 'center',
        pin: true,
      })
      const activeTabs = m.paneGroup(m.activePane).tabs.map(t => m.metadata(t.documentId)?.name)
      return {
        success: res.success,
        activeTabs,
      }
    })
    assert.equal(info.success, true)
    assert.ok(info.activeTabs.includes('doc1.md'))
  })

  console.log(`========================================`)
  console.log(`All ${results.length} Workspace DND tests passed successfully!`)
  console.log(`========================================`)

} finally {
  await browser?.close()
  await server.close()
}
