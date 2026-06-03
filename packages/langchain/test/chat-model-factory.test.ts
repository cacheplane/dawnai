import { afterEach, describe, expect, it, test, vi } from "vitest"

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
    const importer = vi.fn().mockRejectedValue(
      Object.assign(new Error("Cannot find package '@langchain/anthropic'"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
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
    const importer = vi.fn().mockRejectedValue(
      Object.assign(new Error("Cannot find package '@langchain/google-genai'"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
    )

    await expect(
      createChatModel({ model: "gemini-2.5-flash", provider: "google", importer }),
    ).rejects.toThrow(missingProviderPackageMessage("google", "@langchain/google-genai"))
  })

  test("preserves missing transitive dependency errors", async () => {
    const transitiveError = Object.assign(new Error("Cannot find package 'some-transitive-dep'"), {
      code: "ERR_MODULE_NOT_FOUND",
    })
    const importer = vi.fn().mockRejectedValue(transitiveError)

    await expect(
      createChatModel({ model: "claude-sonnet-4-5", provider: "anthropic", importer }),
    ).rejects.toBe(transitiveError)
  })

  test("preserves errors for similarly named missing packages", async () => {
    const similarPackageError = Object.assign(
      new Error("Cannot find package '@langchain/anthropic-extra'"),
      {
        code: "ERR_MODULE_NOT_FOUND",
      },
    )
    const importer = vi.fn().mockRejectedValue(similarPackageError)

    await expect(
      createChatModel({ model: "claude-sonnet-4-5", provider: "anthropic", importer }),
    ).rejects.toBe(similarPackageError)
  })
})

describe("createChatModel OPENAI_BASE_URL", () => {
  const prev = process.env.OPENAI_BASE_URL
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prev
  })

  it("passes configuration.baseURL for the openai provider when OPENAI_BASE_URL is set", async () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1234/v1"
    let captured: Record<string, unknown> | undefined
    class FakeChatOpenAI {
      constructor(options: Record<string, unknown>) {
        captured = options
      }
    }
    await createChatModel({
      model: "gpt-4o-mini",
      provider: "openai",
      importer: async () => ({ ChatOpenAI: FakeChatOpenAI }),
    })
    expect((captured?.configuration as { baseURL?: string } | undefined)?.baseURL).toBe(
      "http://127.0.0.1:1234/v1",
    )
  })

  it("does not set configuration when OPENAI_BASE_URL is unset", async () => {
    delete process.env.OPENAI_BASE_URL
    let captured: Record<string, unknown> | undefined
    class FakeChatOpenAI {
      constructor(options: Record<string, unknown>) {
        captured = options
      }
    }
    await createChatModel({
      model: "gpt-4o-mini",
      provider: "openai",
      importer: async () => ({ ChatOpenAI: FakeChatOpenAI }),
    })
    expect(captured?.configuration).toBeUndefined()
  })
})
