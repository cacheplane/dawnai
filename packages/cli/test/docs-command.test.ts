import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runDocsCommand } from "../src/commands/docs.js"
import { CliError } from "../src/lib/output.js"

function fixtureDocs(): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-docs-"))
  writeFileSync(join(dir, "README.md"), "# Dawn — Documentation\n")
  writeFileSync(join(dir, "tools.md"), "# Tools\n\nCo-located tools.\n")
  mkdirSync(join(dir, "recipes"))
  writeFileSync(join(dir, "recipes", "add-a-tool.md"), "# Add a tool\n")
  return dir
}

function fakeIo() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) },
    out,
    err,
  }
}

describe("runDocsCommand()", () => {
  it("lists topics and prints the docs path when no topic is given", async () => {
    const dir = fixtureDocs()
    const { io, out } = fakeIo()
    await runDocsCommand({ docsDir: dir }, io)
    const text = out.join("\n")
    expect(text).toContain(dir)
    expect(text).toContain("tools")
    expect(text).toContain("recipes/add-a-tool")
  })

  it("prints a topic's markdown to stdout", async () => {
    const dir = fixtureDocs()
    const { io, out } = fakeIo()
    await runDocsCommand({ topic: "tools", docsDir: dir }, io)
    expect(out.join("\n")).toContain("Co-located tools.")
  })

  it("tolerates a .md suffix and nested recipe slugs", async () => {
    const dir = fixtureDocs()
    const { io, out } = fakeIo()
    await runDocsCommand({ topic: "recipes/add-a-tool.md", docsDir: dir }, io)
    expect(out.join("\n")).toContain("# Add a tool")
  })

  it("errors with the topic list on an unknown topic", async () => {
    const dir = fixtureDocs()
    const { io, err } = fakeIo()
    await expect(runDocsCommand({ topic: "nope", docsDir: dir }, io)).rejects.toBeInstanceOf(
      CliError,
    )
    expect(err.join("\n")).toContain("tools")
  })
})
