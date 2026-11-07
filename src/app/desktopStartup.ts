type Unlisten = () => void

/** One registration per key, including registrations still waiting on native IPC. */
export class NativeListenerScope {
  private disposed = false
  private entries = new Map<string, Promise<void>>()
  private stops = new Set<Unlisten>()

  register(key: string, listen: () => Promise<Unlisten>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const existing = this.entries.get(key)
    if (existing) return existing
    const registration = Promise.resolve().then(() => this.disposed ? undefined : listen()).then(unlisten => {
      if (!unlisten) return
      let stopped = false
      const stop = () => {
        if (stopped) return
        stopped = true
        this.stops.delete(stop)
        unlisten()
      }
      if (this.disposed) stop()
      else this.stops.add(stop)
    }).catch(error => {
      this.entries.delete(key)
      throw error
    })
    this.entries.set(key, registration)
    return registration
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    this.stops.clear()
  }
}

export type StartupPhase = 'initializing' | 'ready' | 'failed' | 'exiting' | 'disposed'
export interface StartupState {
  phase: StartupPhase
  error: string
  closeProtected: boolean
  session: 'pending' | 'owner' | 'temporary'
}
interface StartupServices<Launch> {
  protect(scope: NativeListenerScope): Promise<void>
  loadPreferences(current: () => boolean): Promise<void>
  initialize(): Promise<Launch>
  // Must establish the writer/persistence capability before returning its role.
  adopt(launch: Launch, current: () => boolean): Promise<'owner' | 'temporary'>
  release(launch: Launch): Promise<void>
  changed(state: StartupState): void
  timeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/** A timeout is terminal for this WebView: initialize_launch has native side
 * effects and cannot safely be retried while an older invocation is in flight.
 * The recovery path is closing this window and opening it again. */
export class DesktopStartup<Launch> {
  readonly listeners = new NativeListenerScope()
  readonly state: StartupState = { phase: 'initializing', error: '', closeProtected: false, session: 'pending' }
  private generation = 0
  private timer?: ReturnType<typeof setTimeout>
  private attempt?: Promise<void>
  private interrupt?: () => void

  constructor(private readonly services: StartupServices<Launch>) {}
  private publish() { this.services.changed({ ...this.state }) }
  private clearTimer() {
    if (this.timer !== undefined) (this.services.clearTimer || clearTimeout)(this.timer)
    this.timer = undefined
  }
  private stop(phase: StartupPhase, error = '') {
    this.generation++
    this.clearTimer()
    this.state.phase = phase
    this.state.error = error
    this.publish()
    this.interrupt?.()
  }

  start(): Promise<void> {
    if (this.attempt) return this.attempt
    if (this.state.phase !== 'initializing') return Promise.resolve()
    const generation = ++this.generation
    const current = () => this.generation === generation && this.state.phase === 'initializing'
    const interrupted = new Promise<void>(resolve => { this.interrupt = resolve })
    this.publish()
    this.timer = (this.services.setTimer || setTimeout)(() => {
      if (current()) this.stop('failed', '启动超时，编辑已锁定以保护文档和原有会话。请关闭窗口后重新打开。')
    }, this.services.timeoutMs ?? 20000)
    const work = (async () => {
      try {
        await this.services.protect(this.listeners)
        if (this.state.phase === 'disposed' || this.state.phase === 'exiting') return
        this.state.closeProtected = true
        this.publish()
        if (!current()) return
        await this.services.loadPreferences(current)
        if (!current()) return
        const launch = await this.services.initialize()
        if (!current()) { await this.services.release(launch); return }
        let role: 'owner' | 'temporary'
        try {
          role = await this.services.adopt(launch, current)
        } catch (error) {
          // The product release service excludes capabilities already adopted by
          // the document manager, which keeps failed restoration safely owned.
          try { await this.services.release(launch) }
          catch (cleanupError) { throw Error(`${String(error)}；启动资源释放失败：${String(cleanupError)}`) }
          throw error
        }
        if (!current()) return
        this.state.session = role
        this.clearTimer()
        this.state.phase = 'ready'
        this.publish()
      } catch (error) {
        // Late cleanup errors remain visible, without reviving a failed startup.
        if (this.state.phase !== 'disposed' && this.state.phase !== 'exiting') {
          this.stop('failed', `启动失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()
    this.attempt = Promise.race([work, interrupted])
    return this.attempt
  }

  exit() { if (this.state.phase !== 'disposed') this.stop('exiting') }
  async flushForClose(settings: () => Promise<unknown>, session?: () => Promise<unknown>) {
    // An incomplete startup must never save defaults over an unclaimed session.
    // The caller still performs the dirty-document close handshake.
    if (this.state.phase !== 'ready') return
    if (this.state.session === 'pending' || (this.state.session === 'owner' && !session)) {
      throw Error('会话保存能力尚未确认，不能安全关闭。')
    }
    await settings()
    // Temporary windows publish metadata too; native code grants persistence
    // only to the current owner, including windows promoted after startup.
    if (session) await session()
  }
  dispose() {
    if (this.state.phase === 'disposed') return
    this.state.closeProtected = false
    this.stop('disposed')
    this.listeners.dispose()
  }
}
