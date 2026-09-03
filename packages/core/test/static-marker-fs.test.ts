import { describe, expect, it } from "vitest"
import { staticMarkerFs } from "../src/static-marker-fs.js"

const files = {
  "/app/src/app/chat/memory.md": "remember: be brief",
  "/app/src/app/chat/plan.md": "- [ ] first\n- [ ] second\n",
  "/app/src/app/chat/skills/cite-sources/SKILL.md": "---\ndescription: Cite.\n---\n\nCite. ✓",
  "/app/src/app/chat/skills/synthesize/SKILL.md": "---\ndescription: Synth.\n---\n\nSynth.",
} as const

describe("staticMarkerFs", () => {
  const fs = staticMarkerFs(files)

  it("reports files by exact key", () => {
    expect(fs.existsSync("/app/src/app/chat/plan.md")).toBe(true)
    expect(fs.readFileSync("/app/src/app/chat/plan.md")).toBe("- [ ] first\n- [ ] second\n")
    expect(fs.isDirectorySync("/app/src/app/chat/plan.md")).toBe(false)
  })

  it("reports byte sizes, not character counts", () => {
    const content = files["/app/src/app/chat/skills/cite-sources/SKILL.md"]
    expect(fs.statSizeSync("/app/src/app/chat/skills/cite-sources/SKILL.md")).toBe(
      new TextEncoder().encode(content).byteLength,
    )
    expect(fs.statSizeSync("/app/src/app/chat/skills")).toBeUndefined()
    expect(fs.statSizeSync("/nope")).toBeUndefined()
  })

  it("derives directories from key prefixes", () => {
    expect(fs.existsSync("/app/src/app/chat/skills")).toBe(true)
    expect(fs.isDirectorySync("/app/src/app/chat/skills")).toBe(true)
    expect(fs.isDirectorySync("/app/src/app/chat/skills/")).toBe(true)
    expect(fs.isDirectorySync("/app/src/app/chat/skills/cite-sources")).toBe(true)
    expect(fs.readFileSync("/app/src/app/chat/skills")).toBeUndefined()
  })

  it("does not treat a key's string prefix as a directory", () => {
    // "/app/src/app/chat/ski" is a prefix of a key but not a path segment boundary.
    expect(fs.existsSync("/app/src/app/chat/ski")).toBe(false)
    expect(fs.isDirectorySync("/app/src/app/chat/ski")).toBe(false)
  })

  it("lists sorted immediate children of a directory", () => {
    expect(fs.readdirSync("/app/src/app/chat/skills")).toEqual(["cite-sources", "synthesize"])
    expect(fs.readdirSync("/app/src/app/chat")).toEqual(["memory.md", "plan.md", "skills"])
    expect(fs.readdirSync("/app/src/app/chat/skills/cite-sources")).toEqual(["SKILL.md"])
  })

  it("returns empty or undefined for misses and files used as directories", () => {
    expect(fs.readdirSync("/app/src/app/chat/plan.md")).toEqual([])
    expect(fs.readdirSync("/missing")).toEqual([])
    expect(fs.existsSync("/missing")).toBe(false)
    expect(fs.readFileSync("/missing")).toBeUndefined()
  })

  it("never throws, even on odd input", () => {
    for (const path of ["", "/", "//", "/app/", "/app/src/app/chat/skills//"]) {
      expect(() => fs.existsSync(path)).not.toThrow()
      expect(() => fs.isDirectorySync(path)).not.toThrow()
      expect(() => fs.statSizeSync(path)).not.toThrow()
      expect(() => fs.readFileSync(path)).not.toThrow()
      expect(() => fs.readdirSync(path)).not.toThrow()
    }
  })

  it("serves an empty map as an empty filesystem", () => {
    const empty = staticMarkerFs({})
    expect(empty.existsSync("/anything")).toBe(false)
    expect(empty.readdirSync("/")).toEqual([])
  })
})
