import { describe, expect, it } from "vitest"
import { buildStub } from "../src/offload/stub.js"

describe("buildStub", () => {
  it("includes char count, path, threshold, and N preview lines", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const stub = buildStub({
      content,
      relPath: "tool-outputs/search-1-a.txt",
      previewLines: 10,
      thresholdChars: 40000,
    })
    expect(stub).toContain(`${content.length} chars`)
    expect(stub).toContain("40,000")
    expect(stub).toContain("tool-outputs/search-1-a.txt")
    expect(stub).toContain("line 1")
    expect(stub).toContain("line 10")
    expect(stub).not.toContain("line 11")
    expect(stub).toContain("readFile")
  })

  it("shows all lines when content has fewer than previewLines", () => {
    const stub = buildStub({
      content: "only one line",
      relPath: "tool-outputs/x.txt",
      previewLines: 10,
      thresholdChars: 40000,
    })
    expect(stub).toContain("only one line")
  })

  it("pretty-prints single-line JSON content for a readable multi-line preview", () => {
    // A tool that returns an object is JSON.stringify'd to one line with escaped
    // newlines; the preview should show real lines, not "first 1 line".
    const content = JSON.stringify({ a: 1, b: { c: 2 }, items: ["x", "y"] })
    const stub = buildStub({
      content,
      relPath: "tool-outputs/obj-1-a.txt",
      previewLines: 10,
      thresholdChars: 40000,
    })
    // Pretty-printed across multiple readable lines (not one escaped blob).
    expect(stub).toContain('"a": 1')
    expect(stub).toContain('"c": 2')
    expect(stub).not.toContain("first 1 lines")
  })

  it("leaves non-JSON content untouched in the preview", () => {
    const content = "plain text line one\nplain text line two"
    const stub = buildStub({
      content,
      relPath: "tool-outputs/txt-1-a.txt",
      previewLines: 10,
      thresholdChars: 40000,
    })
    expect(stub).toContain("Preview (first 2 lines):")
    expect(stub).toContain("plain text line one")
    expect(stub).toContain("plain text line two")
  })
})
