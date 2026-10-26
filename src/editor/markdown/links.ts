import { invoke, isTauri } from '@tauri-apps/api/core'
export function safeMarkdownURL(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/^<|>$/g, '').replace(/\\([\\()<>])/g, '$1'))
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
export async function openMarkdownLink(raw: string) {
  const url = safeMarkdownURL(raw)
  if (!url) return
  try {
    if (isTauri()) await invoke('open_external_link', { url })
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch (error) { window.dispatchEvent(new CustomEvent('editor-notice', { detail: `打开链接失败: ${String(error)}` })) }
}
/** Resolve only a relative Markdown destination. Native workspace authorization
 * still decides whether this exact target may be opened. */
export function relativeMarkdownLink(base:string,href:string){
  const [destination,fragment='']=href.split('#',2)
  const raw=destination.split('?',1)[0]
  let path:string,anchor:string
  try{path=decodeURIComponent(raw);anchor=decodeURIComponent(fragment)}catch{return null}
  if(!path||/^[/\\]|:|[\0\r\n]/.test(path))return null
  const normalized=base.replace(/^\\\\\?\\UNC\\/i,'//').replace(/^\\\\\?\\/,'').replace(/\\/g,'/')
  const parts=normalized.split('/');parts.pop()
  const floor=normalized.startsWith('//')?4:/^[a-z]:\//i.test(normalized)?1:normalized.startsWith('/')?1:0
  for(const part of path.replace(/\\/g,'/').split('/')){if(!part||part==='.')continue;if(part==='..'){if(parts.length<=floor)return null;parts.pop()}else parts.push(part)}
  return {path:parts.join('/'),anchor}
}
