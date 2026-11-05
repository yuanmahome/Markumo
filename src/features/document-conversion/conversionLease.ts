import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ConversionSelection } from './contracts'

export async function releaseConversion(selection: ConversionSelection | null): Promise<void> {
  if (isTauri() && selection?.token) {
    await invoke('release_conversion_lease', { token: selection.token }).catch(error => {
      console.error('Failed to release conversion authorization:', error)
    })
  }
}

export function saveConversionBytes(target: ConversionSelection, format: 'html' | 'docx' | 'png', bytes: Uint8Array) {
  return invoke<void>('save_conversion_bytes', bytes, {headers: {
    'x-markumo-conversion-token': target.token, 'x-markumo-conversion-format': format,
  }})
}
