import type { GoogleModelId, KnownModelId, OpenAiModelId } from "@dawn-ai/sdk"
import { agent } from "@dawn-ai/sdk"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("KnownModelId", () => {
  test("accepts OpenAI model IDs", () => {
    const descriptor = agent({ model: "gpt-5.5", systemPrompt: "test" })
    expect(descriptor.model).toBe("gpt-5.5")
  })

  test("accepts Google model IDs", () => {
    const descriptor = agent({ model: "gemini-2.5-pro", systemPrompt: "test" })
    expect(descriptor.model).toBe("gemini-2.5-pro")
  })

  test("accepts arbitrary string via (string & {})", () => {
    const descriptor = agent({ model: "my-custom-model", systemPrompt: "test" })
    expect(descriptor.model).toBe("my-custom-model")
  })

  test("per-provider types are subtypes of KnownModelId", () => {
    expectTypeOf<OpenAiModelId>().toMatchTypeOf<KnownModelId>()
    expectTypeOf<GoogleModelId>().toMatchTypeOf<KnownModelId>()
  })
})
