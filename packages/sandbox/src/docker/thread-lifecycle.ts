export interface ThreadLifecycleCoordinator {
  run<T>(threadId: string, operation: () => Promise<T>): Promise<T>
}

/** Keyed FIFO for Docker lifecycle mutations; idle keys are discarded. */
export function createThreadLifecycleCoordinator(): ThreadLifecycleCoordinator {
  const tails = new Map<string, Promise<void>>()

  return {
    async run<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(threadId) ?? Promise.resolve()
      let release = () => {}
      const completion = new Promise<void>((resolve) => {
        release = resolve
      })
      const tail = previous.then(() => completion)
      tails.set(threadId, tail)

      await previous
      try {
        return await operation()
      } finally {
        release()
        if (tails.get(threadId) === tail) tails.delete(threadId)
      }
    },
  }
}
