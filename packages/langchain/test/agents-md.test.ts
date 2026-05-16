import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  applyCapabilities,
  createAgentsMdMarker,
  createCapabilityRegistry,
} from "@dawn-ai/core"

describe("agents-md capability — end-to-end shape", () => {
  let routeDir: string
  let workDir: string
  let originalCwd: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dawn-agents-md-e2e-"))
    routeDir = join(workDir, "route")
    mkdirSync(routeDir, { recursive: true })
    originalCwd = process.cwd()
    process.chdir(workDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workDir, { recursive: true, force: true })
  })

  it("always contributes a promptFragment", async () => {
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toHaveLength(1)
    expect(result.contributions[0]?.contribution.promptFragment?.placement).toBe(
      "after_user_prompt",
    )
  })

  it("renders memory content when workspace/AGENTS.md exists", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "Use pnpm, not npm.")
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    const rendered = fragment?.render({}) ?? ""
    expect(rendered).toContain("# Memory")
    expect(rendered).toContain("Use pnpm, not npm.")
  })

  it("renders empty when workspace/AGENTS.md is absent", async () => {
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    expect(fragment?.render({})).toBe("")
  })

  it("renders updated content after the file is rewritten", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const path = join(workDir, "workspace", "AGENTS.md")
    writeFileSync(path, "before")
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    expect(fragment?.render({})).toContain("before")
    writeFileSync(path, "after")
    expect(fragment?.render({})).toContain("after")
    expect(fragment?.render({})).not.toContain("before")
  })
})
