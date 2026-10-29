// Complete the minimal-CDP baseline coverage after the serial final matrix.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
for (;;) {
  if (fs.existsSync('test-results/p01/final-matrix.json')) {
    const previous = JSON.parse(fs.readFileSync('test-results/p01/final-matrix.json', 'utf8'))
    assert(previous.steps.filter(step=>!step.supersededBy).every(step => step.code === undefined || step.code === 0), 'Final matrix failed; inspect before continuing')
    if (previous.completedAt) break
  }
  await new Promise(resolve => setTimeout(resolve, 5000))
}
const manifest = { startedAt: new Date().toISOString(), steps: [] }
const persist = () => fs.writeFileSync('test-results/p01/additional-matrix.json', JSON.stringify(manifest, null, 2))
async function run(name, args) {
  const log = path.resolve(`test-results/p01/${name}.log`), fd = fs.openSync(log, 'w')
  const step = { name, script: 'scripts/p01-memory-investigation.mjs', args, log, startedAt: new Date().toISOString() }
  manifest.steps.push(step); persist(); console.log('START', name)
  const child = spawn(process.execPath, [step.script, ...args], { windowsHide: true, stdio: ['ignore', fd, fd] })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  fs.closeSync(fd); Object.assign(step, { code, completedAt: new Date().toISOString() }); persist()
  assert.equal(code, 0, log); console.log('PASS', name)
}
// mixed240 already has three interleaved runs. v1.1.2 also has a three-run
// ordinary/code200/image control. Do not duplicate those in the cohort.
await run('raw-v111-remaining', ['--label=p01-v111', '--mode=isolated', '--rounds=3', '--scenes=blank,ordinary,code200,text2mb,panes,pdf,image,markdown-image,split,same240', '--raw-cdp'])
await run('raw-v112-remaining', ['--label=p01-v112', '--mode=isolated', '--rounds=3', '--scenes=blank,text2mb,panes,pdf,markdown-image,split,same240', '--raw-cdp'])
for (const label of ['p01-v111', 'p01-v112']) await run(`raw-sequence-${label}`, [`--label=${label}`, '--mode=sequence', '--rounds=3', '--scenes=ordinary,code200,panes,image,markdown-image,pdf,split,mixed240,text2mb', '--raw-cdp'])
await run('network-cache-control', ['--label=p01-v112', '--mode=profile', '--rounds=1', '--scenes=mixed240', '--raw-cdp', '--native-sampling', '--network-cache-control'])
manifest.completedAt = new Date().toISOString(); persist(); console.log('ADDITIONAL CONTROLS COMPLETE')
