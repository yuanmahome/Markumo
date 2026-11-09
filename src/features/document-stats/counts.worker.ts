import { countText } from './counts'
self.onmessage = (event:MessageEvent<{generation:number;index:number;text:string}>) => {
  const {generation,index,text}=event.data
  self.postMessage({generation,index,counts:countText(text)})
}
