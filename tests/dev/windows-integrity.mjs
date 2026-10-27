import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {prepareWindowsDevArtifacts} from '../../scripts/windows-artifacts.mjs'

if(process.platform!=='win32'){
  console.log('SKIP Windows process-integrity regression: requires Windows')
}else{
  const temp=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(temp,'markumo-dev-integrity-'))
  const system=path.join(process.env.SystemRoot||'C:/Windows','System32')
  const icacls=(file,level)=>execFileSync(path.join(system,'icacls.exe'),[file,'/setintegritylevel',level],{stdio:'pipe',windowsHide:true})
  const token=file=>execFileSync(file,['/groups','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true})
  try{
    icacls(root,'(OI)(CI)L')
    const output=path.join(root,'debug'),binary=path.join(output,'markumo.exe')
    fs.mkdirSync(output);fs.copyFileSync(path.join(system,'whoami.exe'),binary);icacls(binary,'L')
    assert(token(binary).includes('S-1-16-4096'),'Fixture must really launch at Low integrity')
    prepareWindowsDevArtifacts(root)
    assert(token(binary).includes('S-1-16-8192'),'Existing dev executable must launch at Medium integrity')
    const rebuilt=path.join(output,'rebuilt.exe');fs.copyFileSync(path.join(system,'whoami.exe'),rebuilt)
    assert(token(rebuilt).includes('S-1-16-8192'),'New Cargo output must inherit Medium after a hot rebuild')
    const target='x86_64-pc-windows-msvc';prepareWindowsDevArtifacts(root,'markumo',{target,release:true})
    const release=path.join(root,target,'release','markumo.exe');fs.copyFileSync(path.join(system,'whoami.exe'),release)
    assert(token(release).includes('S-1-16-8192'),'Explicit Windows target/release output must inherit Medium')
    console.log('PASS Low workspace → Medium dev executable, hot rebuild and explicit target (real process tokens)')
  }finally{
    assert(root.startsWith(temp+path.sep+'markumo-dev-integrity-'))
    fs.rmSync(root,{recursive:true,force:true})
  }
}
