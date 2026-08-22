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

  test("marks the active thread both visually and for assistive tech", () => {
    const markup = render()
    const rows = markup.split("<button").filter((chunk) => chunk.includes("aria-current"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain(UNTITLED_THREAD_LABEL)
    expect(rows[0]).toContain("bg-[var(--wb-surface)]")
  })

  test("hover-highlights the inactive rows rather than filling them", () => {
    const markup = render()
    const activeRow = markup.split("<button").find((chunk) => chunk.includes("aria-current"))
    const inactiveRow = markup
      .split("<button")
      .find((chunk) => chunk.includes("Agent architectures"))
    expect(inactiveRow).toContain("hover:bg-[var(--wb-surface)]")
    expect(inactiveRow).toContain("text-[var(--wb-muted)]")
    expect(activeRow).not.toContain("text-[var(--wb-muted)]")
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
