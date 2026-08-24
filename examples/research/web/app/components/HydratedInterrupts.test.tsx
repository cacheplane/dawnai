// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The second source of permission gates, mounted over a fake agent.
 *
 * A fake is justified here for the same reason it is in `AppShell.test.tsx`:
 * the contract under test is OUR component's behavior against two library
 * values it only reads — `agent.isRunning` and `agent.pendingInterrupts` — and
 * neither is reachable from a pure layer. What the tests are really guarding
 * is the no-double-render rule. The bug it prevents is invisible to every
 * gate: the live card and the hydrated card render the same interrupt side by
 * side, two identical "Allow once" buttons, and answering one leaves the other
 * pointing at an interrupt the server has already resumed.
 */
const mocks = vi.hoisted(() => ({
  agent: null as unknown as FakeAgent,
  runAgent: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mocks.agent, isReady: true }),
  useCopilotKit: () => ({ copilotkit: { runAgent: mocks.runAgent } }),
}))

const { HydratedInterrupts } = await import("./HydratedInterrupts")

interface FakeAgent {
  isRunning: boolean
  pendingInterrupts: { id: string }[]
}

const PARKED = {
  interruptId: "perm-1",
  type: "permission-request",
  kind: "tool",
  detail: { toolName: "deployProd", argsPreview: "{}", suggestedPattern: "deployProd" },
}

const SECOND = {
  interruptId: "perm-2",
  type: "permission-request",
  kind: "command",
  detail: { command: "rm -rf build", suggestedPattern: "rm *" },
}

function body(...values: unknown[]) {
  return {
    interrupts: values.map((value) => ({
      interruptId: (value as { interruptId: string }).interruptId,
      resumeKey: null,
      value,
    })),
  }
}

/** A `fetch` that answers with a JSON body, or a bare status. */
function respondWith(...answers: ({ status: number } | { json: unknown })[]) {
  let call = 0
  // The url parameter is declared, unused, so `mock.calls` is typed as a
  // one-element tuple and a test can assert on the path that was requested.
  return vi.fn(async (url: RequestInfo | URL) => {
    void url
    const answer = answers[Math.min(call, answers.length - 1)]
    call += 1
    if (answer !== undefined && "status" in answer) {
      return { ok: false, status: answer.status, json: async () => ({}) } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => (answer as { json: unknown }).json,
    } as unknown as Response
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.agent = { isRunning: false, pendingInterrupts: [] }
  mocks.runAgent = vi.fn(async () => ({ result: undefined, newMessages: [] }))
  container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

function render(threadId: string | undefined, fetchFn: typeof fetch, onError = () => {}) {
  act(() => {
    root.render(<HydratedInterrupts threadId={threadId} onError={onError} fetchFn={fetchFn} />)
  })
}

/**
 * Let the fetch (and React's response to it) settle.
 *
 * A tick loop rather than awaiting the fetch's own promise: the component owns
 * the promise, not the test, and the fake resolves immediately — so the only
 * thing being waited on is React's scheduling.
 */
async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve()
  })
}

function cards() {
  return [...container.querySelectorAll('[role="alert"]')]
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  )
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

describe("HydratedInterrupts", () => {
  test("renders a card for a parked interrupt", async () => {
    const fetchFn = respondWith({ json: body(PARKED) })
    render("thread-a", fetchFn as unknown as typeof fetch)
    await settle()
    expect(fetchFn.mock.calls[0]?.[0]).toBe("/api/dawn/threads/thread-a/pending_interrupts")
    expect(cards()).toHaveLength(1)
    expect(container.textContent).toContain("Permission required")
    expect(container.textContent).toContain("deployProd")
  })

  test("renders nothing for the empty answer, which is the normal case", async () => {
    render("thread-a", respondWith({ json: { interrupts: [] } }) as unknown as typeof fetch)
    await settle()
    expect(cards()).toHaveLength(0)
    expect(container.textContent).toBe("")
  })

  test.each([404, 409, 403, 502])("renders nothing on HTTP %i", async (status) => {
    render("thread-a", respondWith({ status }) as unknown as typeof fetch)
    await settle()
    expect(cards()).toHaveLength(0)
  })

  test("renders nothing when the network fails outright", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    render("thread-a", fetchFn as unknown as typeof fetch)
    await settle()
    expect(cards()).toHaveLength(0)
  })

  test("never fetches without a thread", async () => {
    const fetchFn = respondWith({ json: body(PARKED) })
    render(undefined, fetchFn as unknown as typeof fetch)
    await settle()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(cards()).toHaveLength(0)
  })

  // The no-double-render rule, both halves. Each of these is a state the app
  // actually reaches, and in each of them the live source is the one rendering
  // (or about to render) the interrupt.
  test("suppresses an interrupt the live source is already holding", async () => {
    mocks.agent.pendingInterrupts = [{ id: "perm-1" }]
    render("thread-a", respondWith({ json: body(PARKED) }) as unknown as typeof fetch)
    await settle()
    expect(cards()).toHaveLength(0)
  })

  test("still shows the interrupts the live source is NOT holding", async () => {
    mocks.agent.pendingInterrupts = [{ id: "perm-1" }]
    render("thread-a", respondWith({ json: body(PARKED, SECOND) }) as unknown as typeof fetch)
    await settle()
    expect(cards()).toHaveLength(1)
    expect(container.textContent).toContain("rm -rf build")
    expect(container.textContent).not.toContain("deployProd")
  })

  test("suppresses everything while a run is in flight", async () => {
    mocks.agent.isRunning = true
    render("thread-a", respondWith({ json: body(PARKED, SECOND) }) as unknown as typeof fetch)
    await settle()
    expect(cards()).toHaveLength(0)
  })

  test("resumes through runAgent with a resolved entry naming the interrupt", async () => {
    render("thread-a", respondWith({ json: body(PARKED) }) as unknown as typeof fetch)
    await settle()
    act(() => {
      buttonNamed("Allow always").click()
    })
    await settle()
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent.mock.calls[0]?.[0]).toMatchObject({
      agent: mocks.agent,
      resume: [{ interruptId: "perm-1", payload: "always", status: "resolved" }],
    })
  })

  test("denial is a cancelled entry with no payload at all", async () => {
    render("thread-a", respondWith({ json: body(PARKED) }) as unknown as typeof fetch)
    await settle()
    act(() => {
      buttonNamed("Deny").click()
    })
    await settle()
    // The WHOLE argument, `toEqual` not `toMatchObject`: the dev runtime's
    // resume validator rejects a cancelled entry that carries any third key,
    // so a redundant `payload: "deny"` has to fail this assertion.
    expect(mocks.runAgent.mock.calls[0]?.[0]).toEqual({
      agent: mocks.agent,
      resume: [{ interruptId: "perm-1", status: "cancelled" }],
    })
  })

  test("re-fetches after a decision so a second gate becomes visible", async () => {
    const fetchFn = respondWith({ json: body(PARKED, SECOND) }, { json: body(SECOND) })
    render("thread-a", fetchFn as unknown as typeof fetch)
    await settle()
    expect(cards()).toHaveLength(2)
    act(() => {
      buttonNamed("Allow once").click()
    })
    await settle()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(cards()).toHaveLength(1)
    expect(container.textContent).toContain("rm -rf build")
  })

  test("a failed resume reaches the error surface rather than the console", async () => {
    const onError = vi.fn()
    mocks.runAgent = vi.fn(async () => {
      throw new Error("pending interrupt(s) not addressed by resume")
    })
    render("thread-a", respondWith({ json: body(PARKED) }) as unknown as typeof fetch, onError)
    await settle()
    act(() => {
      buttonNamed("Deny").click()
    })
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain("not addressed")
  })

  /**
   * Thread A's answer must never paint into thread B. The first fetch is held
   * open across the switch and then resolved — the shape of a slow server the
   * user got ahead of.
   */
  test("a response that lands after a thread switch does not paint", async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let call = 0
    const fetchFn = vi.fn(async () => {
      call += 1
      if (call === 1) {
        await first
        return {
          ok: true,
          status: 200,
          json: async () => body(PARKED),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ interrupts: [] }),
      } as unknown as Response
    })
    render("thread-a", fetchFn as unknown as typeof fetch)
    render("thread-b", fetchFn as unknown as typeof fetch)
    await settle()
    act(() => {
      releaseFirst()
    })
    await settle()
    expect(cards()).toHaveLength(0)
    expect(container.textContent).not.toContain("deployProd")
  })
})
