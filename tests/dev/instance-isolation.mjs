import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { devOptions } from '../../scripts/devOptions.mjs'

const project = process.cwd(), production = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'))
for (const args of [['dev'], ['dev', '--watch'], ['dev', '--no-watch'], ['dev', '--', '--open', 'test.md']]) {
  const result = devOptions(args, project, {})
  const config = JSON.parse(result.args[result.args.indexOf('--config') + 1])
  assert.equal(config.identifier, 'com.markumo.app.dev')
  assert.notEqual(config.identifier, production.identifier)
  assert.equal(config.app.appDirectoriesOverride, path.join(project, '.markumo-dev'))
  assert.equal(result.env.WEBVIEW2_USER_DATA_FOLDER, path.join(project, '.markumo-dev/webview'))
  assert.equal(result.env.MARKUMO_DESKTOP_NO_RELOAD, args.includes('--no-watch') ? '1' : '0')
  if (args.includes('--')) assert.deepEqual(result.args.slice(result.args.indexOf('--')), ['--', '--open', 'test.md'])
}
const release = devOptions(['build'], project, {})
assert.deepEqual(release.args, ['build'])
assert.deepEqual(release.directories, [])
assert.equal(production.identifier, 'com.markumo.app')
console.log('PASS development and installed app instance identifiers are isolated; profile and release arguments preserved')
