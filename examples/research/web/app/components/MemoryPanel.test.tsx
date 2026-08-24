// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest"

/**
 * The memory panel, in two halves.
 *
 * The pure `MemoryPanelView` is rendered with `renderToStaticMarkup` — it takes
 * props and nothing else, so every branch it has (empty, populated, over the
 * cap, busy, outcome, failed read) is assertable without a DOM.
 *
 * The container is mounted over a fake agent in jsdom, because its wiring is
 * the part that can silently be wrong: the three URLs, the `POST`s that must
 * carry NO body, the re-read after every decision, and the run-finished
 * subscription that is the only reason a memory proposed mid-run shows up
 * without a reload. `fetch` is stubbed rather than the proxy route, since the
 * URL is exactly what is under test here.
 *
 * The whole file runs in jsdom (a single `@vitest-environment` applies per
 * file); `renderToStaticMarkup` is indifferent to that.
 */
const mocks = vi.hoisted(() => ({
  agent: null as unknown as FakeAgent,
}))

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mocks.agent, isReady: true }),
}))

const {
  DECISION_FAILURE_NOTICE,
  LOAD_FAILURE_NOTICE,
  MemoryPanel,
  MemoryPanelView,
  OUTCOME_LIFETIME_MS,
  describeApprove,
} = await import("./MemoryPanel")
type MemoryCandidate = import("./MemoryPanel").MemoryCandidate

const noop = () => {}

const CANDIDATE: MemoryCandidate = {
  id: "cand-1",
  content: "Prefers concise, cited reports.",
  namespace: "default",
  confidence: 0.8,
}

const SECOND: MemoryCandidate = {
  id: "cand-2",
  content: "Works in UTC.",
  namespace: "profile",
}

function render(props: Partial<Parameters<typeof MemoryPanelView>[0]> = {}): string {
  return renderToStaticMarkup(
    <MemoryPanelView
      candidates={[CANDIDATE]}
      onApprove={noop}
      onReject={noop}
      isBusy={false}
      outcome={null}
      loadFailure={null}
      {...props}
    />,
  )
}

/**
 * The visible text of a markup fragment.
 *
 * Collects the `<`-free runs after each `>` rather than stripping tags with a
 * `replace`, which is what CodeQL flags as
 * `js/incomplete-multi-character-sanitization`. Same approach as
 * `ThreadRail.test.tsx`.
 */
function visibleText(fragment: string): string {
  return Array.from(fragment.matchAll(/>([^<]*)/g), (match) => match[1] ?? "").join("")
}

/** How many `<button>`s carry the `disabled` attribute. */
function disabledButtonCount(markup: string): number {
  return markup.split('disabled=""').length - 1
}

describe("memory panel view", () => {
  test("renders a candidate's content and its namespace", () => {
    const text = visibleText(render())
    expect(text).toContain("Prefers concise, cited reports.")
    expect(text).toContain("default")
  })

  test("heads the section with the true total, not the number of rows shown", () => {
    const many = [CANDIDATE, SECOND, { ...SECOND, id: "c3" }, { ...SECOND, id: "c4" }]
    const markup = render({ candidates: many })
    const text = visibleText(markup)
    expect(text).toContain("Memory · 4")
    // Bounded by content rather than by a second scroll region in a 256px
    // rail — the fourth is counted, not listed.
    expect(markup.split("<li").length - 1).toBe(3)
    expect(text).toContain("1 more not shown")
  })

  test("offers both decisions, and names the destructive one after its effect", () => {
    const text = visibleText(render())
    // "Delete", not "Reject": the endpoint is `…/reject` but it hard-deletes,
    // and there is no undo. The footnote says so in words.
    expect(text).toContain("Approve")
    expect(text).toContain("Delete")
    expect(text).toContain("Deleting is permanent")
    expect(disabledButtonCount(render())).toBe(0)
  })

  test("disables both actions on every row while a decision is in flight", () => {
    const markup = render({ candidates: [CANDIDATE, SECOND], isBusy: true })
    // Four buttons, all disabled — including the untouched row's, because the
    // list is about to be re-read and a second click would act on a list
    // already known to be stale.
    expect(markup.split("<button").length - 1).toBe(4)
    expect(disabledButtonCount(markup)).toBe(4)
  })

  test("renders NOTHING at all when there is nothing to review", () => {
    // The resting state of most sessions. A permanent empty box in the rail is
    // a permanent suggestion that something is missing.
    expect(render({ candidates: [] })).toBe("")
  })

  test("shows the superseded outcome even after the last candidate is gone", () => {
    // The case that makes the outcome worth having: approving the only
    // candidate empties the list, so anchoring the message to the list would
    // swallow exactly the outcome the panel exists to surface.
    const text = visibleText(render({ candidates: [], outcome: "Replaced 1 earlier memory." }))
    expect(text).toContain("Replaced 1 earlier memory.")
  })

  test("the outcome replaces the footnote while it is showing", () => {
    const text = visibleText(render({ outcome: "Replaced 2 earlier memories." }))
    expect(text).toContain("Replaced 2 earlier memories.")
    expect(text).not.toContain("Deleting is permanent")
  })

  test("a decision that failed says the candidate is unchanged", () => {
    const text = visibleText(render({ outcome: DECISION_FAILURE_NOTICE }))
    expect(text).toContain("nothing changed")
  })

  test("a failed read is a quiet line, never an alert row", () => {
    const markup = render({ candidates: [], loadFailure: LOAD_FAILURE_NOTICE })
    expect(visibleText(markup)).toContain(LOAD_FAILURE_NOTICE)
    // A background read of a review queue failing is not a conversation
    // failure. `RunError` is the alert surface; this is not that — and
    // `AppShell.test.tsx` asserts the shell has no `[role="alert"]` in
    // states where a stray one here would break it.
    expect(markup).not.toContain('role="alert"')
  })
})

describe("describing an approve", () => {
  test("counts what was replaced, singular and plural", () => {
    expect(describeApprove("superseded", 1)).toBe("Replaced 1 earlier memory.")
    expect(describeApprove("superseded", 3)).toBe("Replaced 3 earlier memories.")
  })

  test("says nothing for a plain activation — the row disappearing is the feedback", () => {
    expect(describeApprove("activated", 0)).toBeNull()
  })

  test("a dedupe is worth a word, because nothing visibly changed", () => {
    expect(describeApprove("deduped", 0)).toBe("Already remembered — nothing changed.")
  })

  test("a superseded action with an empty list is treated as a plain activation", () => {
    // Defensive: the server sends the pre-write snapshot, so this shape should
    // not occur — but "Replaced 0 earlier memories" is worse than silence.
    expect(describeApprove("superseded", 0)).toBeNull()
  })
})

interface FakeAgent {
  subscribe: (subscriber: { onRunFinishedEvent?: () => void }) => { unsubscribe: () => void }
}

/** The subscribers the fake agent is currently holding. */
let subscribers: { onRunFinishedEvent?: () => void }[]

let container: HTMLDivElement
let root: Root

function fetchMock(): Mock<(input: unknown, init?: RequestInit) => Promise<Response>> {
  return globalThis.fetch as unknown as Mock<
    (input: unknown, init?: RequestInit) => Promise<Response>
  >
}

/** A `fetch` that answers each call from a queue, repeating the last answer. */
function answering(...answers: (() => Response)[]) {
  let call = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const answer = answers[Math.min(call, answers.length - 1)]
      call += 1
      return answer === undefined ? Response.json({ candidates: [] }) : answer()
    }),
  )
}

const listing = (candidates: readonly MemoryCandidate[]) => () => Response.json({ candidates })

/** Flushes the microtask queue so a resolved `fetch`'s `.then` chain has run. */
async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  })
}

function mount() {
  act(() => {
    root.render(<MemoryPanel />)
  })
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  )
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found
}

/** Every URL `fetch` was called with, in order. */
function urls(): string[] {
  return fetchMock().mock.calls.map((call) => String(call[0]))
}

describe("memory panel container", () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    subscribers = []
    mocks.agent = {
      subscribe: (subscriber) => {
        subscribers.push(subscriber)
        return {
          unsubscribe: () => {
            subscribers = subscribers.filter((entry) => entry !== subscriber)
          },
        }
      },
    }
    answering(listing([]))
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
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test("reads the allowlisted candidates route on mount and renders what it gets", async () => {
    answering(listing([CANDIDATE]))
    mount()
    await settle()
    expect(urls()[0]).toBe("/api/dawn/memory/candidates")
    expect(container.textContent).toContain("Prefers concise, cited reports.")
  })

  test("renders nothing for the empty answer, which is the normal case", async () => {
    mount()
    await settle()
    expect(container.textContent).toBe("")
  })

  test("approving POSTs the id with no body, then re-reads the list", async () => {
    answering(
      listing([CANDIDATE]),
      () => Response.json({ record: {}, action: "activated", superseded: [] }),
      listing([]),
    )
    mount()
    await settle()
    act(() => {
      buttonNamed("Approve").click()
    })
    await settle()
    expect(urls()[1]).toBe("/api/dawn/memory/candidates/cand-1/approve")
    // No body at all: the endpoint takes none, and sending one would be a
    // shape the server never agreed to.
    expect(fetchMock().mock.calls[1]?.[1]).toEqual({ method: "POST" })
    expect(urls()[2]).toBe("/api/dawn/memory/candidates")
    expect(container.textContent).toBe("")
  })

  test("surfaces a supersede rather than swallowing it", async () => {
    answering(
      listing([CANDIDATE]),
      () => Response.json({ record: {}, action: "superseded", superseded: [{ id: "old" }] }),
      listing([]),
    )
    mount()
    await settle()
    act(() => {
      buttonNamed("Approve").click()
    })
    await settle()
    // The list is empty now — the message survives it, which is the whole
    // point of it not being anchored to a row.
    expect(container.textContent).toContain("Replaced 1 earlier memory.")
  })

  test("the outcome line expires rather than sitting in the rail forever", async () => {
    vi.useFakeTimers()
    answering(
      listing([CANDIDATE]),
      () => Response.json({ record: {}, action: "superseded", superseded: [{ id: "old" }] }),
      listing([]),
    )
    mount()
    await settle()
    act(() => {
      buttonNamed("Approve").click()
    })
    await settle()
    expect(container.textContent).toContain("Replaced 1 earlier memory.")
    act(() => {
      vi.advanceTimersByTime(OUTCOME_LIFETIME_MS)
    })
    expect(container.textContent).toBe("")
  })

  test("deleting POSTs the reject route and says nothing on success", async () => {
    answering(listing([CANDIDATE]), () => Response.json({ ok: true }), listing([]))
    mount()
    await settle()
    act(() => {
      buttonNamed("Delete").click()
    })
    await settle()
    expect(urls()[1]).toBe("/api/dawn/memory/candidates/cand-1/reject")
    expect(fetchMock().mock.calls[1]?.[1]).toEqual({ method: "POST" })
    expect(container.textContent).toBe("")
  })

  test("a failed decision leaves the candidate on screen and says so", async () => {
    answering(listing([CANDIDATE]), () => new Response(null, { status: 500 }), listing([CANDIDATE]))
    mount()
    await settle()
    act(() => {
      buttonNamed("Approve").click()
    })
    await settle()
    expect(container.textContent).toContain(DECISION_FAILURE_NOTICE)
    expect(container.textContent).toContain("Prefers concise, cited reports.")
  })

  test("re-reads when a run finishes, so a memory proposed mid-run appears", async () => {
    // The behavior the old component had and the reason it subscribed at all:
    // `remember()` writes during the run, and nothing else would ask again
    // until the page reloaded.
    answering(listing([]), listing([CANDIDATE]))
    mount()
    await settle()
    expect(container.textContent).toBe("")
    act(() => {
      for (const subscriber of subscribers) subscriber.onRunFinishedEvent?.()
    })
    await settle()
    expect(container.textContent).toContain("Prefers concise, cited reports.")
  })

  test("unsubscribes on unmount", async () => {
    mount()
    await settle()
    expect(subscribers).toHaveLength(1)
    act(() => {
      root.unmount()
    })
    expect(subscribers).toHaveLength(0)
    // The afterEach unmount is now a second one; give it a live root.
    act(() => {
      root = createRoot(container)
    })
  })

  test("stays silent about the proxy's 502, which the connect screen owns", async () => {
    // `AppShell`'s probe reads this same route and is about to replace the
    // whole shell with `ConnectScreen`. A second "couldn't load" line in the
    // rail for the same fact is a competing error surface.
    answering(() => new Response(null, { status: 502 }))
    mount()
    await settle()
    expect(container.textContent).toBe("")
  })

  test("a read that fails for any other reason is one quiet line", async () => {
    answering(() => new Response(null, { status: 500 }))
    mount()
    await settle()
    expect(container.textContent).toContain(LOAD_FAILURE_NOTICE)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  test("an answer that lands after a newer read started does not paint", async () => {
    // The shape of a slow first read overtaken by the re-read a decision
    // fires — that one owns no abort signal, so the ticket is what makes the
    // stale answer harmless.
    let releaseFirst!: (response: Response) => void
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1
        if (call === 1) return new Promise<Response>((resolve) => (releaseFirst = resolve))
        return Response.json({ candidates: [] })
      }),
    )
    mount()
    await settle()
    // The run-finished re-read starts (and finishes) while the first is held.
    act(() => {
      for (const subscriber of subscribers) subscriber.onRunFinishedEvent?.()
    })
    await settle()
    act(() => {
      releaseFirst(Response.json({ candidates: [CANDIDATE] }))
    })
    await settle()
    expect(container.textContent).toBe("")
  })
})

/**
 * NOT covered here, and worth stating rather than implying:
 *
 * - the proxy route itself. Which paths are legal is `proxy-allowlist.test.ts`,
 *   and what the Dawn server does with an approve is `@dawn-ai/memory`'s.
 * - the real `AgentSubscriber` contract. The fake agent's `subscribe` accepts
 *   an `onRunFinishedEvent` because `@ag-ui/client@0.0.57` defines one; that
 *   the installed client actually calls it is a typecheck-and-live-run fact,
 *   not something these tests observe.
 * - anything visual. Whether three clamped candidates plus the thread list fit
 *   in a `w-64` rail is a browser question, and this app has no browser lane.
 * - `AppShell` mounting the panel. `AppShell.test.tsx` renders it incidentally
 *   against an empty-candidates stub, which proves the panel does not break
 *   the shell, not that the rail places it well.
 */
