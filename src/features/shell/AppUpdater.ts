export {UpdateManager} from './updater/UpdateManager'
export {updateState} from './updater/UpdateState'
export const GITHUB_URL='https://github.com/yuanmahome/Markumo'
export function releasePageUrl(version?:string){
  const normalized=version?.replace(/^v/,'')
  return GITHUB_URL+(normalized&&/^\d+\.\d+\.\d+$/.test(normalized)?`/releases/tag/v${normalized}`:'/releases/latest')
}
export async function openProjectPage(desktop:boolean,releases=false,version?:string){
  const url=releases?releasePageUrl(version):GITHUB_URL
  if(desktop){const {invoke}=await import('@tauri-apps/api/core');await invoke('open_external_link',{url})}
  else window.open(url,'_blank','noopener,noreferrer')
}
