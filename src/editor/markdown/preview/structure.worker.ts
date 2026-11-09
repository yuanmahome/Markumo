import { structureBatches } from './structure'
self.onmessage = async (event: MessageEvent<string>) => {
  try {
    for (const batch of structureBatches(event.data)) {
      self.postMessage(batch)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  } catch (error) { self.postMessage({ error: String(error) }) }
}
