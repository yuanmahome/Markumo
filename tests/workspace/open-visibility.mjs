import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const errors = [], results = []
const server = await createServer({
  server: { host: '127.0.0.1', port: 1484, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-workspace-open',
  plugins: [{
    name: 'workspace-open-ui-test-seam',
    enforce: 'pre',
    load(id) {
      if (id.replaceAll('\\', '/').endsWith('/app/useAppShell.ts')) {
        let source = fs.readFileSync(id, 'utf8')
        source = source.replace('new WorkspaceController(tauriWorkspace,', 'new WorkspaceController((window as any).__workspaceGateway,')
        source = source.replace('new FileController(manager, tauriFiles, toast)', 'new FileController(manager, (window as any).__workspaceFileGateway, toast)')
        source = source.replace('\n  return {', '\n  const workspaceTestShell = {')
        const end = source.lastIndexOf('}')
        return source.slice(0, end) + '\n;(window as any).__workspaceShell = workspaceTestShell\nreturn workspaceTestShell\n' + source.slice(end)
      }
    },
  }],
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  ...process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {},
})
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.setDefaultTimeout(12000)
page.on('pageerror', error => errors.push(error.message))

await page.addInitScript(() => {
  window.__toasts = []
  window.addEventListener('editor-notice', event => {
    window.__toasts.push(event.detail)
  })

  const makeDirNode = (name, p, children = []) => ({
    id: p, name, path: p, relativePath: name, isDirectory: true, isSymlink: false,
    isReadOnly: false, size: 0, mtime: null, hasChildren: children.length > 0,
    children, isExpanded: false, isLoading: false,
  })
  const makeFileNode = (name, p) => ({
    id: p, name, path: p, relativePath: name, isDirectory: false, isSymlink: false,
    isReadOnly: false, size: 100, mtime: null, hasChildren: false,
    isExpanded: false, isLoading: false,
  })

  window.__fixtureProjectA = {
    rootPath: 'C:/projects/projectA',
    name: 'projectA',
    entries: [
      makeFileNode('index.ts', 'C:/projects/projectA/index.ts'),
      makeFileNode('README.md', 'C:/projects/projectA/README.md'),
    ],
    warning: null,
  }

  window.__fixtureProjectB = {
    rootPath: 'C:/projects/projectB',
    name: 'projectB',
    entries: [
      makeFileNode('app.py', 'C:/projects/projectB/app.py'),
    ],
    warning: null,
  }

  window.__fixtureProjectC = {
    rootPath: 'C:/projects/projectC',
    name: 'projectC',
    entries: [
      makeFileNode('main.rs', 'C:/projects/projectC/main.rs'),
    ],
    warning: null,
  }

  window.__dialogMockResult = null
  window.__dialogShouldThrow = false

  window.__workspaceFileGateway = {
    historyTransactional: true,
    release: async () => {},
    checkExternal: async () => 'v1',
  }

  window.__workspaceGateway = {
    getRecentWorkspaces: async () => ['C:/projects/projectA', 'C:/projects/projectB'],
    clearSearchPreview: async () => {},
    onSearchBatch: () => () => {},
    onSearchDone: () => () => {},
    cancelSearch: async () => {},
    async openWorkspaceDialog(add = false) {
      if (window.__dialogShouldThrow) throw new Error('模拟目录选择器错误')
      return window.__dialogMockResult
    },
    async openWorkspacePath(targetPath, add = false) {
      if (window.__dialogShouldThrow) throw new Error('模拟目录访问失败')
      if (targetPath === 'C:/projects/projectA') return window.__fixtureProjectA
      if (targetPath === 'C:/projects/projectB') return window.__fixtureProjectB
      if (targetPath === 'C:/projects/projectC') return window.__fixtureProjectC
      throw new Error('未授权目录')
    },
    async openDroppedWorkspace(token) {
      if (token === 'token-proj-a') return window.__fixtureProjectA
      if (token === 'token-proj-b') return window.__fixtureProjectB
      throw new Error('无效放置令牌')
    },
    async readDirectory(dirPath) {
      if (dirPath === 'C:/projects/projectA') return window.__fixtureProjectA.entries
      if (dirPath === 'C:/projects/projectB') return window.__fixtureProjectB.entries
      if (dirPath === 'C:/projects/projectC') return window.__fixtureProjectC.entries
      return []
    },
    async removeWorkspaceFolder() {},
    async findFiles() { return [] },
  }
})

const shell = code => page.evaluate(code)
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function check(name, task) {
  await task()
  results.push(name)
  console.log('PASS workspace:', name)
}

try {
  await page.goto('http://127.0.0.1:1484/')
  await page.waitForFunction(() => window.__workspaceShell?.settingsReady.value)

  // 场景 1: 欢迎页点击「打开文件夹」成功，自动展开左侧边栏并显示根目录及文件树，中间显示空编辑器
  await check('1. Welcome page click open folder succeeds: switches mode, opens sidebar, shows file tree & empty editor', async () => {
    // 初始状态：无文档无工作区，显示欢迎页
    assert.equal(await page.locator('.welcome').isVisible(), true)
    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'single')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)

    // 配置目录对话框返回 projectA
    await shell(() => {
      window.__dialogMockResult = window.__fixtureProjectA
      window.__dialogShouldThrow = false
    })

    // 点击欢迎页的「打开文件夹」按钮
    await page.locator('.welcome button').filter({ hasText: '打开文件夹' }).click()
    await settle()

    // 验证状态
    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'workspace')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), true)
    assert.equal(await shell(() => window.__workspaceShell.sidebarPanel.value), 'files')
    assert.equal(await shell(() => window.__workspaceShell.workspace.rootPath), 'C:/projects/projectA')

    // 验证 UI 渲染：左侧边栏存在并渲染根目录和文件项
    await page.locator('.sidebar-wrapper').waitFor()
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /projectA/)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /index\.ts/)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /README\.md/)

    // 验证中间编辑区：欢迎页已消失，显示空编辑区
    assert.equal(await page.locator('.welcome').count(), 0)
    assert.equal(await page.locator('.pane-empty').isVisible(), true)
  })

  // 场景 2: 用户点击取消，仍停留在欢迎页
  await check('2. Cancel folder dialog: stays on current view, no error switch', async () => {
    // 切回初始空状态
    await shell(() => {
      const s = window.__workspaceShell
      s.workspace.rootPath = null
      s.workspace.roots = []
      s.workspace.entries = []
      s.setMode('single')
      s.sidebarVisible.value = false
      s.revision.value++
      window.__dialogMockResult = null
      window.__dialogShouldThrow = false
    })
    await settle()
    assert.equal(await page.locator('.welcome').isVisible(), true)

    // 点击欢迎页打开文件夹，模拟取消返回 null
    await page.locator('.welcome button').filter({ hasText: '打开文件夹' }).click()
    await settle()

    // 仍保持欢迎页与 single 模式
    assert.equal(await page.locator('.welcome').isVisible(), true)
    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'single')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)
  })

  // 场景 3: 打开失败，原界面不发生错误切换
  await check('3. Open folder fails: reports error toast, does not erroneously switch layout', async () => {
    await shell(() => {
      window.__dialogShouldThrow = true
    })
    await page.locator('.welcome button').filter({ hasText: '打开文件夹' }).click()
    await settle()

    // 仍停留在欢迎页
    assert.equal(await page.locator('.welcome').isVisible(), true)
    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'single')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)
    assert.match(await page.locator('.toast').innerText(), /模拟目录选择器错误/)
  })

  // 场景 4: 已有工作区时打开另一个目录，正确更新文件树
  await check('4. Open another directory when workspace exists: updates file tree cleanly', async () => {
    await shell(() => {
      window.__dialogShouldThrow = false
      window.__dialogMockResult = window.__fixtureProjectA
    })
    await page.locator('.welcome button').filter({ hasText: '打开文件夹' }).click()
    await settle()
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /projectA/)

    // 现在打开另一个目录 projectB
    await shell(() => {
      window.__dialogMockResult = window.__fixtureProjectB
    })
    await shell(() => window.__workspaceShell.openWorkspaceFolder(false))
    await settle()

    assert.equal(await shell(() => window.__workspaceShell.workspace.rootPath), 'C:/projects/projectB')
    assert.equal(await shell(() => window.__workspaceShell.workspace.roots.length), 1)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /projectB/)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /app\.py/)
    assert.doesNotMatch(await page.locator('.sidebar-wrapper').innerText(), /projectA/)
  })

  // 场景 5: 添加文件夹后显示多个根目录
  await check('5. Add folder to workspace: displays multiple roots in tree', async () => {
    await shell(() => {
      window.__dialogMockResult = window.__fixtureProjectC
    })
    await shell(() => window.__workspaceShell.openWorkspaceFolder(true))
    await settle()

    const roots = await shell(() => window.__workspaceShell.workspace.roots.map(r => r.name))
    assert.deepEqual(roots, ['projectB', 'projectC'])
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), true)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /projectB/)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /projectC/)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /main\.rs/)
  })

  // 场景 6: 工作区打开后切换单文件模式，后续文件树刷新不会强制切回
  await check('6. Switch to single file mode: subsequent directory refresh does not force switch back', async () => {
    await shell(() => window.__workspaceShell.setMode('single'))
    await settle()

    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'single')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)

    // 触发刷新
    await shell(() => window.__workspaceShell.workspace.refreshDirectory())
    await settle()

    // 验证依然保持单文件模式与折叠边栏
    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'single')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)
  })

  // 场景 7: 手动收起侧边栏后，普通工作区通知不会重新展开
  await check('7. Manually collapse sidebar: regular tree events do not reopen it', async () => {
    await shell(() => {
      window.__workspaceShell.setMode('workspace')
      window.__workspaceShell.sidebarVisible.value = false
    })
    await settle()

    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'workspace')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)

    // 触发树刷新与选择变动
    await shell(() => {
      window.__workspaceShell.workspace.refreshDirectory()
      window.__workspaceShell.workspace.selectTreePath('C:/projects/projectB')
    })
    await settle()

    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)
  })

  // 场景 8: 专注模式下主动打开工作区，能正确退出专注模式并显示文件树
  await check('8. In focus mode: actively opening workspace exits focus mode and shows file tree', async () => {
    // 重新展开并进入专注模式
    await shell(() => {
      window.__workspaceShell.sidebarVisible.value = true
      window.__workspaceShell.toggleFocus()
    })
    await settle()

    assert.equal(await shell(() => window.__workspaceShell.focusMode.value), true)
    assert.equal(await page.locator('.focus-exit-dock').isVisible(), true)
    assert.equal(await page.locator('.sidebar-wrapper').count(), 0)

    // 专注模式下通过快捷命令/函数主动打开 projectA
    await shell(() => {
      window.__dialogMockResult = window.__fixtureProjectA
    })
    await shell(() => window.__workspaceShell.openWorkspaceFolder(false))
    await settle()

    // 验证专注模式已退出，文件树正常展现
    assert.equal(await shell(() => window.__workspaceShell.focusMode.value), false)
    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'workspace')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), true)
    assert.equal(await shell(() => window.__workspaceShell.sidebarPanel.value), 'files')
    assert.equal(await page.locator('.sidebar-wrapper').isVisible(), true)
  })

  // 场景 9: 小窗口宽度行为合理
  await check('9. Narrow window: behaves rationally and opens sidebar at responsive size', async () => {
    // 窗口从 1200 缩小到 750 时，自动收起边栏保护编辑区
    await page.setViewportSize({ width: 750, height: 700 })
    await settle()
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)

    // 在小窗口下主动打开/展示工作区时，边栏能正常显示且自适应 210px 宽度
    await shell(() => window.__workspaceShell.openWorkspaceFolder(false))
    await settle()
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), true)
    const width = await page.locator('.sidebar-wrapper').evaluate(el => el.getBoundingClientRect().width)
    assert.equal(width, 210)

    // 恢复正常宽度
    await page.setViewportSize({ width: 1200, height: 800 })
    await settle()
  })

  // 场景 10: 重新启动后工作区及布局状态正常恢复
  await check('10. Session restoration: respects saved session mode and roots', async () => {
    await shell(() => {
      const s = window.__workspaceShell
      // 模拟恢复保存的单文件模式会话
      s.workspace.restoreSession([window.__fixtureProjectA])
      s.appMode.value = 'single'
      s.sidebarVisible.value = false
    })
    await settle()

    assert.equal(await shell(() => window.__workspaceShell.workspace.rootPath), 'C:/projects/projectA')
    assert.equal(await shell(() => window.__workspaceShell.appMode.value), 'single')
    assert.equal(await shell(() => window.__workspaceShell.sidebarVisible.value), false)
  })

  // 场景 11: 不丢失现有标签、未保存修改和分栏状态
  await check('11. Preserves existing tabs, unsaved modifications, and split layout on workspace open', async () => {
    // 创建一个已修改文档和分栏
    await shell(() => {
      const s = window.__workspaceShell
      const id1 = s.manager.openFile({ token: 'tab-1', path: 'C:/docs/note1.md', name: 'note1.md', text: 'Original 1', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: false, version: '1' })
      s.manager.restoreRecoveredText(id1, 'Modified 1')
      const pane2 = s.manager.splitPane('right', 'main')
      const id2 = s.manager.openFile({ token: 'tab-2', path: 'C:/docs/note2.md', name: 'note2.md', text: 'Original 2', encoding: 'UTF-8', bom: false, eol: 'LF', readOnly: false, version: '1' }, false, pane2)
      s.manager.restoreRecoveredText(id2, 'Modified 2')
    })
    await settle()

    assert.equal(await shell(() => window.__workspaceShell.manager.openedDocuments.length), 2)
    assert.equal(await shell(() => window.__workspaceShell.manager.hasDirtyDocuments), true)
    assert.equal(await shell(() => window.__workspaceShell.manager.isSplit), true)

    // 打开 projectA 工作区
    await shell(() => {
      window.__dialogMockResult = window.__fixtureProjectA
    })
    await shell(() => window.__workspaceShell.openWorkspaceFolder(false))
    await settle()

    // 验证：标签未关闭、未保存文本未丢失、分栏保持
    assert.equal(await shell(() => window.__workspaceShell.manager.openedDocuments.length), 2)
    assert.equal(await shell(() => window.__workspaceShell.manager.hasDirtyDocuments), true)
    assert.equal(await shell(() => window.__workspaceShell.manager.isSplit), true)
    assert.equal(await shell(() => window.__workspaceShell.manager.getText(window.__workspaceShell.manager.openedDocuments[0].id)), 'Modified 1')
    assert.equal(await shell(() => window.__workspaceShell.manager.getText(window.__workspaceShell.manager.openedDocuments[1].id)), 'Modified 2')
  })

  // 场景 12: 欢迎页不再因状态不同步而异常保留
  await check('12. Welcome page cleanly disappears when workspace is loaded without documents', async () => {
    // 关闭所有标签，重置工作区
    await shell(() => {
      const s = window.__workspaceShell
      s.manager.closeSplit()
      s.manager.close(s.manager.openedDocuments[1].id, true)
      s.manager.close(s.manager.openedDocuments[0].id, true)
      s.workspace.rootPath = null
      s.workspace.roots = []
      s.setMode('single')
      s.sidebarVisible.value = false
      window.__dialogMockResult = window.__fixtureProjectB
    })
    await settle()

    // 确认此时显示欢迎页
    assert.equal(await page.locator('.welcome').isVisible(), true)

    // 打开工作区
    await shell(() => window.__workspaceShell.openWorkspaceFolder(false))
    await settle()

    // 欢迎页消失，边栏展示
    assert.equal(await page.locator('.welcome').count(), 0)
    assert.equal(await page.locator('.pane-empty').isVisible(), true)
    assert.equal(await page.locator('.sidebar-wrapper').isVisible(), true)
    assert.match(await page.locator('.sidebar-wrapper').innerText(), /projectB/)
  })

  console.log(`\nWORKSPACE OPEN TESTS: ${results.length}/${results.length} passed, all 12 scenarios covered.`)
} finally {
  await browser.close()
  await server.close()
}
