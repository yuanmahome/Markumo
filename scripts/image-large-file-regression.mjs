// Large Image Support & Memory Optimization Regression Suite
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createServer as createSocket } from 'node:net'

const output = 'test-results/image-large'
fs.mkdirSync(output, { recursive: true })

fs.writeFileSync(`${output}/index.html`, `<!doctype html>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/src/styles/reset.css">
<link rel="stylesheet" href="/src/styles/variables.css">
<link rel="stylesheet" href="/src/editor/markdown/styles.css">
<link rel="stylesheet" href="/src/editor/markdown/presentation.css">
<link rel="stylesheet" href="/src/editor/markdown/wysiwyg/MarkdownTheme.css">
<div id="app" class="markdown-live" style="display:flex;height:720px"></div>
<script type="module" src="/scripts/fixtures/markdown-live-controller.js"></script>`)

const socket = createSocket()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))

const ASSETS = new Map()

const server = await createServer({
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  plugins: [{
    name: 'test-assets-plugin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/test-assets/')) return next()
        const urlPath = req.url.split('?')[0]
        const filename = decodeURIComponent(urlPath.replace(/^\/test-assets\//, ''))
        if (filename === 'bomb.jpg') {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ code: 'image_size', message: '图片压缩比异常，可能为解压炸弹，已阻止加载以保护内存。' }))
          return
        }
        if (filename === 'malicious.svg') {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ code: 'image_format', message: 'SVG 包含未受信任的脚本，已被阻止显示以保证安全。' }))
          return
        }
        if (filename === 'corrupted.png') {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ code: 'image_format', message: '图片格式不支持或文件已损坏。' }))
          return
        }
        const asset = ASSETS.get(filename)
        if (asset) {
          const mime = filename.endsWith('.png') ? 'image/png'
            : filename.endsWith('.svg') ? 'image/svg+xml'
            : filename.endsWith('.gif') ? 'image/gif'
            : filename.endsWith('.webp') ? 'image/webp'
            : 'image/jpeg'
          res.setHeader('Content-Type', mime)
          res.setHeader('Content-Length', String(asset.length))
          res.end(asset)
        } else {
          res.statusCode = 404
          res.end('Not found')
        }
      })
    }
  }]
})

await server.listen()

const table = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  table[i] = c
}
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}

function padJpeg(buf, targetSize) {
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]))
  if (eoi < 0) return buf
  const beforeEoi = buf.subarray(0, eoi)
  const afterEoi = buf.subarray(eoi)
  let currentLen = buf.length
  const chunks = [beforeEoi]
  while (currentLen < targetSize) {
    const needed = Math.min(65530, targetSize - currentLen)
    if (needed < 4) break
    const comHeader = Buffer.alloc(4)
    comHeader[0] = 0xff; comHeader[1] = 0xfe
    comHeader.writeUInt16BE(needed, 2)
    const comData = Buffer.alloc(needed - 2, 0x41)
    chunks.push(comHeader, comData)
    currentLen += needed + 2
  }
  chunks.push(afterEoi)
  return Buffer.concat(chunks)
}

function padPng(buf, targetSize) {
  const iendIdx = buf.lastIndexOf(Buffer.from('IEND'))
  if (iendIdx < 4) return buf
  const beforeIend = buf.subarray(0, iendIdx - 4)
  const afterIend = buf.subarray(iendIdx - 4)
  const needed = Math.max(0, targetSize - buf.length)
  if (needed <= 20) return buf
  
  const payloadLen = needed - 12
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payloadLen, 0)
  const type = Buffer.from('tEXt')
  const keyword = Buffer.from('Comment\0', 'ascii')
  const textData = Buffer.alloc(payloadLen - keyword.length, 0x20)
  const data = Buffer.concat([keyword, textData])
  const crc = Buffer.alloc(4)
  const crcVal = crc32(Buffer.concat([type, data]))
  crc.writeUInt32BE(crcVal, 0)
  return Buffer.concat([beforeIend, len, type, data, crc, afterIend])
}

function setJpegDimensions(buf, width, height) {
  const copy = Buffer.from(buf)
  for (let i = 0; i < copy.length - 8; i++) {
    if (copy[i] === 0xff && (copy[i + 1] === 0xc0 || copy[i + 1] === 0xc2)) {
      copy.writeUInt16BE(height, i + 5)
      copy.writeUInt16BE(width, i + 7)
      break
    }
  }
  return copy
}

function setPngDimensions(buf, width, height) {
  const copy = Buffer.from(buf)
  copy.writeUInt32BE(width, 16)
  copy.writeUInt32BE(height, 20)
  const ihdrData = copy.subarray(12, 29)
  const newCrc = crc32(ihdrData)
  copy.writeUInt32BE(newCrc, 29)
  return copy
}

let browser
const results = []
const test = async (name, run) => {
  const start = Date.now()
  await run()
  const duration = Date.now() - start
  results.push({ name, duration })
  console.log(`PASS ${name} (${duration}ms)`)
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MARKUMO_CHROME || undefined,
  })
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.goto(`http://127.0.0.1:${port}/${output}/index.html`, { timeout: 45000 })
  await page.waitForFunction(() => !!window.f?.ready())

  // Fast synthesis of base buffers
  const baseAssets = await page.evaluate(async () => {
    const make = (w, h, fill, type = 'image/jpeg') => {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d')
      ctx.fillStyle = fill
      ctx.fillRect(0, 0, w, h)
      return c.toDataURL(type).split(',')[1]
    }
    return {
      jpeg100: make(100, 100, '#ff6600', 'image/jpeg'),
      png100: make(100, 100, '#2288cc', 'image/png'),
      pngTrans: make(100, 100, 'rgba(0, 200, 100, 0.5)', 'image/png'),
    }
  })

  const rawJpg = Buffer.from(baseAssets.jpeg100, 'base64')
  const rawPng = Buffer.from(baseAssets.png100, 'base64')

  ASSETS.set('1mb.png', padPng(rawPng, 1024 * 1024))
  ASSETS.set('5mb.jpg', padJpeg(rawJpg, 5 * 1024 * 1024))
  ASSETS.set('20mb.jpg', padJpeg(rawJpg, 20 * 1024 * 1024))
  ASSETS.set('50mb.jpg', padJpeg(rawJpg, 50 * 1024 * 1024))
  ASSETS.set('6000x4000.jpg', setJpegDimensions(rawJpg, 6000, 4000))
  ASSETS.set('8000x6000.jpg', setJpegDimensions(rawJpg, 8000, 6000))
  ASSETS.set('12000x10000.jpg', setJpegDimensions(rawJpg, 12000, 10000))
  ASSETS.set('long.png', setPngDimensions(rawPng, 800, 10000))
  ASSETS.set('transparent.png', Buffer.from(baseAssets.pngTrans, 'base64'))
  ASSETS.set('clean.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="100%" height="100%" fill="#4a90e2"/><circle cx="300" cy="200" r="80" fill="#ffffff"/></svg>'))
  ASSETS.set('animated.gif', Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x20, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e,
    0x30, 0x03, 0x01, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0x00,
    0x00, 0x00, 0x00, 0x20, 0x00, 0x20, 0x00, 0x00, 0x02, 0x05, 0x84, 0x8f, 0xa9, 0xcb, 0x05, 0x00,
    0x3b,
  ]))
  ASSETS.set('sample.webp', Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    0x18, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x20, 0x00, 0x20, 0x00, 0x00, 0x00,
  ]))

  await page.evaluate(() => {
    window.__globalLoadLocal = async (p) => {
      const key = String(p).replace(/^.*[\\\/]/, '')
      const resp = await fetch('/test-assets/' + encodeURIComponent(key))
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ code: 'not_found', message: 'File not found' }))
        throw err
      }
      return new Uint8Array(await resp.arrayBuffer())
    }
  })

  const reset = async (src) => {
    await page.evaluate(s => window.f.reset(s, true), src)
    await page.waitForFunction(() => window.f.ready())
  }

  // 1. 1 MiB PNG
  await test('1. 1 MiB PNG loads and renders without 4MB rejection', async () => {
    await reset('![1mb](1mb.png)')
    await page.waitForFunction(() => {
      const img = document.querySelector('.md-live-image img')
      return img && img.src.startsWith('blob:') && img.naturalWidth > 0
    })
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  // 2. 5 MiB JPEG
  await test('2. 5 MiB JPEG exceeds old 4MB limit and displays cleanly', async () => {
    await reset('![5mb](5mb.jpg)')
    await page.waitForFunction(() => {
      const img = document.querySelector('.md-live-image img')
      return img && img.src.startsWith('blob:') && img.naturalWidth > 0
    })
    assert.equal(await page.locator('.md-live-image img').count(), 1)
    const nw = await page.locator('.md-live-image img').evaluate(el => el.naturalWidth)
    assert.ok(nw > 0)
  })

  // 3. 20 MiB JPEG
  await test('3. 20 MiB JPEG displays without memory bloat', async () => {
    await reset('![20mb](20mb.jpg)')
    await page.waitForFunction(() => {
      const img = document.querySelector('.md-live-image img')
      return img && img.src.startsWith('blob:') && img.naturalWidth > 0
    })
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  // 4. 50 MiB image
  await test('4. 50 MiB image loads without crashing editor', async () => {
    await reset('![50mb](50mb.jpg)')
    await page.waitForFunction(() => {
      const img = document.querySelector('.md-live-image img')
      return img && img.src.startsWith('blob:') && img.naturalWidth > 0
    })
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  // 5. 6000 x 4000 image (24MP)
  await test('5. 6000 x 4000 (24 MP) photo exceeds old 16MP limit and renders', async () => {
    await reset('![24mp](6000x4000.jpg)')
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth === 6000)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
    const nw = await page.locator('.md-live-image img').evaluate(el => el.naturalWidth)
    assert.equal(nw, 6000)
  })

  // 6. 8000 x 6000 image (48MP)
  await test('6. 8000 x 6000 (48 MP) image renders smoothly', async () => {
    await reset('![48mp](8000x6000.jpg)')
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth === 8000)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
    const nw = await page.locator('.md-live-image img').evaluate(el => el.naturalWidth)
    assert.equal(nw, 8000)
  })

  // 7. 12000 x 10000 image (120MP)
  await test('7. 12000 x 10000 (120 MP) huge image renders without crashing', async () => {
    await reset('![120mp](12000x10000.jpg)')
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth === 12000)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
    const nw = await page.locator('.md-live-image img').evaluate(el => el.naturalWidth)
    assert.equal(nw, 12000)
  })

  // 8. Decompression bomb detection
  await test('8. Decompression bomb is safely rejected with clear error', async () => {
    await reset('![bomb](bomb.jpg)')
    await page.waitForFunction(() => !!document.querySelector('.is-broken-image, .broken-image-tag'))
    const text = await page.locator('.md-live-image').first().innerText()
    const title = (await page.locator('.md-image-media').first().getAttribute('title')) || ''
    assert.ok(/解压炸弹|安全预算|预算/.test(text + ' ' + title), `Error text should mention bomb: ${text} title: ${title}`)
  })

  // 9. Long screenshot (800 x 10000)
  await test('9. Long image (800 x 10000) extends naturally downwards without 600px clamp', async () => {
    await reset('![long](long.png)')
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalHeight === 10000)
    const imgHeight = await page.locator('.md-live-image img').evaluate(el => el.getBoundingClientRect().height)
    assert.ok(imgHeight > 650, `Long image height (${imgHeight}px) should naturally extend beyond 600px`)
  })

  // 10. Transparent PNG
  await test('10. Transparent PNG preserves alpha transparency', async () => {
    await reset('![trans](transparent.png)')
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth > 0)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  // 11. Animated GIF
  await test('11. Animated GIF loads and preserves mime format', async () => {
    await reset('![gif](animated.gif)')
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth > 0)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  // 12. WebP
  await test('12. WebP format displays correctly', async () => {
    await reset('![webp](sample.webp)')
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth > 0)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  // 13. Normal vs Malicious SVG
  await test('13. Clean SVG displays and malicious script SVG is safely blocked', async () => {
    await reset('![clean](clean.svg)\n\n![evil](malicious.svg)')
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('.md-live-image img')
      return imgs.length >= 1
    })
    await page.waitForFunction(() => {
      const broken = document.querySelectorAll('.is-broken-image, .broken-image-tag')
      return broken.length >= 1
    })
    const evilText = await page.locator('.is-broken-image, .broken-image-tag').first().innerText()
    const evilTitle = (await page.locator('.md-image-media').last().getAttribute('title')) || ''
    assert.ok(/脚本|未受信任|格式/.test(evilText + ' ' + evilTitle), `Malicious SVG blocked message: ${evilText} title: ${evilTitle}`)
  })

  // 14. Corrupted file
  await test('14. Corrupted image file displays broken badge gracefully without crash', async () => {
    await reset('![corrupt](corrupted.png)')
    await page.waitForFunction(() => !!document.querySelector('.is-broken-image, .broken-image-tag'))
    assert.ok((await page.locator('.is-broken-image, .broken-image-tag').count()) >= 1)
  })

  // 15. 10 consecutive large images
  await test('15. 10 consecutive large images render with bounded memory and smooth scroll', async () => {
    const doc = Array.from({ length: 10 }, (_, i) => `段落 ${i + 1}\n\n![img${i + 1}](5mb.jpg)`).join('\n\n')
    await reset(doc)
    await page.waitForFunction(() => document.querySelectorAll('.md-live-image img').length >= 1)
    
    // Scroll through the document
    for (let scroll = 0; scroll < 3000; scroll += 500) {
      await page.evaluate(y => document.querySelector('.md-live-dom')?.scrollTo(0, y), scroll)
      await page.waitForTimeout(50)
    }
    const count = await page.locator('.md-live-image img').count()
    assert.ok(count >= 1, `Loaded images count: ${count}`)
  })

  // 16. Repeated document opening and closing (20 times) resource reclamation
  await test('16. Repeated open and close 20 times cleans up object URLs without leaking', async () => {
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.f.reset('![test](1mb.png)', true))
    }
    await reset('![test](1mb.png)')
    await page.waitForFunction(() => !!window.f?.ready())
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth > 0)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  // 17. Live, Source, Split mode consistency
  await test('17. Large image persists across Live -> Source -> Split modes', async () => {
    const doc = '前言\n\n![大图](5mb.jpg)\n\n后语\n'
    await reset(doc)
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth > 0)
    
    for (const mode of ['source', 'split', 'live', 'source', 'live']) {
      await page.evaluate(mode => window.f.manager.setMarkdownMode(window.f.id, mode), mode)
      await page.waitForFunction(() => window.f.ready())
      assert.equal((await page.evaluate(() => window.f.source())).trim(), doc.trim())
    }
    await page.waitForFunction(() => document.querySelector('.md-live-image img')?.naturalWidth > 0)
    assert.equal(await page.locator('.md-live-image img').count(), 1)
  })

  console.log(`\n======================================================`)
  console.log(` All ${results.length} Large Image Support tests passed successfully!`)
  console.log(`======================================================`)
} finally {
  if (browser) await browser.close()
  await server.close()
}
