import type { GoogleModelId, KnownModelId, ModelProviderId, OpenAiModelId } from "@dawn-ai/sdk"
import { agent } from "@dawn-ai/sdk"
import { describe, expect, expectTypeOf, it, test } from "vitest"

import {
  ANTHROPIC_MODEL_IDS,
  CURATED_MODEL_IDS,
  GOOGLE_MODEL_IDS,
  OPENAI_MODEL_IDS,
  XAI_MODEL_IDS,
} from "../src/known-model-ids.js"

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

  test("ModelProviderId accepts known providers and custom strings", () => {
    expectTypeOf<"openai">().toMatchTypeOf<ModelProviderId>()
    expectTypeOf<"anthropic">().toMatchTypeOf<ModelProviderId>()
    expectTypeOf<string & {}>().toMatchTypeOf<ModelProviderId>()
  })
})

describe("curated model ids", () => {
  it("exposes non-empty curated lists for openai, google, anthropic, xai", () => {
    for (const list of [OPENAI_MODEL_IDS, GOOGLE_MODEL_IDS, ANTHROPIC_MODEL_IDS, XAI_MODEL_IDS]) {
      expect(list.length).toBeGreaterThan(0)
    }
  })

  it("maps curated providers to their lists and omits uncurated providers", () => {
    expect(CURATED_MODEL_IDS.openai).toBe(OPENAI_MODEL_IDS)
    expect(CURATED_MODEL_IDS.google).toBe(GOOGLE_MODEL_IDS)
    expect(CURATED_MODEL_IDS.anthropic).toBe(ANTHROPIC_MODEL_IDS)
    expect(CURATED_MODEL_IDS.xai).toBe(XAI_MODEL_IDS)
    expect(CURATED_MODEL_IDS).not.toHaveProperty("ollama")
    expect(CURATED_MODEL_IDS).not.toHaveProperty("openrouter")
    expect(CURATED_MODEL_IDS).not.toHaveProperty("groq")
  })

  it("keeps the flagship anchors present", () => {
    expect(OPENAI_MODEL_IDS).toContain("gpt-5.5")
    expect(ANTHROPIC_MODEL_IDS).toContain("claude-opus-4-8")
    expect(XAI_MODEL_IDS).toContain("grok-4.3")
    expect(GOOGLE_MODEL_IDS).toContain("gemini-2.5-pro")
  })
})
