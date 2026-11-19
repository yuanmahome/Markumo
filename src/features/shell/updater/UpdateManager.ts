import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import type { UpdateState } from './UpdateState'
import { defaultUpdatePreferences, type UpdatePreferences } from './UpdatePreferences'

export interface AppUpdate {
  version: string; body?: string
  download(progress: (event: DownloadEvent) => void, options?: {timeout:number}): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}
export interface UpdateServices {
  check(): Promise<AppUpdate | null>
  prepare(): Promise<boolean>
  finishPreparation(): void
  acquire(): Promise<void>
  release(): Promise<void>
  markPending(version: string): Promise<void>
  clearPending(): Promise<void>
  relaunch(): Promise<void>
  notify(message: string): void
  isSkipped?(version: string): boolean
}

/** One owner per application shell/WebView, never per title-bar component.
 * Rust provides the process-wide installation lease. Download resources belong
 * to this manager until installation or shell disposal, including hidden UI. */
export class UpdateManager {
  private update: AppUpdate | null = null
  private operation: Promise<void> | null = null
  private disposed = false
  private generation = 0
  private preferences = defaultUpdatePreferences()
  private started = false
  private enabled = false
  private automatic = true
  private initial?: ReturnType<typeof setTimeout>
  private periodic?: ReturnType<typeof setInterval>
  private progressTimer?: ReturnType<typeof setTimeout>
  private received = 0
  private total = 0
  private notified = new Set<string>()
  constructor(readonly state: UpdateState, private services: UpdateServices) {}
  start(automatic = true) { if (this.started || this.disposed) return; this.started = true; this.automatic = automatic; this.schedule() }
  configure(preferences: UpdatePreferences, enabled = true) {
    const newlyAutomatic = !this.preferences.autoDownloadUpdates && preferences.autoDownloadUpdates
    this.preferences = {...preferences}; this.enabled = enabled; this.schedule()
    if (newlyAutomatic && enabled && this.automatic && this.state.phase === 'available' && !this.state.error && !this.services.isSkipped?.(this.state.version)) void this.downloadUpdate()
  }
  private schedule() {
    if (!this.started || !this.enabled || !this.automatic || !this.preferences.autoCheckUpdates || this.disposed) {
      if (this.initial) clearTimeout(this.initial); this.initial = undefined
      if (this.periodic) clearInterval(this.periodic); this.periodic = undefined
      return
    }
    if (!this.initial && !this.periodic) this.initial = setTimeout(() => {
      this.initial = undefined
      void this.checkForUpdates(true)
      this.periodic = setInterval(() => { void this.checkForUpdates(true) },4*60*60*1000)
    },2500)
  }
  private run(work: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.operation) return this.operation
    // Reserve synchronously, before any service can re-enter the manager.
    const operation = Promise.resolve().then(() => { if (!this.disposed) return work() })
    this.operation = operation
    void operation.finally(async () => { if (this.operation === operation) this.operation = null; if (this.disposed) await this.releaseUpdate() }).catch(() => {})
    return operation
  }
  checkForUpdates(automatic = false): Promise<void> {
    if (['downloading','downloaded','preparing','installing','awaiting-restart'].includes(this.state.phase)) return this.operation || Promise.resolve()
    return this.run(async () => {
      const generation = ++this.generation
      this.state.phase = 'checking'; this.state.error = ''
      try {
        await this.releaseUpdate()
        const update = await this.services.check()
        if (this.disposed || generation !== this.generation) { await update?.close(); return }
        this.update = update
        this.state.version = update?.version || ''; this.state.notes = update?.body || ''
        this.state.phase = update ? 'available' : 'up-to-date'
        if (automatic && update && this.preferences.autoDownloadUpdates && this.enabled && !this.services.isSkipped?.(update.version)) await this.download()
      } catch (error) { if (!this.disposed) { this.state.phase = 'error'; this.state.error = `检查更新失败，请稍后重试。${String(error)}` } }
      finally { if (this.disposed) await this.releaseUpdate() }
    })
  }
  downloadUpdate(): Promise<void> {
    if (this.state.phase !== 'available') return this.operation || Promise.resolve()
    return this.run(() => this.download())
  }
  private flushProgress() {
    if (this.progressTimer) clearTimeout(this.progressTimer); this.progressTimer = undefined
    if (!this.disposed) { this.state.received = this.received; this.state.total = this.total }
  }
  private async download() {
    if (!this.update || this.disposed) return
    if (!this.state.installSupported) { this.state.error = '当前安装方式不支持应用内更新，请在发布页下载并安装新版 deb。'; return }
    this.state.phase = 'downloading'; this.state.error = ''; this.received = this.total = 0; this.flushProgress()
    try {
      await this.update.download(event => {
        if (this.disposed) return
        if (event.event === 'Started') this.total = event.data.contentLength || 0
        if (event.event === 'Progress') this.received += event.data.chunkLength
        if (!this.progressTimer) this.progressTimer = setTimeout(() => this.flushProgress(),100)
      },{timeout:15*60*1000})
      // SDK emits Finished before signature verification; only promise success
      // proves that verified bytes are available for a subsequent install().
      this.flushProgress()
      if (this.disposed) return
      this.state.phase = 'downloaded'
      if (!this.notified.has(this.state.version)) {
        this.notified.add(this.state.version); this.services.notify('Markumo 更新已准备好，可随时安装')
      }
    } catch (error) { if (!this.disposed) { this.state.phase = 'available'; this.state.error = `下载失败，可重试下载。${String(error)}` } }
    finally { this.flushProgress(); if (this.disposed) await this.releaseUpdate() }
  }
  async prepareInstallation(): Promise<boolean> {
    if (this.operation || this.disposed || this.state.phase!=='downloaded') return false
    let prepared=false
    await this.run(async()=>{
      let leased=false;this.state.phase='preparing';this.state.error=''
      try {await this.services.acquire();leased=true;prepared=await this.services.prepare()}
      catch(error){this.state.error=String(error)}
      finally {if(leased)await this.services.release().catch(()=>{});this.services.finishPreparation();this.state.phase='downloaded';if(this.disposed)await this.releaseUpdate()}
    })
    return prepared
  }
  installUpdate(): Promise<void> {
    if (!['downloaded','awaiting-restart'].includes(this.state.phase)) return this.operation || Promise.resolve()
    return this.run(async () => {
      const installed = this.state.phase === 'awaiting-restart'
      let leased = false, marked = false, nativeInstalled = installed
      this.state.phase = 'preparing'; this.state.error = ''
      try {
        await this.services.acquire(); leased = true
        if (!await this.services.prepare() || this.disposed) { this.state.phase = installed ? 'awaiting-restart' : 'downloaded'; return }
        if (this.disposed) return
        if (!installed) {
          marked = true; await this.services.markPending(this.state.version)
          if (this.disposed) return
          this.state.phase = 'installing'
          await this.update!.install()
          nativeInstalled = true
        }
        if (this.disposed) return
        this.state.phase = 'awaiting-restart'
        // Windows normally exits inside install(). macOS/AppImage require this.
        await this.services.relaunch()
      } catch (error) {
        if (!this.disposed) {
          this.state.phase = nativeInstalled ? 'awaiting-restart' : 'downloaded'
          this.state.error = `${nativeInstalled ? '重启未完成，请保存编辑内容后重试重启。' : '安装未开始或未完成，已保留下载，可重试。'}${String(error)}`
        }
      } finally {
        if (marked && !nativeInstalled) await this.services.clearPending().catch(() => {})
        if (leased) await this.services.release().catch(() => {})
        this.services.finishPreparation()
        if (this.disposed || nativeInstalled) await this.releaseUpdate()
      }
    })
  }
  private async releaseUpdate() { const update = this.update; this.update = null; try { await update?.close() } catch { /* Resource may have been consumed by native installation. */ } }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.generation++
    if (this.initial) clearTimeout(this.initial)
    if (this.periodic) clearInterval(this.periodic)
    if (this.progressTimer) clearTimeout(this.progressTimer)
    if (!this.operation) void this.releaseUpdate()
  }
}
