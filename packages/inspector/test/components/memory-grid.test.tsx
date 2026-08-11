import type { MemoryRecord } from "@dawn-ai/memory"
import type { ColumnFilter, FilterOperator } from "@pretable/react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { COLUMNS, MemoryGrid } from "../../src/components/memory/memory-grid"
import { toBrowseQuery } from "../../src/components/memory/to-browse-query"

/** Operator NAMES in declared order, not the menu's English: what these tests
 *  protect is that every offered operator has a `toBrowseQuery` arm, and those
 *  tables are keyed by name. Asserting pretable's label copy would redden this
 *  file on an upstream wording change that breaks nothing. */
const OFFERED_OPERATORS = {
  status: ["isAnyOf", "isNoneOf"],
  content: ["contains", "notContains", "equals", "notEquals", "startsWith", "endsWith"],
  namespace: ["equals", "startsWith"],
  kind: ["isAnyOf", "isNoneOf"],
  confidence: ["equals", "notEquals", "gt", "gte", "lt", "lte", "between"],
  updated: ["on", "before", "after", "dateBetween"],
} as const satisfies Record<string, readonly FilterOperator[]>

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

/** Text of every cell in one column, top row first — the rendered row order. */
function columnText(container: HTMLElement, columnId: string): string[] {
  return [
    ...container.querySelectorAll(`[role="gridcell"][data-pretable-column-id="${columnId}"]`),
  ].map((cell) => cell.textContent ?? "")
}

function headerFor(container: HTMLElement, label: string): HTMLElement {
  const header = [...container.querySelectorAll('[role="columnheader"]')].find((el) =>
    el.textContent?.startsWith(label),
  )
  if (!header) throw new Error(`no column header for ${label}`)
  return header as HTMLElement
}

/** Leaves the keyboard on one row's cell and returns it. Pointer-down moves the
 *  grid's focus without activating the row; a click does both, and activation is
 *  what the callers are testing. Which key walks focus in from outside the grid
 *  is pretable's contract, not the Inspector's — deliberately not asserted. */
function focusRow(container: HTMLElement, id: string): HTMLElement {
  const cell = container.querySelector<HTMLElement>(
    `[data-pretable-row][data-pretable-row-id="${id}"] [role="gridcell"]`,
  )
  if (!cell) throw new Error(`no row for ${id}`)
  fireEvent.pointerDown(cell, { button: 0, pointerId: 1 })
  expect(document.activeElement).toBe(cell)
  return cell
}

afterEach(cleanup)

describe("MemoryGrid", () => {
  it("renders a row per record", () => {
    const { container } = render(
      <MemoryGrid
        records={[record({ id: "a", content: "acme threshold is 750" }), record({ id: "b" })]}
        onSelect={vi.fn()}
      />,
    )
    expect(columnText(container, "content")).toEqual(["acme threshold is 750", "content b"])
    expect(screen.getAllByText("route=/notes")).toHaveLength(2)
  })

  it("clicking a row selects that record", () => {
    const onSelect = vi.fn()
    render(
      <MemoryGrid
        records={[record({ id: "a" }), record({ id: "b", content: "second row" })]}
        onSelect={onSelect}
      />,
    )
    fireEvent.click(screen.getByText("second row"))
    expect(onSelect.mock.calls).toEqual([["b"]])
  })

  it("Enter activates the focused row", () => {
    const onSelect = vi.fn()
    const { container } = render(
      <MemoryGrid records={[record({ id: "a" }), record({ id: "b" })]} onSelect={onSelect} />,
    )
    const cell = focusRow(container, "a")
    expect(onSelect.mock.calls).toEqual([])
    fireEvent.keyDown(cell, { key: "Enter" })
    expect(onSelect.mock.calls).toEqual([["a"]])
  })

  it("Space activates the focused row too", () => {
    const onSelect = vi.fn()
    const { container } = render(
      <MemoryGrid records={[record({ id: "a" }), record({ id: "b" })]} onSelect={onSelect} />,
    )
    const cell = focusRow(container, "b")
    fireEvent.keyDown(cell, { key: " " })
    expect(onSelect.mock.calls).toEqual([["b"]])
  })

  // These two drive sorting through `confidence` rather than `content` because
  // `content` is deliberately unsortable — `BrowseSortField` has no content
  // field. Which column carries the click is incidental to both; the row order
  // is still read off the content cells.
  it("clicking a column header sorts the rows by that column", () => {
    const { container } = render(
      <MemoryGrid
        records={[
          record({ id: "a", content: "middle", confidence: 0.5 }),
          record({ id: "b", content: "lowest", confidence: 0.1 }),
          record({ id: "c", content: "highest", confidence: 0.9 }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    expect(columnText(container, "content")).toEqual(["middle", "lowest", "highest"])

    const header = headerFor(container, "confidence")
    fireEvent.click(header)
    expect(columnText(container, "content")).toEqual(["highest", "middle", "lowest"])
    expect(header.getAttribute("aria-sort")).toBe("descending")

    fireEvent.click(header)
    expect(columnText(container, "content")).toEqual(["lowest", "middle", "highest"])
    expect(header.getAttribute("aria-sort")).toBe("ascending")
  })

  it("keeps the sort when a poll hands down a fresh records array", () => {
    const records = [
      record({ id: "a", content: "middle", confidence: 0.5 }),
      record({ id: "b", content: "lowest", confidence: 0.1 }),
      record({ id: "c", content: "highest", confidence: 0.9 }),
    ]
    const { container, rerender } = render(<MemoryGrid records={records} onSelect={vi.fn()} />)
    fireEvent.click(headerFor(container, "confidence"))
    expect(columnText(container, "content")).toEqual(["highest", "middle", "lowest"])

    // Live mode refetches every 2s; each response is a new array of equal records.
    rerender(<MemoryGrid records={records.map((rec) => ({ ...rec }))} onSelect={vi.fn()} />)
    expect(columnText(container, "content")).toEqual(["highest", "middle", "lowest"])
    expect(headerFor(container, "confidence").getAttribute("aria-sort")).toBe("descending")
  })

  it("sorts the updated column chronologically, not by its displayed text", () => {
    const { container } = render(
      <MemoryGrid
        records={[
          record({ id: "a", content: "older", updatedAt: "2026-01-02T00:00:00.000Z" }),
          record({ id: "b", content: "newest", updatedAt: "2026-11-30T00:00:00.000Z" }),
          record({ id: "c", content: "middle", updatedAt: "2026-03-04T00:00:00.000Z" }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(headerFor(container, "updated"))
    expect(columnText(container, "content")).toEqual(["newest", "middle", "older"])
  })

  it("tints candidate rows and strikes through superseded ones", () => {
    const { container } = render(
      <MemoryGrid
        records={[
          record({ id: "a", content: "pending", status: "candidate" }),
          record({ id: "b", content: "replaced", status: "superseded" }),
          record({ id: "c", content: "live", status: "active" }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    // Status styling lives on the CELLS, not the row: pretable's grid.css paints
    // every cell with an opaque background, which would cover a row-level tint.
    const cellClasses = (id: string) =>
      [
        ...container.querySelectorAll(
          `[data-pretable-row][data-pretable-row-id="${id}"] [role="gridcell"]`,
        ),
      ].map((cell) => cell.className)
    // `every`/`some` over an empty list would pass without testing anything, and
    // the selector hangs off pretable-owned attributes that can be renamed.
    expect(cellClasses("a").length).toBeGreaterThan(0)
    expect(cellClasses("b").length).toBeGreaterThan(0)
    expect(cellClasses("c").length).toBeGreaterThan(0)
    expect(cellClasses("a").every((cls) => cls.includes("amber"))).toBe(true)
    expect(cellClasses("b").every((cls) => cls.includes("line-through"))).toBe(true)
    expect(cellClasses("c").some((cls) => cls.includes("line-through"))).toBe(false)
  })

  it.each(Object.entries(OFFERED_OPERATORS))(
    "offers only the operators the store can honor, on %s",
    (columnId, operators) => {
      // Pretable appends isEmpty/isNotEmpty to every type by default and no
      // BrowseFilter arm expresses them, so an unpruned menu would show two
      // controls the server ignores.
      render(
        <MemoryGrid
          records={[record({ id: "a" })]}
          onSelect={vi.fn()}
          dataState={{ phase: "idle" }}
        />,
      )
      fireEvent.click(screen.getByRole("button", { name: `Filter ${columnId}` }))
      const dialog = screen.getByRole("dialog", { name: `Filter ${columnId}` })
      const select = within(dialog).getByRole("combobox")
      expect([...select.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
        ...operators,
      ])
    },
  )

  it("declares no funnel operator the browse query cannot map", () => {
    // `filterOperators` and `to-browse-query.ts`'s operator tables are two hand-kept
    // lists of the same set, and an operator with no arm THROWS on the user's click
    // — a runtime failure no menu assertion would reach. Values here are only
    // well-formed enough to get past the shape guards to the operator itself.
    const single: Record<string, ColumnFilter["value"]> = {
      status: ["active"],
      kind: ["semantic"],
      namespace: "route=/notes",
      content: "acme",
      confidence: 0.5,
      updated: "2026-07-13",
    }
    const range: Record<string, ColumnFilter["value"]> = {
      confidence: [0, 1],
      updated: ["2026-07-01", "2026-07-31"],
    }
    const filterable = COLUMNS.filter((column) => column.filterable)
    expect(filterable.map((column) => column.id)).toEqual(Object.keys(OFFERED_OPERATORS))
    for (const column of filterable) {
      // An OMITTED list is pretable's full menu for the type, isEmpty included.
      const operators = column.filterOperators ?? []
      expect(operators.length).toBeGreaterThan(0)
      for (const operator of operators) {
        const value =
          operator === "between" || operator === "dateBetween"
            ? range[column.id]
            : single[column.id]
        // A missing sample would make this column's sweep vacuous, not lenient.
        if (value === undefined) throw new Error(`no sample value for ${column.id}/${operator}`)
        expect(() => toBrowseQuery({ [column.id]: { operator, value } }, [])).not.toThrow()
      }
    }
  })

  it("offers no funnel at all when the rows are a search sample", () => {
    // Search hands down a ranked per-namespace top-N with no server authority
    // behind it, so an engine-applied funnel would narrow the loaded sample and
    // present that as the answer. Browse is the filtering surface.
    render(<MemoryGrid records={[record({ id: "a" }), record({ id: "b" })]} onSelect={vi.fn()} />)
    expect(screen.queryAllByRole("button", { name: /^Filter / })).toEqual([])
  })

  it("never emits sort intent for content — the store has no content sort field", () => {
    const onSortChange = vi.fn()
    const { container } = render(
      <MemoryGrid
        records={[record({ id: "a" }), record({ id: "b" })]}
        onSelect={vi.fn()}
        onSortChange={onSortChange}
      />,
    )
    fireEvent.click(headerFor(container, "content"))
    // The contract: silence. A sortable column fires on the identical click —
    // `confidence` does, in this file's own header-sort tests.
    expect(onSortChange).not.toHaveBeenCalled()
    // KNOWN DEFECT, pinned so it stays visible rather than endorsed. @pretable/react
    // 0.3.0 renders EVERY header as `<button aria-label="Sort …" aria-sort="none">`
    // and only declines inside its own click handler, so a screen-reader user is
    // offered "Sort content, button", activates it, and gets nothing. It is not part
    // of what this test protects — delete the line once pretable stops labelling a
    // non-sortable header as a sort control.
    expect(headerFor(container, "content").getAttribute("aria-sort")).toBe("none")
  })
})

function grid(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="grid"]')
  if (!el) throw new Error("no grid")
  return el
}

function bodyState(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-pretable-body-state]")
  if (!el) throw new Error("no body-state block")
  return el
}

/** The live region is portaled to `document.body`, and the surface debounces every
 *  announcement, so a caller must run the timers before reading it. */
function announcement(): string {
  return document.querySelector("[data-pretable-live-region]")?.textContent ?? ""
}

describe("MemoryGrid lifecycle", () => {
  it("is untouched when dataState is omitted", () => {
    const { container } = render(
      <MemoryGrid
        records={[
          record({ id: "a", content: "apple", confidence: 0.2 }),
          record({ id: "b", content: "banana", confidence: 0.8 }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    expect(container.querySelector("[data-pretable-data-phase]")).toBeNull()
    expect(container.querySelector("[data-pretable-body-state]")).toBeNull()
    // Loaded rows plus the header row — the grid speaks only for what it holds.
    expect(grid(container).getAttribute("aria-rowcount")).toBe("3")
    // Through `confidence`: engine sort authority is the point, not the column,
    // and `content` is unsortable by design.
    fireEvent.click(headerFor(container, "confidence"))
    expect(columnText(container, "content")).toEqual(["banana", "apple"])
    expect(headerFor(container, "confidence").getAttribute("aria-sort")).toBe("descending")
  })

  it("shows a loading block before the first answer", () => {
    const { container } = render(
      <MemoryGrid records={[]} onSelect={vi.fn()} dataState={{ phase: "loading" }} />,
    )
    expect(bodyState(container).getAttribute("data-pretable-body-state")).toBe("loading")
    expect(screen.getByTestId("browse-loading").textContent).toBe("Loading memories…")
    expect(grid(container).getAttribute("data-pretable-data-phase")).toBe("loading")
  })

  it("shows the caller's empty copy, exactly once", () => {
    const { container } = render(
      <MemoryGrid
        records={[]}
        onSelect={vi.fn()}
        dataState={{ phase: "idle" }}
        emptyMessage="No memories match these filters."
      />,
    )
    expect(bodyState(container).getAttribute("data-pretable-body-state")).toBe("empty")
    expect(screen.getByTestId("browse-empty").textContent).toBe("No memories match these filters.")
    expect(screen.getAllByText("No memories match these filters.")).toHaveLength(1)
  })

  it("leaves a body block room to be legible when no rows give the grid height", () => {
    const { container } = render(
      <MemoryGrid records={[]} onSelect={vi.fn()} dataState={{ phase: "loading" }} />,
    )
    // The block is an overlay inset below the sticky header, so the grid's own
    // height is not what the block gets. jsdom computes no geometry; these are the
    // inline styles the surface lays itself out with.
    const available =
      Number.parseFloat(grid(container).style.height) -
      Number.parseFloat(bodyState(container).style.top)
    expect(available).toBeGreaterThanOrEqual(160)
  })

  it("renders a full-bleed error with a retry when nothing is loaded", () => {
    const onRetry = vi.fn()
    const { container } = render(
      <MemoryGrid
        records={[]}
        onSelect={vi.fn()}
        dataState={{ phase: "error", message: "no memory store configured" }}
        onRetry={onRetry}
      />,
    )
    expect(bodyState(container).getAttribute("data-pretable-body-state")).toBe("error")
    const block = screen.getByTestId("browse-error")
    expect(block.textContent).toContain("no memory store configured")
    fireEvent.click(within(block).getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("marks a failure over intact rows as a strip, not a full-bleed error", () => {
    const onRetry = vi.fn()
    const { container } = render(
      <MemoryGrid
        records={[record({ id: "a", content: "banana" }), record({ id: "b", content: "apple" })]}
        onSelect={vi.fn()}
        dataState={{ phase: "error", message: "list failed" }}
        onRetry={onRetry}
      />,
    )
    // A query change whose initial fetch fails leaves the PREVIOUS question's rows
    // on screen, so the failure is a strip above them rather than a block instead
    // of them — and a test that cannot tell the two apart cannot catch the swap.
    expect(bodyState(container).getAttribute("data-pretable-body-state")).toBe("error-strip")
    expect(screen.queryByTestId("browse-error")).toBeNull()
    const strip = screen.getByTestId("browse-error-strip")
    expect(strip.textContent).toContain("list failed")
    expect(columnText(container, "content")).toEqual(["banana", "apple"])
    fireEvent.click(within(strip).getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("claims the server's population, never the loaded window", () => {
    const records = [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })]
    const { container } = render(
      <MemoryGrid
        records={records}
        onSelect={vi.fn()}
        dataState={{ phase: "idle" }}
        resultMeta={{ total: { kind: "exact", count: 4322 } }}
      />,
    )
    expect(grid(container).getAttribute("aria-rowcount")).toBe("4323")

    cleanup()
    const withoutMeta = render(
      <MemoryGrid records={records} onSelect={vi.fn()} dataState={{ phase: "idle" }} />,
    )
    // Unknown, not 4: under server authority the loaded rows are a window, and
    // reporting them as the population is the lie the whole design exists to stop.
    expect(grid(withoutMeta.container).getAttribute("aria-rowcount")).toBe("-1")
  })

  it("browse headers do not sort — the rows are a server-selected sample", () => {
    const { container } = render(
      <MemoryGrid
        records={[
          record({ id: "a", content: "banana" }),
          record({ id: "b", content: "apple" }),
          record({ id: "c", content: "cherry" }),
        ]}
        onSelect={vi.fn()}
        dataState={{ phase: "idle" }}
        resultMeta={{ total: { kind: "exact", count: 4322 } }}
      />,
    )
    const header = headerFor(container, "content")
    fireEvent.click(header)
    expect(columnText(container, "content")).toEqual(["banana", "apple", "cherry"])
    expect(header.getAttribute("aria-sort")).toBe("none")
  })

  it("announces the settled result in the app's own words", () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(
        <MemoryGrid records={[]} onSelect={vi.fn()} dataState={{ phase: "loading" }} />,
      )
      rerender(
        <MemoryGrid
          records={[record({ id: "a" })]}
          onSelect={vi.fn()}
          dataState={{ phase: "idle" }}
          resultMeta={{ total: { kind: "exact", count: 4322 } }}
        />,
      )
      act(() => {
        vi.runAllTimers()
      })
      expect(announcement()).toBe("1 loaded of 4,322 matching.")
    } finally {
      vi.useRealTimers()
    }
  })

  it("announces a failure in the app's own words", () => {
    vi.useFakeTimers()
    try {
      render(
        <MemoryGrid
          records={[]}
          onSelect={vi.fn()}
          dataState={{ phase: "error", message: "list failed" }}
        />,
      )
      act(() => {
        vi.runAllTimers()
      })
      expect(announcement()).toBe("Could not load memories: list failed")
    } finally {
      vi.useRealTimers()
    }
  })
})
