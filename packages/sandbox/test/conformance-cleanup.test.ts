import { describe, expect, test, vi } from "vitest"

import { runProviderConformanceCase } from "../src/testing/conformance.ts"

describe("SandboxProvider conformance cleanup", () => {
  test("destroys a tracked thread when the conformance body fails", async () => {
    const bodyFailure = new Error("body failed")
    const destroy = vi.fn(async () => undefined)

    await expect(
      runProviderConformanceCase({ destroy }, ["thread-a"], async () => {
        throw bodyFailure
      }),
    ).rejects.toBe(bodyFailure)
    expect(destroy).toHaveBeenCalledExactlyOnceWith("thread-a")
  })

  test("attempts cleanup for both isolation threads when the first destroy fails", async () => {
    const cleanupFailure = new Error("first cleanup failed")
    const destroy = vi.fn((threadId: string): Promise<void> => {
      if (threadId === "thread-a") throw cleanupFailure
      return Promise.resolve()
    })

    const error = await runProviderConformanceCase(
      { destroy },
      ["thread-a", "thread-b"],
      async () => undefined,
    ).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([cleanupFailure])
    expect(destroy.mock.calls).toEqual([["thread-a"], ["thread-b"]])
  })

  test("aggregates the primary body failure before every cleanup failure", async () => {
    const bodyFailure = new Error("body failed")
    const firstCleanupFailure = new Error("first cleanup failed")
    const secondCleanupFailure = new Error("second cleanup failed")
    const destroy = vi.fn(async (threadId: string) => {
      throw threadId === "thread-a" ? firstCleanupFailure : secondCleanupFailure
    })

    const error = await runProviderConformanceCase(
      { destroy },
      ["thread-a", "thread-b"],
      async () => {
        throw bodyFailure
      },
    ).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      bodyFailure,
      firstCleanupFailure,
      secondCleanupFailure,
    ])
    expect(destroy.mock.calls).toEqual([["thread-a"], ["thread-b"]])
  })
})
