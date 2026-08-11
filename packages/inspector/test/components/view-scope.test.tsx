import type { MemoryRecord } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

const records = [record({ id: "a" }), record({ id: "b" })]

function stubApi() {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes("/api/memory/stats"))
      return jsonResponse({
        total: 2,
        byStatus: { active: 2 },
        byKind: { semantic: 2 },
        byNamespace: { "route=/notes": 2 },
        bySourceType: { tool: 2 },
      })
    if (u.includes("/api/memory/list"))
      return jsonResponse({ records, total: 2, continuation: null })
    return jsonResponse({ groups: [{ namespace: "route=/notes", records: [record({ id: "a" })] }] })
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function startSearch() {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), {
    target: { value: "acme" },
  })
  await vi.waitFor(() =>
    expect(screen.getByRole("searchbox", { name: "Search memories" })).toHaveProperty(
      "value",
      "acme",
    ),
  )
}

/** Both roles: the surface is a `treegrid` while grouped and a `grid` when flat,
 *  and the namespace grouping this page asks for makes that depend on the facet. */
function browseGrid(): Element | null {
  return screen.getByTestId("browse-region").querySelector('[role="grid"],[role="treegrid"]')
}

describe("view scope", () => {
  it("keeps the browse grid mounted while search results are showing", async () => {
    // Unmounting it would destroy engine-owned selection, focus and the measured
    // row heights, so returning from a search would land the user somewhere else.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    const grid = browseGrid()
    expect(grid).not.toBeNull()
    await startSearch()
    await vi.waitFor(() =>
      expect(screen.getByTestId("browse-region").hasAttribute("hidden")).toBe(true),
    )
    expect(browseGrid()).toBe(grid)
  })

  it("disables the view toggle while a search is running, and says why", async () => {
    // The toggle changes `view` but the screen keeps showing search results —
    // an active-looking control with no visible effect. A real `disabled` would
    // remove it from the tab order and hide the reason with it.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await startSearch()
    const toggle = await screen.findByRole("group", { name: "View" })
    const timeline = within(toggle).getByRole("button", { name: "timeline" })
    await vi.waitFor(() => expect(timeline.getAttribute("aria-disabled")).toBe("true"))
    expect(timeline.hasAttribute("disabled")).toBe(false)
    expect(timeline.tabIndex).toBe(0)
    const described = document.getElementById(timeline.getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toMatch(/not applied to search/i)
  })

  it("refuses the view change rather than switching invisibly", async () => {
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await startSearch()
    const toggle = await screen.findByRole("group", { name: "View" })
    const timeline = within(toggle).getByRole("button", { name: "timeline" })
    fireEvent.click(timeline)
    expect(timeline.getAttribute("aria-pressed")).toBe("false")
  })

  it("marks the load-more control as not applying to search", async () => {
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await startSearch()
    const button = within(screen.getByTestId("load-more-footer")).getByRole("button")
    await vi.waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"))
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toMatch(/not applied to search/i)
  })

  it("keeps the namespace facet active — search honours it", async () => {
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await startSearch()
    const rail = screen.getByRole("navigation")
    const facet = within(rail).getByRole("button", { name: /route=\/notes/ })
    expect(facet.getAttribute("aria-disabled")).toBeNull()
  })
})
