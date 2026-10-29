// Read-only upstream checkout: all instrumentation is a Vite transform, and
// build configuration/output live outside the reference source tree.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const repo = process.cwd(), root = path.resolve('test-results/p03'), source = path.join(root, 'nomo')
const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true }).trim()
assert.equal(git(['diff','HEAD','--']), '', 'Reference source has changes')
const commit = git(['rev-parse','HEAD']), dist = path.join(root,'nomo-dist')
fs.mkdirSync(path.join(root,'tmp'),{recursive:true});process.env.TEMP=process.env.TMP=path.join(root,'tmp')
const {build} = await import(pathToFileURL(path.join(source,'node_modules/vite/dist/node/index.js')))
process.chdir(source)
execFileSync('cmd.exe', ['/d','/c','pnpm exec paraglide-js compile'], {stdio:'inherit',windowsHide:true})
await build({root:source, plugins:[{name:'p03-observe',enforce:'pre',load(id){
  if(id.replaceAll('\\','/').endsWith('/src/app/App.svelte')) return fs.readFileSync(id,'utf8').replace('</script>', `
  ;(globalThis as any).__p03 = {
    open: openFilePathInCurrentWindow, save: saveMarkdownFile, select: switchTab,
    openSearch: () => segmentedWorkspace?.openSearch(), closeSearch: () => segmentedWorkspace?.closeSearch(),
    get ready() { return appBootState === 'ready' },
    get preferences() { return {themeMode, softwareUpdateAutoCheckEnabled} },
    close: async () => { for (const tab of [...tabs]) await closeTab(tab.id, undefined, true) },
    get tabs() { return tabs.map(tab => ({id:tab.id, name:tab.fileName})) }
  };
  </script>`)
},transform(code,id){
  if(id.replaceAll('\\','/').endsWith('/src/lib/text-editor/SegmentedTextEditorCore.ts')) {const updated=code.replace(/this\.emitMetadata\(\);\r?\n  }/, 'this.emitMetadata();\n    (globalThis as any).__p03core = new WeakRef(this);\n  }');assert.notEqual(updated,code,'Core observation anchor missing');return updated}
  if(id.replaceAll('\\','/').endsWith('/src/main.ts')) return `import {invoke as p03Invoke} from '@tauri-apps/api/core'; (globalThis as any).__p03invoke=p03Invoke;\n${code}`
}},],build:{outDir:dist,emptyOutDir:true}})
const config = {identifier:'com.nomo.p03-benchmark', build:{beforeBuildCommand:null,frontendDist:path.relative(path.join(source,'src-tauri'),dist).replaceAll('\\','/')},app:{windows:[{label:'main',title:'Nomo',width:1200,height:780,minWidth:920,minHeight:640,decorations:false,visible:false,skipTaskbar:false}]},bundle:{active:false}}
const configPath=path.join(root,'nomo-config.json');fs.writeFileSync(configPath,JSON.stringify(config,null,2))
const cargoArgs=process.argv.includes('--mirror')?['--','--config','source.crates-io.replace-with="p03-mirror"','--config','source.p03-mirror.registry="sparse+https://rsproxy.cn/index/"','--offline','--locked']:[]
execFileSync(process.execPath,[path.join(source,'node_modules/@tauri-apps/cli/tauri.js'),'build','--no-bundle','--config',configPath,...cargoArgs],{cwd:source,stdio:'inherit',windowsHide:true})
const binary=path.join(root,'nomo-release.exe');fs.copyFileSync(path.join(source,'src-tauri/target/release/nomo.exe'),binary)
execFileSync('icacls',[binary,'/setintegritylevel','M'],{windowsHide:true,stdio:'pipe'})
assert.equal(git(['diff','HEAD','--']), '', 'Upstream source changed during build')
fs.writeFileSync(path.join(root,'nomo-build.json'),JSON.stringify({commit,source,binary,profile:path.join(process.env.APPDATA,'com.nomo.p03-benchmark'),sha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),builtAt:new Date().toISOString(),instrumentation:'App method ports; weak current segmented core witness; invoke export. No editor behavior changes.',config},null,2))
process.chdir(repo)
