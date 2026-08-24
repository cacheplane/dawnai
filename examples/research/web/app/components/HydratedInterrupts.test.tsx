// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest"

/**
 * The second source of permission gates, mounted over a fake agent.
 *
 * A fake is justified here for the same reason it is in `AppShell.test.tsx`:
 * the contract under test is OUR component's behavior against three library
 * values it only reads — `agent.isRunning`, `agent.pendingInterrupts`, and
 * `copilotkit.runAgent` — and none is reachable from a pure layer. What the
 * tests are really guarding is the no-double-render rule. The bug it prevents
 * is invisible to every gate: the live card and the hydrated card render the
 * same interrupt side by side, two identical "Allow once" buttons, and
 * answering one leaves the other pointing at an interrupt the server has
 * already resumed.
 *
 * The BACKEND is stubbed at the `ThreadSource` seam, not at `fetch`: the URL,
 * the status handling and the body mapping are `thread-source`'s own tests.
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
type ThreadSource = import("../lib/thread-source").ThreadSource
type ParkedInterrupt = import("../lib/thread-source").ParkedInterrupt

interface FakeAgent {
  isRunning: boolean
  pendingInterrupts: { id: string }[]
}

const PARKED: ParkedInterrupt = {
  interruptId: "perm-1",
  metadata: {
    kind: "tool",
    detail: { toolName: "deployProd", argsPreview: "{}", suggestedPattern: "deployProd" },
  },
}

const SECOND: ParkedInterrupt = {
  interruptId: "perm-2",
  metadata: { kind: "command", detail: { command: "rm -rf build", suggestedPattern: "rm *" } },
}

let container: HTMLDivElement
let root: Root
let pendingInterrupts: Mock<(id: string, signal?: AbortSignal) => Promise<ParkedInterrupt[]>>

/** A source whose `pendingInterrupts` answers each call from a queue. */
function answering(...answers: ParkedInterrupt[][]) {
  let call = 0
  pendingInterrupts = vi.fn(async (_id: string, _signal?: AbortSignal) => {
    const answer = answers[Math.min(call, answers.length - 1)] ?? []
    call += 1
    return answer
  })
}

/**
 * ONE source object for the whole test, delegating to whatever
 * `pendingInterrupts` currently is.
 *
 * Its identity has to be stable across re-renders, because the component's
 * read effect depends on it — a fresh object per render would re-issue the
 * read and clear the list every time a test re-renders to observe something,
 * which is exactly what the app must not do (and `AppShell` holds its source
 * in `useState`, so it does not).
 */
const source: ThreadSource = {
  create: () => ({ id: "unused", lastActiveAt: 0 }),
  hydrate: async () => ({ messages: [], todos: [] }),
  list: () => [],
  pendingInterrupts: (id, signal) => pendingInterrupts(id, signal),
  touch: () => {},
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.agent = { isRunning: false, pendingInterrupts: [] }
  // The real `runAgent` flips `isRunning` for the duration of the run. The
  // fake does too, so nothing here depends on a run being instantaneous — but
  // OBSERVING the flip needs a re-render, which `useAgent` would provide and a
  // plain object cannot; the tests that care about it re-render explicitly.
  mocks.runAgent = vi.fn(async () => {
    mocks.agent.isRunning = true
    await Promise.resolve()
    mocks.agent.isRunning = false
    return { newMessages: [], result: undefined }
  })
  answering([])
  container = document.createElement("div")
  document.body.append(container)
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

function render(
  threadId: string | undefined,
  options: { onError?: (error: unknown) => void; onPendingChange?: (count: number) => void } = {},
) {
  act(() => {
    root.render(
      <HydratedInterrupts
        threadId={threadId}
        threadSource={source}
        onError={options.onError ?? (() => {})}
        onPendingChange={options.onPendingChange ?? (() => {})}
      />,
    )
  })
}

/**
 * Let the read (and React's response to it) settle.
 *
 * A tick loop rather than awaiting the seam's promise: the component owns that
 * promise, not the test, and the fake resolves immediately — so the only thing
 * being waited on is React's own scheduling.
 */
async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
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
  return found
}

describe("HydratedInterrupts", () => {
  test("renders a card for a parked interrupt", async () => {
    answering([PARKED])
    render("thread-a")
    await settle()
    expect(pendingInterrupts.mock.calls[0]?.[0]).toBe("thread-a")
    expect(cards()).toHaveLength(1)
    expect(container.textContent).toContain("Permission required")
    expect(container.textContent).toContain("deployProd")
  })

  test("renders nothing for the empty answer, which is the normal case", async () => {
    render("thread-a")
    await settle()
    expect(cards()).toHaveLength(0)
    expect(container.textContent).toBe("")
  })

  test("renders nothing when the read fails outright", async () => {
    pendingInterrupts = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    render("thread-a")
    await settle()
    expect(cards()).toHaveLength(0)
  })

  test("never reads without a thread", async () => {
    answering([PARKED])
    render(undefined)
    await settle()
    expect(pendingInterrupts).not.toHaveBeenCalled()
    expect(cards()).toHaveLength(0)
  })

  test("does not take the keyboard when a card appears", async () => {
    answering([PARKED])
    const typing = document.createElement("textarea")
    document.body.append(typing)
    typing.focus()
    render("thread-a")
    await settle()
    expect(cards()).toHaveLength(1)
    // The card arrives ~100ms after a page load, unbidden. Yanking the caret
    // out of the composer mid-sentence is WCAG 3.2.5; `role="alert"` is how it
    // announces itself instead.
    expect(document.activeElement).toBe(typing)
    typing.remove()
  })

  // The no-double-render rule, both halves. Each of these is a state the app
  // actually reaches, and in each of them the live source is the one rendering
  // (or about to render) the interrupt.
  test("suppresses an interrupt the live source is already holding", async () => {
    mocks.agent.pendingInterrupts = [{ id: "perm-1" }]
    answering([PARKED])
    render("thread-a")
    await settle()
    expect(cards()).toHaveLength(0)
  })

  test("still shows the interrupts the live source is NOT holding", async () => {
    // A SPLIT state, and worth being honest that it is not one the app reaches
    // at rest: a turn's gates all ship in one RUN_FINISHED, so the live source
    // normally holds either both or neither. The filter is written per-id
    // rather than as "is the live source holding anything" precisely so that
    // this stays a filter and not a mode — a backend that ever parked gates
    // one at a time would still render correctly.
    mocks.agent.pendingInterrupts = [{ id: "perm-1" }]
    answering([PARKED, SECOND])
    render("thread-a")
    await settle()
    expect(cards()).toHaveLength(1)
    expect(container.textContent).toContain("rm -rf build")
    expect(container.textContent).not.toContain("deployProd")
  })

  test("suppresses everything while a run it did not start is in flight", async () => {
    mocks.agent.isRunning = true
    answering([PARKED, SECOND])
    render("thread-a")
    await settle()
    expect(cards()).toHaveLength(0)
  })

  test("resumes through runAgent with a resolved entry naming the interrupt", async () => {
    answering([PARKED])
    render("thread-a")
    await settle()
    act(() => {
      buttonNamed("Allow always").click()
    })
    await settle()
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent.mock.calls[0]?.[0]).toEqual({
      agent: mocks.agent,
      resume: [{ interruptId: "perm-1", payload: "always", status: "resolved" }],
    })
  })

  test("denial is a cancelled entry with no payload at all", async () => {
    answering([PARKED])
    render("thread-a")
    await settle()
    act(() => {
      buttonNamed("Deny").click()
    })
    await settle()
    // The WHOLE argument, `toEqual` not `toMatchObject`. `resolvePendingResume`
    // ignores the payload on a cancelled entry, and the strict-key validator on
    // `POST /threads/:id/resume` rejects one that carries a third key — so a
    // redundant `payload: "deny"` has to fail this assertion.
    expect(mocks.runAgent.mock.calls[0]?.[0]).toEqual({
      agent: mocks.agent,
      resume: [{ interruptId: "perm-1", status: "cancelled" }],
    })
  })

  test("re-reads after a decision so a second gate becomes visible", async () => {
    answering([PARKED, SECOND], [SECOND])
    render("thread-a")
    await settle()
    expect(cards()).toHaveLength(2)
    act(() => {
      buttonNamed("Allow once").click()
    })
    await settle()
    expect(pendingInterrupts).toHaveBeenCalledTimes(2)
    expect(cards()).toHaveLength(1)
    expect(container.textContent).toContain("rm -rf build")
  })

  test("keeps the answered card on screen, dimmed, while the resume is in flight", async () => {
    answering([PARKED, SECOND])
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.runAgent = vi.fn(async () => {
      mocks.agent.isRunning = true
      await held
      mocks.agent.isRunning = false
      return { newMessages: [], result: undefined }
    })
    render("thread-a")
    await settle()
    act(() => {
      buttonNamed("Allow once").click()
    })
    await settle()
    // The re-render `useAgent` would give us when `isRunning` flips.
    render("thread-a")
    const open = cards()
    expect(open).toHaveLength(1)
    expect(open[0]?.getAttribute("aria-busy")).toBe("true")
    expect(open[0]?.textContent).toContain("deployProd")
    // Without this, the answered card vanishes at the click and focus falls to
    // <body> — and the other gate would flash back into view mid-resume.
    expect(container.textContent).not.toContain("rm -rf build")
    act(() => {
      release()
    })
    await settle()
  })

  test("a failed resume reaches the error surface rather than the console", async () => {
    const onError = vi.fn()
    mocks.runAgent = vi.fn(async () => {
      throw new Error("pending interrupt(s) not addressed by resume")
    })
    answering([PARKED])
    render("thread-a", { onError })
    await settle()
    act(() => {
      buttonNamed("Deny").click()
    })
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain("not addressed")
  })

  /**
   * Thread A's answer must never paint into thread B. The first read is held
   * open across the switch and then resolved — the shape of a slow server the
   * user got ahead of.
   */
  test("a response that lands after a thread switch does not paint", async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let call = 0
    pendingInterrupts = vi.fn(async () => {
      call += 1
      if (call === 1) {
        await first
        return [PARKED]
      }
      return []
    })
    render("thread-a")
    render("thread-b")
    await settle()
    act(() => {
      releaseFirst()
    })
    await settle()
    expect(cards()).toHaveLength(0)
    expect(container.textContent).not.toContain("deployProd")
  })

  describe("reporting the count up", () => {
    test("reports what it is showing, so the composer can block on it", async () => {
      const onPendingChange = vi.fn()
      answering([PARKED, SECOND])
      render("thread-a", { onPendingChange })
      await settle()
      expect(onPendingChange).toHaveBeenLastCalledWith(2)
    })

    test("reports the count the user can act on, not the raw list", async () => {
      // Suppressed by the live source: on screen it is zero cards, so the
      // composer must not be blocked on this source's behalf.
      const onPendingChange = vi.fn()
      mocks.agent.pendingInterrupts = [{ id: "perm-1" }]
      answering([PARKED])
      render("thread-a", { onPendingChange })
      await settle()
      expect(onPendingChange).toHaveBeenLastCalledWith(0)
    })

    test("reports zero once the gate is answered and gone", async () => {
      const onPendingChange = vi.fn()
      answering([PARKED], [])
      render("thread-a", { onPendingChange })
      await settle()
      expect(onPendingChange).toHaveBeenLastCalledWith(1)
      act(() => {
        buttonNamed("Allow once").click()
      })
      await settle()
      expect(onPendingChange).toHaveBeenLastCalledWith(0)
    })

    test("reports zero on unmount, so the block cannot outlive the card", async () => {
      const onPendingChange = vi.fn()
      answering([PARKED])
      render("thread-a", { onPendingChange })
      await settle()
      expect(onPendingChange).toHaveBeenLastCalledWith(1)
      act(() => {
        root.unmount()
      })
      expect(onPendingChange).toHaveBeenLastCalledWith(0)
      // The afterEach unmount is now a second one; give it a live root.
      act(() => {
        root = createRoot(container)
      })
    })
  })
})
