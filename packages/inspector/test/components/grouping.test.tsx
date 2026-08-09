import type { MemoryRecord } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryGrid } from "../../src/components/memory/memory-grid"

/**
 * Looking at every namespace at once, a flat list buries which route a memory
 * came from in a column you have to read row by row. Grouping makes that the
 * structure of the list instead.
 */

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

const records = [
  record({ id: "n1", namespace: "route=/notes" }),
  record({ id: "c1", namespace: "route=/chat" }),
  record({ id: "n2", namespace: "route=/notes" }),
]

function groupLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-pretable-group-row]")].map(
    (row) => row.textContent ?? "",
  )
}

afterEach(cleanup)

describe("grouping by namespace", () => {
  it("renders one group per namespace when grouped", () => {
    const { container } = render(
      <MemoryGrid records={records} onSelect={vi.fn()} groupByNamespace />,
    )

    const labels = groupLabels(container)
    expect(labels).toHaveLength(2)
    expect(labels.join(" ")).toContain("route=/notes")
    expect(labels.join(" ")).toContain("route=/chat")
  })

  it("reports how many rows each group holds", () => {
    const { container } = render(
      <MemoryGrid records={records} onSelect={vi.fn()} groupByNamespace />,
    )

    const counts = [...container.querySelectorAll("[data-pretable-group-count]")].map(
      (el) => el.textContent,
    )
    // route=/notes has two records, route=/chat one.
    expect(counts.join(",")).toMatch(/2/)
    expect(counts.join(",")).toMatch(/1/)
  })

  it("still shows the underlying records", () => {
    render(<MemoryGrid records={records} onSelect={vi.fn()} groupByNamespace />)

    expect(screen.getByText("content n1")).toBeDefined()
    expect(screen.getByText("content c1")).toBeDefined()
  })

  it("collapses and expands a namespace", () => {
    render(<MemoryGrid records={records} onSelect={vi.fn()} groupByNamespace />)

    fireEvent.click(screen.getByRole("button", { name: "Collapse route=/notes" }))
    expect(screen.queryByText("content n1")).toBeNull()
    expect(screen.getByText("content c1")).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "Expand route=/notes" }))
    expect(screen.getByText("content n1")).toBeDefined()
  })

  it("reports selected row ids while grouped", () => {
    const onTickedChange = vi.fn()
    render(
      <MemoryGrid
        records={records}
        onSelect={vi.fn()}
        onTickedChange={onTickedChange}
        groupByNamespace
      />,
    )

    const notesRow = screen.getByRole("row", { name: /content n1/ })
    fireEvent.click(within(notesRow).getByRole("checkbox", { name: "Select row" }))

    expect(onTickedChange).toHaveBeenLastCalledWith(["n1"])
  })

  it("stays flat when grouping is off", () => {
    const { container } = render(<MemoryGrid records={records} onSelect={vi.fn()} />)

    expect(groupLabels(container)).toHaveLength(0)
    expect(container.querySelectorAll("[data-pretable-row]")).toHaveLength(3)
  })

  it("returns to a flat list when grouping is turned off", () => {
    const { container, rerender } = render(
      <MemoryGrid records={records} onSelect={vi.fn()} groupByNamespace />,
    )
    expect(groupLabels(container)).toHaveLength(2)

    rerender(<MemoryGrid records={records} onSelect={vi.fn()} />)

    expect(groupLabels(container)).toHaveLength(0)
    expect(container.querySelectorAll("[data-pretable-row]")).toHaveLength(3)
  })
})
