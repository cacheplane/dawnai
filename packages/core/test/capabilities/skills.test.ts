import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSkillsMarker } from "../../src/capabilities/built-in/skills.js"

describe("createSkillsMarker", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-skills-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  function writeSkill(name: string, frontmatter: string, body: string): void {
    const dir = join(routeDir, "skills", name)
    mkdirSync(dir, { recursive: true })
    const content = frontmatter ? `---\n${frontmatter}\n---\n\n${body}` : body
    writeFileSync(join(dir, "SKILL.md"), content, "utf8")
  }

  it("does not detect when skills/ directory is absent", async () => {
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("does not detect when skills/ exists but is empty", async () => {
    mkdirSync(join(routeDir, "skills"), { recursive: true })
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("does not detect when skills/<name>/ has no SKILL.md", async () => {
    mkdirSync(join(routeDir, "skills", "stub"), { recursive: true })
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("detects when at least one skills/<name>/SKILL.md exists", async () => {
    writeSkill("foo", "description: A foo skill.", "body")
    const marker = createSkillsMarker()
    expect(await marker.detect(routeDir)).toBe(true)
  })

  it("load contributes exactly one tool (readSkill) and one promptFragment, no state/transformers", async () => {
    writeSkill("foo", "description: A foo skill.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.tools?.map((t) => t.name)).toEqual(["readSkill"])
    expect(contribution.promptFragment?.placement).toBe("after_user_prompt")
    expect(contribution.stateFields).toBeUndefined()
    expect(contribution.streamTransformers).toBeUndefined()
  })

  it("uses directory name as the skill name when frontmatter omits it", async () => {
    writeSkill("debug-python", "description: Debug Python.", "# Body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**debug-python** — Debug Python.")
  })

  it("uses frontmatter.name when provided, overriding the directory name", async () => {
    writeSkill("dir-name", "name: override-name\ndescription: Overridden.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**override-name** — Overridden.")
    expect(rendered).not.toContain("**dir-name**")
  })

  it("fails fast when a SKILL.md has no frontmatter", async () => {
    writeSkill("bare", "", "# Just a body with no frontmatter")
    const marker = createSkillsMarker()
    await expect(marker.load(routeDir)).rejects.toThrow(
      /missing required frontmatter|missing required `description`/i,
    )
  })

  it("fails fast when frontmatter lacks description", async () => {
    writeSkill("no-desc", "name: no-desc", "body")
    const marker = createSkillsMarker()
    await expect(marker.load(routeDir)).rejects.toThrow(/missing required `description`/i)
  })

  it("fails fast when two skills resolve to the same name", async () => {
    writeSkill("foo", "description: First.", "body")
    writeSkill("bar", "name: foo\ndescription: Duplicate.", "body")
    const marker = createSkillsMarker()
    await expect(marker.load(routeDir)).rejects.toThrow(/duplicate skill name/i)
  })

  it("skips invalid directory names silently (leading dot or spaces)", async () => {
    writeSkill("good", "description: Good one.", "body")
    mkdirSync(join(routeDir, "skills", ".hidden"), { recursive: true })
    writeFileSync(
      join(routeDir, "skills", ".hidden", "SKILL.md"),
      "---\ndescription: Hidden.\n---\nbody",
      "utf8",
    )
    mkdirSync(join(routeDir, "skills", "has spaces"), { recursive: true })
    writeFileSync(
      join(routeDir, "skills", "has spaces", "SKILL.md"),
      "---\ndescription: Spaced.\n---\nbody",
      "utf8",
    )
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**good**")
    expect(rendered).not.toContain("**.hidden**")
    expect(rendered).not.toContain("has spaces")
  })

  it("rendered prompt fragment includes a '# Skills' header and a readSkill instruction", async () => {
    writeSkill("foo", "description: A foo skill.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("# Skills")
    expect(rendered).toContain('readSkill({ name: "<name>" })')
  })

  it("readSkill returns the body for a known skill", async () => {
    writeSkill("foo", "description: A foo skill.", "FOO BODY CONTENT")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const readSkill = contribution.tools?.[0]
    const result = await readSkill?.run(
      { name: "foo" },
      {
        signal: new AbortController().signal,
      },
    )
    expect(result).toBe("FOO BODY CONTENT")
  })

  it("readSkill returns a helpful error for an unknown skill, listing what's available", async () => {
    writeSkill("foo", "description: A.", "body")
    writeSkill("bar", "description: B.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const readSkill = contribution.tools?.[0]
    const result = await readSkill?.run(
      { name: "nope" },
      {
        signal: new AbortController().signal,
      },
    )
    expect(result).toContain("Unknown skill: nope")
    expect(result).toContain("bar")
    expect(result).toContain("foo")
  })

  it("readSkill validates input shape (rejects non-string name)", async () => {
    writeSkill("foo", "description: A.", "body")
    const marker = createSkillsMarker()
    const contribution = await marker.load(routeDir)
    const readSkill = contribution.tools?.[0]
    await expect(async () => {
      await readSkill?.run({ name: 42 }, { signal: new AbortController().signal })
    }).rejects.toThrow()
  })
})
