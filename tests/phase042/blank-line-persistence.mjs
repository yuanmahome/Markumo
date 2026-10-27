import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = path.resolve('test-results/phase042/blank-lines')
fs.mkdirSync(root, { recursive: true })
const disk = path.join(root, 'persistence.md')
const baseline = process.argv.includes('--baseline')
const baselineFiles = new Set(['MarkdownParser.ts', 'MarkdownSourceBridge.ts', 'MarkdownEditorController.ts', 'rendering.ts', 'styles.css'])
const server = await createServer({ server: { host: '127.0.0.1', port: 1481, strictPort: true, hmr: false, watch: null }, cacheDir: 'node_modules/.vite-blank-lines',
  plugins: baseline ? [{ name: 'blank-line-v109-baseline', enforce: 'pre', load(id) {
    const relative = path.relative(process.cwd(), id).replaceAll('\\', '/')
    if (relative.startsWith('src/editor/markdown/') && baselineFiles.has(path.basename(id))) {
      return execFileSync('git', ['show', `v1.0.9:${relative}`], { encoding: 'utf8', windowsHide: true })
    }
  } }] : [],
})
await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}) })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const fence = '```js\nconst a = 1;\n\n```'
const source = `${fence}\n\n${fence}\n`
const typora = JSON.parse(fs.readFileSync(new URL('./fixtures/typora-blank-lines.json', import.meta.url), 'utf8'))
const reset = async text => { await page.evaluate(text => window.f.reset(text), text); await page.waitForFunction(() => window.f.ready()) }
const snapshot = () => page.evaluate(() => {
  const e = window.f.live()
  return { source: window.f.manager.getText(window.f.id), nodes: e.view.state.doc.toJSON(), blocks: e.bridge.blocks.map(({ id, from, to, raw, prefix }) => ({ id, from, to, raw, prefix })) }
})
const blanks = async () => page.evaluate(() => window.f.live().view.state.doc.content.content.filter(n => n.type.name === 'paragraph' && !n.content.size && !n.attrs.editorTrailing).length)
const text = () => page.evaluate(() => window.f.manager.getText(window.f.id))
async function blankCaret(index = 0, pane = 'main') {
  await page.evaluate(({ index, pane }) => {
    const v = window.f.live(pane).view
    let found = 0
    v.state.doc.forEach((n, pos) => {
      if (n.type.name === 'paragraph' && !n.content.size && !n.attrs.editorTrailing && found++ === index) {
        v.dispatch(v.state.tr.setSelection(window.blankAPI.TextSelection.create(v.state.doc, pos + 1)))
      }
    })
    v.focus()
  }, { index, pane })
}
await page.exposeFunction('blankDiskRead', () => ({ token: 'fixture', path: disk, name: 'persistence.md', text: fs.readFileSync(disk, 'utf8'), encoding: 'UTF-8', bom: false, readOnly: false, eol: fs.readFileSync(disk, 'utf8').includes('\r\n') ? 'CRLF' : 'LF', version: String(fs.statSync(disk).mtimeMs) }))
await page.exposeFunction('blankDiskSave', body => { fs.writeFileSync(disk, body, 'utf8'); return { token: 'fixture', path: disk, name: 'persistence.md', encoding: 'UTF-8', bom: false, readOnly: false, eol: body.includes('\r\n') ? 'CRLF' : 'LF', version: String(fs.statSync(disk).mtimeMs) } })
try {
  await page.goto('http://127.0.0.1:1481/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)
  await page.evaluate(async () => {
    const [{ MarkdownSourceBridge }, { TextSelection }, { FileController }, { createMarkdownRenderer }] = await Promise.all([
      import('/src/editor/markdown/wysiwyg/MarkdownSourceBridge.ts'),
      import('/node_modules/.vite-blank-lines/deps/prosemirror-state.js'),
      import('/src/features/files/FileController.ts'),
      import('/src/editor/markdown/rendering.ts'),
    ])
    window.blankAPI = { MarkdownSourceBridge, TextSelection, FileController, createMarkdownRenderer }
    window.blankFiles = () => new FileController(window.f.manager, {
      historyTransactional: true, save: (_token, body) => window.blankDiskSave(body),
      openRecent: () => window.blankDiskRead(), release: async () => {},
    }, message => window.f.notices.push(message))
  })
  await reset(source)
  const before = await snapshot()
  // Exit the first fence through the real keymap, then use ordinary Enter in
  // the resulting paragraph. Fence content must remain byte-for-byte intact.
  await page.evaluate(async () => {
    const { TextSelection } = await import('/node_modules/.vite-blank-lines/deps/prosemirror-state.js').catch(() => import('/node_modules/prosemirror-state/dist/index.js'))
    const v = window.f.live().view
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.doc.firstChild.nodeSize - 1)))
    v.focus()
  })
  await page.keyboard.press('Control+Enter')
  const inserted = await snapshot()
  await reset(inserted.source)
  const reopened = await snapshot()
  const evidence = { before, inserted, reopened }
  fs.writeFileSync(path.join(root, process.argv.includes('--baseline') ? 'before.json' : 'after.json'), JSON.stringify(evidence, null, 2))
  if (process.argv.includes('--baseline')) {
    console.log(JSON.stringify(evidence, null, 2))
  } else {
    assert.equal(inserted.source, `${fence}\n\n\n\n${fence}\n`)
    assert.equal(reopened.nodes.content.filter(n => n.type === 'paragraph' && !n.attrs.editorTrailing).length, 1)
    assert.deepEqual(errors, [])
    console.log('PASS Enter → canonical source → reparse preserves one editable blank')

    const geometry=[],inputGeometry=[]
    for (const sample of typora.sourcePhysicalLines) {
      const raw=fence+'\n'.repeat(sample.newlines)+fence+'\n'
      await reset(raw)
      assert.equal(await blanks(),sample.paragraphs,`Native Typora: ${sample.blankLines} physical blank lines`)
      assert.equal(await page.evaluate(()=>{const e=window.f.live();return e.bridge.prepare(e.view.state.doc).source}),raw)
      const gap=await page.evaluate(()=>{const [a,b]=document.querySelectorAll('.md-code-block');return b.getBoundingClientRect().top-a.getBoundingClientRect().bottom})
      assert(Math.abs(gap-sample.gap)<1.5,`Native Typora border distance: ${gap} vs ${sample.gap}`)
      geometry.push({...sample,markumoGap:gap})
    }
    for (const sample of typora.input) {
      await reset(source)
      await page.evaluate(()=>{const v=window.f.live().view;v.dispatch(v.state.tr.setSelection(window.blankAPI.TextSelection.create(v.state.doc,v.state.doc.firstChild.nodeSize-1)));v.focus()})
      await page.keyboard.press('Control+Enter')
      for(let i=1;i<sample.paragraphs;i++)await page.keyboard.press('Enter')
      assert.equal(await text(),fence+'\n'.repeat(sample.newlines)+fence+'\n')
      const gap=await page.evaluate(()=>{const [a,b]=document.querySelectorAll('.md-code-block');return b.getBoundingClientRect().top-a.getBoundingClientRect().bottom})
      assert(Math.abs(gap-sample.gap)<1.5)
      inputGeometry.push({...sample,markumoGap:gap})
      if(sample.paragraphs>1)assert(Math.abs(gap-geometry.find(g=>g.paragraphs===2)?.markumoGap-(sample.paragraphs-2)*38.4)<1)
      await blankCaret();await page.keyboard.press('Delete')
      assert.equal(await blanks(),sample.paragraphs-1)
      await page.keyboard.press('Control+z');assert.equal(await blanks(),sample.paragraphs)
      // These bytes came from actual Typora keyboard input and Ctrl+S, not a
      // renderer intended to approximate Typora.
      const saved=fs.readFileSync(new URL(`./fixtures/typora-enter-${sample.paragraphs}.md`,import.meta.url),'utf8')
      await reset(saved);assert.equal(await blanks(),sample.paragraphs)
      assert.equal(await page.evaluate(()=>{const e=window.f.live();return e.bridge.prepare(e.view.state.doc).source}),saved)
    }
    fs.writeFileSync(path.join(root,'typora-geometry.json'),JSON.stringify(geometry,null,2))
    fs.writeFileSync(path.join(root,'typora-input-geometry.json'),JSON.stringify(inputGeometry,null,2))
    console.log('PASS native Typora fixtures: physical lines, 1–5 GUI paragraph insertions, DOM border distances, Delete and undo')

    const pairs = [
      [fence, fence], [fence, '# Heading'], ['![alt](/missing.png)', '# Heading'],
      ['| a |\n| --- |\n| b |', 'Paragraph'], ['第一段', '第二段'],
      ['> Quote', 'Paragraph'], ['> [!NOTE]\n> Callout', 'Paragraph'],
      ['Paragraph', '> [!TIP]\n> Callout'], ['<div>HTML</div>', 'Paragraph'], ['Paragraph', '<div>HTML</div>'],
    ]
    for (const [a, b] of pairs) for (const count of [1, 2, 3, 5]) {
      const original = a + '\n\n' + '\n\n'.repeat(count) + b + '\n'
      await reset(original)
      assert.equal(await blanks(), count, `${a} → ${b}: ${count}`)
      const ids = (await snapshot()).blocks.filter(block => block.raw.trim()).map(block => block.id)
      await blankCaret()
      await page.keyboard.press('Enter')
      assert.equal(await text(), a + '\n\n' + '\n\n'.repeat(count + 1) + b + '\n')
      assert.equal(await blanks(), count + 1)
      await page.keyboard.press('Control+z')
      assert.equal(await text(), original)
      await page.keyboard.press('Control+y')
      assert.equal(await blanks(), count + 1)
      await blankCaret()
      await page.keyboard.press('Backspace')
      assert.equal(await text(), original)
      assert.deepEqual((await snapshot()).blocks.filter(block => block.raw.trim()).map(block => block.id), ids)
      // Every remaining source line can be deleted independently.
      for (let i = 0; i < count; i++) { await blankCaret(); await page.keyboard.press('Backspace') }
      assert.equal(await text(), a + '\n\n' + b + '\n')
      assert.equal(await blanks(), 0)
    }
    console.log('PASS A–H/K/L: block pairs × 1/2/3/5 lines, Enter, Backspace, undo/redo, stable block IDs')

    for (const eol of ['\n', '\r\n']) for (const ending of ['', eol]) {
      const raw = '\n\n# 标题\n\n\n```js\ninside\n\n```\n\n\n- keep  *format*\n\n[link]: <x> "title"\n\n\n![alt](x)\n\n<div>raw</div>'.replaceAll('\n', eol) + ending
      const check = await page.evaluate(raw => {
        const b = new window.blankAPI.MarkdownSourceBridge(raw)
        return { source: b.prepare(b.doc).source, map: b.blocks.filter(b => b.blank).map(block => {
          const p = b.documentPosition(block.from)
          return [block.from, b.sourcePosition(p)]
        }) }
      }, raw)
      assert.equal(check.source, raw)
      for (const [from, mapped] of check.map) assert.equal(mapped, from)
    }
    console.log('PASS byte-exact unedited LF/CRLF, EOF, definitions/list/image/HTML/fence source and blank-line mappings')

    const whitespaceCases=await page.evaluate(()=>{
      let cases=0
      const runs=[''];for(let length=0;length<5;length++)for(const run of runs.filter(r=>r.split('|').length-1===length))for(const line of ['', ' ', '\t'])runs.push(run+line+'|')
      for(const eol of ['\n','\r\n'])for(const run of runs){
        const gap=run.replaceAll('|',eol)
        for(const raw of ['A'+eol+gap+'B',gap+'B','B'+eol+gap,gap]){
          const b=new window.blankAPI.MarkdownSourceBridge(raw)
          if(b.prepare(b.doc).source!==raw)throw Error('Whitespace roundtrip: '+JSON.stringify(raw))
          if(b.doc.content.content.some(n=>n.textContent==='B')){
            const nodes=b.doc.content.content.map(n=>n.textContent==='B'?n.type.create(n.attrs,n.type.schema.text('中文B')):n)
            const result=b.prepare(b.doc.type.create(null,nodes)).source
            if(result!==raw.replace('B','中文B'))throw Error('Unrelated edit moved whitespace: '+JSON.stringify({raw,result}))
          }
          cases++
        }
      }
      return cases
    })
    console.log(`PASS ${whitespaceCases} whitespace span roundtrips and unrelated Chinese edits (LF/CRLF, BOF/EOF, spaces and Tabs)`)

    for (const raw of [`${fence}\n${fence}`, `${fence}\n# Heading`, 'A\n \nB', 'A\n \n\nB', 'A\n\n\nB', '\n\n', ' \n\t\n', '```js\ninside\n\n\n', '~~~\ninside\n\n']) {
      const result = await page.evaluate(raw => {
        const b = new window.blankAPI.MarkdownSourceBridge(raw)
        const renderer = window.blankAPI.createMarkdownRenderer(() => {}, true)
        return { source: b.prepare(b.doc).source, blanks: b.blocks.filter(b => b.blank && b.raw).length, preview: (renderer.render(raw).match(/class="md-blank-line"/g) || []).length }
      }, raw)
      assert.equal(result.source, raw)
      assert.equal(result.preview, result.blanks, raw)
    }
    await reset(`${fence}\n${fence}`)
    await page.evaluate(() => {
      const v = window.f.live().view
      v.dispatch(v.state.tr.setSelection(window.blankAPI.TextSelection.create(v.state.doc, v.state.doc.firstChild.nodeSize - 1))); v.focus()
    })
    await page.keyboard.press('Control+Enter')
    const minimal = await text()
    assert.equal(minimal, `${fence}\n\n\n\n${fence}`)
    await reset(minimal); assert.equal(await blanks(), 1)
    console.log('PASS minimal block separators, whitespace-bearing lines, blank-only sources and unclosed fences')

    await reset('A\n\n\n\nB')
    await page.locator('.md-prose > p').nth(1).click()
    assert.equal(await page.evaluate(() => window.f.live().view.state.selection.$from.parent.content.size), 0)
    await page.keyboard.insertText('  ')
    assert.equal(await text(), 'A\n\n  \n\nB')
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
    assert.equal(await text(), 'A\n\n\n\nB')
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => window.f.live().view.state.selection.$from.parent.content.size), 0)
    console.log('PASS mouse caret, keyboard navigation, typed spaces and return to an empty paragraph')

    for (const eol of ['\n', '\r\n']) {
      fs.writeFileSync(disk, source.replaceAll('\n', eol))
      await reset(fs.readFileSync(disk, 'utf8'))
      await page.evaluate(() => { window.files = window.blankFiles() })
      await page.evaluate(() => {
        const v = window.f.live().view
        v.dispatch(v.state.tr.setSelection(window.blankAPI.TextSelection.create(v.state.doc, v.state.doc.firstChild.nodeSize - 1))); v.focus()
      })
      await page.keyboard.press('Control+Enter')
      await page.keyboard.press('Enter')
      const expected = `${fence}\n\n\n\n\n\n${fence}\n`.replaceAll('\n', eol)
      for (let reopen = 0; reopen < 2; reopen++) {
        assert.equal(await page.evaluate(() => window.f.manager.saveSnapshot(window.f.id).text), expected)
        assert.equal(await page.evaluate(() => window.files.save(window.f.id)), true)
        assert.deepEqual(fs.readFileSync(disk), Buffer.from(expected))
        assert.equal(await page.evaluate(() => window.files.close(window.f.id)), 'closed')
        await page.evaluate(async path => window.files.recent(path), disk)
        await page.waitForFunction(() => window.f.live()?.bridge.source === window.f.manager.getText(window.f.id))
        assert.equal(await blanks(), 2)
        assert.equal(await text(), expected.replaceAll('\r\n', '\n'))
        // After reopening, typing and deleting text restores the same blank.
        await blankCaret()
        await page.keyboard.insertText('中文')
        await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
        assert.equal(await text(), expected.replaceAll('\r\n', '\n'))
      }
      await page.evaluate(() => window.files.dispose())
    }
    console.log('PASS actual FileController → DocumentManager save → disk bytes → close/reopen twice, LF/CRLF, editable Chinese text')

    await reset(`${fence}\n\n\n\n${fence}\n`)
    const modesSource = await text()
    for (const mode of ['source', 'split', 'live', 'source', 'live']) {
      await page.evaluate(mode => window.f.mode(mode), mode)
      await page.waitForFunction(() => window.f.ready())
      assert.equal(await text(), modesSource)
      if (mode === 'split') {
        await page.locator('.md-blank-line').waitFor()
        assert.equal(await page.locator('.md-blank-line').count(), 1)
        assert((await page.locator('.md-blank-line').boundingBox()).height > 0)
      }
      if (mode === 'live') assert.equal(await blanks(), 1)
    }
    const pane = await page.evaluate(() => window.f.split())
    await page.waitForFunction(() => window.f.ready())
    await blankCaret(0, pane); await page.keyboard.press('Enter')
    assert.equal(await blanks(), 2)
    assert.equal(await page.evaluate(pane => window.f.live(pane).view.state.doc.eq(window.f.live().view.state.doc), pane), true)
    await page.keyboard.press('Control+z'); assert.equal(await blanks(), 1)
    await page.keyboard.press('Control+y'); assert.equal(await blanks(), 2)
    console.log('PASS Live/Source/Split cycles, visible preview blanks and multi-pane edit/history synchronization')

    await page.evaluate(() => window.f.mode('source'))
    await page.evaluate(() => {
      const m = window.f.manager, view = m.paneView('main')
      const pos = m.getText(window.f.id).indexOf('\n\n\n')
      view.dispatch({ changes: { from: pos, insert: '\n\n' } })
    })
    const sourceEdited = await text()
    await page.evaluate(() => window.f.mode('live')); await page.waitForFunction(() => window.f.ready())
    assert.equal(await blanks(), 3)
    await page.evaluate(() => window.f.mode('source'))
    assert.equal(await text(), sourceEdited)
    console.log('PASS Source edit → Live → Source uses actual canonical newline bytes')

    for (const original of ['\n\nText', 'Text\n\n\n', `${fence}\n`, '\n\n', '']) {
      await reset(original)
      const exact = await text()
      if (original === `${fence}\n`) {
        assert.equal(await blanks(), 0)
        await page.locator('.md-prose > p').last().click()
      } else if (await blanks()) await blankCaret()
      else await page.locator('.md-prose').click()
      await page.keyboard.press('Enter')
      const entered = await text(), count = await blanks()
      await reset(entered)
      assert.equal(await text(), entered)
      assert.equal(await blanks(), count, JSON.stringify({ exact, entered }))
    }
    console.log('PASS BOF/EOF/empty documents and temporary trailing paragraph promotion')

    await reset('A\n\n\n\nB')
    await blankCaret()
    await page.locator('.md-prose').dispatchEvent('compositionstart', { data: '' })
    await page.locator('.md-prose').dispatchEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 229, isComposing: true })
    assert.equal(await text(), 'A\n\n\n\nB')
    await page.locator('.md-prose').dispatchEvent('compositionend', { data: '' })
    await page.keyboard.insertText('输入法测试')
    assert((await text()).includes('输入法测试'))
    console.log('PASS synthetic IME guard and Chinese text input (native IME candidate UI requires manual testing)')

    const large = Array.from({ length: 200 }, (_, i) => `## ${i}\n\n${fence}\n\n\n\n`).join('')
    await reset(large)
    assert.equal(await page.locator('.md-code-block').count(), 200)
    assert.equal(await page.locator('.md-code-block .cm-editor').count(), 0)
    await blankCaret(100)
    await page.locator('.md-prose > p').nth(100).evaluate(element => element.scrollIntoView({ block: 'center' }))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const scroll = await page.evaluate(() => window.f.live().dom.scrollTop)
    assert(scroll > 0)
    await page.keyboard.press('Enter')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert(Math.abs(await page.evaluate(() => window.f.live().dom.scrollTop) - scroll) < 150, 'Editing a visible blank keeps the viewport near the same location')
    assert.equal(await page.locator('.md-code-block .cm-editor').count(), 0)
    const stable = await snapshot()
    assert.equal(stable.blocks.filter(b => b.raw.startsWith('```')).length, 200)
    assert.equal(await page.evaluate(() => window.f.live().view.state.selection.$from.parent.type.name), 'paragraph')
    await page.evaluate(() => window.f.mode('source')); await page.evaluate(() => window.f.mode('live'))
    await page.waitForFunction(() => window.f.ready())
    assert.equal(await text(), stable.source)
    console.log(`PASS large document, 200 idle fences = 0 embedded CM, paragraph caret (scroll before edit ${scroll}px)`)
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.f.notices), [])
  }
} finally { await browser.close(); await server.close() }
