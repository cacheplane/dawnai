import { describe, expect, it } from "vitest"
import { validateModelId } from "../src/validate-model-id.js"

describe("validateModelId", () => {
  it("flags a near-miss on a curated provider with distance-then-prefix-ranked suggestions", () => {
    const result = validateModelId({ model: "gpt-5" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.provider).toBe("openai")
      // "gpt-4o", "gpt-5.4", "gpt-5.5" all sit at levenshtein distance 2, but the
      // 5.x ids share the full "gpt-5" prefix with the input (5 chars vs 4), so the
      // prefix tie-break ranks them first; alphabetical settles 5.4 vs 5.5.
      expect(result.suggestions).toEqual(["gpt-5.4", "gpt-5.5", "gpt-4o"])
    }
  })

  it("accepts curated hits", () => {
    expect(validateModelId({ model: "gpt-5.5" })).toEqual({ ok: true })
    expect(validateModelId({ model: "claude-opus-4-8" })).toEqual({ ok: true })
    expect(validateModelId({ model: "grok-4.3" })).toEqual({ ok: true })
  })

  it("stays silent for uncurated providers", () => {
    expect(validateModelId({ model: "llama3.1", provider: "ollama" })).toEqual({ ok: true })
    expect(validateModelId({ model: "anything", provider: "openrouter" })).toEqual({ ok: true })
    expect(validateModelId({ model: "mixtral-8x22b" })).toEqual({ ok: true }) // infers mistral, uncurated
  })

  it("stays silent when no provider can be resolved", () => {
    expect(validateModelId({ model: "totally-custom" })).toEqual({ ok: true })
  })

  it("explicit provider beats inference", () => {
    // gpt-prefixed model explicitly routed through an uncurated gateway: silent
    expect(validateModelId({ model: "gpt-5", provider: "openrouter" })).toEqual({ ok: true })
    // custom-named model explicitly on a curated provider: flagged
    const result = validateModelId({ model: "my-alias", provider: "anthropic" })
    expect(result.ok).toBe(false)
  })

  it("flags an anthropic near-miss with a suggestion", () => {
    const result = validateModelId({ model: "claude-opus-4.8" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.suggestions).toContain("claude-opus-4-8")
  })
})
