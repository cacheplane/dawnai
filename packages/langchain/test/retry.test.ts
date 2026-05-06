import { describe, expect, test } from "vitest"
import { isRetryableError, withRetry } from "../src/retry.js"

describe("isRetryableError", () => {
  test("returns true for rate limit errors", () => {
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true)
    expect(isRetryableError(new Error("Rate limit exceeded"))).toBe(true)
  })

  test("returns true for server errors", () => {
    expect(isRetryableError(new Error("500 Internal Server Error"))).toBe(true)
    expect(isRetryableError(new Error("502 Bad Gateway"))).toBe(true)
    expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(true)
  })

  test("returns true for network errors", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true)
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true)
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true)
    expect(isRetryableError(new Error("network error"))).toBe(true)
  })

  test("returns true for OpenAI transient errors", () => {
    expect(isRetryableError(new Error("The server is overloaded"))).toBe(true)
    expect(isRetryableError(new Error("server_error"))).toBe(true)
  })

  test("returns false for non-retryable errors", () => {
    expect(isRetryableError(new Error("Invalid API key"))).toBe(false)
    expect(isRetryableError(new Error("Model not found"))).toBe(false)
    expect(isRetryableError(new Error("400 Bad Request"))).toBe(false)
  })

  test("returns false for non-Error values", () => {
    expect(isRetryableError("string error")).toBe(false)
    expect(isRetryableError(null)).toBe(false)
  })
})

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const result = await withRetry(async () => "hello")
    expect(result).toBe("hello")
  })

  test("retries on retryable error and succeeds", async () => {
    let attempts = 0
    const result = await withRetry(
      async () => {
        attempts++
        if (attempts < 2) throw new Error("503 Service Unavailable")
        return "success"
      },
      { baseDelayMs: 10, maxAttempts: 3 },
    )

    expect(result).toBe("success")
    expect(attempts).toBe(2)
  })

  test("throws immediately on non-retryable error", async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error("Invalid API key")
        },
        { baseDelayMs: 10, maxAttempts: 3 },
      ),
    ).rejects.toThrow("Invalid API key")

    expect(attempts).toBe(1)
  })

  test("throws after max attempts exhausted", async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error("503 Service Unavailable")
        },
        { baseDelayMs: 10, maxAttempts: 2 },
      ),
    ).rejects.toThrow("503 Service Unavailable")

    expect(attempts).toBe(2)
  })

  test("respects abort signal", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(withRetry(async () => "never", { signal: controller.signal })).rejects.toThrow(
      "Operation aborted",
    )
  })
})
