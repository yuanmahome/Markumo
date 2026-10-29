import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
const arg=n=>process.argv.find(v=>v.startsWith(`--${n}=`))?.slice(n.length+3)
const root=path.resolve(`test-results/p03/campaign-${Date.now()}`);fs.mkdirSync(root,{recursive:true})
const labels=(arg('labels')||'p03-base,p03-fulltext,nomo').split(','),report={startedAt:new Date().toISOString(),order:'rotate application order each cohort; independent process/profile per scene',runs:[]}
const persist=()=>fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(report,null,2))
for(let cohort=1;cohort<=3;cohort++)for(let k=0;k<labels.length;k++){
 const label=labels[(k+cohort-1)%labels.length],log=path.join(root,`${cohort}-${label}.log`),args=['scripts/p03-text-benchmark.mjs',`--label=${label}`,'--rounds=1',`--cohort=${cohort}`]
 if(arg('scenes'))args.push(`--scenes=${arg('scenes')}`)
 if(process.argv.includes('--controlled'))args.push('--controlled')
 console.log('COHORT',cohort,label)
 const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']}),stream=fs.createWriteStream(log);let stdout=''
 child.stdout.on('data',b=>{stdout+=b;stream.write(b);process.stdout.write(b)});child.stderr.on('data',b=>stream.write(b))
 const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});await new Promise(r=>stream.end(r))
 const result=stdout.trim().split(/\r?\n/).findLast(line=>line.endsWith('results.json'))
 report.runs.push({cohort,label,log,result,exitCode});persist();if(exitCode!==0)throw Error(`Runner failed: ${label}, ${cohort}`)
}
report.completedAt=new Date().toISOString();persist();console.log(path.join(root,'manifest.json'))
