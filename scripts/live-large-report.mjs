import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

// Explicit report inputs keep historical failures and different builds separate.
const [baselineFile, matrixFile, finalFile] = process.argv.slice(2)
assert(baselineFile && matrixFile && finalFile, 'Pass baseline, matrix and final native JSON paths')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const baseline = read(baselineFile), matrix = read(matrixFile), final = read(finalFile)
for (const report of [baseline, matrix, final]) assert(report.completedAt, 'Campaign must finish first')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
assert.equal(git(['branch', '--show-current']), 'main')
const inputs = git(['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'src-tauri'])
  .split(/\r?\n/).filter(file => file && !file.startsWith('src-tauri/gen/')).sort()
  .map(file => [file, hash(fs.readFileSync(file))])
assert.equal(hash(JSON.stringify(inputs)), final.build.sourceInputsSha256, 'Final app sources differ from installed build')
const quantile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
}
const median = values => quantile(values, .5)
const privateMiB = snapshot => snapshot?.native.processes.reduce((sum, item) => sum + item.private, 0) / 1048576
function metrics(samples) {
  const input = samples.flatMap(sample => sample.input || [])
  const ms = key => median(samples.map(sample => sample[key]))
  return {
    samples: samples.length, passed: samples.filter(sample => sample.passed).length,
    firstReadableMs: ms('firstReadableMs'), firstInputMs: ms('firstInputMs'),
    firstInputFromOpenMs: ms('firstInputFromOpenMs'), inputCount: input.length,
    inputP50Ms: quantile(input, .5), inputP95Ms: quantile(input, .95),
    sourceModeMs: ms('sourceModeMs'), splitModeMs: ms('splitModeMs'),
    splitIndexMs: ms('splitIndexMs'), liveModeMs: ms('liveModeMs'),
    loadedPrivateMiB: median(samples.map(sample => privateMiB(sample.loaded))),
    loadedJSMiB: median(samples.map(sample => sample.loaded?.heap.usedSize / 1048576)),
    loadedEmbedderMiB: median(samples.map(sample => sample.loaded?.heap.embedderHeapUsedSize / 1048576)),
    loadedDOM: median(samples.map(sample => sample.loaded?.dom.connected)),
    closedPrivateMiB: median(samples.map(sample => privateMiB(sample.closed))),
    closedJSMiB: median(samples.map(sample => sample.closed?.heap.usedSize / 1048576)),
    closeCurve: [10000, 30000].map(afterMs => ({afterMs,
      privateMiB: median(samples.map(sample => privateMiB(sample.closeCurve?.find(item => item.afterMs === afterMs)))),
      jsMiB: median(samples.map(sample => sample.closeCurve?.find(item => item.afterMs === afterMs)?.heap.usedSize / 1048576)),
    })),
    diagnosticGCPrivateMiB: median(samples.map(sample => privateMiB(sample.closedDiagnosticGC))),
    diagnosticGCJSMiB: median(samples.map(sample => sample.closedDiagnosticGC?.heap.usedSize / 1048576)),
    failures: samples.filter(sample => !sample.passed).map(sample => ({round: sample.round, phase: sample.phase, failure: sample.failure})),
  }
}
const group = report => Object.fromEntries([...new Set(report.samples.map(sample => sample.scene))]
  .map(scene => [scene, metrics(report.samples.filter(sample => sample.scene === scene))]))
const output = path.resolve('docs/performance/markdown-live-20261109')
fs.mkdirSync(output, { recursive: true })
const artifacts = []
function archive(file) {
  const bytes = fs.readFileSync(file), name = path.basename(file) + '.gz'
  fs.writeFileSync(path.join(output, name), gzipSync(bytes))
  artifacts.push({file: name, bytes: bytes.length, sha256: hash(bytes)})
}
for (const name of fs.readdirSync('test-results/live-large')) {
  if (name === 'report-generation.log') continue
  if (/^(native-.*\.json|runner-.*\.mjs|profile.*\.json|(?:native-.*|input)\.cpuprofile|.*\.log)$/.test(name)) archive(path.join('test-results/live-large', name))
}
for (const label of ['live2-before', 'live2-after', 'live2-final']) archive(`test-results/phase042/build-${label}.json`)
archive('test-results/markdown-large/fixtures.json')
const failedSaveChecks = matrix.samples.filter(sample => sample.scene === '10240kb').map(sample => {
  const sha256 = hash(fs.readFileSync(sample.fixture.file))
  assert.equal(sha256, sample.fixture.sha256, 'Rejected save changed original bytes')
  return {round: sample.round, sha256, unchanged: true}
})
for (const sample of final.samples) {
  assert(sample.passed)
  assert.equal(sample.savedOriginalSHA, sample.fixture.sha256)
  assert.equal(sample.savedEditedSHA, sample.expectedEditedSHA)
  assert.equal(sample.closed.dom.cmRecords, 0)
  assert.equal(sample.closed.dom.liveViews, 0)
  assert.equal(sample.closed.dom.workers.live, 0)
}
const summary = {
  generatedAt: new Date().toISOString(), branch: 'main', head: git(['rev-parse', 'HEAD']),
  sourceMatchesFinalBuild: true, sourceInputsSha256: final.build.sourceInputsSha256,
  inputs: {baselineFile, matrixFile, finalFile}, hardware: final.hardware, runtime: final.runtime,
  baseline: group(baseline), matrix: group(matrix), final: group(final), failedSaveChecks, artifacts,
  limitations: [
    'Full ProseMirror and DOM remain: partitioned Live P0 has NOT passed.',
    'Baseline loaded memory is before first input; optimized loaded memory is after first input.',
    'Input uses WebView2 CDP insertText and two frames, not native OS IME candidate UI.',
    'Matrix build precedes empty-document initialization guard fix; final is independently identified.',
    'Initial CRLF+BOM matrix reopen oracle compared logical source to raw disk hash; corrected supplements are separate.',
    'The first final six-case run overlapped browser smoke and is functional-only evidence.',
    'Optional closedDiagnosticGC occurs after the natural close curve; it is not natural reclamation.',
  ],
}
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
for (const [groupName, data] of Object.entries({baseline: summary.baseline, matrix: summary.matrix, final: summary.final})) {
  console.log(groupName)
  console.table(Object.entries(data).map(([scene, row]) => ({scene, ...Object.fromEntries(Object.entries(row).filter(([key]) => !['failures','closeCurve'].includes(key)))})))
}
