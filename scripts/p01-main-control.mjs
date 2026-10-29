// A clean HEAD baseline separates this patch from other local main updates.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
for (;;) {
  if (fs.existsSync('test-results/p01/additional-matrix.json')) {
    const previous = JSON.parse(fs.readFileSync('test-results/p01/additional-matrix.json', 'utf8'))
    assert(previous.steps.every(step => step.code === undefined || step.code === 0), 'Additional controls failed')
    if (previous.completedAt) break
  }
  await new Promise(resolve => setTimeout(resolve, 5000))
}
const final = JSON.parse(fs.readFileSync('test-results/phase042/build-p01-final.json', 'utf8'))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), final.commit, 'main advanced after acceptance; choose matching input before continuing')
const manifest = { startedAt: new Date().toISOString(), ref: final.commit, steps: [] }
const persist = () => fs.writeFileSync('test-results/p01/main-control-matrix.json', JSON.stringify(manifest, null, 2))
async function run(name, script, args) {
  const log = path.resolve(`test-results/p01/${name}.log`), fd = fs.openSync(log, 'w')
  const step = { name, script, args, log, startedAt: new Date().toISOString() }
  manifest.steps.push(step); persist(); console.log('START', name)
  const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ['ignore', fd, fd] })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  fs.closeSync(fd); Object.assign(step, { code, completedAt: new Date().toISOString() }); persist()
  assert.equal(code, 0, log); console.log('PASS', name)
}
const label = 'p01-main-before', measure = 'scripts/p01-memory-investigation.mjs'
await run('clean-main-build', 'scripts/memory-release-build.mjs', [`--ref=${final.commit}`, `--label=${label}`, '--full-ref'])
const base = [`--label=${label}`, '--raw-cdp', '--rounds=3']
await run('clean-main-isolated', measure, [...base, '--mode=isolated'])
await run('clean-main-exact2mib', measure, [...base, '--mode=isolated', '--scenes=text-exact2mib'])
await run('clean-main-sequence', measure, [...base, '--mode=sequence', '--scenes=ordinary,code200,panes,image,markdown-image,pdf,split,mixed240,text2mb'])
await run('clean-main-profile', measure, [`--label=${label}`, '--raw-cdp', '--rounds=1', '--mode=profile', '--scenes=mixed240,split,image,pdf'])
manifest.completedAt = new Date().toISOString(); persist(); console.log('CLEAN MAIN CONTROL COMPLETE')
