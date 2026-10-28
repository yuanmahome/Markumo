import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const mode = process.argv[2] || 'smoke'
const smokeScripts = [
  'tests/dev/windows-integrity.mjs',
  'tests/markdown-links/regression.mjs',
  'tests/phase042/code-block-browser.mjs',
  'tests/phase042/code-block-layout.mjs',
  'tests/phase042/slash-table-browser.mjs',
  'tests/phase042/table-image-boundaries.mjs',
  'tests/phase042/blank-line-persistence.mjs',
  'tests/phase042/blank-line-visual-layout.mjs',
  'tests/phase042/smart-clipboard.mjs',
  'tests/outline/visibility.mjs',
  'tests/search/browser.mjs',
  'tests/drag/browser.mjs',
  'tests/workspace/open-visibility.mjs',
  'tests/phase042/render-tasks-phase2.mjs',
  'tests/phase042/pane-tab-lifecycle-phase4.mjs',
  'tests/lifecycle/ownership.mjs',
  'tests/lossless/browser.mjs',
]

const regressionScripts = [...smokeScripts]
const releaseLabel = process.env.MARKUMO_PHASE042_RELEASE_LABEL || 'after'
const releaseAfterExe = path.resolve(`test-results/phase042/markumo-${releaseLabel}.exe`)
if (mode === 'regression' && process.platform === 'win32' && fs.existsSync(releaseAfterExe)) {
  regressionScripts.push('tests/phase042/acceptance-a-to-n.mjs')
}

const list = mode === 'regression' ? regressionScripts : smokeScripts
let passed = 0
for (const script of list) {
  console.log(`\n=== Running [${mode}] ${script} ===`)
  const args = script.endsWith('/acceptance-a-to-n.mjs') ? [`--label=${releaseLabel}`] : []
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit', windowsHide: true })
  passed++
}
console.log(`\nSUITE SUMMARY (${mode}): ${passed}/${list.length} passed, 0 failed.`)
