// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest"

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
  runAgent: (async () => {}) as (params: unknown) => Promise<unknown>,
}))

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mocks.agent, isReady: true }),
  useCopilotKit: () => ({
    copilotkit: {
      subscribe: () => ({ unsubscribe: () => {} }),
      runAgent: mocks.runAgent,
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
const { CONNECT_SCREEN_HEADING } = await import("./ConnectScreen")
const { RESTORED_HISTORY_NOTICE } = await import("./Transcript")
type ThreadSource = import("../lib/thread-source").ThreadSource
type HydratedThread = import("../lib/hydrate").HydratedThread
type ParkedInterrupt = import("../lib/thread-source").ParkedInterrupt

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
  subscribe: () => { unsubscribe: () => void }
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
    // The rail's `MemoryPanel` subscribes for `onRunFinishedEvent` (it re-reads
    // the candidate list when a run ends). Nothing in this file drives it; the
    // fake only has to not throw on mount.
    subscribe: () => ({ unsubscribe: () => {} }),
  }
}

let container: HTMLDivElement
let root: Root
// Typed with their real signatures rather than a bare `ReturnType<typeof
// vi.fn>`, which is not callable — the source object below delegates to them.
let hydrate: Mock<(id: string) => Promise<HydratedThread>>
let pendingInterrupts: Mock<(id: string, signal?: AbortSignal) => Promise<ParkedInterrupt[]>>

/**
 * The thread source is stubbed at the SEAM rather than at `global.fetch`: the
 * shell's contract is "ask the source, apply what comes back to the agent that
 * is on screen now", and the URL and status handling are `thread-source`'s own
 * tests (which do stub fetch).
 */
function threadSource(): ThreadSource {
  return {
    create: () => ({ id: "unused", lastActiveAt: 0 }),
    // Delegating rather than capturing, because this object is built ONCE (see
    // `stableSource`) while the fakes are replaced per test.
    hydrate: (id) => hydrate(id),
    list: () => [],
    pendingInterrupts: (id, signal) => pendingInterrupts(id, signal),
    touch: () => {},
  }
}

/**
 * ONE source for every render.
 *
 * Its identity has to be stable: `HydratedInterrupts` re-reads the parked
 * gates whenever the source changes, so a fresh object per render would
 * re-issue that read on every commit and clear the list each time. `page.tsx`
 * holds the real one in `useState`, so the app has the same guarantee.
 */
const stableSource = threadSource()

/**
 * The shell under React's StrictMode, which is what the app ACTUALLY runs in.
 *
 * Next 16's App Router enables StrictMode by default and this app sets no
 * `reactStrictMode` key, so dev double-invokes every effect
 * (setup -> cleanup -> setup). Every other test in this file renders without
 * it, which is why the probe's mounted-flag latch survived them all.
 */
function renderStrict(activeThreadId: string | undefined) {
  act(() => {
    root.render(
      <StrictMode>
        <AppShell
          threads={[]}
          activeThreadId={activeThreadId}
          onSelectThread={() => {}}
          onCreateThread={() => {}}
          onUserMessage={() => {}}
          threadSource={stableSource}
        />
      </StrictMode>,
    )
  })
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
        threadSource={stableSource}
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

/**
 * Wait for a hydrate to be applied: by default the one the shell issued last,
 * or the specific promise a test passes, then let React apply
 * whatever it did with the result.
 *
 * It awaits the seam's OWN promise rather than counting microtask ticks: a
 * fixed number of ticks encodes how many `await`s the implementation happens
 * to have, so adding one inside `applyRestored` would red every test here at
 * once for no behavioral reason. A test with more than one hydrate in flight
 * must name the one it just settled — awaiting the latest would block on a
 * promise it never intends to resolve, and a hung `act` corrupts the act
 * environment for every test after it (which is how this helper first went
 * wrong: one 5s timeout, three red tests). The short tick loop after it only covers
 * React's own scheduling, and `allSettled` keeps a rejecting hydrate (a case
 * under test) from failing the helper instead of the assertion.
 */
async function settleHydration(hydration?: Promise<unknown>) {
  const issued = hydration ?? (hydrate.mock.results.at(-1)?.value as Promise<unknown> | undefined)
  await act(async () => {
    await Promise.allSettled([issued])
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.agent = makeAgent()
  // The default: every thread is empty, which is what the pre-existing
  // switch-reset tests below assume (the shell leaves the agent alone).
  hydrate = vi.fn(async () => ({ messages: [], todos: [] }))
  // The default: nothing is parked, which is what every pre-existing test here
  // assumes (no hydrated card, no composer block from that source).
  pendingInterrupts = vi.fn(async () => [])
  mocks.runAgent = async () => {}
  // The default: the probe reports Dawn up, which is what every pre-existing
  // test here assumes (the normal shell, not the connect screen). Tests
  // under "app shell connect screen" below override this per case.
  // A real empty-candidates body, not a bare 200 with no body: the probe only
  // reads the status, but the rail's `MemoryPanel` reads this same route and
  // parses it, and feeding it an unparseable success would put its "couldn't
  // load" line into every test in this file for no reason.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ candidates: [] })),
  )
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
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
    await settleHydration()
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
    expect(container.textContent).toContain(RESTORED_HISTORY_NOTICE)
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
    await settleHydration()
    expect(mocks.agent.setMessagesArgs.at(-1)).toEqual(RESTORED.messages)
  })

  test("treats an empty thread as normal: no messages applied, no error", async () => {
    render(undefined)
    render("thread-a")
    await settleHydration()
    expect(mocks.agent.messages).toEqual([])
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain(RESTORED_HISTORY_NOTICE)
  })

  test("surfaces a failed hydrate as a run error", async () => {
    hydrate = vi.fn(async () => {
      throw new Error("Could not load this conversation (HTTP 500).")
    })
    render(undefined)
    render("thread-a")
    await settleHydration()
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
    await settleHydration(first.promise)
    expect(mocks.agent.setMessagesCalls).toBe(clearsSoFar)
    expect(mocks.agent.messages).toEqual([])
    expect(container.textContent).not.toContain(RESTORED_HISTORY_NOTICE)
    // B's own answer still applies, so the guard is not simply refusing all.
    second.resolve({ messages: [{ content: "b", id: "b1", role: "user" }], todos: [] })
    await settleHydration(second.promise)
    expect(mocks.agent.messages).toEqual([{ content: "b", id: "b1", role: "user" }])
  })

  test("does not overwrite a message the user typed while the history loaded", async () => {
    const pending = deferred<HydratedThread>()
    hydrate = vi.fn(() => pending.promise)
    render(undefined)
    render("thread-a")
    // The composer is live the whole time a hydrate is in flight, and this is
    // what the user doing something with it looks like on the same agent
    // instance: `addMessage` pushes, and a run may already be attached.
    const typed = { content: "start over", id: "typed-1", role: "user" }
    mocks.agent.messages.push(typed)
    const appliedBefore = mocks.agent.setMessagesArgs.length
    pending.resolve(RESTORED)
    await settleHydration()
    expect(mocks.agent.setMessagesArgs.length).toBe(appliedBefore)
    expect(mocks.agent.messages).toEqual([typed])
    expect(container.textContent).not.toContain(RESTORED_HISTORY_NOTICE)
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
    await settleHydration()
    expect(swapped.messages).toEqual([{ content: "late", id: "l1", role: "user" }])
    // The replacement instance was never cleared by the switch effect, so its
    // leftover parked interrupt would otherwise make the next run throw.
    expect(swapped.pendingInterrupts).toEqual([])
  })
})

/**
 * The half of the reload feature that is not the card.
 *
 * A restored permission prompt with a LIVE composer under it is worse than no
 * prompt at all: `agent.pendingInterrupts` is empty after a reload, so the
 * shell has nothing to block on, and sending starts a fresh run with no
 * resume against a parked checkpoint — `Thread has N pending interrupt(s) not
 * addressed by resume`, thrown after the user's message is already in the
 * transcript. This is the whole path, from the seam's answer to the composer's
 * own state, because every layer in between is a prop hand-off that a type
 * checker is happy to see wired to nothing.
 */
describe("app shell composer block for restored gates", () => {
  const PARKED = {
    interruptId: "perm-1",
    metadata: {
      detail: { argsPreview: "{}", suggestedPattern: "deployProd", toolName: "deployProd" },
      kind: "tool",
    },
  }

  function composer(): HTMLTextAreaElement {
    const found = container.querySelector("textarea")
    if (found === null) throw new Error("no composer")
    return found
  }

  async function settleParked() {
    await act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
    })
  }

  test("blocks the composer while the server holds a gate this browser never saw", async () => {
    pendingInterrupts = vi.fn(async () => [PARKED])
    render(undefined)
    render("thread-a")
    await settleParked()
    // The card is back...
    expect(container.textContent).toContain("Permission required")
    expect(container.textContent).toContain("deployProd")
    // ...and so is the reason the composer is inert. `readOnly`, not
    // `disabled`, so a half-typed draft stays reachable.
    expect(composer().readOnly).toBe(true)
    expect(composer().getAttribute("aria-disabled")).toBe("true")
    expect(composer().placeholder).toBe("Waiting on your decision above…")
    expect(container.textContent).toContain("Allow or deny the request above to continue")
    // The agent itself still reports nothing pending — which is exactly why
    // the count has to travel up from the hydrated source.
    expect(mocks.agent.pendingInterrupts).toEqual([])
  })

  test("unblocks it once the gate is answered", async () => {
    let call = 0
    pendingInterrupts = vi.fn(async () => {
      call += 1
      return call === 1 ? [PARKED] : []
    })
    render(undefined)
    render("thread-a")
    await settleParked()
    expect(composer().readOnly).toBe(true)
    const allow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow once",
    )
    act(() => {
      allow?.click()
    })
    await settleParked()
    expect(container.textContent).not.toContain("Permission required")
    expect(composer().readOnly).toBe(false)
    expect(composer().placeholder).toBe("Ask the research agent…")
  })

  test("leaves the composer alone when nothing is parked", async () => {
    // Cleared explicitly: `makeAgent()` seeds a LIVE pending interrupt for the
    // switch-reset tests above, and the shell's thread switch clears it from
    // an effect — so without this the composer is legitimately blocked by the
    // other source, and this test would prove nothing about its own.
    mocks.agent.pendingInterrupts = []
    render(undefined)
    render("thread-a")
    await settleParked()
    expect(composer().readOnly).toBe(false)
    expect(container.textContent).not.toContain("Permission required")
  })
})

/**
 * The predicate under test here is a real probe through the proxy
 * (`GET /api/dawn/memory/candidates`), not `useCopilotKit().runtimeConnectionStatus`
 * — that read looked right and was proven wrong live: `/api/copilotkit`'s
 * `/info` handler runs in the SAME Next process as the page and answers 200
 * without ever contacting Dawn, so it stayed `"connected"` with Dawn
 * completely down. `global.fetch` is stubbed per test (see `beforeEach`
 * above for the default "up" case) rather than the CopilotKit mock, because
 * the probe calls `fetch` directly — see `probeDawnServer` in `AppShell.tsx`.
 *
 * `SERVER_PROBE_INTERVAL_MS_FOR_TESTS` mirrors the module-private constant of
 * the same value in `AppShell.tsx`; it is not exported, so this is the one
 * place that number is duplicated, and a future change to it needs both
 * updated together.
 */
const SERVER_PROBE_INTERVAL_MS_FOR_TESTS = 5000

/** Flushes the microtask queue so a resolved `fetch`/`hydrate` promise's `.then` has run. */
async function flushMicrotasks() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
  })
}

function fetchMock(): Mock<(input: unknown) => Promise<Response>> {
  return globalThis.fetch as unknown as Mock<(input: unknown) => Promise<Response>>
}

describe("app shell connect screen", () => {
  test("shows the connect screen once the probe reports the proxy's cannot-reach 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 502 })),
    )
    render("thread-a")
    await flushMicrotasks()
    expect(container.textContent).toContain(CONNECT_SCREEN_HEADING)
    // The whole shell is gone with it — no rail, no composer.
    expect(container.querySelector("textarea")).toBeNull()
  })

  test("does NOT show the connect screen while the first probe is still in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    )
    render("thread-a")
    await flushMicrotasks()
    expect(container.textContent).not.toContain(CONNECT_SCREEN_HEADING)
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  test("renders the normal shell once the probe reports up", async () => {
    render("thread-a")
    await flushMicrotasks()
    expect(container.textContent).not.toContain(CONNECT_SCREEN_HEADING)
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  test("flips to the connect screen when a live hydrate hits the dead proxy, without a run-error row", async () => {
    // The probe is left pending (never resolves) so ONLY the hydrate
    // rejection decides `serverStatus` here — this is the OTHER path to
    // "down": a real hydrate request hitting the dead proxy before the probe
    // itself gets an answer either way.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    )
    hydrate = vi.fn(async () => {
      throw new Error(
        "Could not load this conversation (HTTP 502): Cannot reach the Dawn server at http://127.0.0.1:3002: ECONNREFUSED",
      )
    })
    render(undefined)
    render("thread-a")
    await flushMicrotasks()
    expect(container.textContent).toContain(CONNECT_SCREEN_HEADING)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  test("keeps a genuine non-502 hydrate failure on the run-error row, not the connect screen", async () => {
    hydrate = vi.fn(async () => {
      throw new Error("Could not load this conversation (HTTP 500): boom")
    })
    render(undefined)
    render("thread-a")
    await flushMicrotasks()
    expect(container.textContent).not.toContain(CONNECT_SCREEN_HEADING)
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("Could not restore this conversation")
  })

  test("polls every ~5s while down, and recovery restores the shell AND re-hydrates the active thread", async () => {
    vi.useFakeTimers()
    // A flag rather than a call counter — the probe shares this route with the
    // rail's `MemoryPanel`, so "the first fetch" and "the first probe" are no
    // longer the same request.
    let isDown = true
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        isDown ? new Response(null, { status: 502 }) : Response.json({ candidates: [] }),
      ),
    )
    // The first hydrate genuinely fails the same way the real fetch inside it
    // would while Dawn is actually down — this is the request that never
    // gets a natural retry (see `reportHydrateFailure`'s
    // `isProxyUnreachableError` branch) and that recovery has to reissue. The
    // second call is what a live server answers once it is back.
    let hydrateCall = 0
    hydrate = vi.fn(async () => {
      hydrateCall += 1
      if (hydrateCall === 1) {
        throw new Error(
          "Could not load this conversation (HTTP 502): Cannot reach the Dawn server at http://127.0.0.1:3002: ECONNREFUSED",
        )
      }
      return { messages: [{ content: "recovered", id: "r1", role: "user" }], todos: [] }
    })
    render(undefined)
    render("thread-a")
    await flushMicrotasks()
    expect(container.textContent).toContain(CONNECT_SCREEN_HEADING)
    expect(hydrate).toHaveBeenCalledTimes(1)
    // 1, not 0: the thread-switch-to-"thread-a" clear step (`agent.setMessages([])`)
    // ran before the (failed) hydrate — this is not the restore itself.
    expect(mocks.agent.setMessagesCalls).toBe(1)

    isDown = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVER_PROBE_INTERVAL_MS_FOR_TESTS)
    })
    await flushMicrotasks()

    expect(fetchMock().mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).not.toContain(CONNECT_SCREEN_HEADING)
    expect(container.querySelector("textarea")).not.toBeNull()
    // MUTATION CHECK for the recovery-triggers-rehydrate wiring: if
    // `AppShell`'s down→up effect stopped bumping `hydrateNonce` (or the
    // thread-switch effect stopped reading it), `hydrate` would still show
    // exactly 1 call and the two assertions below would red.
    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(mocks.agent.setMessagesCalls).toBe(2)
    expect(mocks.agent.messages).toEqual([{ content: "recovered", id: "r1", role: "user" }])
  })

  test("the retry button re-probes immediately, without waiting for the interval", async () => {
    // A flag, not a call counter: the probe is no longer the only caller of
    // this route — the rail's `MemoryPanel` reads it too — so "the Nth fetch"
    // is not the same thing as "the Nth probe", and counting made this test
    // pass or fail on mount ordering.
    let isDown = true
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        isDown ? new Response(null, { status: 502 }) : Response.json({ candidates: [] }),
      ),
    )
    render("thread-a")
    await flushMicrotasks()
    expect(container.textContent).toContain(CONNECT_SCREEN_HEADING)
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )
    expect(retry).not.toBeUndefined()
    isDown = false
    act(() => {
      retry?.click()
    })
    await flushMicrotasks()
    expect(container.textContent).not.toContain(CONNECT_SCREEN_HEADING)
  })

  test("shows the connect screen under StrictMode, which is what dev actually runs", async () => {
    // MUTATION EVIDENCE: this test is red against a `isMountedRef` whose only
    // write is `= false` in a cleanup. StrictMode's second setup finds the
    // flag already latched false, every `setServerStatus` from a probe is
    // dropped, `serverStatus` stays "checking" forever, and the shell renders
    // normally with Dawn completely down — the exact outage this screen
    // exists to prevent, visible only in dev.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 502 })),
    )
    renderStrict("thread-a")
    await flushMicrotasks()
    expect(container.textContent).toContain(CONNECT_SCREEN_HEADING)
  })

  test("stops probing once the component unmounts", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 502 })),
    )
    // A dedicated root: the shared one from `beforeEach` is unmounted again
    // in `afterEach`, and unmounting twice would throw.
    const localContainer = document.createElement("div")
    document.body.append(localContainer)
    const localRoot = createRoot(localContainer)
    act(() => {
      localRoot.render(
        <AppShell
          threads={[]}
          activeThreadId="thread-a"
          onSelectThread={() => {}}
          onCreateThread={() => {}}
          onUserMessage={() => {}}
          threadSource={stableSource}
        />,
      )
    })
    await flushMicrotasks()
    const callsBeforeUnmount = fetchMock().mock.calls.length
    expect(callsBeforeUnmount).toBeGreaterThan(0)
    act(() => {
      localRoot.unmount()
    })
    localContainer.remove()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SERVER_PROBE_INTERVAL_MS_FOR_TESTS * 2)
    })
    expect(fetchMock().mock.calls.length).toBe(callsBeforeUnmount)
  })
})
