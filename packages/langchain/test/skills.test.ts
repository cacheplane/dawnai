import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  applyCapabilities,
  createCapabilityRegistry,
  createSkillsMarker,
} from "@dawn-ai/core"

describe("skills capability — end-to-end shape", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-skills-e2e-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  function writeSkill(name: string, description: string, body: string): void {
    const dir = join(routeDir, "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\ndescription: ${description}\n---\n\n${body}`,
      "utf8",
    )
  }

  it("contributes nothing when skills/ is absent", async () => {
    const registry = createCapabilityRegistry([createSkillsMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
  })

  it("contributes readSkill tool + prompt fragment when skills/ has at least one skill", async () => {
    writeSkill("foo", "A foo skill.", "Foo body")
    writeSkill("bar", "A bar skill.", "Bar body")
    const registry = createCapabilityRegistry([createSkillsMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toHaveLength(1)
    const contrib = result.contributions[0]?.contribution
    expect(contrib?.tools?.map((t) => t.name)).toEqual(["readSkill"])
    expect(contrib?.promptFragment?.placement).toBe("after_user_prompt")
    const rendered = contrib?.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("# Skills")
    expect(rendered).toContain("**bar** — A bar skill.")
    expect(rendered).toContain("**foo** — A foo skill.")
  })

  it("readSkill returns the body content for the named skill", async () => {
    writeSkill("recipe", "Cooking recipe.", "Step 1: heat the pan.\nStep 2: add oil.")
    const registry = createCapabilityRegistry([createSkillsMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const readSkill = result.contributions[0]?.contribution.tools?.[0]
    const output = await readSkill?.run(
      { name: "recipe" },
      { signal: new AbortController().signal },
    )
    expect(output).toBe("Step 1: heat the pan.\nStep 2: add oil.")
  })
})
