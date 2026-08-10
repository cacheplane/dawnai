import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"

/**
 * The grid's funnels replaced the header's status/kind selects. Filtering has
 * to stay SERVER-side: the list endpoint caps at a page, so narrowing only the
 * rows already loaded would quietly answer a different question.
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

describe("column filters drive the server query", () => {
  it("offers a funnel on status instead of a header select", async () => {
    stubApi()
    render(<ListPage />)

    expect(await screen.findByRole("button", { name: "Filter status" })).toBeDefined()
    // The selects these replaced are gone.
    expect(screen.queryByLabelText("Status")).toBeNull()
    expect(screen.queryByLabelText("Kind")).toBeNull()
  })

  it("sends the ticked status to the server, not just to the grid", async () => {
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")

    await tickStatus("candidate")

    await waitFor(() => {
      const scoped = listUrls(mock).filter(
        (u) => u.searchParams.getAll("status").join(",") === "candidate",
      )
      expect(scoped.length).toBeGreaterThan(0)
    })
  })

  it("repeats the param when two values are ticked", async () => {
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")

    await tickStatus("candidate")
    await tickStatus("active")

    await waitFor(() => {
      const both = listUrls(mock).filter(
        (u) => u.searchParams.getAll("status").sort().join(",") === "active,candidate",
      )
      expect(both.length).toBeGreaterThan(0)
    })
  })

  it("returns to unfiltered when the last ticked value is removed", async () => {
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")

    await tickStatus("candidate")
    await waitFor(() => {
      expect(listUrls(mock).some((u) => u.searchParams.has("status"))).toBe(true)
    })

    // An emptied checklist is an INACTIVE filter to the grid, not a filter that
    // matches nothing — so the query drops the param rather than narrowing to
    // zero. (`isEmpty` below is the operator that really means "nothing".)
    await tickStatus("candidate")

    await waitFor(() => {
      const latest = listUrls(mock).at(-1)
      expect(latest?.searchParams.has("status")).toBe(false)
    })
  })

  it("answers a match-nothing filter locally instead of asking unfiltered", async () => {
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a1")

    fireEvent.click(await screen.findByRole("button", { name: "Filter status" }))
    const dialog = await screen.findByRole("dialog", { name: "Filter status" })
    const operator = dialog.querySelector("select") as HTMLSelectElement
    // status is never blank, so "is empty" matches no row at all.
    fireEvent.change(operator, { target: { value: "isEmpty" } })

    const before = listUrls(mock).length
    await waitFor(() => {
      expect(screen.getByTestId("no-matches")).toBeDefined()
    })
    // Over HTTP a param that appears zero times is *absent*, so re-asking the
    // server would come back unfiltered — the page must answer it here.
    expect(listUrls(mock).length).toBe(before)
    expect(screen.getByTestId("no-matches").textContent).toContain("match these filters")
  })
})
