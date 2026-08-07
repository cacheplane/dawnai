function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError")
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  let rejectAbort: ((reason: unknown) => void) | undefined
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort?.(abortError(signal))
  signal.addEventListener("abort", onAbort, { once: true })

  try {
    if (signal.aborted) throw abortError(signal)
    return await Promise.race([iterator.next(), abort])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Calls `iterator.return()` without waiting for it — a route suspended at a
 * non-abortable await does not settle `.return()` until that await completes,
 * and this function's caller must not block on that. Returns the (never
 * rejecting) cleanup promise so a caller that DOES care when the source
 * actually finishes — e.g. to hold a run slot open — can observe it instead
 * of discarding it.
 */
function closeIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  try {
    const cleanup = iterator.return?.()
    if (cleanup)
      return cleanup.then(
        () => undefined,
        () => undefined,
      )
  } catch {
    // Iterator cleanup is best-effort and must not replace the iteration outcome.
  }
  return Promise.resolve()
}

export async function* abortableAsyncIterable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  onSourceCleanup?: (cleanup: Promise<void>) => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()

  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    const cleanup = closeIterator(iterator)
    if (onSourceCleanup) onSourceCleanup(cleanup)
    // Preserve fire-and-forget cleanup for callers that do not own an
    // execution claim that must remain held until the source unwinds.
    else void cleanup
  }
}
