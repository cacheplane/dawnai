import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"

/**
 * Approving candidates one at a time is the tedious part of curating memory,
 * so the grid's checkboxes drive the same verbs the detail sheet exposes.
 */

const stats: MemoryStats = {
  total: 3,
  byStatus: { candidate: 2, active: 1 },
  byKind: { semantic: 3 },
  byNamespace: { "route=/notes": 3 },
  bySourceType: { tool: 3 },
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
    status: "candidate",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...over,
  }
}

const records = [
  record({ id: "c1", content: "first candidate" }),
  record({ id: "c2", content: "second candidate" }),
  record({ id: "a1", content: "an active one", status: "active" }),
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Stub the read endpoints; `onPost` decides how each mutation answers. */
function stubApi(onPost?: (url: string) => Response) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === "POST") return onPost?.(u) ?? jsonResponse({ ok: true })
    if (u.includes("/api/memory/stats")) return jsonResponse(stats)
    if (u.includes("/api/memory/list")) return jsonResponse({ records, total: records.length })
    return jsonResponse({ groups: [] })
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

function checkboxFor(container: HTMLElement, rowId: string): HTMLElement {
  const box = container.querySelector(
    `[data-pretable-row-id="${rowId}"] button[data-pretable-row-select]`,
  )
  if (!box) throw new Error(`no checkbox for ${rowId}`)
  return box as HTMLElement
}

function postedUrls(mock: ReturnType<typeof stubApi>): string[] {
  return mock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
    .map((call) => String(call[0]))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("bulk actions", () => {
  it("shows no action bar until rows are ticked", async () => {
    stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    expect(screen.queryByTestId("bulk-bar")).toBeNull()

    fireEvent.click(checkboxFor(container, "c1"))

    expect(await screen.findByTestId("bulk-bar")).toBeDefined()
  })

  it("counts what is ticked", async () => {
    stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    fireEvent.click(checkboxFor(container, "c1"))
    fireEvent.click(checkboxFor(container, "c2"))

    expect((await screen.findByTestId("bulk-bar")).textContent).toContain("2 selected")
  })

  it("approves every ticked candidate", async () => {
    const mock = stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    fireEvent.click(checkboxFor(container, "c1"))
    fireEvent.click(checkboxFor(container, "c2"))
    fireEvent.click(await screen.findByRole("button", { name: /approve 2/i }))

    await vi.waitFor(() => {
      expect(postedUrls(mock)).toEqual(["/api/memory/c1/approve", "/api/memory/c2/approve"])
    })
  })

  it("only offers approve for the candidates in the selection", async () => {
    stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    // One candidate + one active: approve applies to the candidate only.
    fireEvent.click(checkboxFor(container, "c1"))
    fireEvent.click(checkboxFor(container, "a1"))

    expect(await screen.findByRole("button", { name: /approve 1/i })).toBeDefined()
  })

  it("hides approve entirely when nothing ticked is a candidate", async () => {
    stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    fireEvent.click(checkboxFor(container, "a1"))

    await screen.findByTestId("bulk-bar")
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
  })

  it("reports which ones failed rather than claiming success", async () => {
    const mock = stubApi((url) =>
      url.includes("/c2/")
        ? jsonResponse({ error: "would supersede an active memory" }, 409)
        : jsonResponse({ ok: true }),
    )
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    fireEvent.click(checkboxFor(container, "c1"))
    fireEvent.click(checkboxFor(container, "c2"))
    fireEvent.click(await screen.findByRole("button", { name: /approve 2/i }))

    const alert = await screen.findByTestId("bulk-error")
    expect(alert.textContent).toContain("1 of 2 failed")
    expect(alert.textContent).toContain("would supersede an active memory")
    expect(postedUrls(mock)).toHaveLength(2)
  })

  it("clears the selection", async () => {
    stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    fireEvent.click(checkboxFor(container, "c1"))
    fireEvent.click(await screen.findByRole("button", { name: /clear/i }))

    await vi.waitFor(() => {
      expect(screen.queryByTestId("bulk-bar")).toBeNull()
    })
  })
})
