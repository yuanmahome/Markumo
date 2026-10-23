// Live / Split layout unification and mixed text-image layout regression suite.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { startRegressionServer } from './regression-server.mjs'

const { chromium } = await import(
  process.env.MARKUMO_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.MARKUMO_PLAYWRIGHT_MODULE).href : 'playwright'
)

const output = 'test-results/live-split-layout'
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(`${output}/progress.log`, '')
fs.writeFileSync(
  `${output}/index.html`,
  '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="app"></div><script type="module" src="./fixture.js"></script>'
)

fs.writeFileSync(
  `${output}/fixture.js`,
  `
import { createApp, h, ref, markRaw, nextTick } from 'vue';
import { DocumentManager } from '/src/editor/core/DocumentManager.ts';
import SplitPreview from '/src/editor/markdown/splitPreview.vue';
import EditorPane from '/src/components/layout/EditorPane.vue';
import MarkdownLiveToolbar from '/src/components/layout/MarkdownLiveToolbar.vue';
import { markdownResources } from '/src/editor/markdown/images.ts';
import '/src/styles/reset.css';
import '/src/styles/variables.css';
import '/src/styles/main.css';
import '/src/editor/markdown/styles.css';

// Create test image PNG bytes
function makePng(width, height, color) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  const data = canvas.toDataURL('image/png').split(',')[1];
  return Uint8Array.from(atob(data), c => c.charCodeAt(0));
}

const normalPng = makePng(160, 80, '#4a90e2');
const smallPng = makePng(40, 40, '#e26a4a');

let manager, docId, app, host;
const revision = ref(0);
const toolbarWidth = ref(860);

window.fixture = {
  get manager() { return manager; },
  get docId() { return docId; },
  get toolbarWidth() { return toolbarWidth.value; },
  async init(source, mode = 'live', width = 860) {
    app?.unmount();
    manager?.dispose();
    host = null;
    manager = markRaw(new DocumentManager([], async () => []));
    manager.setCaretAnimation('off');
    toolbarWidth.value = width;
    manager.setMarkdownTypography({ ...manager.getMarkdownTypography(), width });

    docId = manager.openFile({
      token: 'layout-fixture-token',
      path: 'C:/fixture/layout-test.md',
      name: 'layout-test.md',
      text: source,
      encoding: 'UTF-8',
      bom: false,
      eol: 'LF',
      readOnly: false,
      version: 'v1'
    });

    manager.setMarkdownMode(docId, mode, 'main');
    manager.subscribe(() => revision.value++);

    // Mock resource loader for fixture images
    const facet = manager.getState(docId).facet(markdownResources);
    facet.loadLocal = async (p) => {
      if (p.includes('small')) return smallPng;
      return normalPng;
    };

    app = createApp({
      setup: () => () => {
        revision.value;
        const currentMode = manager.getMarkdownMode(docId, 'main');
        const settings = manager.getMarkdownTypography();
        return h('div', { class: 'fixture-root', style: 'height:100vh;display:flex;flex-direction:column;background:var(--editor)' }, [
          h(MarkdownLiveToolbar, {
            manager,
            pane: 'main',
            revision: revision.value,
            mode: currentMode || 'live',
            markdownWidth: toolbarWidth.value,
            'onUpdate:markdownWidth': w => {
              toolbarWidth.value = w;
              manager.setMarkdownTypography({ ...settings, width: w });
            },
            'onChangeMode': m => {
              manager.setMarkdownMode(docId, m, 'main');
            }
          }),
          h('div', { class: 'fixture-body', style: 'flex:1;min-height:0;display:flex' }, [
            h(EditorPane, { manager, pane: 'main', doc: manager.metadata(docId) })
          ])
        ]);
      }
    });

    app.mount('#app');
    await nextTick();
  },
  setMode(mode) {
    manager.setMarkdownMode(docId, mode, 'main');
    revision.value++;
  },
  setWidth(width) {
    toolbarWidth.value = width;
    manager.setMarkdownTypography({ ...manager.getMarkdownTypography(), width });
    revision.value++;
  }
};
`
)

const server = await startRegressionServer()
const port = server.httpServer.address().port
const results = []
let browser

const testDoc = `# 排版一致性测试

## 普通图片
![普通](./images/normal.png)

## 图片前后有文字
正文 BEFORE ![行内](./images/normal.png) 正文 AFTER

## 连续图片
![第一张](./images/normal.png)
![第二张](./images/small.png)

## 标题附近图片
### 标题
![图片](./images/normal.png)
下一段正文

## 引用图片
> ![引用](./images/normal.png)

## 表格图片
| 名称 | 图片 |
| --- | --- |
| 测试 | ![图片](./images/small.png) |

## HTML
<img src="./images/normal.png" width="160" alt="测试" />`

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MARKUMO_CHROME || undefined,
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(20000)

  await page.goto(`http://127.0.0.1:${port}/${output}/index.html`)
  await page.waitForFunction(() => !!window.fixture)

  const test = async (name, run) => {
    fs.appendFileSync(`${output}/progress.log`, `START ${name}\n`)
    try {
      await run()
      results.push(name)
      console.log('PASS ' + name)
      fs.appendFileSync(`${output}/progress.log`, `PASS ${name}\n`)
    } catch (error) {
      fs.appendFileSync(`${output}/progress.log`, `FAIL ${name}: ${error.stack}\n`)
      await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
      throw error
    }
  }

  // Test 1: Mixed text and image does NOT center, follows left boundary, keeps BEFORE & AFTER in same paragraph
  await test('1. mixed text and image follows left text flow without unnatural centering', async () => {
    await page.evaluate(async ({ doc }) => {
      await window.fixture.init(doc, 'live', 860)
    }, { doc: testDoc })

    await page.waitForSelector('.markdown-live .md-prose p')
    await page.waitForTimeout(500)

    const mixedMetrics = await page.evaluate(() => {
      const prose = document.querySelector('.markdown-live .md-prose')
      const paragraphs = Array.from(prose.querySelectorAll('p'))
      const mixedP = paragraphs.find(p => p.textContent.includes('BEFORE') && p.textContent.includes('AFTER'))
      if (!mixedP) return null

      const pRect = mixedP.getBoundingClientRect()
      const pStyle = window.getComputedStyle(mixedP)
      const imgPreview = mixedP.querySelector('.md-image-preview')
      const img = imgPreview?.querySelector('img')
      const imgRect = img?.getBoundingClientRect()

      // Measure range for BEFORE
      const textNode = Array.from(mixedP.childNodes).find(n => n.nodeType === 3 && n.textContent.includes('BEFORE'))
      const rangeBefore = document.createRange()
      if (textNode) {
        rangeBefore.setStart(textNode, textNode.textContent.indexOf('BEFORE'))
        rangeBefore.setEnd(textNode, textNode.textContent.indexOf('BEFORE') + 'BEFORE'.length)
      }
      const beforeRect = rangeBefore.getBoundingClientRect()

      return {
        textAlign: pStyle.textAlign,
        pLeft: pRect.left,
        pWidth: pRect.width,
        beforeLeft: beforeRect.left,
        beforeRight: beforeRect.right,
        imgLeft: imgRect?.left,
        imgWidth: imgRect?.width,
        isStandalone: imgPreview?.classList.contains('md-image-standalone'),
      }
    })

    assert.ok(mixedMetrics, 'mixed paragraph found')
    assert.equal(mixedMetrics.textAlign, 'start', 'paragraph text-align should not be center')
    assert.equal(mixedMetrics.isStandalone, false, 'inline image must not be marked as standalone')
    assert.ok(mixedMetrics.beforeLeft < mixedMetrics.imgLeft, 'BEFORE text is to the left of the image')
    assert.ok(mixedMetrics.imgLeft >= mixedMetrics.beforeRight - 5, 'image immediately follows BEFORE text')
    assert.ok(mixedMetrics.beforeLeft < mixedMetrics.pLeft + 60, 'paragraph starts from left content boundary')
  })

  // Test 2: Standalone image is properly centered with stable margins
  await test('2. standalone image is properly centered and marked as standalone', async () => {
    const standaloneMetrics = await page.evaluate(() => {
      const prose = document.querySelector('.markdown-live .md-prose')
      const paragraphs = Array.from(prose.querySelectorAll('p'))
      const standaloneP = paragraphs.find(p => p.querySelector('.md-image-standalone'))
      if (!standaloneP) return null

      const pRect = standaloneP.getBoundingClientRect()
      const pStyle = window.getComputedStyle(standaloneP)
      const img = standaloneP.querySelector('img')
      const imgRect = img?.getBoundingClientRect()
      const pCenter = pRect.left + pRect.width / 2
      const imgCenter = (imgRect?.left || 0) + (imgRect?.width || 0) / 2

      return {
        textAlign: pStyle.textAlign,
        pCenter,
        imgCenter,
        diff: Math.abs(pCenter - imgCenter),
        imgWidth: imgRect?.width,
        imgHeight: imgRect?.height,
      }
    })

    assert.ok(standaloneMetrics, 'standalone paragraph found')
    assert.equal(standaloneMetrics.textAlign, 'center', 'standalone paragraph must be centered')
    assert.ok(standaloneMetrics.diff < 5, `image center (${standaloneMetrics.imgCenter}) matches paragraph center (${standaloneMetrics.pCenter})`)
  })

  // Test 3: Live and Split layout metrics match under identical width
  await test('3. Live and Split layout metrics match within pixel tolerance at identical width', async () => {
    // 1. Measure Live mode with width 860px
    const liveDocMetrics = await page.evaluate(() => {
      const liveDoc = document.querySelector('.markdown-live .md-document')
      const h2Elements = Array.from(liveDoc.querySelectorAll('h2')).map(h => ({
        text: h.textContent,
        fontSize: window.getComputedStyle(h).fontSize,
        lineHeight: window.getComputedStyle(h).lineHeight,
        marginTop: window.getComputedStyle(h).marginTop,
        marginBottom: window.getComputedStyle(h).marginBottom,
      }))
      const images = Array.from(liveDoc.querySelectorAll('img')).map(img => ({
        width: Math.round(img.getBoundingClientRect().width),
        height: Math.round(img.getBoundingClientRect().height),
      }))
      return { h2Elements, images, docWidth: liveDoc.getBoundingClientRect().width }
    })

    // 2. Switch to Split mode
    await page.evaluate(() => {
      window.fixture.setMode('split')
    })
    await page.waitForSelector('.split-preview-pane .split-preview-content')
    await page.waitForTimeout(500)

    const splitDocMetrics = await page.evaluate(() => {
      const splitDoc = document.querySelector('.split-preview-pane .split-preview-content')
      const h2Elements = Array.from(splitDoc.querySelectorAll('h2')).map(h => ({
        text: h.textContent,
        fontSize: window.getComputedStyle(h).fontSize,
        lineHeight: window.getComputedStyle(h).lineHeight,
        marginTop: window.getComputedStyle(h).marginTop,
        marginBottom: window.getComputedStyle(h).marginBottom,
      }))
      const images = Array.from(splitDoc.querySelectorAll('img')).map(img => ({
        width: Math.round(img.getBoundingClientRect().width),
        height: Math.round(img.getBoundingClientRect().height),
      }))
      return { h2Elements, images }
    })

    assert.equal(liveDocMetrics.h2Elements.length, splitDocMetrics.h2Elements.length)
    for (let i = 0; i < liveDocMetrics.h2Elements.length; i++) {
      const l = liveDocMetrics.h2Elements[i]
      const s = splitDocMetrics.h2Elements[i]
      assert.equal(l.fontSize, s.fontSize, `H2 font-size matches (${l.text})`)
      assert.equal(l.marginTop, s.marginTop, `H2 margin-top matches (${l.text})`)
      assert.equal(l.marginBottom, s.marginBottom, `H2 margin-bottom matches (${l.text})`)
    }
    // Verify image counts
    assert.ok(splitDocMetrics.images.length >= 5, 'split preview rendered images')
  })

  // Test 4: Table image is rendered as an image slot, not escaped raw text
  await test('4. table image renders as actual image inside table cell', async () => {
    const tableImg = await page.evaluate(() => {
      const splitDoc = document.querySelector('.split-preview-pane .split-preview-content')
      const table = splitDoc.querySelector('table')
      if (!table) return null
      const img = table.querySelector('img')
      const rawText = table.textContent
      return {
        hasImg: !!img,
        hasRawSyntax: rawText.includes('![图片]'),
        imgWidth: img?.getBoundingClientRect().width,
      }
    })

    assert.ok(tableImg, 'table found')
    assert.equal(tableImg.hasImg, true, 'table cell contains rendered <img>')
    assert.equal(tableImg.hasRawSyntax, false, 'table cell must not display escaped raw syntax')
    assert.ok(tableImg.imgWidth > 0, 'table image has non-zero width')
  })

  // Test 5: Split mode forces 100% width on both panes and hides width controls
  await test('5. Split mode forces 100% pane width and hides content width button', async () => {
    const splitState = await page.evaluate(() => {
      const toolbar = document.querySelector('.md-live-toolbar')
      const widthBtn = toolbar.querySelector('.md-toolbar-width')
      const moreWidths = toolbar.querySelector('.md-more-widths')
      const splitPreview = document.querySelector('.split-preview-pane')
      const splitContent = splitPreview.querySelector('.split-preview-content')

      const previewPaneWidth = splitPreview.getBoundingClientRect().width
      const contentWidth = splitContent.getBoundingClientRect().width
      const computedStyle = window.getComputedStyle(splitContent)

      return {
        hasWidthBtn: !!widthBtn,
        hasMoreWidths: !!moreWidths,
        previewPaneWidth: Math.round(previewPaneWidth),
        contentWidth: Math.round(contentWidth),
        maxWidth: computedStyle.maxWidth,
      }
    })

    assert.equal(splitState.hasWidthBtn, false, 'width button hidden in split mode')
    assert.equal(splitState.hasMoreWidths, false, 'width presets hidden in split mode')
    assert.equal(splitState.maxWidth, '100%', 'split preview content max-width is 100%')
    assert.equal(splitState.contentWidth, splitState.previewPaneWidth, 'content width matches pane width 100%')
  })

  // Test 6: Switching from Split to Live restores original user width (e.g. 860px)
  await test('6. switching from Split to Live restores original content width setting', async () => {
    await page.evaluate(() => {
      window.fixture.setMode('live')
    })
    await page.waitForSelector('.markdown-live .md-document')
    await page.waitForTimeout(400)

    const liveState = await page.evaluate(() => {
      const toolbar = document.querySelector('.md-live-toolbar')
      const widthBtn = toolbar.querySelector('.md-toolbar-width')
      const liveDoc = document.querySelector('.markdown-live .md-document')
      const widthText = widthBtn?.querySelector('span')?.textContent

      return {
        hasWidthBtn: !!widthBtn,
        widthText,
        toolbarWidth: window.fixture.toolbarWidth,
        docMaxWidth: window.getComputedStyle(liveDoc).maxWidth,
      }
    })

    assert.equal(liveState.hasWidthBtn, true, 'width button visible in live mode')
    assert.equal(liveState.toolbarWidth, 860, 'user width preference preserved at 860')
    assert.equal(liveState.widthText, '860', 'toolbar displays 860px')
    assert.equal(liveState.docMaxWidth, '860px', 'live document max-width restored to 860px')
  })

  // Test 7: Mode switching does not alter document source text
  await test('7. mode switching does not alter document source text', async () => {
    const textBefore = await page.evaluate(() => window.fixture.manager.getText(window.fixture.docId))
    await page.evaluate(() => window.fixture.setMode('source'))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.fixture.setMode('split'))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.fixture.setMode('live'))
    await page.waitForTimeout(200)
    const textAfter = await page.evaluate(() => window.fixture.manager.getText(window.fixture.docId))

    assert.equal(textAfter, textBefore, 'text must remain identical across mode switches')
  })

  console.log('========================================')
  console.log(`All ${results.length} live-split layout regression tests passed!`)
  console.log('========================================')
} finally {
  await browser?.close()
  await server.close()
}
