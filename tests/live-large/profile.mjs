import fs from 'node:fs'
import {createServer} from 'vite'
import {chromium} from 'playwright'
const server=await createServer({server:{host:'127.0.0.1',port:1556,strictPort:true,hmr:false,watch:null}});await server.listen()
const browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(20000)
const data={};fs.mkdirSync('test-results/live-large',{recursive:true})
const save=()=>fs.writeFileSync('test-results/live-large/profile-browser.json',JSON.stringify(data,null,2))
try{
 await page.goto('http://127.0.0.1:1556/tests/live-large/fixture.html');await page.waitForFunction(()=>window.liveLarge)
 const source=fs.readFileSync('test-results/markdown-large/fixtures/950k.md','utf8'),start=performance.now()
 data.open=await page.evaluate(source=>window.liveLarge.open(source),source)
 await page.waitForFunction(()=>window.liveLarge.live());data.ready=performance.now()-start;save();console.log('mounted',data.ready)
 data.initial=await page.evaluate(()=>({timings:window.liveLarge.times,dom:document.querySelectorAll('*').length,pmChildren:window.liveLarge.live().view.state.doc.childCount}));save();console.log('initial',JSON.stringify(data.initial))
 const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start')
 for(const [name,fn] of [['select',()=>window.liveLarge.live().reveal(0)],['focus',()=>window.liveLarge.live().view.focus()],['input',()=>{const e=window.liveLarge.live();e.view.dispatch(e.view.state.tr.insertText('验',1))}]]){
  const start=performance.now();data.phase=name;save();await Promise.race([page.evaluate(fn),new Promise((_,reject)=>setTimeout(()=>reject(Error(name+' timeout')),20000))]);data[name]=performance.now()-start;data.timings=await page.evaluate(()=>window.liveLarge.times);save();console.log(name,data[name],JSON.stringify(data.timings))
 }
 const profile=await cdp.send('Profiler.stop');fs.writeFileSync('test-results/live-large/input.cpuprofile',JSON.stringify(profile.profile))
}catch(e){process.exitCode=1;data.failure=String(e);save();console.log('FAILED',String(e))}finally{await browser.close();await server.close()}
