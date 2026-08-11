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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const records = [record({ id: "a" }), record({ id: "b" })]

const STATS = {
  total: 2,
  byStatus: { active: 2 },
  byKind: { semantic: 2 },
  byNamespace: { "route=/notes": 2 },
  bySourceType: { tool: 2 },
}

/** `total` is the MATCHING population, not the window size — one larger than the
 *  records handed back is what leaves the load-more control in its ACTIVE state,
 *  which is the only state that can prove the control is live in a given view. */
function stubApi(total = 3) {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes("/api/memory/stats")) return jsonResponse(STATS)
    if (u.includes("/api/memory/list")) return jsonResponse({ records, total, continuation: null })
    return jsonResponse({ groups: [{ namespace: "route=/notes", records: [record({ id: "a" })] }] })
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

type ApiMock = ReturnType<typeof stubApi>

function urlsTo(mock: ApiMock, path: string): URL[] {
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((u) => u.includes(path))
    .map((u) => new URL(u, "http://localhost"))
}

/** Pretable portals its live region to `document.body`, so it is OUTSIDE the
 *  hidden browse region and no `within()` scope reaches it. */
function liveText(): string {
  return [...document.querySelectorAll("[data-pretable-live-region]")]
    .map((el) => el.textContent ?? "")
    .join(" | ")
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function searchBox(): HTMLElement {
  return screen.getByRole("searchbox", { name: "Search memories" })
}

async function typeSearch(value: string) {
  fireEvent.change(searchBox(), { target: { value } })
  await vi.waitFor(() => expect(searchBox()).toHaveProperty("value", value))
}

async function startSearch() {
  await typeSearch("acme")
  await vi.waitFor(() =>
    expect(screen.getByTestId("browse-region").hasAttribute("hidden")).toBe(true),
  )
}

function facet(): HTMLElement {
  return within(screen.getByRole("navigation")).getByRole("button", { name: /route=\/notes/ })
}

/** Both roles: the surface is a `treegrid` while grouped and a `grid` when flat,
 *  and the namespace grouping this page asks for makes that depend on the facet. */
function browseGrid(): Element | null {
  return screen.getByTestId("browse-region").querySelector('[role="grid"],[role="treegrid"]')
}

function scopeNote(): string {
  return screen.getByTestId("browse-scope-note").textContent ?? ""
}

/** Open the status funnel WITHOUT a pointerdown anywhere else first. Pretable's own
 *  popovers close on an outside `pointerdown`, so a mouse user usually dismisses one
 *  on the way to the search box or the view toggle; a keyboard user never does, and
 *  `fireEvent.click` reproduces that — it dispatches `click` alone. */
async function openStatusFunnel(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Filter status" }))
  return await screen.findByRole("dialog", { name: "Filter status" })
}

/** Every pretable popover in the document, found by the attribute rather than by role
 *  so this does not have to agree with the role each one picks. They portal to
 *  `<body>`, so neither a `within()` scope nor the `hidden` attribute on the browse
 *  region reaches them — which is the whole bug. */
function popovers(): Element[] {
  return [...document.querySelectorAll("[data-pretable-popover]")]
}

describe("view scope", () => {
  it("keeps the browse grid mounted while search results are showing", async () => {
    // Same element ⇒ same engine, and the engine is what owns the selection, the
    // focused cell and the measured row heights. Unmounting it would discard all
    // three; the scroll offset it also owns is pinned separately below.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    const grid = browseGrid()
    expect(grid).not.toBeNull()
    await startSearch()
    expect(browseGrid()).toBe(grid)
  })

  it("keeps the browse grid mounted while the timeline is showing", async () => {
    // Flow 10 covers BOTH boundaries. The timeline renders the same rows from the
    // same hook, so unmounting the grid here loses exactly what the search
    // boundary is careful to keep.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    const grid = browseGrid()
    expect(grid).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    await screen.findByTestId("timeline-region")
    expect(screen.getByTestId("browse-region").hasAttribute("hidden")).toBe(true)
    expect(browseGrid()).toBe(grid)
  })

  it("closes an open column popover when a search hides the browse region", async () => {
    // The funnel lives inside the browse region, but its popover is PORTALED to
    // `<body>` — so `hidden` on the region takes the funnel out of the a11y tree and
    // leaves the popover it opened standing over the search results: undimmed, with
    // no `aria-disabled` and no description, and fully interactive. Every other
    // ignored control on this page is marked; this one would be the sole exception,
    // and the loudest, because it is a floating panel rather than a header button.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await openStatusFunnel()
    searchBox().focus()
    await startSearch()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(popovers()).toHaveLength(0)
    // The dismissal must cost nothing: the user is mid-keystroke in this box, and a
    // close that focused the trigger it acts on would take the caret out from under
    // them. (The other tempting route, a synthetic Escape at `document`, leaves focus
    // alone but is rejected for a different reason — `DetailSheet` listens for Escape
    // on `window`, so it would close an open sheet as a side effect.)
    expect(document.activeElement).toBe(searchBox())
  })

  it("closes an open column popover when the timeline hides the browse region", async () => {
    // The boundary this fix is FOR: the timeline used to unmount the grid, which took
    // the popover with it. Hiding instead of unmounting is what made this reachable.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await openStatusFunnel()
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    await screen.findByTestId("timeline-region")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(popovers()).toHaveLength(0)
  })

  it("does not reopen the popover when the browse region comes back", async () => {
    // Closed, not stashed. A popover restored on reveal would reappear pointing at a
    // funnel the user last touched several steps ago — and pretable positions it from
    // the anchor's rect at OPEN time, which `display: none` has since zeroed.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await openStatusFunnel()
    await startSearch()
    await typeSearch("")
    await vi.waitFor(() =>
      expect(screen.getByTestId("browse-region").hasAttribute("hidden")).toBe(false),
    )
    expect(popovers()).toHaveLength(0)
  })

  it("puts the browse viewport back where it was when the search clears", async () => {
    // `hidden` is `display: none`, which destroys the scroll box: a real browser
    // hands the element back at 0 while the engine still holds the old offset, so
    // the virtualizer paints rows for that offset over a viewport at the top.
    // jsdom has no layout and keeps whatever it was told, so the browser's reset is
    // performed EXPLICITLY here — what this pins is the restore, not the loss.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    const viewport = screen
      .getByTestId("browse-region")
      .querySelector<HTMLElement>("[data-pretable-scroll-viewport]")
    if (!viewport) throw new Error("no scroll viewport")
    viewport.scrollTop = 20
    fireEvent.scroll(viewport)
    await startSearch()
    viewport.scrollTop = 0
    await typeSearch("")
    await vi.waitFor(() =>
      expect(screen.getByTestId("browse-region").hasAttribute("hidden")).toBe(false),
    )
    expect(viewport.scrollTop).toBe(20)
  })

  it("does not read the hidden browse population out to assistive tech", async () => {
    // The live region is portaled to <body>, outside the hidden region, and its
    // announcement effect has no visibility gate — while the visible status bar is
    // deliberately withheld during a search. An unfrozen phase would hand AT users
    // a count for a population nobody can see, at the one moment sighted users are
    // protected from it.
    const mock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes("/api/memory/stats")) return jsonResponse(STATS)
      if (u.includes("/api/memory/list")) {
        return u.includes("namespace=")
          ? jsonResponse({ records: [record({ id: "a" })], total: 900, continuation: null })
          : jsonResponse({ records, total: 2, continuation: null })
      }
      return jsonResponse({ groups: [] })
    })
    vi.stubGlobal("fetch", mock)
    render(<ListPage />)
    await screen.findByText("content a")
    await startSearch()
    // A facet click still moves the browse query during a search — that is the
    // point of leaving the facet active — so the hidden grid really does refetch.
    fireEvent.click(facet())
    await vi.waitFor(() =>
      expect(
        urlsTo(mock as ApiMock, "/api/memory/list").some((u) => u.searchParams.has("namespace")),
      ).toBe(true),
    )
    // Longer than pretable's 500ms announcement debounce, so a suppressed
    // announcement is distinguishable from one that has simply not landed yet.
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(liveText()).not.toMatch(/900 matching/)
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
    // `Button`-style dimming is keyed on `aria-disabled`, not on a `searching`
    // branch: an inactive control that renders identically to an active one and
    // still answers hover is the dishonesty this whole task removes.
    expect(timeline.className).toContain("aria-disabled:opacity-50")
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

  it("dims the timeline window select while it is ignoring changes", async () => {
    // Reached by searching from INSIDE the timeline — the toggle refuses the other
    // direction. The select opens, accepts a value and snaps back, so without a
    // visual signal it is the sharpest looks-live-but-ignored control on the page.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    await startSearch()
    const select = screen.getByLabelText("Window")
    expect(select.getAttribute("aria-disabled")).toBe("true")
    expect(select.className).toContain("aria-disabled:opacity-50")
    fireEvent.change(select, { target: { value: "7d" } })
    expect(select).toHaveProperty("value", "all")
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

  it("keeps the load-more control live in the timeline, which pages the same rows", async () => {
    // `TimelineView` renders `browse.rows`, so load-more extends exactly what is on
    // screen. Unmounting it there leaves a status bar quoting a population with no
    // way to reach it — and disabling it would claim it does not apply.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    await screen.findByTestId("timeline-region")
    const button = within(screen.getByTestId("load-more-footer")).getByRole("button")
    expect(button.getAttribute("aria-disabled")).toBeNull()
  })

  it("names what search honours and what it drops, and the request agrees", async () => {
    // The note is the ONLY place the dropped column filters are mentioned: the
    // funnels that hold them are inside the hidden region, so their state is not
    // even visible to contradict the results on screen.
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    fireEvent.click(facet())
    await startSearch()
    await vi.waitFor(() => expect(urlsTo(mock, "/api/memory/search").length).toBeGreaterThan(0))
    const sent = urlsTo(mock, "/api/memory/search").at(-1)
    expect(sent?.searchParams.get("namespace")).toBe("route=/notes")
    expect(sent?.searchParams.get("filters")).toBeNull()
    expect(scopeNote()).toMatch(/namespace facet applies/i)
    expect(scopeNote()).toMatch(/column filters/i)
  })

  it("names the timeline window only in the view that has one", async () => {
    // A note listing a control the user cannot see reads as one more thing that
    // broke; the select exists only in the timeline. Asserted as whole sentences
    // because the variable clause is spliced between two JSX text nodes, where a
    // dropped space is invisible to a substring match.
    stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await startSearch()
    expect(scopeNote()).toBe(
      "Search ranks active memories, and the namespace facet applies to it. Column filters, the view toggle and the load-more control are not applied to search.",
    )
    await typeSearch("")
    fireEvent.click(screen.getByRole("button", { name: "timeline" }))
    await startSearch()
    expect(scopeNote()).toBe(
      "Search ranks active memories, and the namespace facet applies to it. Column filters, the view toggle, the timeline window and the load-more control are not applied to search.",
    )
  })

  it("keeps the namespace facet active — a click during a search re-scopes it", async () => {
    const mock = stubApi()
    render(<ListPage />)
    await screen.findByText("content a")
    await startSearch()
    await vi.waitFor(() => expect(urlsTo(mock, "/api/memory/search").length).toBeGreaterThan(0))
    expect(facet().getAttribute("aria-disabled")).toBeNull()
    fireEvent.click(facet())
    await vi.waitFor(() =>
      expect(
        urlsTo(mock, "/api/memory/search").some(
          (u) => u.searchParams.get("namespace") === "route=/notes",
        ),
      ).toBe(true),
    )
  })

  it("surfaces a browse failure the hidden grid can no longer show", async () => {
    // The grid's body-state block owns the error phase only while it is VISIBLE.
    // Behind a search it is in the document and unreadable, so the banner is the
    // failure's only channel — and the two retries are never on screen together
    // because the condition is exactly the one that hides the block.
    let fail = true
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes("/api/memory/stats")) return jsonResponse(STATS)
        if (u.includes("/api/memory/list")) {
          return fail
            ? jsonResponse({ error: "no memory store configured" }, 500)
            : jsonResponse({ records, total: 2, continuation: null })
        }
        return jsonResponse({ groups: [] })
      }),
    )
    render(<ListPage />)
    await screen.findByTestId("browse-error")
    expect(screen.queryByTestId("error-browse")).toBeNull()
    await startSearch()
    const entry = await screen.findByTestId("error-browse")
    expect(entry.textContent).toContain("no memory store configured")
    fail = false
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await vi.waitFor(() => expect(screen.queryByTestId("error-browse")).toBeNull())
  })
})
