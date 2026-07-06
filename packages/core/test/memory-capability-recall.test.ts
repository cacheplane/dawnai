import { describe, expect, it } from "vitest"
import { createMemoryMarker } from "../src/capabilities/built-in/memory.js"
import type { CapabilityMarkerContext, MemoryContext } from "../src/capabilities/types.js"

const NOW = "2026-07-05T12:00:00.000Z"

function makeContext(captured: { query?: Record<string, unknown> }): CapabilityMarkerContext {
  const memory: MemoryContext = {
    store: {
      async put() {},
      async get() {
        return null
      },
      async search(q) {
        // The index query (query-less) also lands here; only capture ranked queries.
        if ((q as { query?: string }).query) captured.query = q as Record<string, unknown>
        return []
      },
      async update() {},
      async supersede() {},
    },
    namespace: "route=/probe",
    writes: "auto",
    defined: { kind: "semantic", scope: ["route"] },
    validate: () => ({ ok: true, value: {} }),
    now: NOW,
  }
  return {
    routeManifest: {} as never,
    descriptor: undefined,
    appRoot: "/tmp/nowhere",
    memory,
  }
}

describe("memory capability recall tool", () => {
  it("passes context.memory.now as the recency reference on ranked searches", async () => {
    const captured: { query?: Record<string, unknown> } = {}
    const marker = createMemoryMarker()
    const contribution = await marker.load("/tmp/nowhere", makeContext(captured))
    const recall = contribution.tools?.find((t) => t.name === "recall")
    expect(recall).toBeDefined()
    await recall?.run({ query: "billing threshold" }, { signal: new AbortController().signal })
    expect(captured.query?.now).toBe(NOW)
  })
})
