import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"

/**
 * The grid's funnels replaced the header's status/kind selects. Filtering and
 * ordering have to stay SERVER-side: the list endpoint answers with a window, so
 * narrowing or re-ranking the rows already loaded would quietly answer a different
 * question — over the wrong sample, under a truthful-looking header.
 */

const stats: MemoryStats = {
  total: 2,
  byStatus: { candidate: 1, active: 1 },
  byKind: { semantic: 2 },
  byNamespace: { "route=/notes": 2 },
  bySourceType: { tool: 2 },
}

function record(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "semantic",
    namespace: "route=/notes",
    content: `content ${over.id}`,
    data: {},
    source: { type: "tool", id: "remember" },
    confidence: 0.5,
    tags: [],
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...over,
  }
}

const records = [record({ id: "a1" }), record({ id: "c1", status: "candidate" })]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function stubApi() {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes("/api/memory/stats")) return jsonResponse(stats)
    if (u.includes("/api/memory/list")) return jsonResponse({ records, total: records.length })
    return jsonResponse({ groups: [] })
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

/** Every /api/memory/list URL the page has requested. */
function listUrls(mock: ReturnType<typeof stubApi>): URL[] {
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((u) => u.includes("/api/memory/list"))
    .map((u) => new URL(u, "http://localhost"))
}

/** The MOST RECENT list request — the only one that describes the query as it now
 *  stands. Throws rather than returning undefined: an assertion on `undefined`
 *  passes for half the matchers here and would pin nothing. */
function lastListUrl(mock: ReturnType<typeof stubApi>): URL {
  const urls = listUrls(mock)
  const last = urls[urls.length - 1]
  if (!last) throw new Error("no list request yet")
  return last
}

/** Timeline requests, identified by the kind default only that view sends. */
function timelineUrls(mock: ReturnType<typeof stubApi>): URL[] {
  return listUrls(mock).filter((u) => u.searchParams.getAll("kind").includes("episodic"))
}

/** Four sort keys, one past the store's ceiling, so the fourth is declined. Not
 *  `namespace`: this page groups by it while the window is complete, and the grouped
 *  column takes no sort click — a fourth key has to come from a column the grid is
 *  actually offering. */
function capTheSort(container: HTMLElement) {
  for (const column of ["status", "kind", "confidence", "updated"]) {
    fireEvent.click(headerFor(container, column), { shiftKey: true })
  }
}

function headerFor(container: HTMLElement, label: string): HTMLElement {
  const header = [...container.querySelectorAll('[role="columnheader"]')].find((el) =>
    el.textContent?.startsWith(label),
  )
  if (!header) throw new Error(`no column header for ${label}`)
  return header as HTMLElement
}

async function tickStatus(value: string) {
  // The menu stays open between ticks; clicking the funnel again would close it.
  if (!screen.queryByRole("dialog", { name: "Filter status" })) {
    fireEvent.click(await screen.findByRole("button", { name: "Filter status" }))
  }
  const dialog = await screen.findByRole("dialog", { name: "Filter status" })
  const box = within(dialog)
    .getAllByRole("checkbox")
    .find((cb) => cb.closest("label")?.textContent?.includes(value))
  if (!box) throw new Error(`no ${value} option in the status funnel`)
  fireEvent.click(box)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("column funnels drive the server query", () => {
  it("sends a ticked status as a filters JSON predicate", async () => {
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")
    await tickStatus("candidate")
    await vi.waitFor(() => {
      const sent = listUrls(mock)
        .map((u) => u.searchParams.get("filters"))
        .filter((v): v is string => v !== null)
        .map((v) => JSON.parse(v))
      expect(sent).toContainEqual([{ field: "status", op: "in", values: ["candidate"] }])
    })
  })

  it("never sends the legacy status shorthand param", async () => {
    // One encoding, one code path: every predicate goes through `filters`, so a
    // stray shorthand would be a second grammar to keep in step.
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")
    await tickStatus("candidate")
    await vi.waitFor(() => {
      expect(listUrls(mock).some((u) => u.searchParams.get("filters") !== null)).toBe(true)
    })
    expect(listUrls(mock).every((u) => u.searchParams.getAll("status").length === 0)).toBe(true)
  })

  it("sends no filters param at all when nothing is ticked", async () => {
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")
    await vi.waitFor(() => expect(listUrls(mock).length).toBeGreaterThan(0))
    const first = listUrls(mock)[0]
    if (!first) throw new Error("no list request")
    expect(first.searchParams.get("filters")).toBeNull()
  })

  it("sends a header sort as an orderBy JSON entry", async () => {
    const mock = stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("content a1")
    fireEvent.click(headerFor(container, "confidence"))
    await vi.waitFor(() => {
      const sent = listUrls(mock)
        .map((u) => u.searchParams.get("orderBy"))
        .filter((v): v is string => v !== null)
        .map((v) => JSON.parse(v))
      expect(sent).toContainEqual([{ field: "confidence", dir: "desc" }])
    })
  })

  it("returns to the unfiltered query when the last ticked value is removed", async () => {
    // The ROUND TRIP is the claim. Asserting on the first request instead would pass
    // for a page that never removes the param, because the first request is
    // unfiltered by construction — and clearing a funnel has to land back on the
    // dataset key the page started on, or the pivot discards a selection twice.
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")
    await tickStatus("candidate")
    await vi.waitFor(() => {
      expect(lastListUrl(mock).searchParams.get("filters")).not.toBeNull()
    })
    await tickStatus("candidate")
    await vi.waitFor(() => {
      expect(lastListUrl(mock).searchParams.get("filters")).toBeNull()
    })
  })

  it("declines a fourth sort key, and says so rather than drawing it", async () => {
    // The cap has to reach BOTH the query and the grid's own sort state: capping only
    // the query leaves the header drawing an active sort the server never applied,
    // which is the dishonesty this whole slice exists to remove.
    const mock = stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("content a1")
    capTheSort(container)
    expect(await screen.findByTestId("sort-cap-notice")).toBeDefined()
    await vi.waitFor(() => {
      const orderBy = lastListUrl(mock).searchParams.get("orderBy")
      expect(JSON.parse(orderBy ?? "null")).toEqual([
        { field: "status", dir: "desc" },
        { field: "kind", dir: "desc" },
        { field: "confidence", dir: "desc" },
      ])
    })
    await vi.waitFor(() => {
      expect(headerFor(container, "updated").getAttribute("aria-sort")).toBe("none")
    })
  })

  it("retires the cap notice as soon as another control moves the query", async () => {
    // The notice explains ONE click. Left standing it describes an action several
    // steps in the past, about a column the user can no longer see declined — so
    // every other control that moves the query has to retire it. All three are walked
    // here because each is a separate wrapper, and a forgotten one is invisible.
    const mock = stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("content a1")

    capTheSort(container)
    expect(await screen.findByTestId("sort-cap-notice")).toBeDefined()
    await tickStatus("candidate")
    await vi.waitFor(() => {
      expect(lastListUrl(mock).searchParams.get("filters")).not.toBeNull()
    })
    expect(screen.queryByTestId("sort-cap-notice")).toBeNull()

    // One more key is enough to re-cap: the sort still holds the three that survived.
    fireEvent.click(headerFor(container, "updated"), { shiftKey: true })
    expect(await screen.findByTestId("sort-cap-notice")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    fireEvent.click(screen.getByRole("button", { name: "list" }))
    expect(screen.queryByTestId("sort-cap-notice")).toBeNull()

    fireEvent.click(headerFor(container, "updated"), { shiftKey: true })
    expect(await screen.findByTestId("sort-cap-notice")).toBeDefined()
    const rail = screen.getByRole("navigation")
    fireEvent.click(within(rail).getByRole("button", { name: /route=\/notes/ }))
    expect(screen.queryByTestId("sort-cap-notice")).toBeNull()
  })

  it("does not carry a header sort into the timeline, which offers no headers", async () => {
    // `orderBy` decides WHICH rows the window holds, not just their order, and
    // `TimelineView` re-sorts whatever arrives by event time — so an inherited sort
    // would silently swap the sample under an unchanged window label, for a control
    // that view does not show. Funnels still travel: they narrow the same question
    // either view asks, and the rail that sets `namespace` is on screen in both.
    const mock = stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("content a1")
    fireEvent.click(headerFor(container, "confidence"))
    await vi.waitFor(() => {
      expect(listUrls(mock).some((u) => u.searchParams.get("orderBy") !== null)).toBe(true)
    })
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    await vi.waitFor(() => {
      expect(timelineUrls(mock).length).toBeGreaterThan(0)
    })
    expect(timelineUrls(mock).every((u) => u.searchParams.get("orderBy") === null)).toBe(true)
  })
})
