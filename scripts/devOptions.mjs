import { join, resolve } from 'node:path'

// Keep runner/application arguments intact. Only consume our legacy watch alias
// before Tauri's first `--`, never an application argument with the same name.
export function devOptions(input, project, environment = process.env) {
  const args = [...input], env = { ...environment }
  if (args[0] !== 'dev') return { args, env, directories: [] }
  const separator = args.indexOf('--')
  const optionEnd = separator < 0 ? args.length : separator
  const watchIndex = args.slice(0, optionEnd).indexOf('--watch')
  const watch = !args.slice(0, optionEnd).includes('--no-watch')
  if (watchIndex >= 0) args.splice(watchIndex, 1)
  const insertion = args.indexOf('--')
  const additions = []
  // Profile data from the retired default is imported once by the Rust startup.
  const data = resolve(project, env.MARKUMO_DEV_DATA_DIR || '.markumo-dev')
  const temp = join(data, 'temp'), webview = join(data, 'webview')
  env.TEMP = temp
  env.TMP = temp
  env.WEBVIEW2_USER_DATA_FOLDER = webview
  env.MARKUMO_DESKTOP_NO_RELOAD = watch ? '0' : '1'
  // The single-instance plugin keys its Windows mutex by identifier, not by
  // profile directory. Keep dev launches from forwarding to the installed app.
  additions.push('--config', JSON.stringify({ identifier: 'com.markumo.app.dev', app: { appDirectoriesOverride: data } }))
  args.splice(insertion < 0 ? args.length : insertion, 0, ...additions)
  return { args, env, directories: [data, temp, webview], watch }
}
