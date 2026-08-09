import { afterEach, describe, expect, it, vi } from "vitest"
import { createMemoryMarker } from "../src/capabilities/built-in/memory.js"
import type { CapabilityMarkerContext, Embedder, MemoryContext } from "../src/capabilities/types.js"
import { __clearSeededRuntimeEnvForTests, seedRuntimeEnv } from "../src/runtime-env.js"

/**
 * `DAWN_DEBUG_MEMORY` used to be read as a bare `process.env.DAWN_DEBUG_MEMORY`,
 * which is a ReferenceError on a runtime with no `process`. It now goes through
 * `readRuntimeEnv`. These tests pin the NODE behaviour — on/off exactly as
 * before — and then prove the same flag is reachable on the edge by seeding.
 */

const NOW = "2026-07-05T12:00:00.000Z"

const throwingEmbedder: Embedder = {
  id: "fake:test",
  dims: 2,
  embed: async () => {
    throw new Error("embed boom")
  },
}

function makeContext(): CapabilityMarkerContext {
  const memory: MemoryContext = {
    store: {
      async put() {},
      async get() {
        return null
      },
      async search() {
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
    validate: () => ({ ok: true, value: { subject: "x" } }),
    now: () => NOW,
    embedder: throwingEmbedder,
  }
  return {
    routeManifest: {} as never,
    descriptor: undefined,
    appRoot: "/tmp/nowhere",
    memory,
  }
}

async function toolNamed(name: "recall" | "remember") {
  const contribution = await createMemoryMarker().load("/tmp/nowhere", makeContext())
  const tool = contribution.tools?.find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

const signal = () => ({ signal: new AbortController().signal })

describe("DAWN_DEBUG_MEMORY under node", () => {
  afterEach(() => {
    __clearSeededRuntimeEnvForTests()
    vi.restoreAllMocks()
    delete process.env.DAWN_DEBUG_MEMORY
  })

  it("warns on a failed recall embed when set to 1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    process.env.DAWN_DEBUG_MEMORY = "1"
    await (await toolNamed("recall")).run({ query: "expedite delivery" }, signal())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recall embed failed"))
  })

  it("stays silent when unset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await (await toolNamed("recall")).run({ query: "expedite delivery" }, signal())
    expect(warn).not.toHaveBeenCalled()
  })

  it("stays silent for a value other than 1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    process.env.DAWN_DEBUG_MEMORY = "true"
    await (await toolNamed("recall")).run({ query: "expedite delivery" }, signal())
    expect(warn).not.toHaveBeenCalled()
  })

  it("warns on a failed remember embed when set to 1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    process.env.DAWN_DEBUG_MEMORY = "1"
    await (await toolNamed("remember")).run(
      { data: { subject: "x" }, content: "faster shipping" },
      signal(),
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("remember embed failed"))
  })

  it("is reachable on a runtime with no process, via seedRuntimeEnv", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    seedRuntimeEnv({ DAWN_DEBUG_MEMORY: "1" })
    await (await toolNamed("recall")).run({ query: "expedite delivery" }, signal())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recall embed failed"))
  })
})
