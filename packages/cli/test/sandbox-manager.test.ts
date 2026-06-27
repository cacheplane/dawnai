import { fakeSandbox } from "@dawn-ai/sandbox/testing"
import { describe, expect, test, vi } from "vitest"
import { SandboxManager } from "../src/lib/runtime/sandbox-manager.js"

const policy = { network: { mode: "allow" } } as const
const signal = () => new AbortController().signal
const now = { t: 1_000 }
const clock = () => now.t

describe("SandboxManager", () => {
  test("reuses one handle across turns for a thread", async () => {
    const provider = fakeSandbox()
    const acquire = vi.spyOn(provider, "acquire")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    const h1 = await mgr.getForThread("t1", signal())
    const h2 = await mgr.getForThread("t1", signal())
    expect(h1).toBe(h2)
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  test("dedups concurrent acquires for the same thread", async () => {
    const provider = fakeSandbox()
    const acquire = vi.spyOn(provider, "acquire")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    const [a, b] = await Promise.all([
      mgr.getForThread("t1", signal()),
      mgr.getForThread("t1", signal()),
    ])
    expect(a).toBe(b)
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  test("reapIdle releases (not destroys) idle threads, keeping the volume", async () => {
    const provider = fakeSandbox()
    const release = vi.spyOn(provider, "release")
    const destroy = vi.spyOn(provider, "destroy")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    await mgr.getForThread("t1", signal())
    now.t = 25_000
    await mgr.reapIdle()
    expect(release).toHaveBeenCalledWith("t1")
    expect(destroy).not.toHaveBeenCalled()
    await mgr.getForThread("t1", signal())
  })

  test("does not reap an in-flight (in-use) thread", async () => {
    const provider = fakeSandbox()
    const release = vi.spyOn(provider, "release")
    let resolveAcquire!: () => void
    vi.spyOn(provider, "acquire").mockImplementation(
      () =>
        new Promise((r) => {
          resolveAcquire = () =>
            r({
              threadId: "t1",
              filesystem: {} as never,
              exec: {} as never,
              workspaceRoot: "/workspace",
            })
        }),
    )
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 1, clock })
    const inflight = mgr.getForThread("t1", signal())
    now.t = 1_000_000
    await mgr.reapIdle()
    expect(release).not.toHaveBeenCalled()
    resolveAcquire()
    await inflight
  })

  test("destroyThread destroys + drops the entry", async () => {
    const provider = fakeSandbox()
    const destroy = vi.spyOn(provider, "destroy")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    await mgr.getForThread("t1", signal())
    await mgr.destroyThread("t1")
    expect(destroy).toHaveBeenCalledWith("t1")
  })

  test("releaseAll releases every live thread", async () => {
    const provider = fakeSandbox()
    const release = vi.spyOn(provider, "release")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    await mgr.getForThread("a", signal())
    await mgr.getForThread("b", signal())
    await mgr.releaseAll()
    expect(release.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"])
  })
})
