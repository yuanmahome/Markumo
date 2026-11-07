export type RecoveryMode = 'live' | 'source' | 'split'
export interface RecoveryPane {
  pane: string
  mode?: RecoveryMode | null
}
/**
 * A recovery record only belongs to a document after an explicit action:
 *  - `active`    — this session wrote the snapshot for a dirty document.
 *  - `recovered` — the user explicitly restored this record into a document.
 * Records read from disk are `unclaimed` and never inferred from a matching
 * path: a same-path recovery draft belongs to nobody until the user says so.
 */
export type RecoveryClaimKind = 'active' | 'recovered'
export type RecoveryLifecycle = 'unclaimed' | RecoveryClaimKind
export interface RecoveryClaim {
  recordId: string
  kind: RecoveryClaimKind
  /** Version returned by the last read/save; sent back for compare-and-swap. */
  version: string | null
}
export interface RecoverySummary {
  id: string
  name: string
  path: string | null
  updatedAt: number
  charCount: number
  sizeBytes: number
  mode?: RecoveryMode | null
  panes: RecoveryPane[]
  diskExists: boolean
  diskChanged: boolean
}
export interface RecoveryRecord {
  schemaVersion: number
  id: string
  name: string
  path: string | null
  text: string
  encoding: string
  bom: boolean
  eol: 'LF' | 'CRLF' | 'CR' | 'Mixed'
  mode?: RecoveryMode | null
  panes: RecoveryPane[]
  updatedAt: number
  charCount: number
  diskVersion: string | null
  diskSize: number | null
  diskModifiedNs: number | null
  checksum: string
  /** File version of this exact record, used for conditional updates. */
  version: string
}
export interface RecoveryList {
  records: RecoverySummary[]
  warnings: string[]
}
export interface RecoverySaveInput {
  token?: string | null
  id?: string | null
  name: string
  path: string | null
  text: string
  encoding: string
  bom: boolean
  eol: string
  mode?: RecoveryMode | null
  panes: RecoveryPane[]
  diskVersion: string | null
  /** Version of the snapshot this caller last observed. */
  expectedVersion?: string | null
}
export interface RecoverySaveResult {
  record: RecoverySummary
  warnings: string[]
  version: string
}
export interface RecoveryDiff {
  id: string
  name: string
  path: string | null
  recoveryText: string
  diskText: string | null
  error?: string
  diffSource?: 'disk' | 'session' | 'none'
}
export interface RecoveryGateway {
  list(): Promise<RecoveryList>
  read(id: string): Promise<RecoveryRecord>
  save(input: RecoverySaveInput): Promise<RecoverySaveResult>
  remove(id: string): Promise<void>
}
