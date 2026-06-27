import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { getBlueprint, loadBlueprints, validateBlueprints } from "../../lib/blueprints"

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-bp-"))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const GOOD =
  "---\ndescription: Add OTel tracing.\nwebsite: https://opentelemetry.io\nversion: 1\ntags: [otel]\nsource: official\n---\n\n# Add OpenTelemetry\n\nBody.\n"

describe("loadBlueprints()", () => {
  it("derives name from filename and category from directory, sorted by name", () => {
    const dir = fixture({
      "observability/opentelemetry.md": GOOD,
      "retrieval/pgvector.md": "---\ndescription: pgvector.\n---\n# pgvector\n",
    })
    const all = loadBlueprints(dir)
    expect(all.map((e) => e.meta.name)).toEqual(["opentelemetry", "pgvector"])
    const otel = all.at(0)
    expect(otel?.meta.category).toBe("observability")
    expect(otel?.meta.description).toBe("Add OTel tracing.")
    expect(otel?.meta.version).toBe(1)
    expect(otel?.meta.url).toBe("https://dawnai.org/blueprints/opentelemetry.md")
    expect(otel?.body).toContain("# Add OpenTelemetry")
    expect(otel?.body).not.toContain("description:")
  })

  it("defaults version to 1, tags to [], source to official when omitted", () => {
    const dir = fixture({ "retrieval/pgvector.md": "---\ndescription: x.\n---\n# pgvector\n" })
    const e = loadBlueprints(dir).at(0)
    expect(e?.meta.version).toBe(1)
    expect(e?.meta.tags).toEqual([])
    expect(e?.meta.source).toBe("official")
  })
})

describe("getBlueprint()", () => {
  it("resolves by flat name across categories; undefined when missing", () => {
    const dir = fixture({ "observability/opentelemetry.md": GOOD })
    expect(getBlueprint("opentelemetry", dir)?.meta.category).toBe("observability")
    expect(getBlueprint("nope", dir)).toBeUndefined()
  })
})

describe("validateBlueprints()", () => {
  it("returns no errors for a well-formed catalog", () => {
    const dir = fixture({ "observability/opentelemetry.md": GOOD })
    expect(validateBlueprints(dir)).toEqual([])
  })

  it("flags missing description, bad category, bad source, duplicate name, and missing H1", () => {
    const dir = fixture({
      "observability/nodesc.md": "---\nsource: official\n---\n# No desc\n",
      "bogus/x.md": "---\ndescription: y.\n---\n# X\n",
      "retrieval/badsrc.md": "---\ndescription: y.\nsource: vendor\n---\n# Bad\n",
      "observability/dup.md": "---\ndescription: a.\n---\n# Dup\n",
      "retrieval/dup.md": "---\ndescription: b.\n---\n# Dup2\n",
      "deploy/noh1.md": "---\ndescription: z.\n---\n\nNo heading here.\n",
    })
    const errors = validateBlueprints(dir).join("\n")
    expect(errors).toContain("nodesc")
    expect(errors).toContain('category "bogus"')
    expect(errors).toContain("badsrc")
    expect(errors).toContain("duplicate name")
    expect(errors).toContain("noh1")
  })
})
