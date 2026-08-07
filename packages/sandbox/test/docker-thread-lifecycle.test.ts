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
  test("runs same-thread operations FIFO through completion", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const firstGate = deferred()
    const secondGate = deferred()
    const events: string[] = []
    const first = coordinator.run("abc", async () => {
      events.push("first:start")
      await firstGate.promise
      events.push("first:end")
    })
    const second = coordinator.run("abc", async () => {
      events.push("second:start")
      await secondGate.promise
      events.push("second:end")
    })
    const third = coordinator.run("abc", async () => {
      events.push("third")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    firstGate.resolve()
    await first
    await Promise.resolve()
    expect(events).toEqual(["first:start", "first:end", "second:start"])
    secondGate.resolve()
    await Promise.all([second, third])
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end", "third"])
  })

  test("permits different threads to run concurrently", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const firstGate = deferred()
    const events: string[] = []
    const first = coordinator.run("abc", async () => {
      events.push("abc:start")
      await firstGate.promise
      events.push("abc:end")
    })
    const other = coordinator.run("xyz", async () => {
      events.push("xyz")
    })

    await other
    expect(events).toEqual(["abc:start", "xyz"])
    firstGate.resolve()
    await first
  })

  test("a rejection does not poison the next same-thread operation", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    const events: string[] = []
    const failed = coordinator.run("abc", async () => {
      events.push("failed")
      throw new Error("boom")
    })
    const next = coordinator.run("abc", async () => {
      events.push("next")
      return "ok"
    })

    await expect(failed).rejects.toThrow("boom")
    await expect(next).resolves.toBe("ok")
    expect(events).toEqual(["failed", "next"])
  })

  test("a later operation does not wait on a completed idle tail", async () => {
    const coordinator = createThreadLifecycleCoordinator()
    await coordinator.run("abc", async () => "first")

    let started = false
    const later = coordinator.run("abc", async () => {
      started = true
      return "later"
    })
    await Promise.resolve()

    expect(started).toBe(true)
    await expect(later).resolves.toBe("later")
  })
})
