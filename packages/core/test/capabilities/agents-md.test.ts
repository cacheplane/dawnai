import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createAgentsMdMarker } from "../../src/capabilities/built-in/agents-md.js"

describe("createAgentsMdMarker", () => {
  let routeDir: string
  let workDir: string
  let originalCwd: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dawn-agents-md-"))
    routeDir = join(workDir, "route")
    mkdirSync(routeDir, { recursive: true })
    originalCwd = process.cwd()
    process.chdir(workDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workDir, { recursive: true, force: true })
  })

  it("always detects (returns true)", async () => {
    const marker = createAgentsMdMarker()
    expect(await marker.detect(routeDir)).toBe(true)
  })

  it("load returns a single promptFragment, no tools/state/transformers", async () => {
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.placement).toBe("after_user_prompt")
    expect(contribution.tools).toBeUndefined()
    expect(contribution.stateFields).toBeUndefined()
    expect(contribution.streamTransformers).toBeUndefined()
  })

  it("renders empty string when workspace/AGENTS.md does not exist", async () => {
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("renders content under '# Memory' heading when file exists", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "Remember the pnpm convention.")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    const out = contribution.promptFragment?.render({}) ?? ""
    expect(out).toContain("# Memory")
    expect(out).toContain("Remember the pnpm convention.")
  })

  it("returns empty string when file is whitespace-only", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "   \n\n  \n")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("returns size-notice (not body) when file exceeds 64 KiB", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const big = "x".repeat(65 * 1024)
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), big)
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    const out = contribution.promptFragment?.render({}) ?? ""
    expect(out).toContain("# Memory")
    expect(out).toContain("exceeds 64 KiB")
    expect(out).not.toContain("xxxxxxxxxxx") // body NOT included
  })

  it("returns empty string when AGENTS.md is a directory (read throws)", async () => {
    mkdirSync(join(workDir, "workspace", "AGENTS.md"), { recursive: true })
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("re-reads the file on each render call", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const path = join(workDir, "workspace", "AGENTS.md")
    writeFileSync(path, "first")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    const first = contribution.promptFragment?.render({}) ?? ""
    expect(first).toContain("first")
    writeFileSync(path, "second")
    const second = contribution.promptFragment?.render({}) ?? ""
    expect(second).toContain("second")
    expect(second).not.toContain("first")
  })
})
