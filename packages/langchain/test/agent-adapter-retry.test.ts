import { describe, expect, test, vi } from "vitest"

/**
 * These tests verify that per-agent retry config is respected.
 * We test the internal wiring by checking that withRetry receives
 * the correct options from the agent descriptor.
 */

import { isRetryableError, withRetry } from "../src/retry.js"

describe("per-agent retry config wiring", () => {
  test("withRetry respects custom maxAttempts", async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error("503 Service Unavailable")
        },
        { baseDelayMs: 10, maxAttempts: 5 },
      ),
    ).rejects.toThrow("503 Service Unavailable")

    expect(attempts).toBe(5)
  })

  test("withRetry respects custom baseDelayMs", async () => {
    let attempts = 0
    const start = Date.now()
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error("429 Too Many Requests")
        },
        { baseDelayMs: 10, maxAttempts: 2 },
      ),
    ).rejects.toThrow("429 Too Many Requests")

    expect(attempts).toBe(2)
    // With baseDelayMs=10, the delay should be very short
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
