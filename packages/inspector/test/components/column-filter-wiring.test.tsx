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
    const header = [...container.querySelectorAll('[role="columnheader"]')].find((el) =>
      el.textContent?.startsWith("confidence"),
    )
    if (!header) throw new Error("no confidence header")
    fireEvent.click(header)
    await vi.waitFor(() => {
      const sent = listUrls(mock)
        .map((u) => u.searchParams.get("orderBy"))
        .filter((v): v is string => v !== null)
        .map((v) => JSON.parse(v))
      expect(sent).toContainEqual([{ field: "confidence", dir: "desc" }])
    })
  })
})
