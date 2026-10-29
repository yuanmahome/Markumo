import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const output = path.resolve('docs/performance'), directory = path.join(output, 'p03-validation-data-20261029')
fs.mkdirSync(directory, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const entries = [
  ['rust-all-prototype.log', /40 passed; 0 failed/, '40/40 Rust library + experimental engine; Rust code unchanged by subsequent Markdown fixes'],
  ['native-lossless-0.log', /18 byte-identical.*conflict rejected/, 'earlier P0.3 Release; 18 byte-identical save/reopen cases'],
  ['native-lossless-1.log', /11 byte-identical.*conflict rejected/, 'earlier P0.3 Release; 11 encoding/byte cases'],
  ['regression-latest-link-final.log', /blank-line-persistence\.mjs:215/, 'retained failed smoke run: empty-paragraph keyboard navigation assertion; subsequent isolated retry passed'],
  ['blank-line-latest-retry.log', /200 idle fences = 0 embedded CM/, 'isolated retry completed; one intermittent keyboard-navigation failure is retained'],
  ['regression-latest-link-remaining.log', /P03 LATEST REMAINING 16 passed/, 'remaining 13 smoke scripts + bold + FullText + segmented CM bridge completed'],
  ['native-link-final.log', /\\\\\[链接/, 'retained pre-final failure: blank-document character input escaped its opening bracket'],
  ['link-input-final.log', /PASS empty document \(character input\)/, 'final browser link cases; exact source, blank document, containers, escaped literals, code and unsafe URLs'],
  ['lossless-final-link.log', /73\/73, failures=0, pageErrors=0/, 'final source after blank-document fix: 73/73 lossless cases'],
  ['inline-rules-final-link.log', /ALL INLINE MARKDOWN RULES & HR TESTS PASSED/, 'final source: existing inline and horizontal-rule checks'],
  ['typecheck-head-final.log', /vue-tsc --noEmit && tsc --noEmit -p tsconfig.node.json/, 'final source typecheck; command exit status checked separately'],
  ['build-head-final.log', /Built isolated p03-head-final Release/, 'final isolated Windows Release; source-input invariant enforced by builder'],
  ['native-link-fixed.log', /PASS Windows Release explicit-link input and Undo\/Redo, 2\/2/, 'final Windows WebView2 Release: character and one-input links, Undo/Redo'],
  ['native-acceptance-final-link.log', /ALL 14 ACCEPTANCE SCENARIOS \(A-N\) PASSED WITH ZERO ERRORS/, 'final Windows WebView2 Release: A–N 14/14 including source/live/split, panes, images, PDF and lifecycle'],
]
const result = { finalBuild: JSON.parse(fs.readFileSync('test-results/phase042/build-p03-head-final.json')), entries: [], artifacts: [],
  limits: ['No complete production segmented route was enabled.', 'Smoke scripts completed across runs; a failed keyboard-navigation run and its passing retry are both retained.', 'The final Markdown blank-input fix was verified by lossless/inline/link tests and native A–N; natural memory data remains tied to its earlier exact binary hashes.'] }
for (const [name, pattern, scope] of entries) {
  const source = path.resolve('test-results/p03', name), bytes = fs.readFileSync(source)
  assert(pattern.test(bytes.toString('utf8')), `Missing verification evidence: ${name}`)
  const target = path.join(directory, name + '.gz'), compressed = gzipSync(bytes)
  fs.writeFileSync(target, compressed)
  result.entries.push({ source, archive: path.relative(output, target).replaceAll('\\', '/'), sha256: hash(compressed), originalSha256: hash(bytes), scope })
}
for (const file of ['test-results/phase042/acceptance-a-to-n.json', 'test-results/link-input/results.json', 'test-results/p03/native-link-1793273631512/results.json', 'test-results/p03/window-lab-1793273368704/results.json']) {
  const bytes = fs.readFileSync(file), name = file.includes('acceptance') ? 'native-acceptance.json.gz' : file.includes('window-lab') ? 'segmented-window.json.gz' : file.includes('native-link-') ? 'native-link.json.gz' : 'browser-link.json.gz'
  const target = path.join(directory, name), compressed = gzipSync(bytes)
  fs.writeFileSync(target, compressed)
  result.artifacts.push({ source: path.resolve(file), archive: path.relative(output, target).replaceAll('\\', '/'), sha256: hash(compressed), originalSha256: hash(bytes) })
}
fs.writeFileSync(path.join(output, 'p03-validation-20261029.json'), JSON.stringify(result, null, 2) + '\n')
console.log(`Archived ${result.entries.length} logs and ${result.artifacts.length} result artifacts`)
