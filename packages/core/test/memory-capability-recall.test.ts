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
      async delete() {},
      async listCandidates() {
        return []
      },
      async browse() {
        return { records: [], total: 0 }
      },
      async stats() {
        return { total: 0, byStatus: {}, byKind: {}, byNamespace: {}, bySourceType: {} }
      },
      async prune() {
        return { deletedExpired: 0, deletedOverCap: 0 }
      },
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

  // A model does not know today's date. Asked about "last week" it invents an
  // absolute window from around its training cutoff (observed live against a
  // 2026 store: since "2023-10-02", until "2023-10-09"), which matches nothing —
  // and an empty result is indistinguishable from an empty store, so the mistake
  // is silent. The schema is the only place to steer it, so pin the steer.
  it("steers the model away from guessed absolute time windows", async () => {
    const marker = createMemoryMarker()
    const contribution = await marker.load("/tmp/nowhere", makeContext({}))
    const recall = contribution.tools?.find((t) => t.name === "recall")
    const shape = (recall?.schema as { shape?: Record<string, { description?: string }> })?.shape
    for (const field of ["since", "until"] as const) {
      const description = shape?.[field]?.description ?? ""
      expect(description).toMatch(/relative/i)
      expect(description).toContain("-7d")
      // The load-bearing half: naming the offsets is useless if the model still
      // believes it knows the date.
      expect(description).toMatch(/do NOT know today's date/i)
    }
  })
})
