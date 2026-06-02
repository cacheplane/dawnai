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
})
