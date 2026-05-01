import type { AgentConfig, DawnAgent } from "@dawn-ai/sdk"
import { agent, isDawnAgent } from "@dawn-ai/sdk"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("agent()", () => {
  test("returns a DawnAgent descriptor with the provided config", () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    expect(descriptor.model).toBe("gpt-4o-mini")
    expect(descriptor.systemPrompt).toBe("You are helpful.")
  })

  test("descriptor is recognized by isDawnAgent", () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "Hello",
    })

    expect(isDawnAgent(descriptor)).toBe(true)
  })

  test("isDawnAgent rejects plain objects", () => {
    expect(isDawnAgent({})).toBe(false)
    expect(isDawnAgent(null)).toBe(false)
    expect(isDawnAgent(undefined)).toBe(false)
    expect(isDawnAgent({ model: "gpt-4o", systemPrompt: "hi" })).toBe(false)
  })

  test("isDawnAgent rejects objects with invoke method (legacy agents)", () => {
    expect(isDawnAgent({ invoke: async () => ({}) })).toBe(false)
  })

  test("KnownModelId provides autocomplete but accepts any string", () => {
    const config: AgentConfig = {
      model: "my-custom-model",
      systemPrompt: "hi",
    }
    const descriptor = agent(config)
    expect(descriptor.model).toBe("my-custom-model")
  })

  test("DawnAgent type is exported", () => {
    const descriptor = agent({ model: "gpt-4o", systemPrompt: "test" })
    expectTypeOf(descriptor).toMatchTypeOf<DawnAgent>()
  })
})
