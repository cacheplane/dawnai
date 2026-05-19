import { describe, expect, test } from "vitest"
import {
  inferProvider,
  resolveProvider,
  SUPPORTED_AGENT_PROVIDERS,
} from "../src/model-provider-resolver.js"

describe("model provider resolver", () => {
  test.each([
    ["gpt-4o-mini", "openai"],
    ["gpt-5-mini", "openai"],
    ["o3-mini", "openai"],
    ["o4-mini", "openai"],
    ["claude-sonnet-4-5", "anthropic"],
    ["gemini-2.5-pro", "google"],
    ["mistral-large-latest", "mistral"],
    ["mixtral-8x7b", "mistral"],
    ["codestral-latest", "mistral"],
    ["grok-beta", "xai"],
  ] as const)("infers %s as %s", (model, provider) => {
    expect(inferProvider(model)).toBe(provider)
  })

  test.each([
    "my-custom-model",
    "llama-3.3-70b-versatile",
    "qwen3-32b",
    "deepseek-r1",
  ])("does not infer ambiguous model %s", (model) => {
    expect(inferProvider(model)).toBeUndefined()
  })

  test("explicit provider bypasses inference", () => {
    expect(resolveProvider({ provider: "groq", model: "llama-3.3-70b-versatile" })).toBe("groq")
  })

  test("unknown explicit provider fails with supported list", () => {
    expect(() => resolveProvider({ provider: "unknown", model: "gpt-4o" })).toThrow(
      `Unsupported agent provider "unknown". Supported providers: ${SUPPORTED_AGENT_PROVIDERS.join(", ")}.`,
    )
  })

  test("unknown inferred provider asks for explicit provider", () => {
    expect(() => resolveProvider({ model: "internal-alias" })).toThrow(
      'Could not infer a LangChain provider for model "internal-alias". Set provider explicitly on agent({ provider: "...", model: "internal-alias", ... }).',
    )
  })
})
