// Export compact, auditable evidence; heap snapshots and full traces stay local.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = path.resolve('test-results/p01')
const directories = [
  'p01-v112-profile-1793192024139', 'p01-fixed-profile-1793194696904',
  'p01-fixed-profile-1793196356018', 'p01-v112-profile-1793235615475',
]
// Optional final acceptance and the explicit Network enable/disable control.
for (const name of fs.readdirSync(root)) {
  const file = path.join(root, name, 'results.json')
  if (!fs.existsSync(file)) continue
  const r = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (r.profiling && r.completedAt && r.passed && !r.failure &&
      (['p01-final','p01-main-before'].includes(r.label) || r.transport === 'raw-cdp-network-control')) directories.push(name)
}
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const evidence = []
for (const directory of directories) {
  const base = path.join(root, directory), file = path.join(base, 'results.json')
  const r = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!r.completedAt || !r.passed || r.failure) throw Error(`Incomplete diagnostic ${directory}`)
  // Recalculate using the current parser, which excludes V8 literal templates.
  execFileSync(process.execPath, ['scripts/p01-profile-summary.mjs', base], { windowsHide: true, stdio: 'ignore' })
  execFileSync(process.execPath, ['scripts/p01-memoryinfra-summary.mjs', base], { windowsHide: true, stdio: 'ignore' })
  const profile = JSON.parse(fs.readFileSync(path.join(base, 'profile-summary.json'), 'utf8'))
  const infra = JSON.parse(fs.readFileSync(path.join(base, 'memoryinfra-summary.json'), 'utf8'))
  evidence.push({
    directory, label: r.label, transport: r.transport || 'playwright', build: r.build,
    source: { file, sha256: sha(file) }, runtime: r.runtime, display: r.display,
    samples: r.samples.map(s => ({ scene: s.scene, weakWitnesses: s.weakWitnesses, weakViews: s.weakViews,
      weakSurfaces: s.weakSurfaces, snapshots: s.snapshots, trace: { file: s.trace.file, sha256: s.trace.sha256 },
      nativeSampling: s.nativeSampling, nativeSamplingStopped: s.nativeSamplingStopped,
      protocolCommands: s.protocolCommands, pressureResponse: s.pressureResponse,
      points: s.points.filter(p => p.stage !== 'cycle-closed').map(p => ({
        stage: p.stage, plannedMs: p.plannedMs, time: p.time, heapUsed: p.heapUsed, heapTotal: p.heapTotal,
        heapUsage: p.heapUsage, dom: p.dom, js: p.js, workerTargets: p.workerTargets, native: p.native,
      })),
    })),
    heaps: profile.heaps.map(h => ({ name: h.name, nodes: h.nodes, bytes: h.bytes, instances: h.instances,
      detachedNativeNodes: Object.entries(h.detached).filter(([key]) => key.startsWith('native:')).reduce((sum, [, count]) => sum + count, 0),
      detachedByType: h.detached, watched: h.watched,
    })),
    memoryInfra: infra.map(t => ({ name: t.name, correlation: t.correlation, points: t.points.map(p => ({
      tag: p.tag, pid: p.pid, role: p.role, subtype: p.subtype, native: p.native,
      // These allocator families overlap. This is not a partition of Private Bytes.
      categories: p.categories, largest: p.largest.slice(0, 12),
    })) })),
  })
}
const before = path.join(root, directories[0])
const paths = []
for (const scene of ['mixed240', 'image', 'pdf']) {
  const file = path.join(before, `1-${scene}-closed-${scene}.heapsnapshot`)
  const chains = JSON.parse(execFileSync(process.execPath, ['scripts/p01-heap-paths.mjs', file, ...(scene === 'mixed240' ? [] : [scene === 'image' ? 'image-viewer' : 'pdf-viewer'])], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }))
  paths.push({ scene, snapshot: { file, sha256: sha(file) }, chains })
}
const splitSnapshot=path.join(root,'p01-fixed-profile-1793196356018/1-split-closed-split.heapsnapshot')
for(const name of ['md-code-copy','md-diagram']){
 const chains=JSON.parse(execFileSync(process.execPath,['scripts/p01-heap-paths.mjs',splitSnapshot,name],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024}))
 paths.push({scene:'split after CSS fix, before sanitizer fix',target:name,snapshot:{file:splitSnapshot,sha256:sha(splitSnapshot)},matchedChains:chains.length,chains:chains.slice(0,1)})
}
const preliminary = path.join(root, 'p01-v112-profile-1793188019289/results.json')
const original = JSON.parse(fs.readFileSync(preliminary, 'utf8'))
const samples = original.samples.flatMap(s => s.nativeProfile?.profile?.samples || [])
const expectedSizes = [1921484, 1229916]
const nativeResponseCandidates = expectedSizes.map(size => ({ size, count: samples.filter(s => s.size === size).length,
  total: samples.filter(s => s.size === size).reduce((sum, s) => sum + s.total, 0) }))
const output = { generatedAt: new Date().toISOString(), unit: 'raw bytes unless a key explicitly states otherwise',
  notes: ['Profiling is intrusive; these are not natural acceptance medians.',
    'Allocator categories overlap; do not add them to explain all Private Bytes.',
    'Old Split snapshots retained a DOM JSHandle from the test predicate; use the extended and final boolean-predicate test for release verification.',
    'The preliminary trace export failed; only its completed native sampling and heap artifacts are used for diagnosis. Public native symbols could not be downloaded; no function-level native attribution is claimed.'],
  evidence, strongRetentionPaths: paths, preliminaryNativeSampling: { source: { file: preliminary, sha256: sha(preliminary) },
    validForNaturalAcceptance: false, sampledAllocations: samples.length, responseBodySizeCandidates: nativeResponseCandidates },
}
const target = path.resolve('docs/performance/p01-memory-diagnostics-20261028.json')
fs.writeFileSync(target, JSON.stringify(output) + '\n')
console.log('SAVED', target)
