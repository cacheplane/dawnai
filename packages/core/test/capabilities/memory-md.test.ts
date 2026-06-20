import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMemoryMdMarker } from "../../src/capabilities/built-in/memory-md.js"

const ctx = { routeManifest: {} as never, descriptor: undefined, appRoot: "/unused" }

describe("memory-md capability", () => {
  let routeDir: string
  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-memmd-"))
  })
  afterEach(() => rmSync(routeDir, { recursive: true, force: true }))

  it("does not activate when memory.md is absent", async () => {
    expect(await createMemoryMdMarker().detect(routeDir, ctx)).toBe(false)
  })

  it("injects memory.md contents under a heading when present", async () => {
    writeFileSync(join(routeDir, "memory.md"), "Prefer pnpm. Use Vitest.", "utf8")
    const marker = createMemoryMdMarker()
    expect(await marker.detect(routeDir, ctx)).toBe(true)
    const contribution = await marker.load(routeDir, ctx)
    const rendered = contribution.promptFragment?.render({})
    expect(rendered).toContain("Prefer pnpm. Use Vitest.")
    expect(rendered).toContain("# Route Memory")
  })

  it("renders empty for a whitespace-only file", async () => {
    writeFileSync(join(routeDir, "memory.md"), "   \n  ", "utf8")
    const contribution = await createMemoryMdMarker().load(routeDir, ctx)
    expect(contribution.promptFragment?.render({})).toBe("")
  })
})
