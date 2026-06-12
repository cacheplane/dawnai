import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { warnOnUnknownModelId } from "../src/chat-model-factory.js"

describe("model id warnings", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("warns once per (model, provider) pair with suggestions", () => {
    warnOnUnknownModelId({ model: "gpt-5", provider: "openai" })
    warnOnUnknownModelId({ model: "gpt-5", provider: "openai" })
    expect(console.warn).toHaveBeenCalledTimes(1)
    const message = vi.mocked(console.warn).mock.calls[0]?.[0] as string
    expect(message).toContain("[dawn:models]")
    expect(message).toContain('"gpt-5"')
    expect(message).toContain("gpt-5.5")
    expect(message).toContain("Proceeding anyway")
  })

  it("stays silent for curated hits and uncurated providers", () => {
    warnOnUnknownModelId({ model: "gpt-5.5", provider: "openai" })
    warnOnUnknownModelId({ model: "llama3.1", provider: "ollama" })
    expect(console.warn).not.toHaveBeenCalled()
  })
})
