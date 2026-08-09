import { __clearSeededRuntimeEnvForTests, seedRuntimeEnv } from "@dawn-ai/core"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createChatModel } from "../src/chat-model-factory.js"
import { buildSummarizationHook } from "../src/summarization/hook.js"

/**
 * The langchain half of the runtime-env seam.
 *
 * `OPENAI_BASE_URL` is the hot path — `createChatModel` runs it on every openai
 * construction, i.e. the first turn of the canonical gpt-5-mini app. It is also
 * the one read here that is NOT debug-only: guarding it would have left the
 * edge with a base URL that could not be configured at all, and the workerd CI
 * lane points the model at a local aimock through exactly this variable.
 *
 * Node-side `process.env` coverage for it already lives in
 * `chat-model-factory.test.ts`; what follows is the seeded/edge half plus the
 * precedence rule that keeps the node path authoritative.
 */

class FakeModel {
  constructor(readonly options: Record<string, unknown>) {}
}

const importer = () => Promise.resolve({ ChatOpenAI: FakeModel } as Record<string, unknown>)

async function openaiModel(): Promise<FakeModel> {
  return (await createChatModel({
    model: "gpt-5-mini",
    provider: "openai",
    importer,
  })) as FakeModel
}

describe("OPENAI_BASE_URL through the runtime-env seam", () => {
  const previous = process.env.OPENAI_BASE_URL

  afterEach(() => {
    __clearSeededRuntimeEnvForTests()
    vi.unstubAllGlobals()
    if (previous === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previous
  })

  it("uses the seeded base URL when process.env has none", async () => {
    delete process.env.OPENAI_BASE_URL
    seedRuntimeEnv({ OPENAI_BASE_URL: "http://127.0.0.1:4010/v1" })
    const model = await openaiModel()
    expect(model.options.configuration).toEqual({ baseURL: "http://127.0.0.1:4010/v1" })
  })

  it("lets process.env win over a seeded value", async () => {
    process.env.OPENAI_BASE_URL = "http://from-process/v1"
    seedRuntimeEnv({ OPENAI_BASE_URL: "http://from-seed/v1" })
    const model = await openaiModel()
    expect(model.options.configuration).toEqual({ baseURL: "http://from-process/v1" })
  })

  it("omits configuration entirely when neither source has it", async () => {
    delete process.env.OPENAI_BASE_URL
    const model = await openaiModel()
    expect(model.options).toEqual({ model: "gpt-5-mini" })
  })

  it("constructs a model on a runtime with no process at all", async () => {
    // The defect: the old bare `process.env.OPENAI_BASE_URL` threw here, so the
    // very first turn of an edge-deployed app died before reaching the model.
    delete process.env.OPENAI_BASE_URL
    seedRuntimeEnv({ OPENAI_BASE_URL: "http://edge-aimock/v1" })
    vi.stubGlobal("process", undefined)
    let model: FakeModel
    try {
      model = await openaiModel()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(model.options.configuration).toEqual({ baseURL: "http://edge-aimock/v1" })
  })
})

describe("DAWN_DEBUG_SUMMARIZATION under node", () => {
  afterEach(() => {
    __clearSeededRuntimeEnvForTests()
    vi.restoreAllMocks()
    delete process.env.DAWN_DEBUG_SUMMARIZATION
  })

  // Over the threshold, with a summarize that throws → the fallback path that
  // carries the gated warn.
  function failingHook() {
    return buildSummarizationHook({
      maxTokens: 5,
      keepRecentTurns: 1,
      model: "fake",
      tokenCounter: (t: string) => t.length,
      summarize: async () => {
        throw new Error("summarize boom")
      },
    } as never)
  }

  const messages = () => [
    new HumanMessage("u1"),
    new AIMessage("a1"),
    new HumanMessage("u2"),
    new AIMessage("a2"),
  ]

  it("warns when set to 1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    process.env.DAWN_DEBUG_SUMMARIZATION = "1"
    const out = await failingHook()({ messages: messages() })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("summarization failed"),
      expect.anything(),
    )
    // The fallback itself must be unaffected by the flag.
    expect(out.llmInputMessages).toHaveLength(4)
  })

  it("stays silent when unset, and still falls back to the full history", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const out = await failingHook()({ messages: messages() })
    expect(warn).not.toHaveBeenCalled()
    expect(out.llmInputMessages).toHaveLength(4)
  })

  it("is reachable on a runtime with no process, via seedRuntimeEnv", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    seedRuntimeEnv({ DAWN_DEBUG_SUMMARIZATION: "1" })
    await failingHook()({ messages: messages() })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("summarization failed"),
      expect.anything(),
    )
  })
})
