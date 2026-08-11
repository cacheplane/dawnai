import type { MemoryRecord } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryGrid } from "../../src/components/memory/memory-grid"

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

  it("clicking a column header sorts the rows by that column", () => {
    const { container } = render(
      <MemoryGrid
        records={[
          record({ id: "a", content: "banana" }),
          record({ id: "b", content: "apple" }),
          record({ id: "c", content: "cherry" }),
        ]}
        onSelect={vi.fn()}
      />,
    )
    expect(columnText(container, "content")).toEqual(["banana", "apple", "cherry"])

    const header = headerFor(container, "content")
    fireEvent.click(header)
    expect(columnText(container, "content")).toEqual(["cherry", "banana", "apple"])
    expect(header.getAttribute("aria-sort")).toBe("descending")

    fireEvent.click(header)
    expect(columnText(container, "content")).toEqual(["apple", "banana", "cherry"])
    expect(header.getAttribute("aria-sort")).toBe("ascending")
  })

  it("keeps the sort when a poll hands down a fresh records array", () => {
    const records = [
      record({ id: "a", content: "banana" }),
      record({ id: "b", content: "apple" }),
      record({ id: "c", content: "cherry" }),
    ]
    const { container, rerender } = render(<MemoryGrid records={records} onSelect={vi.fn()} />)
    fireEvent.click(headerFor(container, "content"))
    expect(columnText(container, "content")).toEqual(["cherry", "banana", "apple"])

    // Live mode refetches every 2s; each response is a new array of equal records.
    rerender(<MemoryGrid records={records.map((rec) => ({ ...rec }))} onSelect={vi.fn()} />)
    expect(columnText(container, "content")).toEqual(["cherry", "banana", "apple"])
    expect(headerFor(container, "content").getAttribute("aria-sort")).toBe("descending")
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
})
