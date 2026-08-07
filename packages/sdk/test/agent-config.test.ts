import { describe, expect, it } from "vitest"
import { agent } from "../src/index.js"

describe("agent() descriptor — new fields", () => {
  it("preserves an exactly inferred keyed subagent registry and delegation policy", () => {
    const researcher = agent({
      model: "gpt-5-mini",
      systemPrompt: "Research.",
      description: "Does research work",
    })
    const predicate = async () => true as const
    const coordinator = agent({
      model: "gpt-5-mini",
      systemPrompt: "Coordinate.",
      subagents: { researcher },
      delegation: {
        default: "deny",
        rules: {
          researcher: {
            action: "constrain",
            predicate,
          },
        },
      },
    })

    expect(coordinator.subagents?.researcher).toBe(researcher)
    expect(coordinator.delegation).toEqual({
      default: "deny",
      rules: { researcher: { action: "constrain", predicate } },
    })
    expect(researcher.description).toBe("Does research work")
  })

  it("omitting description, subagents, and delegation still works", () => {
    const a = agent({ model: "gpt-5", systemPrompt: "x" })
    expect(a.description).toBeUndefined()
    expect(a.subagents).toBeUndefined()
    expect(a.delegation).toBeUndefined()
  })
})
