import { describe, expect, expectTypeOf, it } from "vitest"
import { agent, type DawnAgent, type ReasoningConfig } from "../src/index.js"

describe("agent() descriptor — new fields", () => {
  it("accepts description and subagents fields", () => {
    const specialist = agent({
      model: "gpt-5",
      systemPrompt: "specialist",
      description: "Does specialist work",
    })
    const coordinator = agent({
      model: "gpt-5",
      systemPrompt: "coordinator",
      subagents: [specialist],
    })
    expect(coordinator.subagents?.[0]).toBe(specialist)
    expect(specialist.description).toBe("Does specialist work")
  })

  it("subagents array must contain DawnAgent values (type-only)", () => {
    expectTypeOf<DawnAgent["subagents"]>().toEqualTypeOf<readonly DawnAgent[] | undefined>()
    expectTypeOf<DawnAgent["description"]>().toEqualTypeOf<string | undefined>()
  })

  it("exports reasoning config used by agent descriptors", () => {
    expectTypeOf<ReasoningConfig["effort"]>().toEqualTypeOf<
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
    >()
    expectTypeOf<DawnAgent["reasoning"]>().toEqualTypeOf<ReasoningConfig | undefined>()
  })

  it("omitting description and subagents still works", () => {
    const a = agent({ model: "gpt-5", systemPrompt: "x" })
    expect(a.description).toBeUndefined()
    expect(a.subagents).toBeUndefined()
  })
})
