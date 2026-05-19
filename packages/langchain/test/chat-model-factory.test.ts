import { describe, expect, test, vi } from "vitest"

import { createChatModel, missingProviderPackageMessage } from "../src/chat-model-factory.js"

class FakeModel {
  constructor(readonly options: Record<string, unknown>) {}
}

describe("chat model factory", () => {
  test("creates OpenAI with reasoningEffort", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatOpenAI: FakeModel })

    const model = await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      reasoning: { effort: "high" },
      importer,
    })

    expect(importer).toHaveBeenCalledWith("@langchain/openai")
    expect((model as FakeModel).options).toEqual({
      model: "gpt-5-mini",
      reasoningEffort: "high",
    })
  })

  test("does not pass OpenAI reasoningEffort to Anthropic", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatAnthropic: FakeModel })

    const model = await createChatModel({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      reasoning: { effort: "high" },
      importer,
    })

    expect(importer).toHaveBeenCalledWith("@langchain/anthropic")
    expect((model as FakeModel).options).toEqual({ model: "claude-sonnet-4-5" })
  })

  test("wraps missing optional peer with install command", async () => {
    const importer = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" }),
      )

    await expect(
      createChatModel({ model: "claude-sonnet-4-5", provider: "anthropic", importer }),
    ).rejects.toThrow(missingProviderPackageMessage("anthropic", "@langchain/anthropic"))
  })

  test("creates Google with @langchain/google-genai ChatGoogleGenerativeAI", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatGoogleGenerativeAI: FakeModel })

    const model = await createChatModel({
      model: "gemini-2.5-flash",
      provider: "google",
      importer,
    })

    expect(importer).toHaveBeenCalledWith("@langchain/google-genai")
    expect((model as FakeModel).options).toEqual({ model: "gemini-2.5-flash" })
  })

  test("reports missing Google @langchain/google-genai optional peer", async () => {
    const importer = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" }),
      )

    await expect(
      createChatModel({ model: "gemini-2.5-flash", provider: "google", importer }),
    ).rejects.toThrow(missingProviderPackageMessage("google", "@langchain/google-genai"))
  })
})
