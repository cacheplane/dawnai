import { describe, expect, it } from "vitest"
import { GET } from "./route"

const EXPECTED_MAP_LINKS = [
  ["Getting Started", "/docs/getting-started"],
  ["Memory", "/docs/memory"],
  ["Agent Protocol", "/docs/dev-server/agent-protocol"],
  ["Fixtures and Recording", "/docs/testing-agents/fixtures"],
  ["Persistence and Tenancy", "/docs/persistence"],
  ["Production Topology", "/docs/production-topology"],
  ["Security Architecture", "/docs/security-architecture"],
  ["Deployment Options", "/docs/deployment"],
  ["Configuration Reference", "/docs/configuration"],
  ["API Reference", "/docs/api"],
] as const

describe("compact LLM documentation route", () => {
  it("publishes the curated application-developer documentation map", async () => {
    const body = await (await GET()).text()
    const start = body.indexOf("## Documentation map")
    const end = body.indexOf("\n## ", start + 1)
    const documentationMap = body.slice(start, end === -1 ? undefined : end)

    expect(start).toBeGreaterThanOrEqual(0)
    for (const [label, href] of EXPECTED_MAP_LINKS) {
      expect(documentationMap).toContain(`- [${label}](https://dawnai.org${href})`)
    }
    expect(documentationMap).toContain("[CLI Reference](https://dawnai.org/docs/cli)")
    expect(documentationMap).toContain("[Embed the Runtime](https://dawnai.org/docs/embedding)")
  })

  it("preserves the compact runtime exposure and cancellation warnings", async () => {
    const body = await (await GET()).text()

    expect(body).toContain(
      "Any non-local exposure requires reverse-proxy or platform authentication",
    )
    expect(body).toContain("POST /threads/:thread_id/cancel")
    expect(body).toContain("its run/cancel registry is isolate-local")
  })
})
