export type RenderTaskPriority = 'high' | 'normal'

export interface RenderTaskOptions {
  signal?: AbortSignal
  priority?: RenderTaskPriority
}

export interface RenderTaskQueueStats {
  readonly concurrency: number
  readonly maxQueued: number
  readonly active: number
  readonly queued: number
  readonly completed: number
  readonly cancelled: number
  readonly dropped: number
}

interface QueueEntry {
  priority: RenderTaskPriority
  start: () => void
  drop: () => void
}

/**
 * Bounded async render/highlight task queue.
 * - Caps concurrent expensive tasks (e.g. syntax parsing, diagram rendering).
 * - Immediately releases task closures when an AbortSignal fires before start.
 * - Bounds waiting queue length so rapid scrolling cannot accumulate unbounded Promises.
 */
export function createRenderTaskQueue(concurrency = 2, maxQueued = 128) {
  let active = 0
  let completed = 0
  let cancelled = 0
  let dropped = 0
  const queue: QueueEntry[] = []

  const syncProbe = (cancelledDelta = 0) => {
    const tasks = (globalThis as { __markumoMemoryProbe?: { tasks?: Record<string, number> } }).__markumoMemoryProbe?.tasks
    if (tasks) {
      tasks.highlightQueued = queue.length
      if (cancelledDelta > 0) {
        tasks.highlightCancelled = (tasks.highlightCancelled || 0) + cancelledDelta
      }
    }
  }

  function drain() {
    while (active < concurrency && queue.length > 0) {
      const next = queue.shift()!
      syncProbe()
      next.start()
    }
  }

  function run<T>(task: () => T | Promise<T>, options?: RenderTaskOptions | AbortSignal): Promise<T> {
    const opts: RenderTaskOptions =
      options && 'aborted' in options ? { signal: options } : (options ?? {})
    const { signal, priority = 'normal' } = opts

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        cancelled++
        syncProbe(1)
        reject(new DOMException('Render task cancelled', 'AbortError'))
        return
      }

      let started = false
      let settled = false
      let taskRef: (() => T | Promise<T>) | null = task

      const cleanupSignal = () => {
        signal?.removeEventListener('abort', onAbort)
      }

      const removeFromQueue = () => {
        const idx = queue.indexOf(entry)
        if (idx >= 0) queue.splice(idx, 1)
      }

      const onAbort = () => {
        if (started || settled) return
        settled = true
        taskRef = null
        removeFromQueue()
        cleanupSignal()
        cancelled++
        syncProbe(1)
        reject(new DOMException('Render task cancelled', 'AbortError'))
      }

      const entry: QueueEntry = {
        priority,
        drop: () => {
          if (started || settled) return
          settled = true
          taskRef = null
          cleanupSignal()
          dropped++
          syncProbe(1)
          reject(new DOMException('Render task dropped due to queue budget', 'AbortError'))
        },
        start: () => {
          if (settled) return
          started = true
          active++
          const fn = taskRef
          taskRef = null
          Promise.resolve()
            .then(() => {
              signal?.throwIfAborted()
              return fn!()
            })
            .then(
              value => {
                settled = true
                completed++
                resolve(value)
              },
              err => {
                settled = true
                if (signal?.aborted) {
                  cancelled++
                  syncProbe(1)
                }
                reject(err)
              }
            )
            .finally(() => {
              cleanupSignal()
              active = Math.max(0, active - 1)
              drain()
            })
        },
      }

      signal?.addEventListener('abort', onAbort, { once: true })

      // Enforce bounded queue size: evict oldest normal-priority task first, or oldest overall.
      if (queue.length >= maxQueued) {
        const normalIdx = queue.findIndex(item => item.priority === 'normal')
        const evictIdx = normalIdx >= 0 ? normalIdx : 0
        const [evicted] = queue.splice(evictIdx, 1)
        evicted?.drop()
      }

      if (priority === 'high') {
        let insertAt = queue.findIndex(item => item.priority !== 'high')
        if (insertAt < 0) insertAt = queue.length
        queue.splice(insertAt, 0, entry)
      } else {
        queue.push(entry)
      }

      syncProbe()
      drain()
    })
  }

  function stats(): RenderTaskQueueStats {
    return {
      concurrency,
      maxQueued,
      active,
      queued: queue.length,
      completed,
      cancelled,
      dropped,
    }
  }

  function clearPending() {
    while (queue.length > 0) {
      queue.shift()!.drop()
    }
    syncProbe()
  }

  return Object.assign(run, { stats, clearPending })
}
