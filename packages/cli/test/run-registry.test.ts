import { describe, expect, it } from "vitest"
import { createRunRegistry } from "../src/lib/dev/run-registry.js"

const shutdown = () => new AbortController().signal

describe("createRunRegistry", () => {
  it("admits the first run for a thread", () => {
    const registry = createRunRegistry()
    expect(registry.begin("t1", shutdown())).toBeDefined()
    expect(registry.has("t1")).toBe(true)
  })

  it("refuses a second concurrent run on the same thread", () => {
    const registry = createRunRegistry()
    registry.begin("t1", shutdown())
    expect(registry.begin("t1", shutdown())).toBeUndefined()
  })

  it("admits concurrent runs on different threads", () => {
    const registry = createRunRegistry()
    expect(registry.begin("t1", shutdown())).toBeDefined()
    expect(registry.begin("t2", shutdown())).toBeDefined()
  })

  it("admits a new run after the previous one is released", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    run?.release()
    expect(registry.has("t1")).toBe(false)
    expect(registry.begin("t1", shutdown())).toBeDefined()
  })

  it("release is idempotent and does not clear a later run's slot", () => {
    const registry = createRunRegistry()
    const first = registry.begin("t1", shutdown())
    first?.release()
    const second = registry.begin("t1", shutdown())
    first?.release() // stale release from the finished run
    expect(registry.has("t1")).toBe(true)
    expect(second).toBeDefined()
  })

  it("cancel aborts the run signal and reports success", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    expect(registry.cancel("t1")).toBe(true)
    expect(run?.signal.aborted).toBe(true)
    expect(run?.cancelled).toBe(true)
  })

  it("cancel returns false when no run is in flight", () => {
    const registry = createRunRegistry()
    expect(registry.cancel("nope")).toBe(false)
  })

  it("server shutdown aborts the run signal but is not a cancellation", () => {
    const registry = createRunRegistry()
    const shutdownController = new AbortController()
    const run = registry.begin("t1", shutdownController.signal)
    shutdownController.abort()
    expect(run?.signal.aborted).toBe(true)
    expect(run?.cancelled).toBe(false)
  })

  it("begin on an already-aborted shutdown signal yields an aborted run signal", () => {
    const registry = createRunRegistry()
    const shutdownController = new AbortController()
    shutdownController.abort()
    const run = registry.begin("t1", shutdownController.signal)
    expect(run?.signal.aborted).toBe(true)
    expect(run?.cancelled).toBe(false)
  })

  it("stops listening to the shutdown signal after release", () => {
    const registry = createRunRegistry()
    const shutdownController = new AbortController()
    const run = registry.begin("t1", shutdownController.signal)
    run?.release()
    shutdownController.abort()
    // Proxy for "the abort listener was removed": a released run no longer
    // reacts to shutdown. Without removeEventListener this would be true.
    expect(run?.signal.aborted).toBe(false)
  })
})

describe("RunRegistry.claim", () => {
  it("returns undefined when no run is in flight", () => {
    const registry = createRunRegistry()
    expect(registry.claim("t1")).toBeUndefined()
  })

  it("aborts the exact run it bound to", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    const claim = registry.claim("t1")
    expect(claim?.cancel()).toBe(true)
    expect(run?.cancelled).toBe(true)
    expect(run?.signal.aborted).toBe(true)
  })

  it("refuses to abort a later run that replaced the one it bound to", () => {
    // The direct sibling of release()'s identity guard: a cancel issued against
    // run N must never land on run N+1.
    const registry = createRunRegistry()
    const first = registry.begin("t1", shutdown())
    const claim = registry.claim("t1")
    first?.release()
    const second = registry.begin("t1", shutdown())
    expect(claim?.cancel()).toBe(false)
    expect(second?.cancelled).toBe(false)
    expect(second?.signal.aborted).toBe(false)
    second?.release()
  })

  it("leaves cancel(threadId) untouched for its other callers", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    expect(registry.cancel("t1")).toBe(true)
    expect(run?.cancelled).toBe(true)
    expect(registry.cancel("t-absent")).toBe(false)
  })
})
