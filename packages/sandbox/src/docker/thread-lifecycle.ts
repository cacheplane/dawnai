export interface ThreadLifecycleCoordinator {
  readonly pendingThreadCount: number
  runShared<T>(threadId: string, operation: () => Promise<T>): Promise<T>
  runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T>
}

interface QueueEntry {
  readonly kind: "shared" | "exclusive"
  readonly start: () => void
}

interface ThreadState {
  activeShared: number
  exclusiveActive: boolean
  readonly queue: QueueEntry[]
}

/**
 * Keyed fair shared/exclusive gate for Docker container access.
 *
 * Exec and filesystem operations share the keeper concurrently. Lifecycle
 * mutations are exclusive: they wait for admitted container operations to
 * drain, and their queue position prevents later operations from starting.
 * Idle thread state is discarded.
 */
export function createThreadLifecycleCoordinator(): ThreadLifecycleCoordinator {
  const states = new Map<string, ThreadState>()

  const drain = (threadId: string, state: ThreadState) => {
    if (state.exclusiveActive || state.activeShared > 0) return

    const first = state.queue[0]
    if (first === undefined) {
      if (states.get(threadId) === state) states.delete(threadId)
      return
    }

    if (first.kind === "exclusive") {
      state.queue.shift()
      state.exclusiveActive = true
      first.start()
      return
    }

    while (state.queue[0]?.kind === "shared") {
      const entry = state.queue.shift()
      if (entry === undefined) break
      state.activeShared += 1
      entry.start()
    }
  }

  const enqueue = <T>(
    threadId: string,
    kind: QueueEntry["kind"],
    operation: () => Promise<T>,
  ): Promise<T> => {
    let state = states.get(threadId)
    if (state === undefined) {
      state = { activeShared: 0, exclusiveActive: false, queue: [] }
      states.set(threadId, state)
    }
    const threadState = state

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        kind,
        start: () => {
          void Promise.resolve()
            .then(operation)
            .then(
              (value) => {
                if (kind === "shared") threadState.activeShared -= 1
                else threadState.exclusiveActive = false
                drain(threadId, threadState)
                resolve(value)
              },
              (error: unknown) => {
                if (kind === "shared") threadState.activeShared -= 1
                else threadState.exclusiveActive = false
                drain(threadId, threadState)
                reject(error)
              },
            )
        },
      }

      if (kind === "shared" && !threadState.exclusiveActive && threadState.queue.length === 0) {
        threadState.activeShared += 1
        entry.start()
      } else {
        threadState.queue.push(entry)
        drain(threadId, threadState)
      }
    })
  }

  return {
    get pendingThreadCount() {
      return states.size
    },
    runShared<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
      return enqueue(threadId, "shared", operation)
    },
    runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
      return enqueue(threadId, "exclusive", operation)
    },
  }
}
