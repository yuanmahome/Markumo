import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const screenshotDir = path.resolve('test-results/mermaid-media-preview')
fs.mkdirSync(screenshotDir, { recursive: true })

/** Minimal valid PNG generator (solid/gradient RGB) with exact requested dimensions, zero external deps. */
function makePngBytes(width, height, r = 56, g = 139, b = 253) {
  const crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = buf => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii')
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(data.length, 0)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
  }

  const rowLen = 1 + width * 3
  const raw = Buffer.alloc(rowLen * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3
      const checker = ((x >> 4) + (y >> 4)) & 1
      raw[px] = checker ? r : Math.min(255, r + 40)
      raw[px + 1] = checker ? g : Math.min(255, g + 30)
      raw[px + 2] = checker ? b : Math.max(0, b - 30)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = zlib.deflateSync(raw, { level: 1 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const smallPngBase64 = makePngBytes(240, 160, 42, 126, 226).toString('base64')
const htmlPngBase64 = makePngBytes(180, 120, 16, 163, 127).toString('base64')
const largeThumbBase64 = makePngBytes(800, 500, 139, 92, 246).toString('base64')
const largeFullBase64 = makePngBytes(2400, 1500, 139, 92, 246).toString('base64')

const server = await createServer({
  server: { host: '127.0.0.1', port: 1486, strictPort: true, hmr: false, watch: null },
  cacheDir: 'node_modules/.vite-mermaid-media-preview',
})
await server.listen()

const browser = await chromium.launch({
  headless: true,
  args: ['--js-flags=--expose-gc'],
  ...(process.env.MARKUMO_CHROME ? { executablePath: process.env.MARKUMO_CHROME } : {}),
})
const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1.5 })
await context.grantPermissions(['clipboard-read', 'clipboard-write'])
const page = await context.newPage()

const pageErrors = []
const externalRequests = []
page.on('pageerror', err => pageErrors.push(err.message))
await page.route('**/*', route => {
  const url = new URL(route.request().url())
  if (url.hostname === '127.0.0.1' || url.protocol === 'blob:' || url.protocol === 'data:') {
    return route.continue()
  }
  externalRequests.push(route.request().url())
  return route.abort()
})

const cdp = await context.newCDPSession(page)
await cdp.send('Performance.enable')

try {
  await page.goto('http://127.0.0.1:1486/tests/markdown-links/fixture.html')
  await page.waitForFunction(() => !!window.f)

  // Install Blob URL tracking + local image IPC mock + SplitPreview resource wiring
  await page.evaluate(
    async ({ smallPngBase64, htmlPngBase64, largeThumbBase64, largeFullBase64 }) => {
      const decodeB64 = b64 => {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return bytes.buffer
      }
      const imageMap = {
        'sample.png': { preview: decodeB64(smallPngBase64), full: decodeB64(smallPngBase64) },
        'html-sample.png': { preview: decodeB64(htmlPngBase64), full: decodeB64(htmlPngBase64) },
        'large-photo.png': { preview: decodeB64(largeThumbBase64), full: decodeB64(largeFullBase64) },
      }

      const activeBlobs = new Set()
      const origCreate = URL.createObjectURL.bind(URL)
      const origRevoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = obj => {
        const u = origCreate(obj)
        activeBlobs.add(u)
        return u
      }
      URL.revokeObjectURL = u => {
        activeBlobs.delete(u)
        return origRevoke(u)
      }
      window.__activeBlobCount = () => activeBlobs.size

      const prevInvoke = window.__TAURI_INTERNALS__.invoke
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'read_markdown_image') {
          const rel = String(args?.relative || '').replace(/^\.\//, '')
          const entry = imageMap[rel]
          if (!entry) {
            throw { code: 'not_found', message: `File not found: ${rel}` }
          }
          return args?.full ? entry.full.slice(0) : entry.preview.slice(0)
        }
        return prevInvoke(command, args)
      }

      // Enhance window.f.mode('split') so SplitPreview receives real MarkdownResources just like EditorPane.vue
      const { mountTestSplitPreview, unmountTestSplitPreview } = await import(
        '/tests/mermaid-media-preview/helper.ts'
      )
      const origReset = window.f.reset.bind(window.f)
      window.f.reset = (source, readOnly = false) => {
        unmountTestSplitPreview()
        return origReset(source, readOnly)
      }
      const origDispose = window.f.dispose.bind(window.f)
      window.f.dispose = () => {
        unmountTestSplitPreview()
        return origDispose()
      }
      window.f.mode = mode => {
        unmountTestSplitPreview()
        window.f.manager.setMarkdownMode(window.f.id, mode, 'main')
        if (mode === 'split') {
          mountTestSplitPreview(window.f.manager, window.f.id)
        }
      }
    },
    { smallPngBase64, htmlPngBase64, largeThumbBase64, largeFullBase64 }
  )

  // =========================================================================
  // E.1 Plain text / non-diagram baseline: zero Mermaid load & zero modal DOM
  // =========================================================================
  const plainBaseline = await page.evaluate(async () => {
    window.f.reset('# 普通 Markdown 纯文本\n\n这里没有任何图表，也没有图片。\n\n- 列表项一\n- 列表项二\n')
    while (!window.f.ready()) await new Promise(r => setTimeout(r, 10))
    const dialogsInDom = document.querySelectorAll('dialog.md-image-lightbox').length
    const zoomBtnsHidden = [...document.querySelectorAll('.md-media-zoom-btn')].every(b => b.hidden)
    return { dialogsInDom, zoomBtnsHidden }
  })
  assert.equal(plainBaseline.dialogsInDom, 0, 'Modal dialog must not be mounted before first preview open')
  assert.equal(plainBaseline.zoomBtnsHidden, true, 'Hover zoom button must stay hidden when idle')
  console.log('PASS [E.1] Plain Markdown baseline: 0 modal dialogs mounted, zoom trigger hidden')

  // =========================================================================
  // A. Mermaid Legal Syntax & All 21 Diagram Types + Unsupported Clear Prompt
  // =========================================================================
  const diagramVerification = await page.evaluate(async () => {
    const { renderDiagram, clearRenderCaches } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    clearRenderCaches()

    const sandbox = document.createElement('div')
    sandbox.style.cssText = 'width: 900px;'
    document.body.append(sandbox)

    const validCases = {
      classInheritanceAndRelations: `classDiagram
  class Animal~T~ {
    <<abstract>>
    +String 名称
    +eat(food) bool
  }
  class Flyable {
    <<interface>>
    +fly() void
  }
  Animal <|-- Duck : 继承
  Flyable <|.. Duck : 实现
  Duck *-- Wing : 组合
  Pond o-- Duck : 聚合
  Duck <-- Feeder : 关联
  Duck <.. Logger : 依赖
  Duck <--> Partner : 双向`,

      styledAndChineseSpecial: `flowchart LR
  Start["开始：请求耗时 < 50ms & 状态正常"]:::primary --> Check{"重试次数 < 3?"}
  Check -->|是| Api["调用 https://api.example.com (click/callback/style 文本)"]
  DB@{ shape: cyl, label: "核心订单库" }
  Api --> DB
  Check -->|否| Fail["告警 & 降级"]
  classDef primary fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0c4a6e
  style Fail fill:#fee2e2,stroke:#dc2626,stroke-width:2px
  linkStyle 0 stroke:#0284c7,stroke-width:3px`,

      yamlFrontmatter: `---
title: 订单支付核心流转
config:
  theme: forest
  flowchart:
    curve: basis
---
flowchart LR
  A[下单] --> B[风控校验] --> C[支付成功]`,

      legacyInitDirective: `%%{init: {"theme": "neutral", "flowchart": {"curve": "linear"}}}%%
flowchart TD
  InitA[初始化配置] --> InitB[渲染完成]`,

      flowchart: 'flowchart TD\n  A[节点A] --> B{判断} --> C[节点C]',
      sequenceDiagram: 'sequenceDiagram\n  participant U as 用户\n  participant S as 服务端\n  U->>S: 登录请求\n  S-->>U: 返回令牌',
      classDiagram: 'classDiagram\n  Base <|-- Derived\n  Base : +id int',
      stateDiagramV2: 'stateDiagram-v2\n  [*] --> 待处理\n  待处理 --> 处理中 : 开始\n  处理中 --> [*]',
      erDiagram: 'erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ ITEM : contains',
      gantt: 'gantt\n  title 迭代排期\n  dateFormat YYYY-MM-DD\n  section 研发\n  架构设计 :a1, 2026-01-01, 5d',
      pie: 'pie title 渠道占比\n  "桌面端" : 65\n  "移动端" : 35',
      gitGraph: 'gitGraph\n  commit id: "init"\n  branch feat\n  checkout feat\n  commit id: "mermaid"\n  checkout main\n  merge feat',
      mindmap: 'mindmap\n  root((Markumo))\n    编辑器\n      ProseMirror\n      CodeMirror\n    图表\n      Mermaid',
      timeline: 'timeline\n  title 版本演进\n  2025 : 1.0 发布\n  2026 : 图表增强',
      journey: 'journey\n  title 写作体验旅程\n  section 编辑\n    输入图表: 5: 作者\n    悬浮放大: 5: 作者',
      quadrantChart: 'quadrantChart\n  title 需求四象限\n  x-axis 低成本 --> 高成本\n  y-axis 低价值 --> 高价值\n  Mermaid增强: [0.3, 0.9]',
      xychartBeta: 'xychart-beta\n  title "性能趋势"\n  x-axis [v1, v2, v3]\n  y-axis "耗时(ms)" 0 --> 100\n  bar [80, 45, 22]\n  line [80, 45, 22]',
      sankeyBeta: 'sankey-beta\n\nTraffic,CacheHit,70\nTraffic,LiveRender,30',
      blockBeta: 'block-beta\n  columns 2\n  A["编辑器内核"] B["预览模态层"]\n  A --> B',
      architectureBeta: 'architecture-beta\n  group app(cloud)[Markumo]\n  service ui(server)[VueUI] in app\n  service core(database)[RustCore] in app\n  ui:R -- L:core',
      kanban: 'kanban\n  待办\n    [语法兼容]\n  已完成\n    [统一大图预览]',
      requirementDiagram: 'requirementDiagram\n  requirement req_mermaid {\n    id: 1\n    text: Safe Mermaid rendering\n    risk: low\n    verifymethod: test\n  }\n  element renderer {\n    type: module\n  }\n  renderer - satisfies -> req_mermaid',
      c4: 'C4Context\n  title Markumo Context\n  Person(author, "Author", "Writes Markdown")\n  System(markumo, "Markumo", "Desktop Editor")\n  Rel(author, markumo, "Edits")',
      venn: 'venn-beta\n  set A["图片预览"]\n  set B["图表预览"]\n  union A, B["统一模态层"]',
      ishikawa: 'ishikawa-beta\n  Quality\n    Syntax\n      Validation\n    Security\n      Sanitize',
    }

    const validResults = {}
    for (const [name, src] of Object.entries(validCases)) {
      const host = document.createElement('div')
      sandbox.append(host)
      try {
        await renderDiagram(host, src)
        const svg = host.querySelector('svg')
        const rect = svg?.getBoundingClientRect()
        const labelTexts = [...host.querySelectorAll('text, title')].map(el => el.textContent || '').join(' ')
        validResults[name] = {
          ok: !!svg && (rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0,
          foreignObjects: host.querySelectorAll('foreignObject').length,
          textSample: labelTexts.replace(/\s+/g, ' ').trim().slice(0, 200),
          html: svg ? svg.outerHTML.slice(0, 300) : '',
          hasPrimaryFill: host.innerHTML.includes('#e0f2fe'),
          hasInlineStyleFill: host.innerHTML.includes('#fee2e2'),
        }
      } catch (err) {
        validResults[name] = { ok: false, error: String(err?.message || err) }
      }
    }

    // Unsupported diagrams must throw clear error and NEVER leave fake SVG or orphan #d... nodes
    const unsupportedCases = {
      zenuml: 'zenuml\n  Alice->Bob: Hello',
      bareVenn: 'venn\n  set A\n  set B',
      nonExistent: 'superCustomChart\n  x --> y',
    }
    const unsupportedResults = {}
    for (const [name, src] of Object.entries(unsupportedCases)) {
      const host = document.createElement('div')
      sandbox.append(host)
      try {
        await renderDiagram(host, src)
        unsupportedResults[name] = { rejected: false, hasSvg: !!host.querySelector('svg') }
      } catch (err) {
        unsupportedResults[name] = {
          rejected: true,
          message: err instanceof Error ? err.message : String(err),
          hasSvg: !!host.querySelector('svg'),
          bodyOrphans: document.querySelectorAll('[id^="dmarkumo-diagram-"]').length,
        }
      }
    }

    sandbox.remove()
    return { validResults, unsupportedResults }
  })

  for (const [name, res] of Object.entries(diagramVerification.validResults)) {
    assert.equal(res.ok, true, `Expected Mermaid case "${name}" to render valid SVG, got: ${JSON.stringify(res)}`)
    assert.equal(res.foreignObjects, 0, `Diagram "${name}" must not retain <foreignObject> in sanitized SVG`)
  }
  assert(diagramVerification.validResults.styledAndChineseSpecial.hasPrimaryFill, 'classDef fill must apply')
  assert(diagramVerification.validResults.styledAndChineseSpecial.hasInlineStyleFill, 'style fill must apply')
  assert(
    diagramVerification.validResults.yamlFrontmatter.textSample.includes('订单支付核心流转'),
    'YAML Frontmatter title must render in SVG'
  )
  assert(
    diagramVerification.validResults.journey.textSample.includes('输入图表'),
    'Journey diagram labels converted from foreignObject must remain visible'
  )
  for (const [name, res] of Object.entries(diagramVerification.unsupportedResults)) {
    assert.equal(res.rejected, true, `Unsupported diagram "${name}" must not pretend to succeed`)
    assert.equal(res.hasSvg, false)
    assert.equal(res.bodyOrphans, 0, 'Failed Mermaid render must leave 0 orphan nodes on document.body')
    assert(/暂不支持/.test(res.message), `Expected clear unsupported prompt for "${name}", got: ${res.message}`)
  }
  assert(
    diagramVerification.unsupportedResults.bareVenn.message.includes('venn-beta'),
    'Bare "venn" should suggest "venn-beta" for Mermaid 11.16.1'
  )
  console.log(
    `PASS [A] All ${Object.keys(diagramVerification.validResults).length} Mermaid syntax & diagram cases rendered; unsupported types clearly prompted`
  )

  // =========================================================================
  // B. Security Scenarios (XSS, HTML, External Resources, Callbacks, Config Escalation, SVG ID Isolation)
  // =========================================================================
  const securityVerification = await page.evaluate(async () => {
    const { renderDiagram } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    const sandbox = document.createElement('div')
    document.body.append(sandbox)

    window.__mermaidXss = 0

    // 1. Malicious script & dangerous HTML inside node labels -> sanitized cleanly, zero execution
    const xssHost = document.createElement('div')
    sandbox.append(xssHost)
    await renderDiagram(
      xssHost,
      `flowchart LR
  A["<script>window.__mermaidXss=1</script><img src=x onerror=window.__mermaidXss=2><iframe src='https://evil.invalid'></iframe>安全节点"] --> B["<svg onload=window.__mermaidXss=3>终点"]`
    )
    const xssDomCheck = {
      xssValue: window.__mermaidXss,
      scripts: xssHost.querySelectorAll('script').length,
      iframes: xssHost.querySelectorAll('iframe').length,
      imgs: xssHost.querySelectorAll('img, image, feImage').length,
      foreignObjects: xssHost.querySelectorAll('foreignObject').length,
      anchors: xssHost.querySelectorAll('a').length,
    }

    // 2. Click external link neutralization (keeps node geometry, strips <a> and href)
    const linkHost = document.createElement('div')
    sandbox.append(linkHost)
    await renderDiagram(
      linkHost,
      'flowchart LR\n  NodeA[可点击外观节点] --> NodeB[普通节点]\n  click NodeA "https://evil.invalid/phish" _blank'
    )
    const linkNeutralized = {
      anchors: linkHost.querySelectorAll('a').length,
      hrefAttrs: [...linkHost.querySelectorAll('*')].some(
        el => el.hasAttribute('href') || el.hasAttribute('xlink:href')
      ),
      hasNodeAText: linkHost.textContent?.includes('可点击外观节点') ?? false,
    }

    // 3. Explicit rejection of callbacks, dangerous protocols, external resources, and config privilege escalation
    const blockedPayloads = {
      jsCallback: 'flowchart LR\n  A --> B\n  click A call alert(1)',
      jsProtocol: 'flowchart LR\n  A --> B\n  click A "javascript:alert(1)"',
      dataProtocol: 'flowchart LR\n  A --> B\n  click A "data:text/html,<script>alert(1)</script>"',
      externalShapeImg: 'flowchart LR\n  A@{ img: "https://evil.invalid/spy.png", label: "Spy" } --> B',
      externalStyleUrl: 'flowchart LR\n  A --> B\n  style A fill:url(https://evil.invalid/pattern.svg#p)',
      cssImport: 'flowchart LR\n  A --> B\n  classDef bad fill:#fff;@import url("https://evil.invalid/a.css")',
      fmLooseSecurity: '---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\n  A --> B',
      fmHtmlLabels: '---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n  A --> B',
      fmThemeCss: '---\nconfig:\n  themeCSS: "svg { background: url(https://evil.invalid/x) }"\n---\nflowchart LR\n  A --> B',
      initLooseSecurity: '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n  A --> B',
      initNestedHtmlLabels: '%%{init: {"flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A --> B',
      initDompurifyBypass: '%%{init: {"dompurifyConfig": {"ALLOW_TAGS": ["script"]}}}%%\nflowchart LR\n  A --> B',
      initMaxTextBypass: '%%{init: {"maxTextSize": 99999999}}%%\nflowchart LR\n  A --> B',
    }
    const blockedResults = {}
    for (const [name, payload] of Object.entries(blockedPayloads)) {
      const h = document.createElement('div')
      sandbox.append(h)
      try {
        await renderDiagram(h, payload)
        blockedResults[name] = { blocked: false }
      } catch (err) {
        blockedResults[name] = { blocked: true, msg: err instanceof Error ? err.message : String(err) }
      }
    }

    // 4. Multi-diagram SVG ID isolation across identical + distinct diagrams on the same page
    const idHost1 = document.createElement('div')
    const idHost2 = document.createElement('div')
    const idHost3 = document.createElement('div')
    sandbox.append(idHost1, idHost2, idHost3)
    const sharedChart = 'flowchart LR\n  X[源] --> Y[汇]\n  classDef c fill:#dbeafe,stroke:#2563eb\n  class X c'
    await renderDiagram(idHost1, sharedChart)
    await renderDiagram(idHost2, sharedChart)
    await renderDiagram(idHost3, 'sequenceDiagram\n  A->>B: ping')

    const allElementsWithId = [...sandbox.querySelectorAll('svg [id], svg[id]')]
    const allIds = allElementsWithId.map(el => el.id)
    const uniqueIdCount = new Set(allIds).size
    // Verify every marker-end="url(#...)" resolves inside its own SVG root
    const brokenMarkerRefs = [idHost1, idHost2, idHost3].flatMap(h => {
      const svg = h.querySelector('svg')
      if (!svg) return ['missing-svg']
      const localIds = new Set([...svg.querySelectorAll('[id]')].map(n => n.id))
      if (svg.id) localIds.add(svg.id)
      const refs = []
      for (const el of svg.querySelectorAll('[marker-end], [marker-start], [clip-path], [filter]')) {
        for (const attr of ['marker-end', 'marker-start', 'clip-path', 'filter']) {
          const val = el.getAttribute(attr)
          const m = val && /url\(#([^)]+)\)/.exec(val)
          if (m && !localIds.has(m[1])) refs.push(`${attr}->${m[1]}`)
        }
      }
      return refs
    })

    sandbox.remove()
    return {
      xssDomCheck,
      linkNeutralized,
      blockedResults,
      totalIds: allIds.length,
      uniqueIdCount,
      brokenMarkerRefs,
    }
  })

  assert.equal(securityVerification.xssDomCheck.xssValue, 0, 'XSS script must never execute')
  assert.equal(securityVerification.xssDomCheck.scripts, 0)
  assert.equal(securityVerification.xssDomCheck.iframes, 0)
  assert.equal(securityVerification.xssDomCheck.imgs, 0)
  assert.equal(securityVerification.xssDomCheck.foreignObjects, 0)
  assert.equal(securityVerification.xssDomCheck.anchors, 0)
  assert.equal(securityVerification.linkNeutralized.anchors, 0, 'SVG <a> must be unwrapped/removed')
  assert.equal(securityVerification.linkNeutralized.hrefAttrs, false, 'External href/xlink:href must be stripped')
  assert.equal(securityVerification.linkNeutralized.hasNodeAText, true, 'Unwrapped click node must preserve text')
  for (const [name, res] of Object.entries(securityVerification.blockedResults)) {
    assert.equal(res.blocked, true, `Expected malicious payload "${name}" to be blocked`)
  }
  assert.equal(
    securityVerification.uniqueIdCount,
    securityVerification.totalIds,
    'Every SVG ID across multiple mounted diagrams must be globally unique'
  )
  assert.deepEqual(securityVerification.brokenMarkerRefs, [], 'All url(#id) marker/clipPath/filter refs must point to local SVG IDs')
  assert.deepEqual(externalRequests, [], 'Zero external network requests allowed during security tests')
  console.log('PASS [B] All XSS, HTML, external resource, callback, config escalation & SVG ID isolation checks passed')

  // =========================================================================
  // C. Interactive Unified MediaPreview (Hover/Focus Button, Zoom, Wheel-at-Pointer, Pan, Esc, Live & Split)
  // =========================================================================
  const interactiveDoc = [
    '# 统一媒体预览交互测试',
    '',
    '首段普通文本，用于检查光标和布局高度零偏移。',
    '',
    '![正常图片](sample.png)',
    '',
    '<div><img src="html-sample.png" alt="HTML图片" width="180" /></div>',
    '',
    '![损坏图片](does-not-exist.png)',
    '',
    '![未授权远程图片](https://example.com/untrusted.png)',
    '',
    '```mermaid',
    '---',
    'title: 系统架构流转',
    '---',
    'flowchart LR',
    '  Client[客户端]:::core --> Gateway[API 网关] --> Service[业务服务]',
    '  Service --> DB@{ shape: cyl, label: "主数据库" }',
    '  classDef core fill:#dbeafe,stroke:#2563eb,stroke-width:2px',
    '```',
    '',
    '```mermaid',
    'classDiagram',
    '  MediaPreview <|-- ImageTarget',
    '  MediaPreview <|-- DiagramTarget',
    '```',
    '',
    '```mermaid',
    'zenuml',
    '  Broken->Diagram: unsupported',
    '```',
    '',
  ].join('\n')

  await page.evaluate(doc => window.f.reset(doc), interactiveDoc)
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.markdown-live img:not(.ProseMirror-separator)')]
    const svgs = [...document.querySelectorAll('.markdown-live .md-diagram > svg')]
    const errs = [...document.querySelectorAll('.markdown-live .md-diagram.md-render-error')]
    return imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0) && svgs.length === 2 && errs.length === 1
  })

  // Measure layout heights BEFORE hover
  const beforeHoverMetrics = await page.evaluate(() => {
    const prose = document.querySelector('.markdown-live .md-prose')
    const img = document.querySelector('.markdown-live .md-live-image img')
    const diagram = document.querySelector('.markdown-live .md-diagram')
    return {
      proseHeight: prose.getBoundingClientRect().height,
      imgRect: img.getBoundingClientRect().toJSON(),
      diagramRect: diagram.getBoundingClientRect().toJSON(),
    }
  })

  // 1. Hover Markdown image -> floating zoom button appears at top-right with ZERO layout shift
  const liveMdImg = page.locator('.markdown-live .md-live-image img').first()
  await liveMdImg.hover()
  const liveZoomBtn = page.locator('.markdown-live > .md-media-zoom-btn')
  await liveZoomBtn.waitFor({ state: 'visible' })

  const duringImgHoverMetrics = await page.evaluate(() => {
    const prose = document.querySelector('.markdown-live .md-prose')
    const img = document.querySelector('.markdown-live .md-live-image img')
    const diagram = document.querySelector('.markdown-live .md-diagram')
    const btn = document.querySelector('.markdown-live > .md-media-zoom-btn')
    const cs = getComputedStyle(btn)
    return {
      proseHeight: prose.getBoundingClientRect().height,
      imgRect: img.getBoundingClientRect().toJSON(),
      diagramRect: diagram.getBoundingClientRect().toJSON(),
      btnRect: btn.getBoundingClientRect().toJSON(),
      position: cs.position,
    }
  })
  assert.equal(duringImgHoverMetrics.position, 'absolute', 'Zoom icon must use absolute positioning')
  assert.equal(duringImgHoverMetrics.proseHeight, beforeHoverMetrics.proseHeight, 'Hovering image must cause 0px document height change')
  assert.equal(duringImgHoverMetrics.imgRect.height, beforeHoverMetrics.imgRect.height, 'Hovering image must cause 0px image height change')
  assert(
    Math.abs(duringImgHoverMetrics.btnRect.right - duringImgHoverMetrics.imgRect.right) <= 16 &&
      Math.abs(duringImgHoverMetrics.btnRect.top - duringImgHoverMetrics.imgRect.top) <= 16,
    'Zoom icon must appear at top-right corner of hovered image'
  )

  // 2. Hover HTML <img> -> zoom button also appears
  await page.locator('.markdown-live .md-html-preview img').hover()
  await liveZoomBtn.waitFor({ state: 'visible' })
  assert.equal(await liveZoomBtn.getAttribute('data-media-kind'), 'image')

  // 3. Hover broken image, pending remote image, and failed Mermaid diagram -> zoom button MUST stay hidden!
  await page.locator('.markdown-live .md-live-image.is-broken-image').hover()
  assert.equal(await liveZoomBtn.isHidden(), true, 'Broken image must NOT show zoom button')

  await page.locator('.markdown-live .md-diagram.md-render-error').hover()
  assert.equal(await liveZoomBtn.isHidden(), true, 'Failed Mermaid diagram must NOT show zoom button')

  // 4. Hover valid Mermaid diagram -> capture screenshot & open modal WITHOUT calling mermaid.render() again!
  const firstMermaidDiagram = page.locator('.markdown-live .md-diagram').first()
  await firstMermaidDiagram.hover()
  await liveZoomBtn.waitFor({ state: 'visible' })
  assert.equal(await liveZoomBtn.getAttribute('data-media-kind'), 'diagram')
  await page.screenshot({ path: path.join(screenshotDir, '01-live-mermaid-hover.png') })

  const rendersBeforeModal = await page.evaluate(async () => {
    const { getRenderCacheStats } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    return getRenderCacheStats().diagramRenders
  })

  await liveZoomBtn.click()
  const dialog = page.locator('dialog.md-image-lightbox[open]')
  await dialog.waitFor({ state: 'visible' })
  await page.screenshot({ path: path.join(screenshotDir, '02-mermaid-modal-open.png') })

  const modalMermaidState = await page.evaluate(async () => {
    const { getRenderCacheStats } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    const modalSvg = document.querySelector('dialog.md-image-lightbox[open] svg.md-media-lightbox-svg')
    const cs = modalSvg ? getComputedStyle(modalSvg) : null
    const allSvgIds = [...document.querySelectorAll('svg [id], svg[id]')].map(el => el.id).filter(Boolean)
    return {
      rendersAfterModal: getRenderCacheStats().diagramRenders,
      hasModalSvg: !!modalSvg,
      maxWidth: cs?.maxWidth,
      totalModalDialogs: document.querySelectorAll('dialog.md-image-lightbox').length,
      allIdsUnique: new Set(allSvgIds).size === allSvgIds.length,
    }
  })
  assert.equal(modalMermaidState.hasModalSvg, true, 'Modal must display cloned Mermaid SVG')
  assert.equal(
    modalMermaidState.rendersAfterModal,
    rendersBeforeModal,
    'Opening Mermaid preview must reuse rendered SVG without calling mermaid.render()'
  )
  assert.equal(modalMermaidState.maxWidth, 'none', 'Previewed SVG must not be constrained by max-width: 100%')
  assert.equal(modalMermaidState.totalModalDialogs, 1, 'Only ONE shared modal dialog may exist')
  assert.equal(modalMermaidState.allIdsUnique, true, 'Cloned modal SVG IDs must not collide with page SVG IDs')

  // 5. Toolbar buttons: 100%, 放大, 缩小, 适应窗口, 重置
  await dialog.locator('button[aria-label="100%"]').click()
  assert.equal(await dialog.locator('output').textContent(), '100%')
  const widthAt100 = await dialog.locator('svg.md-media-lightbox-svg').evaluate(el => el.getBoundingClientRect().width)

  await dialog.locator('button[aria-label="放大"]').click()
  assert.equal(await dialog.locator('output').textContent(), '125%')
  const widthAt125 = await dialog.locator('svg.md-media-lightbox-svg').evaluate(el => el.getBoundingClientRect().width)
  assert(Math.abs(widthAt125 / widthAt100 - 1.25) < 0.02, 'Zoom in must scale SVG vector width by 1.25x')

  await dialog.locator('button[aria-label="缩小"]').click()
  assert.equal(await dialog.locator('output').textContent(), '100%')

  // 6. Pointer-centered wheel zoom + underlying editor scroll isolation
  // Zoom until SVG overflows both X and Y axes of the modal viewport so both scrollbars can anchor freely
  while (
    await page.evaluate(() => {
      const svg = document.querySelector('dialog.md-image-lightbox[open] svg.md-media-lightbox-svg')
      const surface = document.querySelector('dialog.md-image-lightbox[open] .md-image-lightbox-surface')
      return svg.getBoundingClientRect().height < surface.clientHeight * 1.15
    })
  ) {
    await dialog.locator('button[aria-label="放大"]').click()
  }
  const editorScrollBeforeWheel = await page.evaluate(() => document.querySelector('.markdown-live').scrollTop)
  const wheelAnchor = await page.evaluate(() => {
    const surface = document.querySelector('dialog.md-image-lightbox[open] .md-image-lightbox-surface')
    surface.scrollLeft = Math.round((surface.scrollWidth - surface.clientWidth) * 0.4)
    surface.scrollTop = Math.round((surface.scrollHeight - surface.clientHeight) * 0.4)
    const svg = document.querySelector('dialog.md-image-lightbox[open] svg.md-media-lightbox-svg')
    const sr = surface.getBoundingClientRect()
    const px = Math.round(sr.left + sr.width * 0.35)
    const py = Math.round(sr.top + sr.height * 0.4)
    const r = svg.getBoundingClientRect()
    return { px, py, relX: (px - r.left) / r.width, relY: (py - r.top) / r.height }
  })
  await page.mouse.move(wheelAnchor.px, wheelAnchor.py)
  await page.mouse.wheel(0, -160)

  const afterWheel = await page.evaluate(({ px, py }) => {
    const svg = document.querySelector('dialog.md-image-lightbox[open] svg.md-media-lightbox-svg')
    const r = svg.getBoundingClientRect()
    return {
      relX: (px - r.left) / r.width,
      relY: (py - r.top) / r.height,
      editorScrollTop: document.querySelector('.markdown-live').scrollTop,
    }
  }, wheelAnchor)
  assert(Math.abs(afterWheel.relX - wheelAnchor.relX) < 0.015, `Wheel zoom must anchor X at pointer (${afterWheel.relX} vs ${wheelAnchor.relX})`)
  assert(Math.abs(afterWheel.relY - wheelAnchor.relY) < 0.015, `Wheel zoom must anchor Y at pointer (${afterWheel.relY} vs ${wheelAnchor.relY})`)
  assert.equal(afterWheel.editorScrollTop, editorScrollBeforeWheel, 'Modal wheel must never scroll underlying editor')

  // 7. Left-button drag panning & grab -> grabbing -> grab cursor state
  const surfaceLoc = dialog.locator('.md-image-lightbox-surface')
  assert.equal(await surfaceLoc.evaluate(el => getComputedStyle(el).cursor), 'grab')
  const surfaceBox = await surfaceLoc.boundingBox()
  const startPanScroll = await surfaceLoc.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }))
  await page.mouse.move(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height / 2)
  await page.mouse.down({ button: 'left' })
  assert.equal(await surfaceLoc.evaluate(el => getComputedStyle(el).cursor), 'grabbing')
  await page.mouse.move(surfaceBox.x + surfaceBox.width / 2 - 90, surfaceBox.y + surfaceBox.height / 2 - 60, { steps: 4 })
  const afterPanScroll = await surfaceLoc.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }))
  assert(afterPanScroll.left > startPanScroll.left, 'Dragging left must pan scrollLeft right')
  await page.mouse.up({ button: 'left' })
  assert.equal(await surfaceLoc.evaluate(el => getComputedStyle(el).cursor), 'grab')

  // Reset button returns scroll to (0,0) and fits window
  await dialog.locator('button[aria-label="重置"]').click()
  const resetState = await surfaceLoc.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }))
  assert.equal(resetState.left, 0)
  assert.equal(resetState.top, 0)

  // Keyboard zoom (+/-) and Esc close + DOM cleanup
  const scaleBeforeKey = await dialog.locator('output').textContent()
  await page.keyboard.press('+')
  assert.notEqual(await dialog.locator('output').textContent(), scaleBeforeKey)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('dialog.md-image-lightbox[open]'))
  const stageChildrenAfterClose = await page.evaluate(
    () => document.querySelector('dialog.md-image-lightbox .md-media-lightbox-stage')?.childElementCount ?? 0
  )
  assert.equal(stageChildrenAfterClose, 0, 'Closing modal must release cloned SVG DOM immediately')

  // 8. Keyboard focus accessibility on zoom button & focus restoration on Esc
  await page.evaluate(() => {
    const btn = document.querySelector('.markdown-live .md-diagram-btn')
    btn.focus()
  })
  await liveZoomBtn.waitFor({ state: 'visible' })
  await page.evaluate(() => document.querySelector('.markdown-live > .md-media-zoom-btn').focus())
  await page.keyboard.press('Enter')
  await dialog.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('dialog.md-image-lightbox[open]'))
  const restoredToZoomBtn = await page.evaluate(
    () => document.activeElement === document.querySelector('.markdown-live > .md-media-zoom-btn')
  )
  assert.equal(restoredToZoomBtn, true, 'Closing modal opened via keyboard must restore focus to zoom button')

  // 9. Split Preview consistency & zero redundant Mermaid render calculation
  const statsBeforeSplit = await page.evaluate(async () => {
    const { getRenderCacheStats } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    return getRenderCacheStats()
  })
  await page.evaluate(() => window.f.mode('split'))
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('.split-preview-pane img')]
      const svgs = [...document.querySelectorAll('.split-preview-pane .md-diagram > svg')]
      return imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0) && svgs.length === 2
    },
    null,
    { timeout: 8000 }
  ).catch(async err => {
    const diag = await page.evaluate(() => ({
      paneRect: document.querySelector('.split-preview-pane')?.getBoundingClientRect().toJSON(),
      contentRect: document.querySelector('.split-preview-content')?.getBoundingClientRect().toJSON(),
      imgs: [...document.querySelectorAll('.split-preview-pane img')].map(i => ({ src: i.src, nw: i.naturalWidth })),
      diagrams: [...document.querySelectorAll('.split-preview-pane .md-diagram')].map(d => ({
        rect: d.getBoundingClientRect().toJSON(),
        hasSvg: !!d.querySelector('svg'),
        txt: d.textContent?.slice(0, 60),
      })),
    }))
    console.error('SplitPreview diagnostic:', JSON.stringify(diag, null, 2))
    throw err
  })
  const statsAfterSplit = await page.evaluate(async () => {
    const { getRenderCacheStats } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    return getRenderCacheStats()
  })
  assert.equal(
    statsAfterSplit.diagramRenders,
    statsBeforeSplit.diagramRenders,
    'Switching to Split Preview must hit shared diagram cache with 0 redundant mermaid.render() calls'
  )
  assert(statsAfterSplit.diagramCacheHits > statsBeforeSplit.diagramCacheHits, 'Split Preview must record cache hits')

  // Hover Mermaid in Split Preview -> verify button doesn't overlap copy button & opens shared modal
  await page.locator('.split-preview-pane .md-diagram').first().hover()
  const splitZoomBtn = page.locator('.preview-partition-pane > .md-media-zoom-btn')
  await splitZoomBtn.waitFor({ state: 'visible' })
  const splitButtonsNonOverlapping = await page.evaluate(() => {
    const zoom = document.querySelector('.preview-partition-pane > .md-media-zoom-btn').getBoundingClientRect()
    const copy = document.querySelector('.split-preview-pane .md-preview-fence .md-code-copy').getBoundingClientRect()
    return zoom.right <= copy.left + 1
  })
  assert.equal(splitButtonsNonOverlapping, true, 'Split preview zoom button must not overlap copy button')
  await page.screenshot({ path: path.join(screenshotDir, '03-split-preview-hover.png') })

  await splitZoomBtn.click()
  await dialog.waitFor({ state: 'visible' })
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('dialog.md-image-lightbox').length),
    1,
    'Live and Split Preview must share the single modal instance'
  )
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.f.mode('live'))
  await page.waitForFunction(() => window.f.ready())
  console.log('PASS [C] Hover/focus zoom trigger, wheel-at-pointer, grab/grabbing pan, Esc/focus, and Live/Split parity passed')

  // =========================================================================
  // D. Editing Reliability (Lossless Round-trip, Undo/Redo, IME, Image Edit/Context, Code Copy, Scroll Preservation)
  // =========================================================================
  // 1. Lossless Markdown preservation across open, preview, close, reopen
  const afterPreviewSnapshot = await page.evaluate(() => window.f.snapshot())
  assert.equal(afterPreviewSnapshot.source, interactiveDoc, 'Previewing media must never mutate Markdown source')
  assert.equal(afterPreviewSnapshot.dirty, false, 'Previewing media must never dirty the document')
  assert.equal(afterPreviewSnapshot.undo, 0, 'Previewing media must never push undo history entries')

  // 2. Single-click image edits source; double-click selects all source; right-click opens context menu
  await page.waitForFunction(() => {
    const img = document.querySelector('.markdown-live .md-live-image img')
    return img && img.complete && img.naturalWidth > 0
  })
  await page.locator('.markdown-live .md-live-image img').first().click()
  await page.locator('.markdown-live .md-source-image .md-inline-source-input').waitFor({ state: 'visible' })
  assert.equal(
    await page.evaluate(() => !!document.querySelector('dialog.md-image-lightbox[open]')),
    false,
    'Clicking image body must enter inline source edit, NOT open lightbox'
  )
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.markdown-live .md-source-image'))

  await page.locator('.markdown-live .md-live-image img').first().dblclick()
  const dblClickSelectedAll = await page.evaluate(() => {
    const ed = window.f.live().inlineSource
    return ed ? ed.selection().head - ed.selection().anchor === ed.sourceTo - ed.sourceFrom : false
  })
  assert.equal(dblClickSelectedAll, true, 'Double-clicking image must select entire image Markdown source')
  await page.keyboard.press('Escape')

  await page.locator('.markdown-live .md-live-image img').first().click({ button: 'right' })
  await page.locator('.md-context-menu button').filter({ hasText: '放大预览' }).waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')

  // 3. Undo/Redo, IME composition, and CodeBlock copy
  await page.evaluate(() => window.f.caret('首段普通文本'))
  await page.keyboard.type('新增文字')
  await page.waitForFunction(() => window.f.ready())
  assert((await page.evaluate(() => window.f.snapshot().source)).includes('新增文字'))
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.f.ready())
  assert.equal((await page.evaluate(() => window.f.snapshot())).source, interactiveDoc)
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => window.f.ready())
  assert((await page.evaluate(() => window.f.snapshot().source)).includes('新增文字'))
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.f.ready())

  // Synthetic IME composition guard in prose
  await page.locator('.markdown-live .md-prose').dispatchEvent('compositionstart', { data: '' })
  await page.locator('.markdown-live .md-prose').dispatchEvent('compositionend', { data: '中文输入' })
  assert.equal((await page.evaluate(() => window.f.snapshot())).source, interactiveDoc)

  // Code block input & copy button
  const codeDoc = '# 代码块复制与输入\n\n```ts\nconst answer = 42\n```\n'
  await page.evaluate(doc => window.f.reset(doc), codeDoc)
  await page.waitForFunction(() => window.f.ready())
  await page.locator('.markdown-live .md-code-editor-wrap').click()
  await page.keyboard.press('End')
  await page.keyboard.type('\nconst extra = true')
  await page.waitForFunction(() => window.f.ready())
  await page.evaluate(() => window.f.clear())
  await page.locator('.markdown-live .md-code-surface').hover()
  await page.locator('.markdown-live .md-code-copy').click()
  await page.waitForFunction(() =>
    window.f.requests.some(r => r.command === 'plugin:clipboard-manager|write_text')
  )
  const copiedText = await page.evaluate(
    () => window.f.requests.find(r => r.command === 'plugin:clipboard-manager|write_text')?.args?.text
  )
  assert.equal(copiedText, 'const answer = 42\nconst extra = true', 'Code block copy button must copy exact edited code')

  // 4. Cursor & scroll position preservation when previewing media far down a long document
  const longScrollDoc =
    '# 顶部光标锚点\n\n光标停留在此段落。\n\n' +
    Array.from({ length: 30 }, (_, i) => `填充段落 ${i + 1}：保持足够滚动高度以验证预览关闭后不跳回顶部。`).join('\n\n') +
    '\n\n```mermaid\nflowchart LR\n  BottomA[底部图表] --> BottomB[滚动位置保持]\n```\n'
  await page.evaluate(doc => {
    const liveHost = document.querySelector('#app > section[data-pane="main"]')
    liveHost.style.cssText = 'height: 600px; display: flex; flex-direction: column; overflow: hidden;'
    window.f.reset(doc)
  }, longScrollDoc)
  await page.waitForFunction(() => window.f.ready())
  await page.evaluate(() => {
    const liveHost = document.querySelector('#app > section[data-pane="main"]')
    liveHost.style.cssText = 'height: 600px; display: flex; flex-direction: column; overflow: hidden;'
    window.f.caret('光标停留在此段落')
  })
  const caretBeforePreview = await page.evaluate(() => window.f.snapshot().canonicalSelection)
  await page.evaluate(() => {
    const scroller = document.querySelector('.markdown-live')
    scroller.scrollTop = scroller.scrollHeight
  })
  await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-diagram > svg'))
  const scrollBeforePreview = await page.evaluate(() => document.querySelector('.markdown-live').scrollTop)
  assert(scrollBeforePreview > 200, 'Must actually be scrolled down')

  await page.locator('.markdown-live .md-diagram').hover()
  await page.locator('.markdown-live > .md-media-zoom-btn').click()
  await dialog.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('dialog.md-image-lightbox[open]'))

  const afterScrollAndCaret = await page.evaluate(() => ({
    scrollTop: document.querySelector('.markdown-live').scrollTop,
    sel: window.f.snapshot().canonicalSelection,
    source: window.f.snapshot().source,
  }))
  assert(
    Math.abs(afterScrollAndCaret.scrollTop - scrollBeforePreview) <= 2,
    `Closing modal must preserve scrollTop (${afterScrollAndCaret.scrollTop} vs ${scrollBeforePreview})`
  )
  assert.deepEqual(afterScrollAndCaret.sel, caretBeforePreview, 'Closing modal must preserve editor caret selection')
  assert.equal(afterScrollAndCaret.source, longScrollDoc)
  console.log('PASS [D] Lossless Markdown, Undo/Redo, IME, image click/dblclick/context, code copy & scroll/caret preservation')

  // =========================================================================
  // E. Performance & Memory Control (Large Image, Large Mermaid, 35+ Diagrams On-Demand, 20x Preview Cycles)
  // =========================================================================
  // 1. Large image: downsampled in document (800x500) -> full-res in modal (2400x1500) -> immediate Blob revoke on close
  await page.evaluate(() => window.f.reset('# 大图按需全分辨率升级\n\n![高清大图](large-photo.png)\n'))
  await page.waitForFunction(() => {
    const img = document.querySelector('.markdown-live .md-live-image img')
    return img && img.complete && img.naturalWidth === 800
  })
  const blobsBeforeLargePreview = await page.evaluate(() => window.__activeBlobCount())
  await page.locator('.markdown-live .md-live-image img').hover()
  await page.locator('.markdown-live > .md-media-zoom-btn').click()
  await page.waitForFunction(() => {
    const lbImg = document.querySelector('dialog.md-image-lightbox[open] img')
    return lbImg && lbImg.complete && lbImg.naturalWidth === 2400 && lbImg.naturalHeight === 1500
  })
  const blobsDuringLargePreview = await page.evaluate(() => window.__activeBlobCount())
  assert.equal(blobsDuringLargePreview, blobsBeforeLargePreview + 1, 'Modal holds temporary full-res Blob while open')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('dialog.md-image-lightbox[open]'))
  const blobsAfterLargeClose = await page.evaluate(() => window.__activeBlobCount())
  assert.equal(blobsAfterLargeClose, blobsBeforeLargePreview, 'Closing modal must immediately revoke temporary full-res Blob')

  // 2. Tiered Mermaid budget: Extended large diagram (~260 lines) succeeds; Hard ceiling (>50,000 chars) gives explainable error while preserving source
  const extendedLines = ['flowchart TD']
  for (let i = 0; i < 255; i++) {
    extendedLines.push(`  N${i}["模块节点_${i}"] --> N${i + 1}["模块节点_${i + 1}"]`)
  }
  const extendedMermaidDoc = `# 大型架构图分层预算验证\n\n\`\`\`mermaid\n${extendedLines.join('\n')}\n\`\`\`\n`
  await page.evaluate(doc => window.f.reset(doc), extendedMermaidDoc)
  await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-diagram > svg'), null, { timeout: 15000 })
  assert.equal(await page.evaluate(() => window.f.snapshot().source), extendedMermaidDoc)

  const overBudgetMermaid = 'flowchart TD\n' + '  A --> B\n'.repeat(6500) // > 52,000 chars
  const overBudgetDoc = `# 超限预算验证\n\n\`\`\`mermaid\n${overBudgetMermaid}\`\`\`\n`
  await page.evaluate(doc => window.f.reset(doc), overBudgetDoc)
  await page.waitForFunction(() => !!document.querySelector('.markdown-live .md-diagram.md-render-error'))
  const overBudgetInfo = await page.evaluate(() => ({
    errText: document.querySelector('.markdown-live .md-diagram.md-render-error')?.textContent || '',
    sourceSame: window.f.snapshot().source.length,
  }))
  assert(overBudgetInfo.errText.includes('安全预算'), `Expected budget message, got: ${overBudgetInfo.errText}`)
  assert.equal(overBudgetInfo.sourceSame, overBudgetDoc.length, 'Over-budget diagram must preserve full Markdown source')

  // 3. 35 Diagrams in a long document: lazy viewport loading in BOTH Live & Split (never rejecting #17..#35!) + cache cap <= 30 / 4 MiB
  const thirtyFiveDiagramsDoc = [
    '# 35 张 Mermaid 图表按需加载验证\n',
    ...Array.from(
      { length: 35 },
      (_, i) =>
        `## 图表章节 ${i + 1}\n\n` +
        '间隔段落文本，确保下方图表位于可视区域与 400px 预加载边距之外。\n\n'.repeat(6) +
        `\`\`\`mermaid\nflowchart LR\n  S_${i + 1}[起点_${i + 1}] --> E_${i + 1}[终点_${i + 1}]\n\`\`\`\n`
    ),
  ].join('\n')

  await page.evaluate(async doc => {
    const { clearRenderCaches } = await import('/src/editor/markdown/wysiwyg/renderers.ts')
    clearRenderCaches()
    window.f.reset(doc)
    const liveHost = document.querySelector('#app > section[data-pane="main"]')
    liveHost.style.cssText = 'height: 620px; display: flex; flex-direction: column; overflow: hidden;'
  }, thirtyFiveDiagramsDoc)
  await page.waitForFunction(() => document.querySelectorAll('.markdown-live .md-diagram > svg').length >= 1)
  await new Promise(r => setTimeout(r, 250))

  const live35Initial = await page.evaluate(() => ({
    totalDiagrams: document.querySelectorAll('.markdown-live .md-diagram').length,
    renderedInitially: document.querySelectorAll('.markdown-live .md-diagram > svg').length,
  }))
  assert.equal(live35Initial.totalDiagrams, 35)
  assert(
    live35Initial.renderedInitially >= 1 && live35Initial.renderedInitially <= 8,
    `Offscreen diagrams must not render upfront in Live mode (rendered ${live35Initial.renderedInitially}/35)`
  )

  // Scroll to bottom of Live mode -> diagram #35 must render cleanly!
  await page.evaluate(() => {
    const scroller = document.querySelector('.markdown-live')
    scroller.scrollTop = scroller.scrollHeight
  })
  await page.waitForFunction(() => {
    const last = [...document.querySelectorAll('.markdown-live .md-diagram')].at(-1)
    return !!last?.querySelector('svg') && last.textContent?.includes('终点_35')
  })

  // Switch to Split Preview -> verify diagrams #17..#35 are NOT rejected and render on demand when scrolled!
  await page.evaluate(() => window.f.mode('split'))
  await page.waitForFunction(() => document.querySelectorAll('.split-preview-pane .md-diagram').length > 0 && !document.querySelector('.preview-progress'))
  await new Promise(r => setTimeout(r, 250))

  const split35Initial = await page.evaluate(() => {
    const diagrams = [...document.querySelectorAll('.split-preview-pane .md-diagram')]
    return {
      renderedInitially: diagrams.filter(d => d.querySelector('svg')).length,
      anyBudgetRefusal: diagrams.some(d => (d.textContent || '').includes('16 个的预算')),
    }
  })
  assert.equal(split35Initial.anyBudgetRefusal, false, 'SplitPreview must never reject diagrams past #16')
  assert(
    split35Initial.renderedInitially >= 1 && split35Initial.renderedInitially <= 8,
    `SplitPreview must lazily render only near-viewport diagrams (got ${split35Initial.renderedInitially}/35)`
  )

  // Scroll through SplitPreview to bottom -> diagram #35 renders, and cache stays bounded <= 30 entries / 4 MiB!
  await page.evaluate(async () => {
    const scroller = document.querySelector('.split-preview-pane')
    for (let step = 1; step <= 6; step++) {
      scroller.scrollTop = (scroller.scrollHeight * step) / 6
      await new Promise(r => setTimeout(r, 120))
    }
  })
  await page.waitForFunction(() => {
    const last = [...document.querySelectorAll('.split-preview-pane .md-diagram')].at(-1)
    return !!last?.querySelector('svg') && last.textContent?.includes('终点_35')
  })

  const cacheBoundsAfter35 = await page.evaluate(async () => {
    const { getRenderCacheStats, DIAGRAM_CACHE_LIMIT, DIAGRAM_CACHE_MAX_BYTES } = await import(
      '/src/editor/markdown/wysiwyg/renderers.ts'
    )
    return { stats: getRenderCacheStats(), DIAGRAM_CACHE_LIMIT, DIAGRAM_CACHE_MAX_BYTES }
  })
  assert(
    cacheBoundsAfter35.stats.diagramEntries <= cacheBoundsAfter35.DIAGRAM_CACHE_LIMIT,
    `Diagram cache entries (${cacheBoundsAfter35.stats.diagramEntries}) must never exceed ${cacheBoundsAfter35.DIAGRAM_CACHE_LIMIT}`
  )
  assert(
    cacheBoundsAfter35.stats.diagramBytes <= cacheBoundsAfter35.DIAGRAM_CACHE_MAX_BYTES,
    `Diagram cache bytes (${cacheBoundsAfter35.stats.diagramBytes}) must never exceed 4 MiB`
  )

  // 4. 20x Modal open/close cycles + pane split/close + dispose memory check
  await page.evaluate(() => window.f.reset('# 内存循环验证\n\n![图片](large-photo.png)\n\n```mermaid\nflowchart LR\n  M1 --> M2\n```\n'))
  await page.waitForFunction(() => {
    const img = document.querySelector('.markdown-live .md-live-image img')
    const svg = document.querySelector('.markdown-live .md-diagram > svg')
    return img?.complete && img.naturalWidth > 0 && !!svg
  })

  await cdp.send('HeapProfiler.collectGarbage')
  const domBefore20Cycles = await cdp.send('Memory.getDOMCounters')
  const blobsBefore20Cycles = await page.evaluate(() => window.__activeBlobCount())

  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) {
      await page.locator('.markdown-live .md-live-image img').hover()
    } else {
      await page.locator('.markdown-live .md-diagram').hover()
    }
    await page.locator('.markdown-live > .md-media-zoom-btn').click()
    await dialog.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.md-image-lightbox[open]'))
  }

  // Also split pane and close split pane, then dispose manager completely
  await page.evaluate(() => {
    window.f.split()
  })
  await page.waitForFunction(() => document.querySelectorAll('.markdown-live').length === 2)

  await cdp.send('HeapProfiler.collectGarbage')
  const blobsAfter20Cycles = await page.evaluate(() => window.__activeBlobCount())
  assert.equal(blobsAfter20Cycles, blobsBefore20Cycles, '20 modal open/close cycles must leak 0 Blob URLs')

  // Dispose all panes -> shared modal must unmount completely from document.body!
  await page.evaluate(() => window.f.dispose())
  await cdp.send('HeapProfiler.collectGarbage')
  const afterDisposeState = await page.evaluate(() => ({
    dialogsInDom: document.querySelectorAll('dialog.md-image-lightbox').length,
    zoomBtnsInDom: document.querySelectorAll('.md-media-zoom-btn').length,
  }))
  const domAfterDispose = await cdp.send('Memory.getDOMCounters')

  assert.equal(afterDisposeState.dialogsInDom, 0, 'Disposing all Markdown panes must remove shared modal from DOM')
  assert.equal(afterDisposeState.zoomBtnsInDom, 0, 'Disposing all Markdown panes must remove all zoom trigger buttons')
  console.log(
    `PASS [E] Large image revoke, tiered Mermaid budgets, 35-diagram lazy load (Live+Split), cache <= 30/4MiB & 20x cycle cleanup (DOM ${domBefore20Cycles.nodes} -> ${domAfterDispose.nodes})`
  )

  // =========================================================================
  // F. Full App Shell (?demo=1) Plain-Text / Code Memory Baseline & Theme/Split E2E
  // =========================================================================
  const appPage = await context.newPage()
  const loadedScripts = []
  appPage.on('response', res => {
    const u = res.url()
    if (/\/mermaid(?:@|\.core|\/dist\/)/.test(u)) loadedScripts.push(u)
  })
  appPage.on('pageerror', err => pageErrors.push(err.message))
  const appCdp = await context.newCDPSession(appPage)
  await appCdp.send('Performance.enable')

  await appPage.goto('http://127.0.0.1:1486/?demo=1')
  await appPage.waitForSelector('.cm-editor')
  await new Promise(r => setTimeout(r, 200))

  // While editing non-diagram Rust/plain text tab, 0 Mermaid modules and 0 lightbox dialogs are loaded!
  const plainShellCheck = await appPage.evaluate(() => ({
    dialogs: document.querySelectorAll('dialog.md-image-lightbox').length,
    zoomBtns: document.querySelectorAll('.md-media-zoom-btn').length,
  }))
  assert.equal(loadedScripts.length, 0, 'Editing non-Mermaid files must load 0 Mermaid chunks')
  assert.equal(plainShellCheck.dialogs, 0, 'Editing non-Markdown files must mount 0 lightbox dialogs')
  assert.equal(plainShellCheck.zoomBtns, 0, 'Editing non-Markdown files must mount 0 media zoom buttons')

  await appCdp.send('HeapProfiler.collectGarbage')
  const plainMetrics = await appCdp.send('Performance.getMetrics')
  const plainHeapMB = (
    (plainMetrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0) /
    (1024 * 1024)
  ).toFixed(2)

  // Switch to README.md tab in the full App.vue shell
  await appPage.locator('[role="tab"], .tab-item').filter({ hasText: 'README.md' }).first().click()
  await appPage.waitForSelector('.markdown-live')
  await appPage.evaluate(() => {
    // Toggle light theme & back to dark theme to verify theme observer stability
    document.body.classList.add('light')
  })
  await new Promise(r => setTimeout(r, 150))
  await appPage.screenshot({ path: path.join(screenshotDir, '04-full-app-shell.png') })
  await appPage.close()
  console.log(`PASS [F] Full App Shell E2E: 0 Mermaid chunks & 0 modal overhead on non-diagram files (plain JSHeap=${plainHeapMB} MiB)`)

  assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`)
  assert.deepEqual(externalRequests, [], `Unexpected external requests: ${externalRequests.join('; ')}`)
  console.log('ALL MERMAID & UNIFIED MEDIA PREVIEW REGRESSION TESTS PASSED!')
} finally {
  await browser.close()
  await server.close()
}
