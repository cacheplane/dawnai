export async function isDevServerReady(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/healthz", baseUrl))

    if (response.status !== 200) {
      return false
    }

    const body = (await response.json()) as { readonly status?: string }
    return body.status === "ready"
  } catch {
    return false
  }
}

export async function waitForDevServerReady(
  baseUrl: string,
  options: {
    readonly intervalMs?: number
    readonly signal?: AbortSignal
    readonly timeoutMs?: number
  } = {},
): Promise<void> {
  const startedAt = Date.now()
  const intervalMs = options.intervalMs ?? 25
  const timeoutMs = options.timeoutMs ?? 5_000

  while (Date.now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Readiness wait aborted")
    }

    if (await isDevServerReady(baseUrl)) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out waiting for ${baseUrl}/healthz readiness`)
}
