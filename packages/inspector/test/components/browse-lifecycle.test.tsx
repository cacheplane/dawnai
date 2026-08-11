import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"

const stats: MemoryStats = {
  total: 2,
  byStatus: { candidate: 1, active: 1 },
  byKind: { semantic: 2 },
  byNamespace: { "route=/notes": 2 },
  bySourceType: { tool: 2 },
}

function record(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    kind: "semantic",
    namespace: "route=/notes",
    content: `content ${id}`,
    data: {},
    source: { type: "tool", id: "remember" },
    confidence: 0.5,
    tags: [],
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** A fake server whose /list answer is swappable mid-test. */
function stubServer(list: () => Response) {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes("/api/memory/stats")) return jsonResponse(stats)
    if (u.includes("/api/memory/list")) return list()
    if (u.includes("/api/memory/search")) return jsonResponse({ groups: [] })
    return jsonResponse({ error: "not found" }, 404)
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("browse lifecycle", () => {
  it("flow 1: shows a loading block, then rows and the honest total", async () => {
    stubServer(() => jsonResponse({ records: [record("a")], total: 5432 }))
    render(<ListPage />)
    expect(screen.getByTestId("browse-loading")).toBeDefined()
    expect(await screen.findByText("content a")).toBeDefined()
    expect(screen.getByTestId("browse-status").textContent).toContain("1 loaded of 5,432 matching")
  })

  it("an empty result gets the empty block, with copy that knows about filters", async () => {
    stubServer(() => jsonResponse({ records: [], total: 0 }))
    render(<ListPage />)
    await waitFor(() =>
      expect(screen.getByTestId("browse-empty").textContent).toContain("No memories yet"),
    )
    const rail = screen.getByRole("navigation")
    fireEvent.click(within(rail).getByRole("button", { name: /route=\/notes/ }))
    await waitFor(() =>
      expect(screen.getByTestId("browse-empty").textContent).toContain(
        "No memories match these filters",
      ),
    )
  })

  it("flow 7: an initial failure renders the error block with a retry that recovers", async () => {
    let fail = true
    stubServer(() =>
      fail
        ? jsonResponse({ error: "no memory store configured" }, 500)
        : jsonResponse({ records: [record("a")], total: 1 }),
    )
    render(<ListPage />)
    const block = await screen.findByTestId("browse-error")
    expect(block.textContent).toContain("no memory store configured")

    fail = false
    fireEvent.click(within(block).getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("content a")).toBeDefined()
    expect(screen.queryByTestId("browse-error")).toBeNull()
  })

  it("flow 2/4: a facet change marks the visible rows stale and asks for the exact namespace", async () => {
    let release: (() => void) | undefined
    const mock = stubServer(() => jsonResponse({ records: [record("a")], total: 1 }))
    render(<ListPage />)
    expect(await screen.findByText("content a")).toBeDefined()

    // Hold the next answer so the stale window is observable.
    mock.mockImplementation(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes("/api/memory/stats")) return jsonResponse(stats)
      if (u.includes("/api/memory/search")) return jsonResponse({ groups: [] })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return jsonResponse({ records: [record("z")], total: 1 })
    })

    const rail = screen.getByRole("navigation")
    fireEvent.click(within(rail).getByRole("button", { name: /route=\/notes/ }))
    await waitFor(() =>
      expect(screen.getByTestId("browse-status").getAttribute("data-phase")).toBe("stale"),
    )
    // The OLD rows are still on screen, and marked as answering the old question.
    expect(screen.getByText("content a")).toBeDefined()

    release?.()
    expect(await screen.findByText("content z")).toBeDefined()
    const listCalls = mock.mock.calls
      .map((call) => String(call[0]))
      .filter((u) => u.includes("/api/memory/list"))
    expect(listCalls.some((u) => u.includes("namespace=route%3D%2Fnotes"))).toBe(true)
  })

  it("flow 8/9: a failing poll tick banners itself without disturbing the rows", async () => {
    vi.useFakeTimers()
    try {
      let fail = false
      stubServer(() =>
        fail
          ? jsonResponse({ error: "network down" }, 503)
          : jsonResponse({ records: [record("a")], total: 1 }),
      )
      render(<ListPage />)
      await vi.waitFor(() => expect(screen.getByText("content a")).toBeDefined())

      fail = true
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() =>
        expect(screen.getByTestId("error-refresh").textContent).toContain("network down"),
      )
      // Rows survive a failed refresh, and the failure did NOT become the error block.
      expect(screen.getByText("content a")).toBeDefined()
      expect(screen.queryByTestId("browse-error")).toBeNull()

      fail = false
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => expect(screen.queryByTestId("error-refresh")).toBeNull())
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows an as-of instant once polling is paused", async () => {
    stubServer(() => jsonResponse({ records: [record("a")], total: 1 }))
    render(<ListPage />)
    expect(await screen.findByText("content a")).toBeDefined()
    expect(screen.getByTestId("browse-status").textContent).not.toContain("Updated ")

    fireEvent.click(screen.getByLabelText("live"))
    await waitFor(() =>
      expect(screen.getByTestId("browse-status").textContent).toContain("Updated "),
    )
  })
})
