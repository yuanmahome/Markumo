#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG_DIR = path.resolve(ROOT_DIR, 'test-results/regression-logs')

// Smoke tests: fast, deterministic, core regressions covering Markdown, settings, updater, smooth caret, workspace, syntax, brackets
const SMOKE_TESTS = [
  'scripts/tab-navigation-regression.mjs',
  'scripts/outline-docking-regression.mjs',
  'scripts/code-structure-regression.mjs',
  'scripts/split-preview-regression.mjs',
  'scripts/workspace-replace-regression.mjs',
  'scripts/markdown-empty-regression.mjs',
  'scripts/markdown-live-controller-regression.mjs',
  'scripts/markdown-live-toolbar-regression.mjs',
  'scripts/markdown-undo-regression.mjs',
  'scripts/diagram-security-regression.mjs',
  'scripts/code-block-virtualization-regression.mjs',
  'scripts/settings-keybindings-regression.mjs',
  'scripts/updater-regression.mjs',
  'scripts/smooth-caret-regression.mjs',
  'scripts/workspace-p0-regression.mjs',
  'scripts/syntax-regression.mjs',
  'scripts/highlight-runtime-regression.mjs',
  'scripts/brackets-regression.mjs',
  'scripts/shell-lifecycle-regression.mjs',
  'scripts/document-manager-regression.mjs',
  'scripts/table-text-selection-regression.mjs',
  'scripts/quick-open-regression.mjs',
  'scripts/quick-open-app-regression.mjs',
  'scripts/file-save-regression.mjs',
  'scripts/external-file-regression.mjs',
  'scripts/conversion-regression.mjs',
  'scripts/recovery-regression.mjs',
  'scripts/callout-regression.mjs',
  'scripts/toc-regression.mjs',
  'scripts/footnote-regression.mjs',
  'scripts/image-editing-regression.mjs',
  'scripts/outline-reorder-regression.mjs',
  'scripts/frontmatter-regression.mjs',
  'scripts/history-regression.mjs',
  'scripts/history-dialog-regression.mjs',
  'scripts/docx-regression.mjs',
  'scripts/docx-worker-regression.mjs',
  'scripts/repair01-regression.mjs',
  'scripts/repair02-regression.mjs',
  'scripts/repair03-regression.mjs',
  'scripts/repair04-outline-regression.mjs',
  'scripts/autolink-regression.mjs',
  'scripts/workspace-dnd-regression.mjs',
  'scripts/live-split-layout-regression.mjs',
  'scripts/slash-commands-regression.mjs',
  'scripts/math-editor-regression.mjs',
  'scripts/typewriter-focus-regression.mjs',
  'scripts/focus-mode-regression.mjs',
  'scripts/pdf-destination-regression.mjs',
]

// Full regression suite: all existing regression scripts
const FULL_REGRESSION_TESTS = [...new Set([
  'scripts/tab-navigation-regression.mjs',
  'scripts/outline-docking-regression.mjs',
  'scripts/code-structure-regression.mjs',
  'scripts/split-preview-regression.mjs',
  'scripts/workspace-replace-regression.mjs',
  'scripts/markdown-empty-regression.mjs',
  'scripts/markdown-live-controller-full-regression.mjs',
  'scripts/markdown-live-toolbar-regression.mjs',
  'scripts/slash-commands-regression.mjs',
  'scripts/math-editor-regression.mjs',
  'scripts/markdown-undo-regression.mjs',
  'scripts/diagram-security-regression.mjs',
  'scripts/code-block-virtualization-regression.mjs',
  'scripts/settings-keybindings-regression.mjs',
  'scripts/updater-regression.mjs',
  'scripts/smooth-caret-regression.mjs',
  'scripts/workspace-p0-regression.mjs',
  'scripts/workspace-smart-expand-regression.mjs',
  'scripts/syntax-regression.mjs',
  'scripts/highlight-runtime-regression.mjs',
  'scripts/brackets-regression.mjs',
  'scripts/shell-lifecycle-regression.mjs',
  'scripts/document-manager-regression.mjs',
  'scripts/table-text-selection-regression.mjs',
  'scripts/quick-open-regression.mjs',
  'scripts/quick-open-app-regression.mjs',
  'scripts/file-save-regression.mjs',
  'scripts/external-file-regression.mjs',
  'scripts/rich-clipboard-regression.mjs',
  'scripts/outline-regression.mjs',
  'scripts/outline-navigation-regression.mjs',
  'scripts/heading-outline-regression.mjs',
  'scripts/table-layout-regression.mjs',
  'scripts/native-drop-regression.mjs',
  'scripts/export-code-regression.mjs',
  'scripts/conversion-regression.mjs',
  'scripts/recovery-regression.mjs',
  'scripts/media-regression.mjs',
  'scripts/windows-artifacts-regression.mjs',
  'scripts/typewriter-focus-regression.mjs',
  'scripts/focus-mode-regression.mjs',
  'scripts/pdf-destination-regression.mjs',
  'scripts/release-regression.mjs',
  ...SMOKE_TESTS,
])]

// Bounds on retained child output. A runaway test must not grow this process.
const MAX_CAPTURE_CHARS = 64 * 1024
const HEAD_CHARS = 8 * 1024
const KILL_GRACE_MS = 10000

function findSystemBrowser() {
  const candidates = []
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA || ''
    candidates.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe')
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    )
  } else {
    // Linux
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium'
    )
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

async function inspectEnvironment() {
  let playwrightInstalled = false
  let chromiumPath = null

  try {
    const pw = await import('playwright')
    playwrightInstalled = true
    if (pw.chromium && typeof pw.chromium.executablePath === 'function') {
      try {
        const p = pw.chromium.executablePath()
        if (p && fs.existsSync(p)) {
          chromiumPath = p
        }
      } catch {}
    }
  } catch {}

  if (process.env.MARKUMO_CHROME) {
    if (fs.existsSync(process.env.MARKUMO_CHROME)) {
      return { ok: true, browser: process.env.MARKUMO_CHROME, type: 'custom-chrome' }
    } else {
      console.warn(`[WARN] MARKUMO_CHROME is set to "${process.env.MARKUMO_CHROME}" but file does not exist.`)
    }
  }

  if (chromiumPath) {
    return { ok: true, browser: chromiumPath, type: 'playwright-chromium' }
  }

  const sysBrowser = findSystemBrowser()
  if (sysBrowser) {
    process.env.MARKUMO_CHROME = sysBrowser
    return { ok: true, browser: sysBrowser, type: 'detected-system-browser' }
  }

  if (!playwrightInstalled) {
    return {
      ok: false,
      error: 'Playwright is not installed. Run `pnpm install`.'
    }
  }

  return {
    ok: false,
    error:
      'No compatible Chromium or Chrome executable found.\n' +
      '  - Run `pnpm exec playwright install chromium` to install Playwright Chromium, OR\n' +
      '  - Set MARKUMO_CHROME to your Chrome/Edge executable path.'
  }
}

function checkTestPrerequisites(scriptPath) {
  const norm = scriptPath.replace(/\\/g, '/')
  if (norm.endsWith('media-regression.mjs')) {
    const requiredFiles = ['single.pdf', 'transparent.png', 'sample.jpg']
    const fixtureDir = path.resolve(ROOT_DIR, '.markumo-media-test/fixtures')
    const missing = requiredFiles.filter(f => !fs.existsSync(path.join(fixtureDir, f)))
    if (missing.length > 0) {
      return {
        ok: false,
        reason:
          `Missing media fixtures in .markumo-media-test/fixtures (${missing.join(', ')}).\n` +
          'Please generate fixtures before running media regression:\n' +
          '  python scripts/media-fixtures.py .markumo-media-test/fixtures\n' +
          '(Requires Python packages: Pillow, reportlab, pypdf)'
      }
    }
  }
  return { ok: true }
}

/**
 * Bounded output capture: keeps the first HEAD_CHARS characters plus a rolling
 * tail, so a runaway or chatty test cannot exhaust memory.
 */
class BoundedOutput {
  constructor() {
    this.head = ''
    this.tail = ''
    this.totalChars = 0
    this.truncated = false
  }

  append(chunk) {
    this.totalChars += chunk.length
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    if (!chunk) return
    this.tail += chunk
    if (this.tail.length > MAX_CAPTURE_CHARS) {
      // Drop the oldest tail content in large blocks to keep this O(1) amortised.
      this.tail = this.tail.slice(this.tail.length - MAX_CAPTURE_CHARS)
      this.truncated = true
    }
    if (this.totalChars > this.head.length + this.tail.length) this.truncated = true
  }

  /** Whole captured text, bounded and safe to persist. */
  text() {
    if (this.tail.length === 0) return this.head
    const omitted = this.totalChars - this.head.length - this.tail.length
    const marker = omitted > 0 ? `\n... [${omitted} characters omitted by the regression runner] ...\n` : ''
    return this.head + marker + this.tail
  }
}

function terminateProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (!pid) return

  if (process.platform === 'win32') {
    // taskkill may fail (already exited, access denied). Unref the helper and
    // fall back to a direct kill so the runner can never wait forever.
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {})
      killer.unref()
    } catch {}
    try {
      child.kill('SIGKILL')
    } catch {}
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }
}

function saveLog(scriptPath, payload) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const base = path.basename(scriptPath).replace(/\.mjs$/, '')
    fs.writeFileSync(path.join(LOG_DIR, `${base}.log`), payload, 'utf8')
  } catch {}
}

function runSingleTest(scriptPath, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const absPath = path.resolve(ROOT_DIR, scriptPath)
    if (!fs.existsSync(absPath)) {
      resolve({
        name: scriptPath,
        status: 'FAIL',
        duration: 0,
        error: `Test script not found: ${absPath}`
      })
      return
    }

    const prereq = checkTestPrerequisites(scriptPath)
    if (!prereq.ok) {
      resolve({
        name: scriptPath,
        status: 'FAIL',
        duration: 0,
        error: prereq.reason
      })
      return
    }

    const startTime = performance.now()
    const env = { ...process.env }
    // Restricted environments may not expose a writable TEMP; fall back to the
    // workspace so tests that create temporary files still run.
    if (!env.TEMP || !env.TMP) {
      const fallbackTemp = path.resolve(ROOT_DIR, '.markumo-media-test/tmp')
      try {
        fs.mkdirSync(fallbackTemp, { recursive: true })
        env.TEMP ||= fallbackTemp
        env.TMP ||= fallbackTemp
      } catch {}
    }

    // Warm all lazy runtime dependencies before navigation in ordinary CI too.
    // Source overrides still require an explicit MARKUMO_TEST_REF.
    const snapshotArgs = ['--import', pathToFileURL(path.join(ROOT_DIR, 'scripts/regression-snapshot-register.mjs')).href]
    const child = spawn(process.execPath, [...snapshotArgs, absPath], {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })

    const stdout = new BoundedOutput()
    const stderr = new BoundedOutput()
    let timedOut = false
    let settled = false
    let watchdog
    let timer

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      resolve(result)
    }

    const collect = () => ({
      stdout: stdout.text(),
      stderr: stderr.text()
    })

    child.stdout.on('data', (data) => stdout.append(data.toString()))
    child.stderr.on('data', (data) => stderr.append(data.toString()))

    timer = setTimeout(() => {
      timedOut = true
      terminateProcess(child)
      // A wedged child (or a failed taskkill) must not stall the whole suite.
      watchdog = setTimeout(() => {
        const duration = Math.round(performance.now() - startTime)
        const captured = collect()
        saveLog(scriptPath, `# ${scriptPath}\n# TIMEOUT after ${timeoutMs}ms; process did not exit after ${KILL_GRACE_MS}ms\n\n--- stdout ---\n${captured.stdout}\n\n--- stderr ---\n${captured.stderr}\n`)
        finish({
          name: scriptPath,
          status: 'FAIL',
          duration,
          error: `Test timed out after ${timeoutMs}ms and did not exit ${KILL_GRACE_MS}ms after termination`,
          logFile: path.join(LOG_DIR, `${path.basename(scriptPath).replace(/\.mjs$/, '')}.log`),
          ...captured
        })
      }, KILL_GRACE_MS)
    }, timeoutMs)

    child.on('close', (code, signal) => {
      const duration = Math.round(performance.now() - startTime)
      const captured = collect()
      const logFile = path.join(LOG_DIR, `${path.basename(scriptPath).replace(/\.mjs$/, '')}.log`)
      saveLog(scriptPath, `# ${scriptPath}\n# exit=${code} signal=${signal || 'none'} timeout=${timedOut} duration=${duration}ms\n\n--- stdout ---\n${captured.stdout}\n\n--- stderr ---\n${captured.stderr}\n`)

      if (timedOut) {
        finish({
          name: scriptPath,
          status: 'FAIL',
          duration,
          error: `Test timed out after ${timeoutMs}ms`,
          logFile,
          ...captured
        })
        return
      }

      if (signal) {
        finish({
          name: scriptPath,
          status: 'FAIL',
          duration,
          error: `Process terminated by signal ${signal}`,
          logFile,
          ...captured
        })
        return
      }

      // A visible skip is only honoured on a clean exit and must be announced on
      // its own line. Failures can never be reported as skips.
      const isSkipped = code === 0 && /^\s*SKIP:/m.test(stdout.text())
      if (isSkipped) {
        finish({
          name: scriptPath,
          status: 'SKIP',
          duration,
          logFile,
          ...captured
        })
        return
      }

      if (code !== 0) {
        finish({
          name: scriptPath,
          status: 'FAIL',
          duration,
          error: `Process exited with code ${code}`,
          logFile,
          ...captured
        })
        return
      }

      finish({
        name: scriptPath,
        status: 'PASS',
        duration,
        logFile,
        ...captured
      })
    })

    child.on('error', (err) => {
      const duration = Math.round(performance.now() - startTime)
      const captured = collect()
      finish({
        name: scriptPath,
        status: 'FAIL',
        duration,
        error: `Failed to spawn process: ${err.message}`,
        ...captured
      })
    })
  })
}

function printFailureDetails(result) {
  if (result.error) console.log(`      ${result.error}`)
  if (result.logFile) console.log(`      Log: ${path.relative(ROOT_DIR, result.logFile)}`)

  const stderrTail = (result.stderr || '').trim()
  const stdoutTail = (result.stdout || '').trim()

  if (stderrTail) {
    console.log('      --- stderr (tail) ---')
    for (const line of stderrTail.split('\n').slice(-30)) console.log(`      ${line}`)
  }
  if (stdoutTail) {
    console.log('      --- stdout (tail) ---')
    for (const line of stdoutTail.split('\n').slice(-30)) console.log(`      ${line}`)
  }
  if (!stderrTail && !stdoutTail) console.log('      (test produced no output)')
}

async function main() {
  const args = process.argv.slice(2)
  let suiteName = 'smoke'
  let customFiles = []
  let timeoutMs = 180000
  let repeat = 1

  for (const arg of args) {
    if (arg === 'smoke' || arg === '--smoke' || arg === '--suite=smoke') {
      suiteName = 'smoke'
    } else if (arg === 'regression' || arg === '--regression' || arg === '--suite=regression' || arg === 'all') {
      suiteName = 'regression'
    } else if (arg.startsWith('--repeat=')) {
      repeat = Number(arg.slice('--repeat='.length))
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw Error('--repeat must be an integer from 1 to 10')
    } else if (arg.startsWith('--timeout=')) {
      const val = parseInt(arg.split('=')[1], 10)
      if (!isNaN(val) && val > 0) timeoutMs = val
    } else if (!arg.startsWith('-')) {
      customFiles.push(arg)
    }
  }

  let testsToRun = []
  if (customFiles.length > 0) {
    testsToRun = customFiles
    suiteName = 'custom'
  } else if (suiteName === 'regression') {
    testsToRun = FULL_REGRESSION_TESTS
  } else {
    testsToRun = SMOKE_TESTS
  }
  testsToRun = Array.from({ length: repeat }, () => testsToRun).flat()

  console.log('='.repeat(70))
  console.log(` Markumo Regression Runner [suite: ${suiteName}]`)
  console.log(` Platform: ${process.platform} (${process.arch}), Node: ${process.version}`)
  console.log('='.repeat(70))

  const envCheck = await inspectEnvironment()
  if (!envCheck.ok) {
    console.error(`\n[FATAL] Environment check failed:\n${envCheck.error}\n`)
    process.exit(1)
  }
  console.log(`[ENV] Browser: ${envCheck.browser} (${envCheck.type})`)
  console.log('[ENV] Lazy runtime dependencies prepared before browser navigation; HMR disabled')
  if (process.env.MARKUMO_TEST_REF) console.log(`[ENV] Read-only source snapshot: ${process.env.MARKUMO_TEST_REF}; test-host HMR disabled`)
  console.log(`[INFO] Running ${testsToRun.length} test(s) serially (timeout: ${timeoutMs / 1000}s)...\n`)

  const results = []
  const overallStart = performance.now()

  for (let i = 0; i < testsToRun.length; i++) {
    const testFile = testsToRun[i]
    const indexStr = `[${i + 1}/${testsToRun.length}]`
    process.stdout.write(`${indexStr} Running ${testFile} ... `)

    const res = await runSingleTest(testFile, timeoutMs)
    if (repeat > 1 && res.logFile && fs.existsSync(res.logFile)) {
      const roundLog = res.logFile.replace(/\.log$/, `.round-${Math.floor(i / (testsToRun.length / repeat)) + 1}.log`)
      fs.copyFileSync(res.logFile, roundLog)
      res.logFile = roundLog
    }
    results.push(res)

    if (res.status === 'PASS') {
      console.log(`\x1b[32mPASS\x1b[0m (${(res.duration / 1000).toFixed(2)}s)`)
    } else if (res.status === 'SKIP') {
      console.log(`\x1b[33mSKIP\x1b[0m (${(res.duration / 1000).toFixed(2)}s)`)
    } else {
      console.log(`\x1b[31mFAIL\x1b[0m (${(res.duration / 1000).toFixed(2)}s)`)
      printFailureDetails(res)
    }
  }

  const overallDuration = ((performance.now() - overallStart) / 1000).toFixed(2)
  const passed = results.filter(r => r.status === 'PASS').length
  const failed = results.filter(r => r.status === 'FAIL').length
  const skipped = results.filter(r => r.status === 'SKIP').length
  fs.mkdirSync(path.join(ROOT_DIR, 'test-results'), { recursive: true })
  fs.writeFileSync(path.join(ROOT_DIR, 'test-results', `regression-${suiteName}-summary.json`), JSON.stringify({
    suite: suiteName, repeat, platform: process.platform, node: process.version,
    browser: envCheck, sourceRef: process.env.MARKUMO_TEST_REF || null,
    total: results.length, passed, failed, skipped, durationSeconds: Number(overallDuration), results,
  }, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log(' Test Summary')
  console.log('='.repeat(70))
  console.log(` Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped} | Time: ${overallDuration}s`)

  if (failed > 0 || suiteName === 'smoke' && skipped > 0) {
    if (skipped > 0) console.error('Smoke gate requires every selected test to run; skipped tests cannot pass this gate.')
    console.log('\nFailed tests:')
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  - ${r.name}: ${r.error || 'Unknown failure'}`)
      if (r.logFile) console.log(`      log: ${path.relative(ROOT_DIR, r.logFile)}`)
    }
    console.log('='.repeat(70) + '\n')
    process.exit(1)
  }

  console.log('='.repeat(70) + '\n')
  process.exit(0)
}

main().catch((err) => {
  console.error('[UNCAUGHT ERROR in runner]', err)
  process.exit(1)
})
