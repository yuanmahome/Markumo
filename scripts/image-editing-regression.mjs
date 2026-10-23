// Image Editing Controls and Persistence Regression Suite
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createServer as createSocket } from 'node:net'
import ts from 'typescript'

const output = 'test-results/image-edit'
fs.mkdirSync(output, { recursive: true })
const unitResults = []
const htmlModule = ts.transpileModule(fs.readFileSync('src/editor/markdown/wysiwyg/imageHtml.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { controlledImageHtml, parseControlledImageHtml, normalizeImageWidth } = await import('data:text/javascript;base64,' + Buffer.from(htmlModule).toString('base64'))
for (const value of ['auto', '25%', '160', '320px']) assert.equal(normalizeImageWidth(value), value)
for (const value of ['calc(1px)', '-1', '100vw', {}, 'NaN']) assert.equal(normalizeImageWidth(value), null)
unitResults.push('Width validation accepts HTML pixels and rejects executable/CSS expressions')
for (const src of ['./中文 图片(1).png', 'C:/literal%25/a.png', './a&b.png', './a"b.png']) {
  const attrs = { src, alt: '<中文>&"\'', title: 'title "&"', width: '50%', align: 'center' }
  assert.deepEqual(parseControlledImageHtml(controlledImageHtml(attrs)), attrs)
}
unitResults.push('Controlled HTML round-trips paths, Unicode, quotes and entities')
assert.deepEqual(parseControlledImageHtml('<img src="" alt="empty" />'), { src: '', alt: 'empty', title: null, width: null, align: null })
assert.equal(controlledImageHtml({ src: 'a.png', alt: '', title: null, width: null, align: null }), null)
unitResults.push('Plain Markdown stays Markdown; empty HTML remains repairable')
for (const source of ['<img src="x" onload="run()" />', '<img src="x" width="1" srcset="y" />', '<img src="x" src="y" />', '<img src="x" /><img src="y" />']) assert.equal(parseControlledImageHtml(source), null)
unitResults.push('HTML allow-list rejects executable or ambiguous attribute state')
for (const name of unitResults) console.log('PASS UNIT ' + name)
await import('./typora-image-parity-regression.mjs')
