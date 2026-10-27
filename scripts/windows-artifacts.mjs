import {existsSync,mkdirSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'

// Set the output directory before Cargo creates/replaces the executable, so
// hot rebuilds also inherit Medium instead of the workspace's Low label.
export function prepareWindowsDevArtifacts(targetDirectory,mainBinaryName='markumo',{target='',release=false}={}){
  if(process.platform!=='win32')return
  if(target&&!/^[\w.-]+-windows-(msvc|gnu|gnullvm)$/.test(target))return
  const output=join(targetDirectory,target,release?'release':'debug')
  mkdirSync(output,{recursive:true})
  const icacls=join(process.env.SystemRoot||'C:/Windows','System32/icacls.exe')
  execFileSync(icacls,[output,'/setintegritylevel','(OI)(CI)M'],{stdio:'pipe',windowsHide:true})
  const binary=join(output,`${mainBinaryName}.exe`)
  if(existsSync(binary))execFileSync(icacls,[binary,'/setintegritylevel','M'],{stdio:'pipe',windowsHide:true})
}

// Build directories can carry a Low mandatory integrity label. An installer
// inherits it even though its ordinary ACL grants write access, so Windows
// starts that installer at Low integrity and blocks writes to normal folders.
// Normalize generated outputs for every Windows build entry point, not just
// build.bat/package.mjs. Security metadata does not change signed file bytes.
export function normalizeWindowsArtifacts(targetDirectory,mainBinaryName='markumo'){
  if(process.platform!=='win32')return
  const releases=[join(targetDirectory,'release')]
  if(existsSync(targetDirectory))for(const entry of readdirSync(targetDirectory,{withFileTypes:true})){
    if(entry.isDirectory()&&/-windows-(msvc|gnu|gnullvm)$/.test(entry.name))releases.push(join(targetDirectory,entry.name,'release'))
  }
  const icacls=join(process.env.SystemRoot||'C:/Windows','System32/icacls.exe')
  const set=(file,level)=>execFileSync(icacls,[file,'/setintegritylevel',level],{stdio:'pipe',windowsHide:true})
  for(const release of releases){
    const installers=join(release,'bundle/nsis')
    if(existsSync(installers)){
      set(installers,'(OI)(CI)M')
      for(const file of readdirSync(installers))if(file.endsWith('.exe'))set(join(installers,file),'M')
    }
    const binary=join(release,`${mainBinaryName}.exe`)
    if(existsSync(binary))set(binary,'M')
  }
}
