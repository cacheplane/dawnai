import { describe, expect, it } from "vitest"
import { loadBlueprints, validateBlueprints } from "../../lib/blueprints"

describe("shipped blueprint catalog", () => {
  it("passes validation", () => {
    expect(validateBlueprints()).toEqual([])
  })

  it("ships the four exemplars across three categories", () => {
    const all = loadBlueprints()
    expect(all.map((e) => e.meta.name).sort()).toEqual([
      "docker",
      "opentelemetry",
      "pgvector",
      "pinecone",
    ])
    expect(new Set(all.map((e) => e.meta.category))).toEqual(
      new Set(["observability", "retrieval", "deploy"]),
    )
  })

  it("marks the primary file in every guide", () => {
    for (const { meta, body } of loadBlueprints()) {
      expect(body, `${meta.name} should contain its dawn-blueprint marker`).toContain(
        `dawn-blueprint: ${meta.name}@`,
      )
    }
  })
})
