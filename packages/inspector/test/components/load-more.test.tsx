import type { MemoryRecord } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"
import { LoadMoreFooter } from "../../src/components/memory/load-more-footer"

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("LoadMoreFooter", () => {
  it("quotes the loaded count against the matching total", () => {
    render(
      <LoadMoreFooter
        state="available"
        loaded={200}
        total={5432}
        onLoadMore={vi.fn()}
        browseOnlyReason={undefined}
      />,
    )
    expect(screen.getByRole("button").textContent).toBe("Load more — 200 of 5,432 loaded")
  })

  it("stays mounted and focusable when everything is loaded", () => {
    // Unmounting it would drop keyboard focus to <body> at the exact moment the
    // user finished paging.
    render(
      <LoadMoreFooter
        state="exhausted"
        loaded={137}
        total={137}
        onLoadMore={vi.fn()}
        browseOnlyReason={undefined}
      />,
    )
    const button = screen.getByRole("button")
    expect(button.textContent).toBe("All 137 loaded")
    expect(button.getAttribute("aria-disabled")).toBe("true")
    expect(button.hasAttribute("disabled")).toBe(false)
    expect(button.tabIndex).toBe(0)
  })

  it("explains the resident cap instead of silently refusing", () => {
    render(
      <LoadMoreFooter
        state="at-cap"
        loaded={1000}
        total={5432}
        onLoadMore={vi.fn()}
        browseOnlyReason={undefined}
      />,
    )
    const button = screen.getByRole("button")
    expect(button.textContent).toBe("First 1,000 of 5,432 loaded")
    expect(button.getAttribute("aria-disabled")).toBe("true")
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toMatch(/narrow the filters/i)
  })

  it("does not look active while there is no answer for it to extend", () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreFooter
        state="unavailable"
        loaded={200}
        total={5432}
        onLoadMore={onLoadMore}
        browseOnlyReason={undefined}
      />,
    )
    const button = screen.getByRole("button")
    expect(button.getAttribute("aria-disabled")).toBe("true")
    // `Button`'s base class styles `disabled:` only, and this control is never
    // natively `disabled` — without an `aria-disabled`-keyed rule the inactive
    // states render identically to the active one and still answer hover.
    expect(button.className).toContain("aria-disabled:opacity-50")
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toMatch(/answer to extend/i)
    fireEvent.click(button)
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it("treats an empty browse-only reason as no reason at all", () => {
    // One normalization feeds every branch. Read through two different guards, `""`
    // strips the counts off the label AND leaves the control active with nothing
    // rendered to explain the missing numbers.
    const onLoadMore = vi.fn()
    render(
      <LoadMoreFooter
        state="available"
        loaded={200}
        total={5432}
        onLoadMore={onLoadMore}
        browseOnlyReason=""
      />,
    )
    const button = screen.getByRole("button")
    expect(button.textContent).toBe("Load more — 200 of 5,432 loaded")
    expect(button.getAttribute("aria-disabled")).toBe(null)
    fireEvent.click(button)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it("does not call onLoadMore when it is not available", () => {
    const onLoadMore = vi.fn()
    render(
      <LoadMoreFooter
        state="exhausted"
        loaded={10}
        total={10}
        onLoadMore={onLoadMore}
        browseOnlyReason={undefined}
      />,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it("carries a browse-only reason when one is supplied", () => {
    render(
      <LoadMoreFooter
        state="available"
        loaded={200}
        total={5432}
        onLoadMore={vi.fn()}
        browseOnlyReason="Not applied while searching"
      />,
    )
    const button = screen.getByRole("button")
    expect(button.getAttribute("aria-disabled")).toBe("true")
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toBe("Not applied while searching")
  })
})

describe("load-more in the page", () => {
  /** `total` is the MATCHING population the list route reports, independent of how
   *  many records either window carries — passing one equal to `first.length` is what
   *  puts the footer in a state other than `"available"` on the very first response. */
  function stubPages(first: MemoryRecord[], second: MemoryRecord[], total = 3) {
    const mock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes("/api/memory/stats"))
        return jsonResponse({
          total: 3,
          byStatus: { active: 3 },
          byKind: { semantic: 3 },
          byNamespace: { "route=/notes": 3 },
          bySourceType: { tool: 3 },
        })
      if (u.includes("/api/memory/list")) {
        // Which window is being asked for is read off `offset`, because that is what
        // the shipped client sends. The route ALSO accepts a keyset `cursor` and every
        // page carries a `continuation` (see api.e2e.test.ts), but `browseSearchParams`
        // never sends one and `BrowsePageResponse` does not carry one — so a
        // cursor-keyed stub would answer a question the client never asks and hand back
        // the first page forever.
        const offset = new URL(u, "http://localhost").searchParams.get("offset")
        return jsonResponse(
          offset !== null && offset !== "0"
            ? { records: second, total, continuation: null }
            : { records: first, total, continuation: "cur-1" },
        )
      }
      return jsonResponse({ groups: [] })
    })
    vi.stubGlobal("fetch", mock)
    return { mock }
  }

  it("lives OUTSIDE the grid element and after it in the document", async () => {
    // The scroll viewport IS the role="grid" element: a loose button inside it
    // corrupts the grid's owned children, and virtualization can unmount a
    // focused in-viewport node out from under the user.
    stubPages([record({ id: "a" })], [])
    const { container } = render(<ListPage />)
    await screen.findByText("content a")
    // Either role: the surface is a `treegrid` while grouped by namespace and a
    // `grid` when flat. The claim below is about the footer's PLACEMENT, which
    // holds for both.
    const grid = container.querySelector('[role="grid"],[role="treegrid"]')
    const footer = screen.getByTestId("load-more-footer").querySelector("button")
    if (!grid || !footer) throw new Error("grid or footer missing")
    expect(grid.contains(footer)).toBe(false)
    expect(grid.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("quotes the page's own loaded count against the page's own matching total", async () => {
    // The seam between `loadMoreState` and the footer. Both sides are unit-covered;
    // only the rendered label proves the page hands each prop the value it names —
    // `state`, `loaded` and `total` can each be replaced by a constant without this.
    stubPages([record({ id: "a" })], [])
    render(<ListPage />)
    await screen.findByText("content a")
    expect(within(screen.getByTestId("load-more-footer")).getByRole("button").textContent).toBe(
      "Load more — 1 of 3 loaded",
    )
  })

  it("stops offering more once the window already holds the whole answer", async () => {
    // The other direction of `state`: pinned to a constant `"available"` the mount
    // site still passes every test above, because in those fixtures `"available"` is
    // the true value. Here it is not.
    stubPages([record({ id: "a" })], [], 1)
    render(<ListPage />)
    await screen.findByText("content a")
    expect(within(screen.getByTestId("load-more-footer")).getByRole("button").textContent).toBe(
      "All 1 loaded",
    )
  })

  it("appends the next window and keeps the rows already loaded", async () => {
    stubPages(
      [record({ id: "a" }), record({ id: "b" })],
      [record({ id: "b" }), record({ id: "c" })],
    )
    render(<ListPage />)
    await screen.findByText("content a")
    fireEvent.click(within(screen.getByTestId("load-more-footer")).getByRole("button"))
    // `findByText`/`getByText` throw on a miss, so the query IS the assertion here.
    await screen.findByText("content c")
    screen.getByText("content a")
    // "b" arrived in both windows — an expiry between the two requests shifts every
    // later offset up by one and re-emits the row on the seam. It must appear once.
    expect(screen.getAllByText("content b")).toHaveLength(1)
  })

  it("asks for the window that starts after the rows already resident", async () => {
    // The plan wrote this as "sends the newest continuation as the cursor". The
    // shipped client does not walk keyset cursors: `loadMoreWindow` builds
    // `{limit, offset: residentCount}` and `browseSearchParams` sends exactly those
    // two. The subject of the test is unchanged — the second request must not re-ask
    // for the rows already on screen — but it is asserted in the protocol that ships.
    const { mock } = stubPages([record({ id: "a" })], [record({ id: "c" })])
    render(<ListPage />)
    await screen.findByText("content a")
    fireEvent.click(within(screen.getByTestId("load-more-footer")).getByRole("button"))
    await screen.findByText("content c")
    const offsets = mock.mock.calls
      .map((call) => new URL(String(call[0]), "http://localhost"))
      .filter((u) => u.pathname.includes("/api/memory/list"))
      .map((u) => u.searchParams.get("offset"))
    expect(offsets).toEqual(["0", "1"])
  })
})
