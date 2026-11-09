// Official Tauri CLI 2.12.2 tools, downloaded through GitHub's asset API to
// avoid outages on github.com/releases/download. No mirror or hash bypass.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const platform = option('platform') || process.platform
assert(['win32','linux'].includes(platform), 'Only Windows and Linux bundler tools are prepared')
assert.equal(JSON.parse(fs.readFileSync('node_modules/@tauri-apps/cli/package.json')).version, '2.12.2', 'Update pinned tools when upgrading Tauri CLI')
const cache = path.resolve(option('cache-dir') || path.join(platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tauri'))
fs.mkdirSync(cache, {recursive:true})
const hash = (bytes, algorithm='sha256') => createHash(algorithm).update(bytes).digest('hex')
async function download(repo, id, file, sha256, sha1) {
  const valid = bytes => hash(bytes) === sha256 && (!sha1 || hash(bytes,'sha1') === sha1)
  if (fs.existsSync(file) && valid(fs.readFileSync(file))) return
  let error
  for (let attempt=1;attempt<=3;attempt++) {
    try {
      const headers = {Accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28','Cache-Control':'no-cache'}
      if(process.env.GITHUB_TOKEN)headers.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`
      const url = `https://api.github.com/repos/${repo}/releases/assets/${id}?download=1&nonce=${Date.now()}`
      let response = await fetch(url, {headers,signal:AbortSignal.timeout(300000)})
      if([403,404].includes(response.status)&&headers.Authorization){delete headers.Authorization;response=await fetch(url,{headers,signal:AbortSignal.timeout(300000)})}
      if(!response.ok) throw Error(`Official asset ${id}: HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert(valid(bytes), `Official asset ${id} checksum mismatch`)
      fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, bytes)
      if (process.platform !== 'win32') fs.chmodSync(file, 0o770)
      console.log(`Verified ${path.basename(file)} (${bytes.length} bytes)`)
      return
    } catch (cause) {error=cause; if(attempt<3)await new Promise(resolve=>setTimeout(resolve,attempt*1000))}
  }
  throw error
}
if (platform === 'win32') {
  const archive = path.join(cache, 'nsis-3.11.zip')
  await download('tauri-apps/binary-releases',317051073,archive,'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1','ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d')
  execFileSync('tar.exe',['-xf',archive,'-C',cache],{windowsHide:true,stdio:'inherit'})
  fs.cpSync(path.join(cache,'nsis-3.11'),path.join(cache,'NSIS'),{recursive:true})
  await download('tauri-apps/nsis-tauri-utils',345882097,path.join(cache,'NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll'),'5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709','75197fee3c6a814fe035788d1c34ead39349b860')
  assert(fs.existsSync(path.join(cache,'NSIS/Bin/makensis.exe')))
} else {
  await download('tauri-apps/binary-releases',274691722,path.join(cache,'AppRun-x86_64'),'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f')
  await download('tauri-apps/binary-releases',576945544,path.join(cache,'linuxdeploy-07333c6-x86_64.AppImage'),'36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62')
  await download('linuxdeploy/linuxdeploy-plugin-appimage',602435573,path.join(cache,'linuxdeploy-plugin-appimage.AppImage'),'49d6a17160675a6bd1781699aae6bdf7692d98552e02a3671d2183d10547842e')
}
console.log(`Prepared verified ${platform} Tauri bundler tools`)
