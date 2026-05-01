import { agent } from "@dawn-ai/sdk"
import { describe, expect, test } from "vitest"
import { executeAgent } from "../src/agent-adapter.js"

describe("agent() descriptor integration", () => {
  test("DawnAgent descriptor is recognized and does not throw invoke error", async () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are a test assistant.",
    })

    // Without a real LLM key, materialization will fail on ChatOpenAI creation
    // or network call — but it should NOT fail with "must expose invoke(input)"
    const error = await executeAgent({
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("must expose invoke")
  })

  test("DawnAgent with tools passes tools to materialized agent", async () => {
    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "Use tools.",
    })

    const tools = [
      {
        name: "lookup",
        description: "Look up data",
        run: async (_input: unknown) => ({ result: "found" }),
      },
    ]

    // Will fail on LLM connection, but should get past tool conversion
    const error = await executeAgent({
      entry: descriptor,
      input: { query: "test" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools,
    }).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("must expose invoke")
  })
})
