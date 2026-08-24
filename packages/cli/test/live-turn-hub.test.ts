import { describe, expect, it } from "vitest"
import { createLiveTurnHub } from "../src/lib/dev/live-turn-hub.js"
import type { StreamChunk } from "../src/lib/runtime/stream-types.js"

const chunk = (data: string): StreamChunk => ({ type: "chunk", data })

describe("LiveTurnHub", () => {
  it("hands an attacher the digest snapshot then the live tail, ending after terminal", async () => {
    const hub = createLiveTurnHub()
    const p = hub.open({
      threadId: "t1",
      anchorCheckpointId: "cp-1",
      runStartedAt: "2020-01-01T00:00:00.000Z",
      resume: false,
      input: { messages: [] },
    })
    p.publish(chunk("hel"))
    p.publish(chunk("lo"))

    const a = hub.attach("t1")
    expect(a).toBeDefined()
    if (!a) throw new Error("no attachment")
    // Coalesced digest: two consecutive chunk frames became one.
    expect(a.turn).toEqual([{ type: "chunk", data: "hello" }])
    expect(a.truncated).toBe(false)
    expect(a.anchorCheckpointId).toBe("cp-1")
    expect(a.resume).toBe(false)
    expect(a.terminal).toBeNull()

    // A frame published after the snapshot arrives only through next().
    p.publish({ type: "tool_call", id: "c1", name: "search", input: {} })
    p.close({ type: "done", output: { ok: true } })

    const first = await a.next()
    expect(first).toEqual({ type: "tool_call", id: "c1", name: "search", input: {} })
    const last = await a.next()
    expect(last).toEqual({ type: "done", output: { ok: true } })
    const end = await a.next()
    expect(end).toBeNull()
    a.detach()
  })

  it("drops the digest whole on overflow and reports truncated", async () => {
    const hub = createLiveTurnHub({ digestMaxBytes: 64 })
    const p = hub.open({
      threadId: "t",
      anchorCheckpointId: null,
      runStartedAt: "x",
      resume: false,
      input: null,
    })
    for (let i = 0; i < 50; i++)
      p.publish({ type: "tool_call", id: `c${i}`, name: "n", input: { i } })
    const a = hub.attach("t")
    expect(a?.turn).toBeNull()
    expect(a?.truncated).toBe(true)
    a?.detach()
  })

  it("drops only the overflowing subscriber", async () => {
    const hub = createLiveTurnHub({ subscriberMaxFrames: 2 })
    const p = hub.open({
      threadId: "t",
      anchorCheckpointId: null,
      runStartedAt: "x",
      resume: false,
      input: null,
    })
    const slow = hub.attach("t")
    const fast = hub.attach("t")
    if (!slow || !fast) throw new Error("no attachment")
    p.publish(chunk("a"))
    expect(await fast.next()).toEqual({ type: "chunk", data: "a" })
    p.publish(chunk("b"))
    expect(await fast.next()).toEqual({ type: "chunk", data: "b" })
    p.publish({ type: "tool_call", id: "c", name: "n", input: {} })
    expect(await fast.next()).toEqual({ type: "tool_call", id: "c", name: "n", input: {} })
    // slow never drained -> its queue overflowed; fast drained after each publish and stays under cap.
    expect(slow.overflowed()).toBe("overflow")
    expect(await slow.next()).toBeNull()
    expect(fast.overflowed()).toBeUndefined()
    slow.detach()
    fast.detach()
  })

  it("a producer whose entry was replaced is inert", async () => {
    const hub = createLiveTurnHub()
    const p1 = hub.open({
      threadId: "t",
      anchorCheckpointId: null,
      runStartedAt: "1",
      resume: false,
      input: null,
    })
    const p2 = hub.open({
      threadId: "t",
      anchorCheckpointId: null,
      runStartedAt: "2",
      resume: false,
      input: null,
    })
    p1.publish(chunk("zombie"))
    const a = hub.attach("t")
    expect(a?.turn).toEqual([]) // p1's write did not reach the new entry
    expect(a?.runStartedAt).toBe("2")
    p2.close({ type: "done", output: null })
    a?.detach()
  })

  it("an attach that lands after the terminal still terminates", async () => {
    const hub = createLiveTurnHub()
    const p = hub.open({
      threadId: "t",
      anchorCheckpointId: null,
      runStartedAt: "x",
      resume: false,
      input: null,
    })
    p.publish(chunk("hi"))
    // close evicts the entry, so attach() now returns undefined — the durable path.
    p.close({ type: "done", output: { ok: true } })
    expect(hub.attach("t")).toBeUndefined()
  })
})
