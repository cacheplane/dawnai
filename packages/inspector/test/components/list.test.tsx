import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"

const stats: MemoryStats = {
  total: 1,
  byStatus: { candidate: 1 },
  byKind: { semantic: 1 },
  byNamespace: { "route=/notes": 1 },
  bySourceType: { tool: 1 },
}

const candidate: MemoryRecord = {
  id: "cand1",
  kind: "semantic",
  namespace: "route=/notes",
  content: "acme threshold is 750",
  data: {},
  source: { type: "tool", id: "remember" },
  confidence: 0.9,
  tags: [],
  status: "candidate",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Stub fetch with the happy-path API surface; returns the mock for call assertions. */
function stubApi() {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes("/api/memory/stats")) return jsonResponse(stats)
    if (u.includes("/api/memory/list"))
      return jsonResponse({ records: [candidate], total: 1, continuation: null })
    if (u.includes("/api/memory/search")) {
      return jsonResponse({
        groups: [{ namespace: "route=/notes", records: [candidate] }],
        hybrid: false,
      })
    }
    return jsonResponse({ error: "not found" }, 404)
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

/** Structural on purpose: the mutation stubs below take an `init` the read-only
 *  stub does not, so a `ReturnType<typeof stubApi>` parameter would reject them. */
function callsTo(mock: { mock: { calls: readonly (readonly unknown[])[] } }, path: string): URL[] {
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((u) => u.includes(path))
    .map((u) => new URL(u, "http://localhost"))
}

function rowCheckbox(container: HTMLElement, rowId: string): HTMLElement {
  const box = container.querySelector(
    `[data-pretable-row-id="${rowId}"] button[data-pretable-row-select]`,
  )
  if (!box) throw new Error(`no checkbox for ${rowId}`)
  return box as HTMLElement
}

function postCount(mock: { mock: { calls: readonly (readonly unknown[])[] } }): number {
  return mock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
    .length
}

describe("ListPage", () => {
  it("renders stats badges and records from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) return jsonResponse(stats)
        if (u.includes("/api/memory/list")) {
          return jsonResponse({ records: [candidate], total: 1, continuation: null })
        }
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    expect(await screen.findByText("1 candidate")).toBeDefined()
    expect(await screen.findByText("acme threshold is 750")).toBeDefined()
  })

  it("a namespace facet sends the EXACT namespace, never a prefix", async () => {
    const mock = stubApi()
    render(<ListPage />)
    const rail = await screen.findByRole("navigation")
    const facet = within(rail).getByRole("button", { name: /route=\/notes/ })
    fireEvent.click(facet)
    await vi.waitFor(() => {
      const scoped = callsTo(mock, "/api/memory/list").filter(
        (u) => u.searchParams.get("namespace") === "route=/notes",
      )
      expect(scoped.length).toBeGreaterThan(0)
    })
    expect(
      callsTo(mock, "/api/memory/list").every(
        (u) => u.searchParams.get("namespacePrefix") === null,
      ),
    ).toBe(true)
  })

  it("renders every row the server returned for a facet — no client narrowing", async () => {
    // The old code fetched by PREFIX and then narrowed to equality on the
    // client, so the rows on screen and the `total` beside them answered
    // different questions. The server answers the exact question now, and the
    // page must not second-guess it.
    const sibling: MemoryRecord = {
      ...candidate,
      id: "cand2",
      namespace: "route=/notes2",
      content: "sibling prefix record",
    }
    const mock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes("/api/memory/stats")) {
        return jsonResponse({
          ...stats,
          total: 2,
          byNamespace: { "route=/notes": 1, "route=/notes2": 1 },
        })
      }
      if (u.includes("/api/memory/list"))
        return jsonResponse({ records: [candidate, sibling], total: 2, continuation: null })
      return jsonResponse({ groups: [] })
    })
    vi.stubGlobal("fetch", mock)
    render(<ListPage />)
    expect(await screen.findByText("acme threshold is 750")).toBeDefined()
    const facetLabel = within(screen.getByRole("navigation")).getByText("route=/notes")
    const facetButton = facetLabel.closest("button")
    if (!facetButton) throw new Error("facet button not found")
    fireEvent.click(facetButton)
    // The stub answers every window with both rows, so the sibling is already on
    // screen before the click. Without waiting for the scoped request the click
    // must send, this passes against a facet control that does nothing at all.
    await vi.waitFor(() => {
      const scoped = callsTo(mock, "/api/memory/list").filter(
        (u) => u.searchParams.get("namespace") === "route=/notes",
      )
      expect(scoped.length).toBeGreaterThan(0)
    })
    // Whatever the (stubbed) server hands back is what shows. Nothing is hidden.
    expect(await screen.findByText("sibling prefix record")).toBeDefined()
  })

  it("labels the facet counts as global, on the rail AND on every count", async () => {
    stubApi()
    render(<ListPage />)
    const rail = await screen.findByRole("navigation")
    const scopeId = rail.getAttribute("aria-describedby")
    expect(scopeId).toBeTruthy()
    // Resolving the reference, not just comparing the attribute to a literal: a
    // dangling `aria-describedby` is the failure mode of a hand-written id, and
    // it announces nothing.
    expect(document.getElementById(scopeId ?? "")?.textContent).toMatch(/across all memories/i)
    // A description on the landmark does not reach its descendants, and the
    // counts are read off the buttons — someone who tabs straight to a facet
    // would otherwise hear the number with no scope attached to it.
    const facets = within(rail).getAllByRole("button")
    expect(facets.length).toBeGreaterThan(1)
    for (const facet of facets) {
      expect(facet.getAttribute("aria-describedby")).toBe(scopeId)
    }
  })

  it("reports no count when the stats request has not answered", async () => {
    // A `0` sitting under a label that promises a census of every memory reads as
    // that census. A failed (or merely pending) /stats has not delivered one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) return jsonResponse({ error: "no store" }, 500)
        if (u.includes("/api/memory/list"))
          return jsonResponse({ records: [candidate], total: 1, continuation: null })
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    const rail = await screen.findByRole("navigation")
    const all = within(rail).getByRole("button", { name: /all/i })
    expect(all.textContent).toBe("all—")
  })

  it("typing a query fires a debounced search and renders grouped results", async () => {
    const mock = stubApi()
    render(<ListPage />)
    fireEvent.change(screen.getByLabelText("Search memories"), { target: { value: "acme" } })
    expect(await screen.findByRole("heading", { level: 2, name: "route=/notes" })).toBeDefined()
    const searches = callsTo(mock, "/api/memory/search")
    expect(searches).toHaveLength(1)
    expect(searches[0]?.searchParams.get("q")).toBe("acme")
  })

  it("surfaces API errors as a banner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "no memory store configured" }, 500)),
    )
    render(<ListPage />)
    const banner = await screen.findByRole("alert")
    expect(banner.textContent).toContain("no memory store configured")
  })

  it("surfaces a browse failure in the timeline view, with a way out", async () => {
    let fail = true
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) return jsonResponse(stats)
        if (u.includes("/api/memory/list")) {
          return fail
            ? jsonResponse({ error: "no memory store configured" }, 500)
            : jsonResponse({ records: [candidate], total: 1, continuation: null })
        }
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))

    const entry = await screen.findByTestId("error-browse")
    expect(entry.textContent).toContain("no memory store configured")
    // The error phase suspends polling, so without a control here the timeline never
    // asks again and the failure reads as an empty window for the rest of the session.
    fail = false
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("acme threshold is 750")).toBeDefined()
    expect(screen.queryByTestId("error-browse")).toBeNull()
  })

  it("puts exactly one retry on screen for a failed browse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) return jsonResponse(stats)
        if (u.includes("/api/memory/list")) {
          return jsonResponse({ error: "no memory store configured" }, 500)
        }
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    const block = await screen.findByTestId("browse-error")
    expect(block.textContent).toContain("no memory store configured")
    // The grid's body-state block owns the error PHASE wherever the grid is mounted;
    // a banner for the same failure would put a second retry on screen for one failure.
    expect(screen.queryByTestId("error-browse")).toBeNull()
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
  })

  it("leaves a failed bulk action to the bar that reports it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url)
        if (init?.method === "POST") return jsonResponse({ error: "would supersede" }, 409)
        if (u.includes("/api/memory/stats")) return jsonResponse(stats)
        if (u.includes("/api/memory/list"))
          return jsonResponse({ records: [candidate], total: 1, continuation: null })
        return jsonResponse({ groups: [] })
      }),
    )
    const { container } = render(<ListPage />)
    await screen.findByText("acme threshold is 750")
    fireEvent.click(rowCheckbox(container, "cand1"))
    fireEvent.click(await screen.findByRole("button", { name: /approve 1/i }))

    const report = await screen.findByTestId("bulk-error")
    expect(report.textContent).toContain("1 of 1 failed")
    // One failure, one channel. A banner repeating it announces the same event a second
    // time, and — cleared by nothing the bar does — outlives the bar it points at.
    expect(screen.queryByTestId("error-mutation")).toBeNull()
    expect(screen.queryByText(/bulk action\(s\) failed/)).toBeNull()
  })

  it("a mutation still refetches when a request was already in flight", async () => {
    let release: (() => void) | undefined
    let hold = false
    const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === "POST") return jsonResponse({ ok: true })
      if (u.includes("/api/memory/stats")) return jsonResponse(stats)
      if (u.includes("/api/memory/list")) {
        if (hold) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return jsonResponse({ records: [candidate], total: 1, continuation: null })
      }
      return jsonResponse({ groups: [] })
    })
    vi.stubGlobal("fetch", mock)
    const { container } = render(<ListPage />)
    await screen.findByText("acme threshold is 750")

    // Live off: a mutation's own refresh is the only thing that will ever ask again —
    // which is what makes the FIRST one the request in flight that the second has to
    // survive. A query change would put a request in flight too, but the bulk bar is
    // withheld for the whole of `stale`, so that route is not a gesture a user has.
    fireEvent.click(screen.getByLabelText("live"))
    hold = true
    fireEvent.click(rowCheckbox(container, "cand1"))
    fireEvent.click(await screen.findByRole("button", { name: /approve 1/i }))
    await vi.waitFor(() => {
      expect(release).toBeDefined()
    })

    fireEvent.click(rowCheckbox(container, "cand1"))
    fireEvent.click(await screen.findByRole("button", { name: /approve 1/i }))
    await vi.waitFor(() => {
      expect(postCount(mock)).toBe(2)
    })

    hold = false
    const before = callsTo(mock, "/api/memory/list").length
    release?.()
    await vi.waitFor(() => {
      expect(callsTo(mock, "/api/memory/list").length).toBeGreaterThan(before)
    })
  })

  it("does not call an unanswered timeline window empty", async () => {
    let release: (() => void) | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) return jsonResponse(stats)
        if (u.includes("/api/memory/list")) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return jsonResponse({ records: [candidate], total: 1, continuation: null })
        }
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))

    expect(await screen.findByTestId("browse-loading")).toBeDefined()
    // "No episodes in this window." is an ANSWER, and the server has not given one.
    expect(screen.queryByText("No episodes in this window.")).toBeNull()

    release?.()
    expect(await screen.findByText("acme threshold is 750")).toBeDefined()
    // Counts and freshness describe the browse, not the grid — both surfaces get them.
    expect(screen.getByTestId("browse-status").textContent).toContain("1 loaded of 1 matching")
  })
})
