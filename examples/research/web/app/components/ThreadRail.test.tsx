import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import type { WorkbenchThread } from "../lib/thread-source"
import { ThreadRail, UNTITLED_THREAD_LABEL } from "./ThreadRail"

const noop = () => {}

const THREADS: readonly WorkbenchThread[] = [
  { id: "thread-a", title: "Agent architectures", lastActiveAt: 3 },
  { id: "thread-b", lastActiveAt: 2 },
  { id: "thread-c", title: "Quantum computing", lastActiveAt: 1 },
]

function render(props: Partial<Parameters<typeof ThreadRail>[0]> = {}): string {
  return renderToStaticMarkup(
    <ThreadRail
      threads={THREADS}
      activeThreadId="thread-b"
      onSelect={noop}
      onCreate={noop}
      {...props}
    />,
  )
}

interface ParsedRow {
  readonly label: string
  readonly className: string
  readonly isCurrent: boolean
}

/** The rendered thread rows, ignoring the "+ New conversation" action above them. */
function parseRows(markup: string): readonly ParsedRow[] {
  return markup
    .split("<li>")
    .slice(1)
    .map((chunk) => ({
      label: chunk.replace(/<[^>]*>/g, ""),
      className: /class="([^"]*)"/.exec(chunk)?.[1] ?? "",
      isCurrent: chunk.includes('aria-current="true"'),
    }))
}

describe("thread rail", () => {
  test("lists every thread in the order it is given", () => {
    // Rows only, so the "+ New conversation" action above them cannot stand in
    // for the untitled row's label.
    const rows = render()
      .split("<li>")
      .slice(1)
      .map((chunk) => chunk.replace(/<[^>]*>/g, ""))
    expect(rows).toEqual(["Agent architectures", UNTITLED_THREAD_LABEL, "Quantum computing"])
  })

  test("labels an untitled thread instead of rendering a blank row", () => {
    // A thread has no title until its first user message lands, so the row the
    // user just created would otherwise be an unclickable-looking empty button.
    expect(render()).toContain(`>${UNTITLED_THREAD_LABEL}</button>`)
  })

  test("marks the active thread for assistive tech, not by color alone", () => {
    // A rail of buttons where only the background says which one is selected
    // is unusable without sight. `aria-current` is the other half.
    const rows = parseRows(render())
    const current = rows.filter((row) => row.isCurrent)
    expect(current).toHaveLength(1)
    expect(current[0]?.label).toBe(UNTITLED_THREAD_LABEL)
  })

  test("styles the active row differently from the inactive ones, which match each other", () => {
    // Asserts the distinction the design calls for without pinning which
    // utilities produce it — restyling the rail should not red this test,
    // but flattening the active state into the others should.
    const rows = parseRows(render())
    const active = rows.find((row) => row.isCurrent)
    const inactive = rows.filter((row) => !row.isCurrent)
    expect(inactive).toHaveLength(2)
    expect(active?.className).toBeDefined()
    for (const row of inactive) expect(row.className).not.toBe(active?.className)
    expect(new Set(inactive.map((row) => row.className)).size).toBe(1)
  })

  test("gives the inactive rows a hover affordance", () => {
    const inactive = parseRows(render()).filter((row) => !row.isCurrent)
    for (const row of inactive) expect(row.className).toMatch(/\bhover:/)
  })

  test("truncates a long title in the fixed-width rail instead of wrapping it", () => {
    const long = "A ".repeat(80).trim()
    const markup = render({ threads: [{ id: "thread-long", title: long, lastActiveAt: 1 }] })
    // `truncate` (overflow-hidden + ellipsis + nowrap) is what keeps a 16rem
    // rail one line per row; `title` gives the full text back on hover.
    expect(markup).toContain("truncate")
    expect(markup).toContain(`title="${long}"`)
  })

  test("says so when there are no threads, and still offers the create action", () => {
    const markup = render({ threads: [] })
    expect(markup).toContain("No conversations yet.")
    expect(markup).toContain("+ New conversation")
    expect(markup).not.toContain("<ul")
  })
})
