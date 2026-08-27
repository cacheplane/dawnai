import { describe, expect, it } from "vitest"

import robots from "./robots"

const AI_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "CCBot",
] as const

function normalize(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

describe("robots policy", () => {
  it("declares the owner-approved allow-all policy for named AI agents", () => {
    const metadata = robots()

    expect(metadata.sitemap).toBe("https://dawnai.org/sitemap.xml")
    expect(metadata.host).toBe("https://dawnai.org")

    expect(Array.isArray(metadata.rules)).toBe(true)
    if (!Array.isArray(metadata.rules)) {
      throw new Error("robots metadata must contain one rule group per agent")
    }

    expect(metadata.rules).toHaveLength(AI_AGENTS.length + 1)
    expect(new Set(metadata.rules.flatMap((rule) => normalize(rule.userAgent))).size).toBe(
      metadata.rules.length,
    )
    expect(metadata.rules.flatMap((rule) => normalize(rule.userAgent))).toEqual(["*", ...AI_AGENTS])

    for (const rule of metadata.rules) {
      expect(Object.keys(rule).sort()).toEqual(["allow", "disallow", "userAgent"])
      expect(normalize(rule.allow)).toEqual(["/"])
      expect(normalize(rule.disallow)).toEqual(["/api/"])
    }
  })
})
