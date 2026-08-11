import type { MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
    if (u.includes("/api/memory/list"))
      return jsonResponse({ records, total: records.length, continuation: null })
    const one = records.find((r) => u.endsWith(`/api/memory/${r.id}`))
    if (one) return jsonResponse(one)
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

/** The grid's own element, identified by an attribute that survives the
 *  grid/treegrid role flip grouping causes — a `[role="grid"]` query goes null
 *  the moment the page groups, and an identity assertion against null passes
 *  while pinning nothing. Throws so a missing grid fails loudly. */
function gridElement(container: HTMLElement): Element {
  const grid = container.querySelector("[data-pretable-scroll-viewport]")
  if (!grid) throw new Error("no grid element")
  return grid
}

function selectAllCheckbox(container: HTMLElement): HTMLElement {
  const box = container.querySelector("[data-pretable-row-select-all]")
  if (!box) throw new Error("no select-all checkbox")
  return box as HTMLElement
}

function postedUrls(mock: ReturnType<typeof stubApi>): string[] {
  return mock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
    .map((call) => String(call[0]))
}

/** The `filters` predicate of every browse window asked for, in order. Funnels reach
 *  the server through this one param, so a bare "fetch was called" says nothing about
 *  whether the funnel click became a question — the mount already called fetch. */
function requestedFilters(mock: ReturnType<typeof stubApi>): string[] {
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((u) => u.includes("/api/memory/list"))
    .map((u) => new URL(u, "http://localhost").searchParams.get("filters") ?? "")
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

  it("a query change clears the selection without remounting the grid", async () => {
    // The old code bumped a `key` to throw the grid away, taking measured row
    // heights, focus and scroll with it. A datasetKey pivot clears exactly the
    // state that belonged to the old answer, and nothing else.
    const mock = stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")
    const grid = gridElement(container)
    fireEvent.click(checkboxFor(container, "c1"))
    expect(await screen.findByTestId("bulk-bar")).toBeDefined()

    fireEvent.click(await screen.findByRole("button", { name: "Filter status" }))
    const dialog = await screen.findByRole("dialog", { name: "Filter status" })
    const box = within(dialog)
      .getAllByRole("checkbox")
      .find((cb) => cb.closest("label")?.textContent?.includes("candidate"))
    if (!box) throw new Error("no candidate option")
    fireEvent.click(box)

    await vi.waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull())
    expect(gridElement(container)).toBe(grid)
    expect(requestedFilters(mock).some((f) => f.includes("candidate"))).toBe(true)
  })

  it("clearing the selection from the bulk bar keeps the same grid instance", async () => {
    stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")
    const grid = gridElement(container)
    fireEvent.click(checkboxFor(container, "c1"))
    const bar = await screen.findByTestId("bulk-bar")
    fireEvent.click(within(bar).getByRole("button", { name: /clear/i }))
    await vi.waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull())
    expect(gridElement(container)).toBe(grid)
    // Without the remount, dropping the page's `ticked` alone would hide the bar
    // and leave the box ticked — so the box is what proves the ENGINE cleared.
    expect(checkboxFor(container, "c1").getAttribute("aria-checked")).toBe("false")
  })

  it("withholds the bar while the rows on screen answer the previous query", async () => {
    // Between the question changing and the answer landing the OLD rows are still
    // on screen and still ticked. Acting on them is the ambiguity the design bans,
    // so the bar goes when the question changes, not when the answer arrives.
    let release: (() => void) | undefined
    let hold = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url)
        if (init?.method === "POST") return jsonResponse({ ok: true })
        if (u.includes("/api/memory/stats")) return jsonResponse(stats)
        if (u.includes("/api/memory/list")) {
          if (hold) {
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          return jsonResponse({ records, total: records.length, continuation: null })
        }
        return jsonResponse({ groups: [] })
      }),
    )
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")
    fireEvent.click(checkboxFor(container, "c1"))
    expect(await screen.findByTestId("bulk-bar")).toBeDefined()

    hold = true
    fireEvent.click(await screen.findByRole("button", { name: "Filter status" }))
    const dialog = await screen.findByRole("dialog", { name: "Filter status" })
    const box = within(dialog)
      .getAllByRole("checkbox")
      .find((cb) => cb.closest("label")?.textContent?.includes("candidate"))
    if (!box) throw new Error("no candidate option")
    fireEvent.click(box)

    await vi.waitFor(() => expect(release).toBeDefined())
    // The rows the selection was formed over are still the ones rendered.
    expect(screen.getByText("first candidate")).toBeDefined()
    expect(screen.queryByTestId("bulk-bar")).toBeNull()

    hold = false
    release?.()
    // And the answer landing does not bring it back, because by then the selection
    // itself is gone: `resultMeta.datasetKey` pivots on the FULFILLED revision, so
    // the engine drops the ticks as the new rows land. Waiting on the BOX going
    // unticked is what dates this to after the response was applied — c1 is in the
    // document the whole time, so waiting on the row's mere existence would resolve
    // on the first tick and re-assert the withheld-while-stale case above.
    await vi.waitFor(() =>
      expect(checkboxFor(container, "c1").getAttribute("aria-checked")).toBe("false"),
    )
    expect(screen.queryByTestId("bulk-bar")).toBeNull()
  })

  it("clears whole rows even when a cell was clicked first", async () => {
    // Opening a row's detail sheet is the page's primary gesture, and it parks the
    // engine's focus on the clicked cell. A clear that only COLLAPSES the selection
    // leaves that row spanning one column — an indeterminate row box and an
    // indeterminate select-all, with the bar that owned the clear already gone.
    stubApi()
    const { container } = render(<ListPage />)
    await screen.findByText("first candidate")

    fireEvent.click(screen.getByText("an active one"))
    fireEvent.click(await screen.findByLabelText("Close detail"))

    fireEvent.click(checkboxFor(container, "c1"))
    const bar = await screen.findByTestId("bulk-bar")
    fireEvent.click(within(bar).getByRole("button", { name: /clear/i }))
    await vi.waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull())

    expect(checkboxFor(container, "c1").getAttribute("aria-checked")).toBe("false")
    expect(checkboxFor(container, "a1").getAttribute("aria-checked")).toBe("false")
    expect(selectAllCheckbox(container).getAttribute("aria-checked")).toBe("false")
  })
})
