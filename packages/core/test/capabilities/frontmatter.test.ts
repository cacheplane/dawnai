import { describe, expect, it } from "vitest"
import { parseFrontmatter } from "../../src/capabilities/built-in/frontmatter.js"

describe("parseFrontmatter", () => {
  it("returns empty frontmatter and full body when input has no frontmatter", () => {
    const input = "# Just a heading\n\nSome content."
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: {},
      body: "# Just a heading\n\nSome content.",
    })
  })

  it("returns empty frontmatter when missing closing ---", () => {
    const input = "---\nname: foo\nbody continues"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: {},
      body: "---\nname: foo\nbody continues",
    })
  })

  it("parses a single key/value", () => {
    const input = "---\nname: debug-python\n---\n\n# Body"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "debug-python" },
      body: "# Body",
    })
  })

  it("parses multiple keys", () => {
    const input = "---\nname: debug-python\ndescription: Debug stack traces.\n---\n\n# Body content"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "debug-python", description: "Debug stack traces." },
      body: "# Body content",
    })
  })

  it("strips surrounding double-quotes from values", () => {
    const input = '---\nname: "with spaces"\n---\nbody'
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "with spaces" },
      body: "body",
    })
  })

  it("strips surrounding single-quotes from values", () => {
    const input = "---\nname: 'with spaces'\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "with spaces" },
      body: "body",
    })
  })

  it("ignores comment lines (start with #)", () => {
    const input = "---\n# this is a comment\nname: foo\n# another comment\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "body",
    })
  })

  it("ignores blank lines inside frontmatter", () => {
    const input = "---\nname: foo\n\ndescription: bar\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo", description: "bar" },
      body: "body",
    })
  })

  it("trims whitespace from keys and values", () => {
    const input = "---\n  name  :   foo  \n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "body",
    })
  })

  it("handles CRLF line endings", () => {
    const input = "---\r\nname: foo\r\n---\r\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "body",
    })
  })

  it("preserves multi-line body verbatim (minus the first leading newline)", () => {
    const input = "---\nname: foo\n---\n\nLine 1\nLine 2\n\nLine 4"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "Line 1\nLine 2\n\nLine 4",
    })
  })

  it("returns empty body when nothing follows the closing ---", () => {
    const input = "---\nname: foo\n---"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo" },
      body: "",
    })
  })

  it("returns empty frontmatter (the whole input as body) when input starts with --- but not --- followed by newline", () => {
    const input = "--- not really frontmatter\nname: foo"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: {},
      body: "--- not really frontmatter\nname: foo",
    })
  })

  it("treats a line without a colon as ignored (no key)", () => {
    const input = "---\nname: foo\nthis line has no colon\ndescription: bar\n---\nbody"
    expect(parseFrontmatter(input)).toEqual({
      frontmatter: { name: "foo", description: "bar" },
      body: "body",
    })
  })
})
