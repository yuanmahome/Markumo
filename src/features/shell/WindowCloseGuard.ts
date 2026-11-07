export type CloseSource = 'titlebar' | 'command' | 'native' | 'handoff'
export interface CloseStatus {
  fileBusy: boolean
  savingCount: number
  composing: boolean
  dirtyCount: number
  documentCount: number
  activePane: string
  hasActiveDocument: boolean
}
interface CloseServices {
  status(): CloseStatus
  flush(): Promise<unknown>
  authorizeAutomatic?(): Promise<boolean>
  confirmDirty(): void
  destroy(): Promise<void>
  blocked(reason: 'busy' | 'composing'): void
  failed(): void
  diagnose(data: CloseStatus & { source: CloseSource; stage: string }): void
}

// One native close handshake at a time. Never log paths or file contents.
export class WindowCloseGuard {
  private pending: Promise<void> | null = null
  constructor(private readonly services: CloseServices) {}
  request(source: CloseSource): Promise<void> {
    if (this.pending) { this.log(source, 'duplicate'); return this.pending }
    const attempt = this.perform(source)
    this.pending = attempt
    void attempt.then(() => { if (this.pending === attempt) this.pending = null })
    return attempt
  }
  private log(source: CloseSource, stage: string) {
    this.services.diagnose({ source, stage, ...this.services.status() })
  }
  private blocked(source: CloseSource) {
    const status = this.services.status()
    if (status.fileBusy || status.savingCount) {
      this.log(source, 'blocked-busy'); this.services.blocked('busy'); return true
    }
    if (status.composing) {
      this.log(source, 'blocked-composing'); this.services.blocked('composing'); return true
    }
    return false
  }
  private async perform(source: CloseSource) {
    try {
      this.log(source, 'requested')
      if (this.blocked(source)) return
      await this.services.flush()
      // Input/save may have started while settings were being persisted.
      if (this.blocked(source)) return
      if (source === 'handoff') {
        if (!this.services.authorizeAutomatic || !await this.services.authorizeAutomatic() || this.blocked(source) || this.services.status().documentCount) return
      }
      if (this.services.status().dirtyCount) {
        this.log(source, 'confirm-dirty'); this.services.confirmDirty(); return
      }
      this.log(source, 'destroy')
      await this.services.destroy()
    } catch {
      this.log(source, 'failed'); this.services.failed()
    }
  }
}
