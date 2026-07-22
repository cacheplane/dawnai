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

function closeIterator<T>(iterator: AsyncIterator<T>): void {
  try {
    const cleanup = iterator.return?.()
    if (cleanup) void cleanup.catch(() => undefined)
  } catch {
    // Iterator cleanup is best-effort and must not replace the iteration outcome.
  }
}

export async function* abortableAsyncIterable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()

  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    closeIterator(iterator)
  }
}
