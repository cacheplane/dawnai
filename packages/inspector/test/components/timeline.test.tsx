import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"
import { TimelineView } from "../../src/components/memory/timeline-view"

const stats: MemoryStats = {
  total: 2,
  byStatus: { active: 2 },
  byKind: { episodic: 2 },
  byNamespace: { "route=/chat": 2 },
  bySourceType: { run: 2 },
}

function episode(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "episodic",
    namespace: "route=/chat",
    content: "Ran: summarize the meeting",
    data: { input: "summarize the meeting", outcome: "ok", durationMs: 1234 },
    source: { type: "run", id: "run-1" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    effectiveAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  }
}

const epDay1 = episode({ id: "ep1" })
const epDay2 = episode({
  id: "ep2",
  content: "Ran: draft the release notes",
  data: { input: "draft the release notes", outcome: "error", durationMs: 500 },
  effectiveAt: "2026-08-02T12:30:00.000Z",
  createdAt: "2026-08-02T12:30:00.000Z",
  updatedAt: "2026-08-02T12:30:00.000Z",
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Stub fetch with an episodic API surface; returns the mock for call assertions. */
function stubApi(records: readonly MemoryRecord[] = [epDay1, epDay2]) {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes("/api/memory/stats")) return jsonResponse(stats)
    if (u.includes("/api/memory/list")) {
      return jsonResponse({ records, total: records.length })
    }
    if (u.includes("/api/memory/search")) return jsonResponse({ groups: [], hybrid: false })
    const byId = records.find((r) => u.endsWith(`/api/memory/${r.id}`))
    if (byId) return jsonResponse(byId)
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const noop = () => {}

describe("TimelineView", () => {
  it("groups records by day with outcome badges and durations", () => {
    render(<TimelineView records={[epDay1, epDay2]} onSelect={noop} />)
    expect(screen.getByRole("heading", { level: 2, name: "2026-08-01" })).toBeDefined()
    expect(screen.getByRole("heading", { level: 2, name: "2026-08-02" })).toBeDefined()
    expect(screen.getByText("ok")).toBeDefined()
    const errorBadge = screen.getByText("error")
    expect(errorBadge.className).toContain("bg-red-100")
    expect(screen.getByText("1.2s")).toBeDefined()
    expect(screen.getByText("0.5s")).toBeDefined()
  })

  it("sorts by event time (newest first), not fetch order", () => {
    // browse orders by updated_at DESC — a mutation on an old record hoists it
    // to the front of the fetch. Supply updated-at order: the OLD-event record
    // first, then day-2 rows earliest-first. The timeline must re-sort by
    // (effectiveAt ?? createdAt) descending.
    const oldEventBumped = episode({
      id: "ep-old",
      content: "Ran: an old episode, recently mutated",
      effectiveAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    })
    const day2Early = episode({
      id: "ep-early",
      content: "Ran: early on day two",
      effectiveAt: "2026-08-02T12:30:00.000Z",
    })
    const day2Late = episode({
      id: "ep-late",
      content: "Ran: late on day two",
      effectiveAt: "2026-08-02T15:45:00.000Z",
    })
    render(<TimelineView records={[oldEventBumped, day2Early, day2Late]} onSelect={noop} />)
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(["2026-08-02", "2026-08-01"])
    // Within-day rows descend by event time: 15:45 above 12:30.
    const times = screen.getAllByText(/^\d{2}:\d{2}$/).map((el) => el.textContent)
    expect(times).toEqual(["15:45", "12:30", "09:00"])
  })

  it("labels agent-authored episodes (no outcome) as authored", () => {
    const authored = episode({
      id: "ep3",
      content: "User prefers expedited shipping",
      data: {},
      source: { type: "tool", id: "remember" },
    })
    render(<TimelineView records={[authored]} onSelect={noop} />)
    expect(screen.getByText("authored")).toBeDefined()
  })

  it("renders the empty state when there are no episodes", () => {
    render(<TimelineView records={[]} onSelect={noop} />)
    expect(screen.getByText("No episodes in this window.")).toBeDefined()
  })
})

describe("ListPage timeline mode", () => {
  it("clicking a timeline row opens the detail sheet", async () => {
    stubApi()
    render(<ListPage />)
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    const row = await screen.findByRole("button", {
      name: "Open episode: Ran: summarize the meeting",
    })
    fireEvent.click(row)
    expect(await screen.findByTestId("detail-sheet")).toBeDefined()
  })

  it("shows the timeline empty state for an empty window", async () => {
    stubApi([])
    render(<ListPage />)
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    expect(await screen.findByText("No episodes in this window.")).toBeDefined()
  })

  it("timeline mode defaults kind=episodic and the window select threads since", async () => {
    const mock = stubApi()
    render(<ListPage />)
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    await vi.waitFor(() => {
      const episodic = callsTo(mock, "/api/memory/list").filter(
        (u) => u.searchParams.get("kind") === "episodic",
      )
      expect(episodic.length).toBeGreaterThan(0)
    })
    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "24h" } })
    await vi.waitFor(() => {
      const windowed = callsTo(mock, "/api/memory/list").filter((u) => u.searchParams.has("since"))
      expect(windowed.length).toBeGreaterThan(0)
      const since = windowed[windowed.length - 1]?.searchParams.get("since") ?? ""
      expect(Number.isFinite(Date.parse(since))).toBe(true)
      // Client-computed lower bound: roughly Date.now() - 24h.
      expect(Date.now() - Date.parse(since)).toBeLessThan(25 * 60 * 60 * 1000)
      expect(Date.now() - Date.parse(since)).toBeGreaterThan(23 * 60 * 60 * 1000)
    })
  })
})
