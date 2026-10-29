import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
const module=input.samples[0].nativeProfile.profile.modules.find(m=>m.name==='msedge.dll.pdb')
if(!/^[A-Fa-f0-9]+$/.test(module.uuid))throw Error('Invalid symbol identity')
const directory=path.resolve('test-results/p01/symbols',module.name,module.uuid)
fs.mkdirSync(directory,{recursive:true})
const destination=path.join(directory,module.name)
if(fs.existsSync(destination)){console.log('Matching symbol file already cached');process.exit(0)}
const response=await fetch(`https://msdl.microsoft.com/download/symbols/${module.name}/${module.uuid}/${module.name}`,{signal:AbortSignal.timeout(600000)})
if(!response.ok)throw Error(`Symbol server HTTP ${response.status}`)
const expected=Number(response.headers.get('content-length')),partial=destination+'.partial'
let bytes=0,last=0
const progress=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes-last>=64*1048576){console.log('Public symbols MiB',(bytes/1048576).toFixed(1),'/',(expected/1048576).toFixed(1));last=bytes}callback(null,chunk)}})
await pipeline(Readable.fromWeb(response.body),progress,fs.createWriteStream(partial,{flags:'wx'}))
if(bytes!==expected)throw Error(`Symbol length ${bytes} != ${expected}`)
fs.renameSync(partial,destination)
console.log('Public symbols cached',destination,bytes)
