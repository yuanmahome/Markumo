import { invoke } from '@tauri-apps/api/core'
import type { RecoveryGateway, RecoveryList, RecoveryRecord, RecoverySaveResult } from './types'

export const tauriRecovery: RecoveryGateway = {
  list: () => invoke<RecoveryList>('recovery_list'),
  read: id => invoke<RecoveryRecord>('recovery_read', { id }),
  save: ({token,...input}) => invoke<RecoverySaveResult>('recovery_save', { input, token:token??null }),
  remove: id => invoke<void>('recovery_delete', { id }),
}
