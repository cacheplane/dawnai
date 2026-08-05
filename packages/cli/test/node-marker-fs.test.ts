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
    await writeFile(file, "remember the thing", "utf8")

    expect(nodeMarkerFs.existsSync(file)).toBe(true)
    expect(nodeMarkerFs.statSizeSync(file)).toBe(18)
    expect(nodeMarkerFs.readFileSync(file)).toBe("remember the thing")
    expect(nodeMarkerFs.readDirSync(dir)).toEqual(["AGENTS.md"])
  })

  it("fails closed on missing paths (no throw from existsSync/statSizeSync)", () => {
    expect(nodeMarkerFs.existsSync("/nonexistent/definitely/not-here")).toBe(false)
    expect(nodeMarkerFs.statSizeSync("/nonexistent/definitely/not-here")).toBeUndefined()
    expect(() => nodeMarkerFs.readFileSync("/nonexistent/definitely/not-here")).toThrow()
    expect(nodeMarkerFs.readDirSync("/nonexistent/definitely/not-here")).toEqual([])
  })
})
