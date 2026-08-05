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
    if (u.includes("/api/memory/list")) return jsonResponse({ records: [candidate], total: 1 })
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

function callsTo(mock: ReturnType<typeof stubApi>, path: string): URL[] {
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((u) => u.includes(path))
    .map((u) => new URL(u, "http://localhost"))
}

describe("ListPage", () => {
  it("renders stats badges and records from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) return jsonResponse(stats)
        if (u.includes("/api/memory/list")) {
          return jsonResponse({ records: [candidate], total: 1 })
        }
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    expect(await screen.findByText("1 candidate")).toBeDefined()
    expect(await screen.findByText("acme threshold is 750")).toBeDefined()
  })

  it("clicking a namespace facet scopes the next list fetch", async () => {
    const mock = stubApi()
    render(<ListPage />)
    const facet = await screen.findByRole("button", { name: /route=\/notes/ })
    fireEvent.click(facet)
    await vi.waitFor(() => {
      const scoped = callsTo(mock, "/api/memory/list").filter(
        (u) => u.searchParams.get("namespacePrefix") === "route=/notes",
      )
      expect(scoped.length).toBeGreaterThan(0)
    })
  })

  it("a selected facet filters the page to the exact namespace, not the prefix", async () => {
    const sibling: MemoryRecord = {
      ...candidate,
      id: "cand2",
      namespace: "route=/notes2",
      content: "sibling prefix record",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) {
          return jsonResponse({
            ...stats,
            total: 2,
            byNamespace: { "route=/notes": 1, "route=/notes2": 1 },
          })
        }
        if (u.includes("/api/memory/list")) {
          // The server narrows by PREFIX, so a route=/notes selection still
          // returns the route=/notes2 sibling — the client must filter exactly.
          return jsonResponse({ records: [candidate, sibling], total: 2 })
        }
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    expect(await screen.findByText("acme threshold is 750")).toBeDefined()
    expect(await screen.findByText("sibling prefix record")).toBeDefined()

    // Exact-text lookup scoped to the facet rail: "route=/notes" must not
    // match the "route=/notes2" facet (or the grid's namespace cells).
    const facetLabel = within(screen.getByRole("navigation")).getByText("route=/notes")
    const facetButton = facetLabel.closest("button")
    if (!facetButton) throw new Error("facet button not found")
    fireEvent.click(facetButton)
    await vi.waitFor(() => {
      expect(screen.queryByText("sibling prefix record")).toBeNull()
    })
    expect(screen.getByText("acme threshold is 750")).toBeDefined()
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
})
