/**
 * Retry with exponential backoff for transient LLM and tool failures.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  readonly maxAttempts?: number
  /** Base delay in ms before first retry (default: 1000) */
  readonly baseDelayMs?: number
  /** Maximum delay in ms (default: 10000) */
  readonly maxDelayMs?: number
  /** Abort signal to cancel retries */
  readonly signal?: AbortSignal
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 10_000

/**
 * Returns true if the error is transient and the operation should be retried.
 * Retries on: rate limits (429), server errors (5xx), network errors, timeouts.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()

  // Rate limit errors
  if (message.includes("429") || message.includes("rate limit")) return true

  // Server errors (5xx)
  if (message.includes("500") || message.includes("502") || message.includes("503")) return true

  // Network/timeout errors
  if (
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("network")
  )
    return true

  // OpenAI-specific transient errors
  if (message.includes("overloaded") || message.includes("server_error")) return true

  return false
}

/**
 * Execute an async function with retry and exponential backoff.
 * Only retries on transient errors (rate limits, server errors, network issues).
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const signal = options?.signal

  let lastError: Error | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("Operation aborted")
    }

    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Don't retry non-transient errors or on the last attempt
      if (!isRetryableError(error) || attempt === maxAttempts - 1) {
        throw lastError
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 500, maxDelayMs)

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, delay)
        if (signal) {
          const onAbort = () => {
            clearTimeout(timeout)
            reject(new Error("Operation aborted"))
          }
          signal.addEventListener("abort", onAbort, { once: true })
        }
      })
    }
  }

  throw lastError ?? new Error("Retry exhausted")
}
