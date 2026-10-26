import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const mode = process.argv[2] || 'smoke'
const smokeScripts = [
  'tests/markdown-links/regression.mjs',
  'tests/phase042/code-block-browser.mjs',
  'tests/phase042/render-tasks-phase2.mjs',
  'tests/phase042/pane-tab-lifecycle-phase4.mjs',
]

const regressionScripts = [...smokeScripts]
const releaseAfterExe = path.resolve('test-results/phase042/markumo-after.exe')
if (mode === 'regression' && process.platform === 'win32' && fs.existsSync(releaseAfterExe)) {
  regressionScripts.push('tests/phase042/acceptance-a-to-n.mjs')
}

const list = mode === 'regression' ? regressionScripts : smokeScripts
let passed = 0
for (const script of list) {
  console.log(`\n=== Running [${mode}] ${script} ===`)
  execFileSync(process.execPath, [script], { stdio: 'inherit', windowsHide: true })
  passed++
}
console.log(`\nSUITE SUMMARY (${mode}): ${passed}/${list.length} passed, 0 failed.`)
