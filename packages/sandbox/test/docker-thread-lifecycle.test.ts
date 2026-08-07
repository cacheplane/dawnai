import { describe, expect, test } from "vitest"
import { createThreadLifecycleCoordinator } from "../src/docker/thread-lifecycle.ts"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("thread lifecycle coordinator", () => {
  test("lets admitted execs drain before a lifecycle mutation and blocks later execs", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const firstGate = deferred()
    const secondGate = deferred()
    const mutationGate = deferred()
    const events: string[] = []

    const first = coordinator.runShared("abc", async () => {
      events.push("first:start")
      await firstGate.promise
      events.push("first:end")
    })
    const second = coordinator.runShared("abc", async () => {
      events.push("second:start")
      await secondGate.promise
      events.push("second:end")
    })
    await Promise.resolve()

    const mutation = coordinator.runExclusive("abc", async () => {
      events.push("mutation:start")
      await mutationGate.promise
      events.push("mutation:end")
    })
    const later = coordinator.runShared("abc", async () => {
      events.push("later")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start", "second:start"])
    firstGate.resolve()
    secondGate.resolve()
    await Promise.all([first, second])
    await Promise.resolve()
    expect(events).toEqual([
      "first:start",
      "second:start",
      "first:end",
      "second:end",
      "mutation:start",
    ])

    mutationGate.resolve()
    await Promise.all([mutation, later])
    expect(events).toEqual([
      "first:start",
      "second:start",
      "first:end",
      "second:end",
      "mutation:start",
      "mutation:end",
      "later",
    ])
    expect(coordinator.pendingThreadCount).toBe(0)
  })

  test("runs same-thread operations FIFO through completion", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const firstGate = deferred()
    const secondGate = deferred()
    const events: string[] = []
    const first = coordinator.runExclusive("abc", async () => {
      events.push("first:start")
      await firstGate.promise
      events.push("first:end")
    })
    const second = coordinator.runExclusive("abc", async () => {
      events.push("second:start")
      await secondGate.promise
      events.push("second:end")
    })
    const third = coordinator.runExclusive("abc", async () => {
      events.push("third")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    expect(coordinator.pendingThreadCount).toBe(1)
    firstGate.resolve()
    await first
    await Promise.resolve()
    expect(events).toEqual(["first:start", "first:end", "second:start"])
    secondGate.resolve()
    await Promise.all([second, third])
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end", "third"])
    expect(coordinator.pendingThreadCount).toBe(0)
  })

  test("permits different threads to run concurrently", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const firstGate = deferred()
    const events: string[] = []
    const first = coordinator.runExclusive("abc", async () => {
      events.push("abc:start")
      await firstGate.promise
      events.push("abc:end")
    })
    const other = coordinator.runExclusive("xyz", async () => {
      events.push("xyz")
    })

    await other
    expect(events).toEqual(["abc:start", "xyz"])
    expect(coordinator.pendingThreadCount).toBe(1)
    firstGate.resolve()
    await first
    expect(coordinator.pendingThreadCount).toBe(0)
  })

  test("a rejection does not poison the next same-thread operation", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const events: string[] = []
    const failed = coordinator.runExclusive("abc", async () => {
      events.push("failed")
      throw new Error("boom")
    })
    const next = coordinator.runExclusive("abc", async () => {
      events.push("next")
      return "ok"
    })

    await expect(failed).rejects.toThrow("boom")
    await expect(next).resolves.toBe("ok")
    expect(events).toEqual(["failed", "next"])
    expect(coordinator.pendingThreadCount).toBe(0)
  })

  test("a rejected shared operation releases a queued lifecycle mutation", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const failed = coordinator.runShared("abc", async () => {
      throw new Error("exec failed")
    })
    const mutation = coordinator.runExclusive("abc", async () => "recovered")

    await expect(failed).rejects.toThrow("exec failed")
    await expect(mutation).resolves.toBe("recovered")
    expect(coordinator.pendingThreadCount).toBe(0)
  })

  test("a later operation does not wait on a completed idle tail", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    await coordinator.runExclusive("abc", async () => "first")

    let started = false
    const later = coordinator.runExclusive("abc", async () => {
      started = true
      return "later"
    })
    await Promise.resolve()

    expect(started).toBe(true)
    await expect(later).resolves.toBe("later")
    expect(coordinator.pendingThreadCount).toBe(0)
  })
})
