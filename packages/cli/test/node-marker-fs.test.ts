import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { nodeMarkerFs } from "../src/lib/runtime/node-marker-fs.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe("nodeMarkerFs", () => {
  it("reports existence, size, and content for a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-marker-fs-"))
    cleanup.push(() => rm(dir, { force: true, recursive: true }))
    const file = join(dir, "AGENTS.md")
    const content = "remember the thing"
    await writeFile(file, content, "utf8")

    expect(nodeMarkerFs.existsSync(file)).toBe(true)
    expect(nodeMarkerFs.statSizeSync(file)).toBe(Buffer.byteLength(content))
    expect(nodeMarkerFs.readFileSync(file)).toBe(content)
    expect(nodeMarkerFs.readdirSync(dir)).toEqual(["AGENTS.md"])
    expect(nodeMarkerFs.readdirSync(file)).toEqual([])
    expect(nodeMarkerFs.statSizeSync(join(file, "under"))).toBeUndefined()
    expect(nodeMarkerFs.isDirectorySync(dir)).toBe(true)
    expect(nodeMarkerFs.isDirectorySync(file)).toBe(false)
  })

  it("fails closed on missing paths (no throw from any method)", () => {
    expect(nodeMarkerFs.existsSync("/nonexistent/definitely/not-here")).toBe(false)
    expect(nodeMarkerFs.isDirectorySync("/nonexistent/definitely/not-here")).toBe(false)
    expect(nodeMarkerFs.statSizeSync("/nonexistent/definitely/not-here")).toBeUndefined()
    expect(nodeMarkerFs.readFileSync("/nonexistent/definitely/not-here")).toBeUndefined()
    expect(nodeMarkerFs.readdirSync("/nonexistent/definitely/not-here")).toEqual([])
  })
})
