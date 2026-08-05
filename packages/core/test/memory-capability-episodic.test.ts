import { describe, expect, it } from "vitest"
import { createMemoryMarker } from "../src/capabilities/built-in/memory.js"
import type {
  CapabilityMarkerContext,
  MemoryContext,
  MemoryRecordLike,
  MemoryStoreLike,
} from "../src/capabilities/types.js"

const NOW = "2026-08-05T12:00:00.000Z"

interface CallLog {
  puts: MemoryRecordLike[]
  updates: number
  supersedes: number
  /** Every search q, in call order. The FIRST search is the load-time index query. */
  searches: Record<string, unknown>[]
}

function makeStore(log: CallLog): MemoryStoreLike {
  return {
    async put(record) {
      log.puts.push(record)
    },
    async get() {
      return null
    },
    async search(q) {
      log.searches.push(q as Record<string, unknown>)
      return []
    },
    async update() {
      log.updates += 1
    },
    async supersede() {
      log.supersedes += 1
    },
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
  }
}

function makeContext(
  log: CallLog,
  over: Partial<Pick<MemoryContext, "writes" | "defined">> = {},
): CapabilityMarkerContext {
  const memory: MemoryContext = {
    store: makeStore(log),
    namespace: "route=/probe",
    writes: "auto",
    defined: { kind: "episodic", scope: ["route"] },
    validate: () => ({ ok: true, value: { event: "deployed" } }),
    now: NOW,
    ...over,
  }
  return {
    routeManifest: {} as never,
    descriptor: undefined,
    appRoot: "/tmp/nowhere",
    memory,
  }
}

function newLog(): CallLog {
  return { puts: [], updates: 0, supersedes: 0, searches: [] }
}

async function loadTools(log: CallLog, over?: Partial<Pick<MemoryContext, "writes" | "defined">>) {
  const marker = createMemoryMarker()
  const contribution = await marker.load("/tmp/nowhere", makeContext(log, over))
  const recall = contribution.tools?.find((t) => t.name === "recall")
  const remember = contribution.tools?.find((t) => t.name === "remember")
  return { recall, remember }
}

const signal = () => ({ signal: new AbortController().signal })

describe("episodic remember (append-only)", () => {
  it("appends twice with identical data — two puts, zero supersede/update, no identity scan", async () => {
    const log = newLog()
    const { remember } = await loadTools(log)
    const input = { data: { event: "deployed" }, content: "deployed v2 to staging" }
    const r1 = (await remember?.run(input, signal())) as { result: string }
    const r2 = (await remember?.run(input, signal())) as { result: string }
    expect(log.puts.length).toBe(2)
    expect(log.updates).toBe(0)
    expect(log.supersedes).toBe(0)
    // Only the load-time index search ran — the append path never scans actives.
    expect(log.searches.length).toBe(1)
    expect(r1.result).toMatch(/Stored memory/)
    expect(r2.result).toMatch(/Stored memory/)
    // Accepted same-request id collapse: same data + same mem.now → same id, so
    // a real store's id-keyed upsert keeps ONE row for this degenerate case.
    // Distinct real-world episodes always differ in data or request time.
    expect(log.puts[0]?.id).toBe(log.puts[1]?.id)
    const rec = log.puts[0]
    expect(rec?.kind).toBe("episodic")
    expect(rec?.status).toBe("active")
    expect(rec?.effectiveAt).toBe(NOW)
    expect(rec?.expiresAt).toBeUndefined()
  })

  it("candidate mode writes an episodic candidate", async () => {
    const log = newLog()
    const { remember } = await loadTools(log, { writes: "candidate" })
    await remember?.run({ data: { event: "deployed" }, content: "x" }, signal())
    expect(log.puts.length).toBe(1)
    expect(log.puts[0]?.status).toBe("candidate")
    expect(log.puts[0]?.effectiveAt).toBe(NOW)
  })

  it("procedural kind returns a not-yet-wired tool error with zero store writes", async () => {
    const log = newLog()
    const { remember } = await loadTools(log, {
      defined: { kind: "procedural", scope: ["route"] },
    })
    const out = (await remember?.run({ data: { event: "x" }, content: "x" }, signal())) as {
      result: string
    }
    expect(out.result).toContain("not yet wired")
    expect(log.puts.length).toBe(0)
    expect(log.updates).toBe(0)
    expect(log.supersedes).toBe(0)
    // No store calls beyond the load-time index search.
    expect(log.searches.length).toBe(1)
  })
})

describe("recall since/until time windows", () => {
  it("passes resolved ISO since/until to store.search (relative resolved against the request clock)", async () => {
    const log = newLog()
    const { recall } = await loadTools(log)
    await recall?.run(
      { query: "deploy", since: "-24h", until: "2026-08-05T00:00:00.000Z" },
      signal(),
    )
    const q = log.searches.at(-1)
    expect(q?.since).toBe(new Date(Date.parse(NOW) - 86_400_000).toISOString())
    expect(q?.until).toBe("2026-08-05T00:00:00.000Z")
    expect(q?.now).toBe(NOW)
  })

  it("garbage since returns the actionable message and never hits search", async () => {
    const log = newLog()
    const { recall } = await loadTools(log)
    const before = log.searches.length
    const out = (await recall?.run({ query: "deploy", since: "yesterday" }, signal())) as {
      result: string
    }
    expect(out.result).toMatch(/ISO timestamp or relative/)
    expect(log.searches.length).toBe(before)
  })
})

describe("memory-index prompt fragment", () => {
  it("passes the request `now` into the load-time index search (expired rows must not be advertised)", async () => {
    const log = newLog()
    const marker = createMemoryMarker()
    await marker.load("/tmp/nowhere", makeContext(log))
    // The FIRST search is the index query built at load time.
    expect(log.searches[0]?.now).toBe(NOW)
  })
})
