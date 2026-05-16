import { describe, expect, it } from "vitest"
import { parsePlanMarkdown } from "../../src/capabilities/built-in/plan-md-parser.js"

describe("parsePlanMarkdown", () => {
  it("returns empty list for empty input", () => {
    expect(parsePlanMarkdown("")).toEqual([])
  })

  it("returns empty list for prose-only input", () => {
    expect(parsePlanMarkdown("# Heading\n\nSome notes here.\n")).toEqual([])
  })

  it("parses pending items", () => {
    expect(parsePlanMarkdown("- [ ] Read AGENTS.md")).toEqual([
      { content: "Read AGENTS.md", status: "pending" },
    ])
  })

  it("parses completed items", () => {
    expect(parsePlanMarkdown("- [x] Done thing")).toEqual([
      { content: "Done thing", status: "completed" },
    ])
  })

  it("treats [X] case-insensitively", () => {
    expect(parsePlanMarkdown("- [X] Capital X")).toEqual([
      { content: "Capital X", status: "completed" },
    ])
  })

  it("ignores intermixed prose and headings", () => {
    const input = `# My plan

Some thoughts.

- [ ] First
- [x] Second
- [ ] Third

End.
`
    expect(parsePlanMarkdown(input)).toEqual([
      { content: "First", status: "pending" },
      { content: "Second", status: "completed" },
      { content: "Third", status: "pending" },
    ])
  })

  it("trims surrounding whitespace from content", () => {
    expect(parsePlanMarkdown("- [ ]   spaced item   ")).toEqual([
      { content: "spaced item", status: "pending" },
    ])
  })

  it("ignores items with empty content", () => {
    expect(parsePlanMarkdown("- [ ]\n- [ ]   \n- [ ] real")).toEqual([
      { content: "real", status: "pending" },
    ])
  })
})
