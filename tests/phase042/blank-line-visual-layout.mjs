import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = path.resolve('test-results/phase042/blank-lines-visual')
fs.mkdirSync(root, { recursive: true })
const disk = path.join(root, 'visual-test.md')

const server = await createServer({
  server: { host: '127.0.0.1', port: 1485, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-blank-lines-visual',
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const errors = []
page.on('pageerror', error => errors.push(error.message))

const reset = async text => {
  await page.evaluate(text => window.f.reset(text), text)
  await page.waitForFunction(() => window.f.ready())
}

const blanks = async () =>
  page.evaluate(() =>
    window.f.live().view.state.doc.content.content.filter(
      n => n.type.name === 'paragraph' && !n.content.size && !n.attrs.editorTrailing
    ).length
  )

const text = () => page.evaluate(() => window.f.manager.getText(window.f.id))

await page.exposeFunction('visualDiskRead', () => ({
  token: 'fixture',
  path: disk,
  name: 'visual-test.md',
  text: fs.readFileSync(disk, 'utf8'),
  encoding: 'UTF-8',
  bom: false,
  readOnly: false,
  eol: fs.readFileSync(disk, 'utf8').includes('\r\n') ? 'CRLF' : 'LF',
  version: String(fs.statSync(disk).mtimeMs),
}))

await page.exposeFunction('visualDiskSave', body => {
  fs.writeFileSync(disk, body, 'utf8')
  return {
    token: 'fixture',
    path: disk,
    name: 'visual-test.md',
    encoding: 'UTF-8',
    bom: false,
    readOnly: false,
    eol: body.includes('\r\n') ? 'CRLF' : 'LF',
    version: String(fs.statSync(disk).mtimeMs),
  }
})

try {
  await page.goto('http://127.0.0.1:1485/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  await page.evaluate(async () => {
    const [{ MarkdownSourceBridge }, { TextSelection }, { FileController }] = await Promise.all([
      import('/src/editor/markdown/wysiwyg/MarkdownSourceBridge.ts'),
      import('/node_modules/.vite-blank-lines-visual/deps/prosemirror-state.js').catch(() =>
        import('/node_modules/prosemirror-state/dist/index.js')
      ),
      import('/src/features/files/FileController.ts'),
    ])
    window.visualAPI = { MarkdownSourceBridge, TextSelection, FileController }
    window.visualFiles = () =>
      new FileController(
        window.f.manager,
        {
          historyTransactional: true,
          save: (_token, body) => window.visualDiskSave(body),
          openRecent: () => window.visualDiskRead(),
          release: async () => {},
        },
        message => window.f.notices.push(message)
      )
  })

  // ==========================================
  // 1. 用户真实文件等价测试用例 (测试(1).md 关键区域)
  // 行 24: 前一个代码块闭合围栏
  // 行 25~29: 5 个物理空行 (6 个连续换行)
  // 行 30: 下一个代码块开始围栏 ```java
  // ==========================================
  const prefixLines = Array.from({ length: 23 }, (_, i) => `line ${i + 1}`).join('\n')
  const fence1 = '```js\nconst a = 1;\n```'
  const fence2 = '```java\npublic class A {\n    public static void main(String[] args) {}\n}\n```'
  // 23 lines + fence1 (line 24 is ```) + 5 physical empty lines (lines 25-29) + fence2 (line 30 starts with ```java)
  const fixtureDoc = `${prefixLines}\n${fence1}\n\n\n\n\n\n${fence2}\n`

  await reset(fixtureDoc)

  // 1. 验证源码换行数与解析出的持久空段落数
  const gapMatch = fixtureDoc.match(/```\n([\s\S]*?)```java/)
  assert(gapMatch, 'Fixture contains two code blocks')
  const newlines = (gapMatch[1].match(/\n/g) || []).length
  assert.equal(newlines, 5, 'Between fences there are 5 blank lines / 6 continuous newlines')

  assert.equal(await blanks(), 4, 'Markumo block parser produces exactly 4 editable blank paragraphs')

  // 2. 测量 Live 模式 DOM 真实尺寸与样式
  const liveData = await page.evaluate(() => {
    const codeBlocks = Array.from(document.querySelectorAll('.markdown-live .md-code-block'))
    const r1 = codeBlocks[0].getBoundingClientRect()
    const r2 = codeBlocks[1].getBoundingClientRect()
    const blankParas = Array.from(document.querySelectorAll('.markdown-live .md-prose > p.md-blank-line'))

    const singleLineHeight = parseFloat(window.getComputedStyle(blankParas[0]).lineHeight)
    const fontSize = parseFloat(window.getComputedStyle(blankParas[0]).fontSize)

    const paraMeasurements = blankParas.map(p => {
      const rect = p.getBoundingClientRect()
      const style = window.getComputedStyle(p)
      return {
        height: rect.height,
        marginTop: parseFloat(style.marginTop),
        marginBottom: parseFloat(style.marginBottom),
        lineHeight: parseFloat(style.lineHeight),
      }
    })

    const visualGap = r2.top - r1.bottom

    return {
      blankParasCount: blankParas.length,
      singleLineHeight,
      fontSize,
      paraMeasurements,
      visualGap,
    }
  })

  assert.equal(liveData.blankParasCount, 4, 'Live mode renders exactly 4 p.md-blank-line elements')
  for (const p of liveData.paraMeasurements) {
    assert.equal(p.marginTop, 0, 'Blank paragraph top margin must be 0')
    assert.equal(p.marginBottom, 0, 'Blank paragraph bottom margin must be 0')
    assert(Math.abs(p.height - liveData.singleLineHeight) < 1, 'Blank paragraph height equals line-height')
  }

  // 4 个连续空行的高度总和约为 4 * 1行高 (约 102.4px at 16px/1.6)
  // 代码块上下各保留正常间隔，总空白区域高度不再异常放大至 200px+
  assert(liveData.visualGap < 160, `Visual gap (${liveData.visualGap}px) should not be inflated above 160px`)

  // 3. 测量 Split 模式
  await page.evaluate(() => window.f.mode('split'))
  await page.waitForFunction(() => window.f.ready())
  await page.waitForSelector('.split-preview-content')

  const splitData = await page.evaluate(() => {
    const codeBlocks = Array.from(document.querySelectorAll('.split-preview-content .md-preview-fence'))
    const r1 = codeBlocks[0].getBoundingClientRect()
    const r2 = codeBlocks[1].getBoundingClientRect()
    const blankParas = Array.from(document.querySelectorAll('.split-preview-content .md-blank-line'))

    const paraMeasurements = blankParas.map(p => {
      const rect = p.getBoundingClientRect()
      const style = window.getComputedStyle(p)
      return {
        height: rect.height,
        marginTop: parseFloat(style.marginTop),
        marginBottom: parseFloat(style.marginBottom),
        lineHeight: parseFloat(style.lineHeight),
      }
    })

    const visualGap = r2.top - r1.bottom

    return {
      blankParasCount: blankParas.length,
      paraMeasurements,
      visualGap,
    }
  })

  assert.equal(splitData.blankParasCount, 4, 'Split mode renders exactly 4 .md-blank-line elements')
  for (const p of splitData.paraMeasurements) {
    assert.equal(p.marginTop, 0, 'Split blank paragraph top margin must be 0')
    assert.equal(p.marginBottom, 0, 'Split blank paragraph bottom margin must be 0')
    assert(Math.abs(p.height - liveData.singleLineHeight) < 1, 'Split blank paragraph height equals line-height')
  }

  // Live 与 Split 在相同设置下的空白区域高度应高度一致 (差距不超过 2px)
  assert(
    Math.abs(liveData.visualGap - splitData.visualGap) < 2,
    `Live (${liveData.visualGap}px) and Split (${splitData.visualGap}px) visual gaps match`
  )
  console.log('PASS 8.1 实际文件复现测试：4 个持久空段落、正常行高、零 margin、Live 与 Split 视觉高度一致')

  // ==========================================
  // 8.2 & 8.3 多种空行数量与线性高度递增验证
  // 测试 0, 1, 2, 4, 5 个可编辑空段落
  // ==========================================
  await page.evaluate(() => window.f.mode('live'))
  await page.waitForFunction(() => window.f.ready())

  const testPairs = [
    { name: 'code_block -> code_block', a: fence1, b: fence2, measureKind: 'code' },
    { name: 'paragraph -> paragraph', a: 'Paragraph Alpha', b: 'Paragraph Beta', measureKind: 'paragraph' },
    { name: 'heading -> paragraph', a: '# Heading 1', b: 'Content paragraph', measureKind: 'heading' },
  ]

  for (const pair of testPairs) {
    const gaps = []
    const counts = [0, 1, 2, 4, 5]
    for (const count of counts) {
      const src = count === 0 ? `${pair.a}\n\n${pair.b}\n` : `${pair.a}\n${'\n'.repeat(count + 1)}${pair.b}\n`
      await reset(src)
      assert.equal(await blanks(), count, `${pair.name}: ${count} blank paragraphs parsed`)

      const gap = await page.evaluate(kind => {
        if (kind === 'code') {
          const els = document.querySelectorAll('.md-code-block')
          return els[1].getBoundingClientRect().top - els[0].getBoundingClientRect().bottom
        }
        if (kind === 'heading') {
          const h1 = document.querySelector('h1')
          const paras = Array.from(document.querySelectorAll('.md-prose > p')).filter(p => !p.classList.contains('md-blank-line'))
          const target = paras[paras.length - 1]
          return target.getBoundingClientRect().top - h1.getBoundingClientRect().bottom
        }
        const paras = Array.from(document.querySelectorAll('.md-prose > p')).filter(p => !p.classList.contains('md-blank-line'))
        return paras[1].getBoundingClientRect().top - paras[0].getBoundingClientRect().bottom
      }, pair.measureKind)
      gaps.push({ count, gap })
    }

    // 校验线性增长：从 1 到 2, 4, 5，每个空段落递增约 1 个行高 (±2px 浏览器浮点误差)
    const lineH = liveData.singleLineHeight
    const gap1 = gaps.find(g => g.count === 1).gap
    const gap2 = gaps.find(g => g.count === 2).gap
    const gap4 = gaps.find(g => g.count === 4).gap
    const gap5 = gaps.find(g => g.count === 5).gap

    assert(Math.abs((gap2 - gap1) - lineH) < 2.5, `${pair.name}: +1 blank increases gap by ~1 line-height (gap2-gap1 = ${gap2 - gap1}, lineH = ${lineH})`)
    assert(Math.abs((gap4 - gap1) - 3 * lineH) < 3.5, `${pair.name}: +3 blanks increases gap by ~3 line-heights`)
    assert(Math.abs((gap5 - gap1) - 4 * lineH) < 4.0, `${pair.name}: +4 blanks increases gap by ~4 line-heights`)
  }
  console.log('PASS 8.2 & 8.3 多种空行数量排版高度断言：各块之间空行高度近似严格线性增长 (斜率 = 1行高)')

  // ==========================================
  // 8.4 编辑行为与持久化
  // 点击空行、文字输入、删除、Backspace、Enter、Undo/Redo、保存及重开
  // ==========================================
  await reset(`${fence1}\n\n\n\n\n\n${fence2}\n`)
  assert.equal(await blanks(), 4)

  // 1. 点击第 2 个空段落 (index = 1)
  await page.locator('.markdown-live .md-prose > p.md-blank-line').nth(1).click()
  const selectionIndex = await page.evaluate(() => {
    const sel = window.f.live().view.state.selection
    return sel.$from.parent.type.name === 'paragraph' && !sel.$from.parent.content.size
  })
  assert(selectionIndex, 'Clicking blank line lands caret inside the empty paragraph')

  // 2. 输入文字：该段落应失去 md-blank-line 类并具有正常段落 margin
  await page.keyboard.insertText('Inserted Line')
  assert.equal(await blanks(), 3, 'Typing converts 1 blank line into a regular paragraph')
  const insertedState = await page.evaluate(() => {
    const p = document.querySelectorAll('.markdown-live .md-prose > p')[1]
    const s = window.getComputedStyle(p)
    return {
      text: p.textContent,
      hasBlankClass: p.classList.contains('md-blank-line'),
      marginTop: parseFloat(s.marginTop),
      marginBottom: parseFloat(s.marginBottom),
    }
  })
  assert.equal(insertedState.text, 'Inserted Line')
  assert.equal(insertedState.hasBlankClass, false, 'Non-empty paragraph no longer has md-blank-line class')
  assert(insertedState.marginTop > 0, 'Non-empty paragraph regains normal paragraph margin')

  // 3. 退格删除全部文字：恢复为 md-blank-line
  for (let i = 0; i < 'Inserted Line'.length; i++) {
    await page.keyboard.press('Backspace')
  }
  assert.equal(await blanks(), 4, 'Deleting all text restores empty paragraph to blank line')
  const restoredClass = await page.evaluate(() => {
    const p = document.querySelectorAll('.markdown-live .md-prose > p')[1]
    return p.classList.contains('md-blank-line')
  })
  assert(restoredClass, 'Empty paragraph regains md-blank-line class')

  // 4. Backspace 删除空行
  await page.keyboard.press('Backspace')
  assert.equal(await blanks(), 3, 'Backspace on blank paragraph deletes it')

  // 5. Enter 插入空行
  await page.keyboard.press('Enter')
  assert.equal(await blanks(), 4, 'Enter in blank paragraph inserts a new blank paragraph')

  // 6. Undo / Redo
  await page.keyboard.press('Control+z')
  assert.equal(await blanks(), 3, 'Undo works on blank paragraph operations')
  await page.keyboard.press('Control+y')
  assert.equal(await blanks(), 4, 'Redo works on blank paragraph operations')

  // 7. 保存到真实文件网关并两次关闭/重开
  const expectedSource = `${fence1}\n\n\n\n\n\n${fence2}\n`
  fs.writeFileSync(disk, expectedSource, 'utf8')
  await reset(fs.readFileSync(disk, 'utf8'))
  await page.evaluate(() => { window.files = window.visualFiles() })

  for (let reopen = 0; reopen < 2; reopen++) {
    assert.equal(await text(), expectedSource)
    assert.equal(await blanks(), 4)
    assert.equal(await page.evaluate(() => window.files.save(window.f.id)), true)
    assert.deepEqual(fs.readFileSync(disk), Buffer.from(expectedSource))
    assert.equal(await page.evaluate(() => window.files.close(window.f.id)), 'closed')

    await page.evaluate(async path => window.files.recent(path), disk)
    await page.waitForFunction(() => window.f.live()?.bridge.source === window.f.manager.getText(window.f.id))
    assert.equal(await blanks(), 4)
    assert.equal(await text(), expectedSource)

    const reopenedGap = await page.evaluate(() => {
      const codeBlocks = Array.from(document.querySelectorAll('.markdown-live .md-code-block'))
      return codeBlocks[1].getBoundingClientRect().top - codeBlocks[0].getBoundingClientRect().bottom
    })
    assert(Math.abs(reopenedGap - liveData.visualGap) < 1, `Visual gap preserved after reopen #${reopen + 1}`)
  }
  await page.evaluate(() => window.files.dispose())
  console.log('PASS 8.4 编辑与持久化测试：点击、文字输入扩展/回退、Enter/Backspace、Undo/Redo、两次重开字节精确一致')

  // 8. 模式切换一致性
  for (const mode of ['source', 'split', 'live', 'source', 'split', 'live']) {
    await page.evaluate(mode => window.f.mode(mode), mode)
    await page.waitForFunction(() => window.f.ready())
    assert.equal(await text(), expectedSource)
    if (mode === 'live') {
      assert.equal(await blanks(), 4)
    } else if (mode === 'split') {
      await page.waitForSelector('.split-preview-content .md-blank-line')
      assert.equal(await page.locator('.split-preview-content .md-blank-line').count(), 4)
    }
  }
  console.log('PASS 三种模式（Source / Live / Split）循环切换，源码字节与空行数量保持一致')

  assert.deepEqual(errors, [])
  assert.deepEqual(await page.evaluate(() => window.f.notices), [])

  console.log('\n=== ALL BLANK-LINE VISUAL LAYOUT & PERSISTENCE CHECKS PASSED ===\n')
} finally {
  await browser.close()
  await server.close()
}
