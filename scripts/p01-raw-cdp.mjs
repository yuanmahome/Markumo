// Minimal public CDP transport. Intentionally never enables Network or Debugger.
// This controls for DevTools response retention in the Playwright transport.
import { EventEmitter } from 'node:events'

class Connection extends EventEmitter {
  constructor(socket) {
    super();this.socket=socket;this.nextId=0;this.pending=new Map();this.counts={}
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data)
      if(message.id){
        const pending=this.pending.get(message.id);if(!pending)return
        this.pending.delete(message.id);clearTimeout(pending.timer)
        if(message.error)pending.reject(Error(`${pending.method}: ${message.error.message}`));else pending.resolve(message.result||{})
      }else this.emit(`${message.sessionId||''}:${message.method}`,message.params||{})
    })
    socket.addEventListener('close',event=>{this.closed={code:event.code,reason:event.reason,wasClean:event.wasClean,time:Date.now()};for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(`CDP connection closed (${event.code}, ${event.reason})`))}this.pending.clear()})
  }
  send(method,params={},sessionId){
    this.counts[method]=(this.counts[method]||0)+1
    return new Promise((resolve,reject)=>{
      if(this.socket.readyState!==WebSocket.OPEN){reject(Error('CDP disconnected'));return}
      const id=++this.nextId,timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`CDP timeout: ${method}`))},120000)
      this.pending.set(id,{resolve,reject,timer,method})
      this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))
    })
  }
  session(id=''){
    const connection=this
    return {send:(method,params)=>connection.send(method,params,id),
      on(method,listener){connection.on(`${id}:${method}`,listener);return this},
      off(method,listener){connection.off(`${id}:${method}`,listener);return this},
      once(method,listener){connection.once(`${id}:${method}`,listener);return this}}
  }
}
class Page {
  constructor(session,url){this.session=session;this.location=url;this.emitter=new EventEmitter()
    session.on('Runtime.exceptionThrown',({exceptionDetails:e})=>this.emitter.emit('pageerror',Error(e.exception?.description||e.text)))
    session.on('Runtime.consoleAPICalled',event=>this.emitter.emit('console',{type:()=>event.type,text:()=>event.args.map(a=>a.value??a.description??'').join(' ')}))
  }
  on(event,listener){this.emitter.on(event,listener)}
  url(){return this.location}
  context(){return {newCDPSession:async()=>this.session}}
  async evaluate(fn,arg){
    const expression=`(${fn.toString()})(${arg===undefined?'':JSON.stringify(arg)})`
    return this.evaluateSource(expression)
  }
  async evaluateSource(expression){
    const response=await this.session.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true})
    if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text)
    return response.result?.value
  }
  async waitForFunction(fn,arg,options={}){
    const deadline=Date.now()+(options.timeout||30000)
    for(;;){
      const remaining=deadline-Date.now();if(remaining<=0)throw Error('Raw CDP waitForFunction timed out')
      try{return await this.evaluateSource(`new Promise((resolve,reject)=>{
        const predicate=(${fn.toString()}),arg=${arg===undefined?'undefined':JSON.stringify(arg)},start=performance.now();
        function poll(){try{if(predicate(arg)){resolve(true);return}}catch(error){reject(error);return}
          if(performance.now()-start>${remaining}){reject(Error('Raw CDP predicate timed out'));return}requestAnimationFrame(poll)}poll();
      })`)}
      catch(error){if(!/context.*destroyed|Cannot find context|navigated/i.test(String(error)))throw error;await new Promise(resolve=>setTimeout(resolve,50))}
    }
  }
  locator(selector){return {count:()=>this.evaluate(selector=>document.querySelectorAll(selector).length,selector)}}
}
export async function connectRawCDP(endpoint){
  const metadata=await(await fetch(`${endpoint}/json/version`)).json(),socket=new WebSocket(metadata.webSocketDebuggerUrl),connection=new Connection(socket)
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  const root=connection.session(),version=await root.send('Browser.getVersion')
  let target
  for(let i=0;i<300;i++){
    target=(await root.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!t.url.startsWith('devtools:'))
    if(target)break
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(!target){socket.close();throw Error('No WebView page target')}
  const {sessionId}=await root.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}),session=connection.session(sessionId),page=new Page(session,target.url)
  await session.send('Page.enable');await session.send('Runtime.enable')
  return {version:()=>version.product.match(/[\d]+(?:\.[\d]+){3}/)?.[0]||version.product,
    contexts:()=>[{pages:()=>[page]}],newBrowserCDPSession:async()=>root,
    protocolCommandCounts:()=>({...connection.counts}),
    transportStatus:()=>({readyState:socket.readyState,closed:connection.closed}),
    close:async()=>{socket.close()}}
}
