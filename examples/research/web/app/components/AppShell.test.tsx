// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The one test in this suite that mounts a component over a fake, and the one
 * place a fake is justified: the contract under test is *our* effect's
 * behavior, not the library's. `AppShell`'s thread-switch reset is guarded by
 * `renderedThreadIdRef`, and the guard exists because `agent` is also in the
 * effect's dependency array while its identity changes for reasons outside
 * this file — `useAgent` swaps a provisional stand-in for the real agent once
 * the runtime `/info` sync resolves, and hands back a different instance again
 * whenever the registry changes.
 *
 * Both halves of that guard have to hold, and neither is observable from the
 * pure layers:
 *
 * - drop the ref and an agent swap wipes a transcript nobody asked to leave;
 * - break the ref the other way (make it always match) and a real thread
 *   switch stops clearing `pendingInterrupts`, which puts thread A's
 *   approve/deny card in front of an agent now pointed at thread B — a bug we
 *   have already shipped once. Every gate stayed green for it; the only
 *   symptom was the wrong card in a live browser.
 */
const mocks = vi.hoisted(() => ({
  agent: null as unknown as FakeAgent,
}))

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mocks.agent, isReady: true }),
  useCopilotKit: () => ({
    copilotkit: {
      subscribe: () => ({ unsubscribe: () => {} }),
      runAgent: async () => {},
    },
  }),
  useRenderActivityMessage: () => ({
    renderActivityMessage: () => null,
    findRenderer: () => null,
  }),
  useRenderToolCall: () => () => null,
  useInterrupt: () => null,
  useSuggestions: () => ({
    suggestions: [],
    reloadSuggestions: () => {},
    clearSuggestions: () => {},
    isLoading: false,
  }),
  CopilotChatAssistantMessage: { MarkdownRenderer: () => null },
}))

const { AppShell } = await import("./AppShell")
type ThreadSource = import("../lib/thread-source").ThreadSource
type HydratedThread = import("../lib/hydrate").HydratedThread

interface FakeAgent {
  messages: unknown[]
  setMessagesArgs: unknown[][]
  isRunning: boolean
  pendingInterrupts: unknown[]
  setMessagesCalls: number
  abortCalls: number
  addMessage: (message: unknown) => void
  setMessages: (messages: unknown[]) => void
  abortRun: () => void
}

function makeAgent(): FakeAgent {
  return {
    messages: [{ id: "m1", role: "user", content: "carried over" }],
    isRunning: false,
    pendingInterrupts: [{ id: "interrupt-1" }],
    setMessagesArgs: [],
    setMessagesCalls: 0,
    abortCalls: 0,
    addMessage() {},
    setMessages(messages) {
      this.setMessagesCalls += 1
      this.setMessagesArgs.push(messages)
      this.messages = messages
    },
    abortRun() {
      this.abortCalls += 1
    },
  }
}

let container: HTMLDivElement
let root: Root
let hydrate: ReturnType<typeof vi.fn>

/**
 * The thread source is stubbed at the SEAM rather than at `global.fetch`: the
 * shell's contract is "ask the source, apply what comes back to the agent that
 * is on screen now", and the URL and status handling are `thread-source`'s own
 * tests (which do stub fetch).
 */
function threadSource(): ThreadSource {
  return {
    create: () => ({ id: "unused", lastActiveAt: 0 }),
    hydrate: hydrate as unknown as ThreadSource["hydrate"],
    list: () => [],
    touch: () => {},
  }
}

function render(activeThreadId: string | undefined) {
  act(() => {
    root.render(
      <AppShell
        threads={[]}
        activeThreadId={activeThreadId}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onUserMessage={() => {}}
        threadSource={threadSource()}
      />,
    )
  })
}

/** Lets a test resolve or reject one hydrate at the exact moment it chooses. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

/** Flush the promise callbacks a settled hydrate queues, inside `act`. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.agent = makeAgent()
  // The default: every thread is empty, which is what the pre-existing
  // switch-reset tests below assume (the shell leaves the agent alone).
  hydrate = vi.fn(async () => ({ messages: [], todos: [] }))
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe("app shell thread-switch reset", () => {
  test("leaves the agent alone on the first render of a thread", () => {
    render("thread-a")
    expect(mocks.agent.setMessagesCalls).toBe(0)
    expect(mocks.agent.pendingInterrupts).toHaveLength(1)
  })

  test("clears the transcript and the parked interrupts when the thread changes", () => {
    render("thread-a")
    const agent = mocks.agent
    render("thread-b")
    expect(agent.setMessagesCalls).toBe(1)
    expect(agent.messages).toEqual([])
    // The half that matters most: a parked interrupt left on the shared agent
    // makes the next run throw, and leaves the abandoned thread's card live.
    expect(agent.pendingInterrupts).toEqual([])
  })

  test("aborts a run in flight when the thread changes", () => {
    mocks.agent.isRunning = true
    render("thread-a")
    const agent = mocks.agent
    render("thread-b")
    expect(agent.abortCalls).toBe(1)
  })

  test("does NOT reset when only the agent's identity changes", () => {
    render("thread-a")
    // What `useAgent` does when the provisional agent is swapped for the real
    // one after runtime sync: same thread, different instance.
    const swapped = makeAgent()
    mocks.agent = swapped
    render("thread-a")
    expect(swapped.setMessagesCalls).toBe(0)
    expect(swapped.pendingInterrupts).toHaveLength(1)
    expect(swapped.messages).toHaveLength(1)
  })
})

describe("app shell hydration", () => {
  const RESTORED: HydratedThread = {
    messages: [{ content: "what did we find?", id: "h1", role: "user" }],
    todos: [{ content: "Read the corpus", status: "completed" }],
  }

  test("restores the checkpointed messages, with the plan card in front", async () => {
    hydrate = vi.fn(async () => RESTORED)
    render(undefined)
    render("thread-a")
    await flush()
    expect(hydrate).toHaveBeenCalledWith("thread-a")
    const applied = mocks.agent.setMessagesArgs.at(-1) ?? []
    expect(applied).toEqual([
      {
        activityType: "dawn.plan",
        content: { todos: [{ content: "Read the corpus", status: "completed" }] },
        id: "hydrated:plan:thread-a",
        role: "activity",
      },
      { content: "what did we find?", id: "h1", role: "user" },
    ])
    // And the shell admits what a restore cannot bring back.
    expect(container.textContent).toContain("Subagent cards are not saved")
  })

  test("drops a malformed plan rather than rendering it, keeping the messages", async () => {
    hydrate = vi.fn(async () => ({
      messages: RESTORED.messages,
      // Past `hydrate.ts`'s own filter only because this test bypasses it —
      // the point is that the schema, not the mapper, is the last gate.
      todos: [{ content: "x", status: "bogus" }] as unknown as HydratedThread["todos"],
    }))
    render(undefined)
    render("thread-a")
    await flush()
    expect(mocks.agent.setMessagesArgs.at(-1)).toEqual(RESTORED.messages)
  })

  test("treats an empty thread as normal: no messages applied, no error", async () => {
    render(undefined)
    render("thread-a")
    await flush()
    // Only the switch's own clear; nothing applied on top of it.
    expect(mocks.agent.setMessagesCalls).toBe(1)
    expect(mocks.agent.messages).toEqual([])
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain("Subagent cards are not saved")
  })

  test("surfaces a failed hydrate as a run error", async () => {
    hydrate = vi.fn(async () => {
      throw new Error("Could not load this conversation (HTTP 500).")
    })
    render(undefined)
    render("thread-a")
    await flush()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("Could not restore this conversation")
    expect(alert?.textContent).toContain("HTTP 500")
  })

  test("ignores a response for a thread the user has already left", async () => {
    const first = deferred<HydratedThread>()
    const second = deferred<HydratedThread>()
    const answers = [first.promise, second.promise]
    hydrate = vi.fn(() => answers.shift() ?? Promise.resolve({ messages: [], todos: [] }))
    render(undefined)
    render("thread-a")
    render("thread-b")
    const clearsSoFar = mocks.agent.setMessagesCalls
    // Thread A's history lands late — after the user is already looking at B.
    first.resolve(RESTORED)
    await flush()
    expect(mocks.agent.setMessagesCalls).toBe(clearsSoFar)
    expect(mocks.agent.messages).toEqual([])
    expect(container.textContent).not.toContain("Subagent cards are not saved")
    // B's own answer still applies, so the guard is not simply refusing all.
    second.resolve({ messages: [{ content: "b", id: "b1", role: "user" }], todos: [] })
    await flush()
    expect(mocks.agent.messages).toEqual([{ content: "b", id: "b1", role: "user" }])
  })

  test("applies a late hydrate to the agent instance that is on screen now", async () => {
    const pending = deferred<HydratedThread>()
    hydrate = vi.fn(() => pending.promise)
    render(undefined)
    render("thread-a")
    // What `useAgent` does after the runtime `/info` sync: same thread, a
    // different instance. The in-flight hydrate must follow it.
    const swapped = makeAgent()
    swapped.messages = []
    mocks.agent = swapped
    render("thread-a")
    pending.resolve({ messages: [{ content: "late", id: "l1", role: "user" }], todos: [] })
    await flush()
    expect(swapped.messages).toEqual([{ content: "late", id: "l1", role: "user" }])
  })
})
