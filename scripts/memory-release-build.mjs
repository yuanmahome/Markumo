// Build an isolated Windows WebView2 Release binary on main with identical,
// non-invasive allocation and lifecycle counters for Phase 04.2 A/B measurement.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { build } from 'vite'
import { run } from '@tauri-apps/cli'
import { normalizeWindowsArtifacts } from './windows-artifacts.mjs'

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const ref = arg('ref') || 'WORKTREE'
const label = arg('label') || 'before'
assert(/^[\w-]+$/.test(label), `Invalid label: ${label}`)

const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
assert.equal(git(['branch', '--show-current']), 'main', 'Must stay on main branch')

const root = path.resolve('test-results/phase042')
const tmpDir = path.join(root, 'tmp')
fs.mkdirSync(tmpDir, { recursive: true })
process.env.TEMP = tmpDir
process.env.TMP = tmpDir

let commit = git(['rev-parse', 'HEAD'])
let originals = new Map()
let changed = []
if (ref !== 'WORKTREE') {
  assert(/^[\w.~^-]+$/.test(ref), `Invalid git ref: ${ref}`)
  assert.equal(
    git(['diff', ref, '--', 'src-tauri']),
    '',
    'Native Rust source must match reference when building a historical frontend overlay'
  )
  commit = git(['rev-parse', ref])
  changed = git(['diff', '--name-only', commit, '--', 'src']).split(/\r?\n/).filter(Boolean)
  originals = new Map(
    changed.map(file => [
      path.resolve(file).replaceAll('\\', '/'),
      execFileSync('git', ['show', `${commit}:${file}`], { encoding: 'utf8', windowsHide: true }),
    ])
  )
}

const PROBE_BOOTSTRAP = `
;(function initMarkumoMemoryProbe() {
  if (typeof window === 'undefined' || window.__markumoMemoryProbe) return;
  const blobSizes = new Map();
  const probe = {
    editors: {
      pm: { created: 0, live: 0, peak: 0 },
      mainCM: { created: 0, live: 0, peak: 0 },
      embeddedCM: { created: 0, live: 0, peak: 0 },
    },
    workers: { created: 0, live: 0, peak: 0 },
    tasks: {
      active: 0,
      peak: 0,
      total: 0,
      diagramActive: 0,
      diagramTotal: 0,
      mathActive: 0,
      mathTotal: 0,
      highlightRuns: 0,
      highlightQueued: 0,
      highlightCancelled: 0,
    },
    blobs: {
      created: 0,
      revoked: 0,
      liveUrls: 0,
      peakUrls: 0,
      activeBytes: 0,
      peakBytes: 0,
    },
    longTasks: [],
  };
  window.__markumoMemoryProbe = probe;

  const NativeWorker = window.Worker;
  if (typeof NativeWorker === 'function') {
    const WrappedWorker = function(scriptURL, options) {
      const instance = new NativeWorker(scriptURL, options);
      probe.workers.created++;
      probe.workers.live++;
      probe.workers.peak = Math.max(probe.workers.peak, probe.workers.live);
      let terminated = false;
      const origTerminate = instance.terminate.bind(instance);
      instance.terminate = () => {
        if (!terminated) {
          terminated = true;
          probe.workers.live = Math.max(0, probe.workers.live - 1);
        }
        return origTerminate();
      };
      return instance;
    };
    WrappedWorker.prototype = NativeWorker.prototype;
    Object.setPrototypeOf(WrappedWorker, NativeWorker);
    window.Worker = WrappedWorker;
  }

  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  const origRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function(obj) {
    const url = origCreateObjectURL(obj);
    const size = obj && typeof obj.size === 'number' ? obj.size : 0;
    blobSizes.set(url, size);
    probe.blobs.created++;
    probe.blobs.liveUrls = blobSizes.size;
    probe.blobs.peakUrls = Math.max(probe.blobs.peakUrls, probe.blobs.liveUrls);
    probe.blobs.activeBytes += size;
    probe.blobs.peakBytes = Math.max(probe.blobs.peakBytes, probe.blobs.activeBytes);
    return url;
  };
  URL.revokeObjectURL = function(url) {
    if (blobSizes.has(url)) {
      const size = blobSizes.get(url) || 0;
      blobSizes.delete(url);
      probe.blobs.revoked++;
      probe.blobs.liveUrls = blobSizes.size;
      probe.blobs.activeBytes = Math.max(0, probe.blobs.activeBytes - size);
    }
    return origRevokeObjectURL(url);
  };

  if (typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
  }

  window.__resetMemorySceneProbe = function() {
    for (const group of Object.values(probe.editors)) {
      group.created = 0;
      group.peak = group.live;
    }
    probe.workers.created = 0;
    probe.workers.peak = probe.workers.live;
    probe.tasks.peak = probe.tasks.active;
    probe.tasks.total = 0;
    probe.tasks.diagramTotal = 0;
    probe.tasks.mathTotal = 0;
    probe.tasks.highlightRuns = 0;
    probe.tasks.highlightCancelled = 0;
    probe.blobs.created = 0;
    probe.blobs.revoked = 0;
    probe.blobs.peakUrls = probe.blobs.liveUrls;
    probe.blobs.peakBytes = probe.blobs.activeBytes;
    probe.longTasks = [];
  };

  window.__collectDomMediaMetrics = function() {
    let decodedImagePixels = 0;
    let connectedImages = 0;
    let loadedImages = 0;
    const imageDetails = [];
    for (const img of document.querySelectorAll('img')) {
      connectedImages++;
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (w > 0 && h > 0) {
        loadedImages++;
        decodedImagePixels += w * h;
        if (imageDetails.length < 16) {
          imageDetails.push({ w, h, pixels: w * h });
        }
      }
    }
    let canvasCount = 0;
    let canvasPixels = 0;
    for (const canvas of document.querySelectorAll('canvas')) {
      canvasCount++;
      canvasPixels += (canvas.width || 0) * (canvas.height || 0);
    }
    return {
      connectedDomNodes: document.querySelectorAll('*').length,
      domCmEditors: document.querySelectorAll('.cm-editor').length,
      domMainCmEditors: document.querySelectorAll('.editor-host > .cm-editor').length,
      domEmbeddedCmEditors: document.querySelectorAll('.md-code-block .cm-editor').length,
      domPmEditors: document.querySelectorAll('.markdown-live .ProseMirror').length,
      connectedImages,
      loadedImages,
      decodedImagePixels,
      imageDetails,
      canvasCount,
      canvasPixels,
    };
  };
})();
`

const dist = path.join(root, `dist-${label}`)
await build({
  logLevel: 'warn',
  plugins: [
    {
      name: 'phase042-memory-probe',
      enforce: 'pre',
      load(id) {
        if (!originals.size) return
        const [file, query] = id.split('?')
        if (query && file.endsWith('.vue')) return
        const normalized = file.replaceAll('\\', '/')
        const source = originals.get(normalized)
        if (source !== undefined && query && new URLSearchParams(query).has('raw')) {
          return `export default ${JSON.stringify(source)}`
        }
        return source
      },
      transform(code, id) {
        const cleanId = id.split('?')[0].replaceAll('\\', '/')
        if (cleanId.endsWith('/src/main.ts')) {
          return PROBE_BOOTSTRAP + '\n' + code
        }
        if (cleanId.endsWith('/editor/core/DocumentManager.ts')) {
          const ctorAnchor = 'constructor(seeds: DocumentSeed[] = [], private readonly languageLoader = loadLanguage) {'
          const extRegex = /extensions:\s*\[\s*coreExtensions,/
          assert(code.includes(ctorAnchor), 'DocumentManager constructor anchor missing')
          assert(extRegex.test(code), 'DocumentManager coreExtensions anchor missing')
          return (
            `import { ViewPlugin as __MainCMProbePlugin } from '@codemirror/view';\n` +
            code
              .replace(ctorAnchor, `${ctorAnchor}\n    ;(window as any).__nativeManager = this;`)
              .replace(
                extRegex,
                `extensions: [\n        __MainCMProbePlugin.define(() => { const p = (window as any).__markumoMemoryProbe?.editors?.mainCM; if (p) { p.created++; p.live++; p.peak = Math.max(p.peak, p.live); } return { destroy() { if (p) p.live = Math.max(0, p.live - 1); } }; }),\n        coreExtensions,`
              )
          )
        }
        if (cleanId.endsWith('/editor/markdown/wysiwyg/CodeBlockView.ts')) {
          const extAnchor = 'extensions: ['
          assert(code.includes(extAnchor), 'CodeBlockView extensions anchor missing')
          return (
            `import { ViewPlugin as __EmbeddedCMProbePlugin } from '@codemirror/view';\n` +
            code.replace(
              extAnchor,
              `extensions: [\n          __EmbeddedCMProbePlugin.define(() => { const p = (window as any).__markumoMemoryProbe?.editors?.embeddedCM; if (p) { p.created++; p.live++; p.peak = Math.max(p.peak, p.live); } return { destroy() { if (p) p.live = Math.max(0, p.live - 1); } }; }),`
            )
          )
        }
        if (cleanId.endsWith('/editor/markdown/wysiwyg/MarkdownEditorController.ts')) {
          const pmImportAnchor = "import { EditorView, type NodeView } from 'prosemirror-view'"
          assert(code.includes(pmImportAnchor), 'MarkdownEditorController EditorView import anchor missing')
          return code.replace(
            pmImportAnchor,
            `import { EditorView as __RawPMView, type NodeView } from 'prosemirror-view'
class EditorView extends __RawPMView {
  private __pmTracked = true;
  constructor(...args: ConstructorParameters<typeof __RawPMView>) {
    super(...args);
    const p = (window as any).__markumoMemoryProbe?.editors?.pm;
    if (p) { p.created++; p.live++; p.peak = Math.max(p.peak, p.live); }
  }
  override destroy() {
    if (this.__pmTracked) {
      this.__pmTracked = false;
      const p = (window as any).__markumoMemoryProbe?.editors?.pm;
      if (p) p.live = Math.max(0, p.live - 1);
    }
    super.destroy();
  }
}`
          )
        }
        if (cleanId.endsWith('/editor/core/syntaxSpans.ts')) {
          const fnAnchor = 'export function syntaxSpans(code: string, support: LanguageSupport) {'
          assert(code.includes(fnAnchor), 'syntaxSpans anchor missing')
          return code.replace(
            fnAnchor,
            `${fnAnchor}\n  const __tasks = (window as any).__markumoMemoryProbe?.tasks; if (__tasks) __tasks.highlightRuns++;`
          )
        }
        if (cleanId.endsWith('/editor/markdown/wysiwyg/renderers.ts')) {
          const diagAnchor = 'export async function renderDiagram('
          const mathAnchor = 'export async function renderMath('
          assert(code.includes(diagAnchor) && code.includes(mathAnchor), 'renderers anchors missing')
          return (
            code
              .replace(diagAnchor, 'async function __rawRenderDiagram(')
              .replace(mathAnchor, 'async function __rawRenderMath(') +
            `\nexport async function renderDiagram(...args: Parameters<typeof __rawRenderDiagram>) {
  const t = (window as any).__markumoMemoryProbe?.tasks;
  if (t) { t.active++; t.diagramActive++; t.total++; t.diagramTotal++; t.peak = Math.max(t.peak, t.active); }
  try { return await __rawRenderDiagram(...args); }
  finally { if (t) { t.active = Math.max(0, t.active - 1); t.diagramActive = Math.max(0, t.diagramActive - 1); } }
}
export async function renderMath(...args: Parameters<typeof __rawRenderMath>) {
  const t = (window as any).__markumoMemoryProbe?.tasks;
  if (t) { t.active++; t.mathActive++; t.total++; t.mathTotal++; t.peak = Math.max(t.peak, t.active); }
  try { return await __rawRenderMath(...args); }
  finally { if (t) { t.active = Math.max(0, t.active - 1); t.mathActive = Math.max(0, t.mathActive - 1); } }
}\n`
          )
        }
      },
    },
  ],
  build: { outDir: dist, emptyOutDir: true },
})

const profileDir = path.join(root, `native-profile-${label}`)
fs.mkdirSync(profileDir, { recursive: true })
const config = {
  identifier: `com.markumo.phase042-${label}`,
  app: { appDirectoriesOverride: profileDir },
  build: {
    beforeBuildCommand: null,
    frontendDist: path.relative(path.resolve('src-tauri'), dist).replaceAll('\\', '/'),
  },
  bundle: { active: false, createUpdaterArtifacts: false },
}
const configPath = path.join(root, `config-${label}.json`)
fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

await run(['build', '--no-bundle', '--config', configPath], 'tauri')

const targetDir = path.resolve('src-tauri/target')
normalizeWindowsArtifacts(targetDir, 'markumo')
const binary = path.join(root, `markumo-${label}.exe`)
fs.copyFileSync(path.join(targetDir, 'release/markumo.exe'), binary)
if (process.platform === 'win32') {
  const icacls = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/icacls.exe')
  execFileSync(icacls, [binary, '/setintegritylevel', 'M'], { stdio: 'pipe', windowsHide: true })
}

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const dirtyFiles = ref === 'WORKTREE' ? git(['status', '--porcelain', '--', 'src', 'src-tauri']).split(/\r?\n/).filter(Boolean) : []
const buildInfo = {
  commit,
  ref,
  label,
  worktreeDirty: dirtyFiles,
  binary,
  sha256: sha256(binary),
  rustTree: git(['rev-parse', `${commit}:src-tauri`]),
  overlay: changed,
  instrumentation: 'Identical non-invasive counters for PM, main CM, embedded CM, Workers, render tasks, Blob URLs/bytes, decoded DOM pixels, and production DocumentManager reference.',
  frontendFiles: fs.readdirSync(path.join(dist, 'assets')).sort(),
  builtAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(root, `build-${label}.json`), JSON.stringify(buildInfo, null, 2))
console.log(`Built isolated ${label} Release (${commit.slice(0, 7)}): ${binary} [sha256=${buildInfo.sha256.slice(0, 12)}]`)
