import { describe, expect, it } from "vitest"
import { createMemoryMarker } from "../src/capabilities/built-in/memory.js"
import type { CapabilityMarkerContext, Embedder, MemoryContext } from "../src/capabilities/types.js"

const NOW = "2026-07-05T12:00:00.000Z"

// Tiny deterministic embedder — every text maps to the same unit vector so we
// only assert the WIRING (that the capability embeds + threads through), not the
// vector math (covered by the store/embedder unit tests).
const fakeEmbedder: Embedder = {
  id: "fake:test",
  dims: 2,
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0])),
}

// A throwing embedder — used to prove the capability degrades to keyword-only
// (never throws, never loses the write) when embedding fails.
const throwingEmbedder: Embedder = {
  id: "fake:test",
  dims: 2,
  embed: async () => {
    throw new Error("embed boom")
  },
}

interface Captured {
  lastQuery?: Record<string, unknown>
  lastPut?: { record: unknown; opts?: unknown }
  putCount: number
}

function makeContext(captured: Captured, embedder: Embedder | undefined): CapabilityMarkerContext {
  const memory: MemoryContext = {
    store: {
      async put(record, opts) {
        captured.putCount += 1
        captured.lastPut = { record, opts }
      },
      async get() {
        return null
      },
      async search(q) {
        // The query-less index search also lands here; only capture ranked queries.
        if ((q as { query?: string }).query) captured.lastQuery = q as Record<string, unknown>
        return []
      },
      async update() {},
      async supersede() {},
    },
    namespace: "route=/probe",
    writes: "auto",
    defined: { kind: "semantic", scope: ["route"] },
    validate: () => ({ ok: true, value: { subject: "x" } }),
    now: NOW,
    ...(embedder ? { embedder } : {}),
  }
  return {
    routeManifest: {} as never,
    descriptor: undefined,
    appRoot: "/tmp/nowhere",
    memory,
  }
}

describe("memory capability vector wiring", () => {
  it("recall embeds the query → store receives queryEmbedding + embedderId", async () => {
    const captured: Captured = { putCount: 0 }
    const marker = createMemoryMarker()
    const contribution = await marker.load("/tmp/nowhere", makeContext(captured, fakeEmbedder))
    const recall = contribution.tools?.find((t) => t.name === "recall")
    expect(recall).toBeDefined()
    await recall?.run({ query: "expedite delivery" }, { signal: new AbortController().signal })
    expect(captured.lastQuery?.queryEmbedding).toBeInstanceOf(Float32Array)
    expect(captured.lastQuery?.embedderId).toBe("fake:test")
  })

  it("remember embeds content → store.put receives embedding + embeddingModel", async () => {
    const captured: Captured = { putCount: 0 }
    const marker = createMemoryMarker()
    const contribution = await marker.load("/tmp/nowhere", makeContext(captured, fakeEmbedder))
    const remember = contribution.tools?.find((t) => t.name === "remember")
    expect(remember).toBeDefined()
    await remember?.run(
      { data: { subject: "x" }, content: "faster shipping preferred" },
      { signal: new AbortController().signal },
    )
    expect(captured.putCount).toBe(1)
    const opts = captured.lastPut?.opts as
      | { embedding?: Float32Array; embeddingModel?: string }
      | undefined
    expect(opts?.embedding).toBeInstanceOf(Float32Array)
    expect(opts?.embeddingModel).toBe("fake:test")
  })

  it("embed failure degrades to keyword-only: recall still searches, no throw", async () => {
    const captured: Captured = { putCount: 0 }
    const marker = createMemoryMarker()
    const contribution = await marker.load("/tmp/nowhere", makeContext(captured, throwingEmbedder))
    const recall = contribution.tools?.find((t) => t.name === "recall")
    await recall?.run({ query: "expedite delivery" }, { signal: new AbortController().signal })
    expect(captured.lastQuery?.query).toBe("expedite delivery")
    expect(captured.lastQuery?.queryEmbedding).toBeUndefined()
    expect(captured.lastQuery?.embedderId).toBeUndefined()
  })

  it("embed failure degrades to keyword-only: remember still stores, no lost write", async () => {
    const captured: Captured = { putCount: 0 }
    const marker = createMemoryMarker()
    const contribution = await marker.load("/tmp/nowhere", makeContext(captured, throwingEmbedder))
    const remember = contribution.tools?.find((t) => t.name === "remember")
    await remember?.run(
      { data: { subject: "x" }, content: "faster shipping preferred" },
      { signal: new AbortController().signal },
    )
    expect(captured.putCount).toBe(1)
    expect(captured.lastPut?.opts).toBeUndefined()
  })
})
