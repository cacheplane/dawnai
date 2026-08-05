import { join } from "node:path"
import { type MemoryRecord, sqliteMemoryStore } from "@dawn-ai/memory"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  gated,
  type InspectorServer,
  pkgRoot,
  rawRequestWithHost,
  removeDawnDir,
  resetDawnDir,
  startInspector,
} from "./harness"

const fixtureApp = join(pkgRoot, "test/fixtures/app")
const brokenApp = join(pkgRoot, "test/fixtures/broken-app")
const identityApp = join(pkgRoot, "test/fixtures/identity-app")

function record(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "semantic",
    namespace: "route=/notes",
    content: "seed",
    data: {},
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "candidate",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  }
}

describe.skipIf(!gated)("memory JSON API", () => {
  let server: InspectorServer

  beforeAll(async () => {
    resetDawnDir(fixtureApp)
    const store = sqliteMemoryStore({ path: join(fixtureApp, ".dawn", "memory.sqlite") })
    await store.put(
      record({
        id: "active1",
        status: "active",
        content: "acme threshold is 500",
        data: { subject: "acme", predicate: "threshold", value: "500" },
      }),
    )
    await store.put(
      record({
        id: "cand1",
        content: "acme threshold is 750",
        data: { subject: "acme", predicate: "threshold", value: "750" },
        createdAt: "2026-07-13T01:00:00.000Z",
        updatedAt: "2026-07-13T01:00:00.000Z",
      }),
    )
    await store.put(
      record({
        id: "cand2",
        content: "zed color is blue",
        data: { subject: "zed", predicate: "color", value: "blue" },
        createdAt: "2026-07-13T02:00:00.000Z",
        updatedAt: "2026-07-13T02:00:00.000Z",
      }),
    )
    await store.put(
      record({
        id: "other1",
        namespace: "route=/other",
        status: "active",
        content: "other namespace record",
        data: { subject: "other", predicate: "thing", value: "x" },
      }),
    )
    server = await startInspector(fixtureApp)
  })

  afterAll(async () => {
    await server?.stop()
    removeDawnDir(fixtureApp)
  })

  it("browse lists all records with total", async () => {
    const res = await fetch(`${server.base}/api/memory/list`)
    expect(res.status).toBe(200)
    const page = (await res.json()) as { records: MemoryRecord[]; total: number }
    expect(page.total).toBe(4)
    expect(page.records.map((r) => r.id).sort()).toEqual(["active1", "cand1", "cand2", "other1"])
  })

  it("browse filters by status", async () => {
    const res = await fetch(`${server.base}/api/memory/list?status=candidate`)
    const page = (await res.json()) as { records: MemoryRecord[]; total: number }
    expect(page.total).toBe(2)
    expect(page.records.map((r) => r.id).sort()).toEqual(["cand1", "cand2"])

    // Unknown enum-ish params are rejected honestly, not silently no-matched.
    const bad = await fetch(`${server.base}/api/memory/list?status=bogus`)
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as { error: string }
    expect(badBody.error).toContain('invalid status "bogus"')
  })

  it("browse filters by namespacePrefix across namespaces", async () => {
    const params = new URLSearchParams({ namespacePrefix: "route=/notes" })
    const res = await fetch(`${server.base}/api/memory/list?${params}`)
    const page = (await res.json()) as { records: MemoryRecord[]; total: number }
    expect(page.total).toBe(3)
    expect(page.records.every((r) => r.namespace === "route=/notes")).toBe(true)
  })

  it("stats aggregates byStatus and byNamespace", async () => {
    const res = await fetch(`${server.base}/api/memory/stats`)
    expect(res.status).toBe(200)
    const stats = (await res.json()) as {
      total: number
      byStatus: Record<string, number>
      byNamespace: Record<string, number>
    }
    expect(stats.total).toBe(4)
    expect(stats.byStatus).toEqual({ active: 2, candidate: 2 })
    expect(stats.byNamespace).toEqual({ "route=/notes": 3, "route=/other": 1 })
  })

  it("get returns a record by id and 404 for unknown", async () => {
    const ok = await fetch(`${server.base}/api/memory/active1`)
    expect(ok.status).toBe(200)
    const rec = (await ok.json()) as MemoryRecord
    expect(rec.id).toBe("active1")
    expect(rec.status).toBe("active")

    const missing = await fetch(`${server.base}/api/memory/does-not-exist`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "not found" })
  })

  it("search groups active matches by namespace", async () => {
    const res = await fetch(`${server.base}/api/memory/search?q=threshold`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      groups: { namespace: string; records: MemoryRecord[] }[]
      hybrid: boolean
    }
    expect(body.groups.length).toBeGreaterThan(0)
    const notes = body.groups.find((g) => g.namespace === "route=/notes")
    expect(notes?.records.map((r) => r.id)).toContain("active1")
    // Fixture config defines no embedder — keyword-only path.
    expect(body.hybrid).toBe(false)
  })

  it("search without q returns empty groups", async () => {
    const res = await fetch(`${server.base}/api/memory/search`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ groups: [] })
  })

  it("rejects state-changing requests from a foreign Origin", async () => {
    const res = await fetch(`${server.base}/api/memory/cand1/approve`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("forbidden origin")

    // Same hostname on a DIFFERENT port is still a foreign origin — only the
    // inspector's own origin (host including port) may change state.
    const resOtherPort = await fetch(`${server.base}/api/memory/cand1/approve`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:1" },
    })
    expect(resOtherPort.status).toBe(403)
    expect(((await resOtherPort.json()) as { error: string }).error).toContain("forbidden origin")

    // The inspector's own origin passes the guard (404 = past it, no mutation).
    const resSameOrigin = await fetch(`${server.base}/api/memory/no-such-id/approve`, {
      method: "POST",
      headers: { origin: server.base },
    })
    expect(resSameOrigin.status).toBe(404)

    // The guard fired BEFORE any mutation: cand1 is still a candidate.
    const rec = (await (await fetch(`${server.base}/api/memory/cand1`)).json()) as MemoryRecord
    expect(rec.status).toBe("candidate")
  })

  it("rejects requests with a foreign Host header", async () => {
    // undici's fetch strips forbidden headers like Host, so use raw node:http.
    const res = await rawRequestWithHost(server.port, "/api/memory/list", "evil.example")
    expect(res.status).toBe(403)
    expect(res.body).toContain("forbidden host")
  })

  it("approve reconciles a contradicting candidate by superseding the active row", async () => {
    const res = await fetch(`${server.base}/api/memory/cand1/approve`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      approved: MemoryRecord
      action: string
      superseded: MemoryRecord[]
      identityFallback: boolean
    }
    expect(body.action).toBe("superseded")
    expect(body.superseded[0]?.id).toBe("active1")
    // Fixture app is not discoverable (no package.json) → default identity keys.
    expect(body.identityFallback).toBe(true)
    expect(body.approved.status).toBe("active")

    const old = (await (await fetch(`${server.base}/api/memory/active1`)).json()) as MemoryRecord
    expect(old.status).toBe("superseded")
    const approved = (await (await fetch(`${server.base}/api/memory/cand1`)).json()) as MemoryRecord
    expect(approved.status).toBe("active")
  })

  it("approve returns 404 for unknown ids and 409 for non-candidates", async () => {
    const missing = await fetch(`${server.base}/api/memory/nope/approve`, { method: "POST" })
    expect(missing.status).toBe(404)

    // cand1 is active after the previous approval.
    const again = await fetch(`${server.base}/api/memory/cand1/approve`, { method: "POST" })
    expect(again.status).toBe(409)
    const body = (await again.json()) as { error: string }
    expect(body.error).toContain("not a candidate")
  })

  it("reject guards non-candidates and deletes candidates", async () => {
    const guarded = await fetch(`${server.base}/api/memory/other1/reject`, { method: "POST" })
    expect(guarded.status).toBe(409)
    const guardedBody = (await guarded.json()) as { error: string }
    expect(guardedBody.error).toBe("not a candidate (status: active)")

    const res = await fetch(`${server.base}/api/memory/cand2/reject`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: "cand2" })
    expect((await fetch(`${server.base}/api/memory/cand2`)).status).toBe(404)
  })

  it("forget deletes records of any status (no candidate guard)", async () => {
    const res = await fetch(`${server.base}/api/memory/other1/forget`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: "other1" })
    expect((await fetch(`${server.base}/api/memory/other1`)).status).toBe(404)
  })
})

describe.skipIf(!gated)("identity resolution error discipline", () => {
  let server: InspectorServer

  beforeAll(async () => {
    resetDawnDir(brokenApp)
    const store = sqliteMemoryStore({ path: join(brokenApp, ".dawn", "memory.sqlite") })
    await store.put(
      record({
        id: "bcand1",
        content: "acme threshold is 900",
        data: { subject: "acme", predicate: "threshold", value: "900" },
      }),
    )
    server = await startInspector(brokenApp)
  })

  afterAll(async () => {
    await server?.stop()
    removeDawnDir(brokenApp)
  })

  it("approve surfaces a broken route memory.ts as 500 (no silent fallback)", async () => {
    const res = await fetch(`${server.base}/api/memory/bcand1/approve`, { method: "POST" })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Failed to load .*memory\.ts/)
    expect(body.error).toContain("broken memory.ts fixture")
    // And the candidate was NOT approved.
    const rec = (await (await fetch(`${server.base}/api/memory/bcand1`)).json()) as MemoryRecord
    expect(rec.status).toBe("candidate")
  })
})

describe.skipIf(!gated)("identity resolution happy path (CLI mirror)", () => {
  let server: InspectorServer

  beforeAll(async () => {
    resetDawnDir(identityApp)
    const store = sqliteMemoryStore({ path: join(identityApp, ".dawn", "memory.sqlite") })
    await store.put(
      record({
        id: "iactive1",
        status: "active",
        content: "acme threshold is 500",
        data: { subject: "acme", predicate: "threshold", value: "500" },
      }),
    )
    // Same subject, DIFFERENT predicate: only the route's identity ["subject"]
    // makes this an identity match — the [subject, predicate] default would
    // classify it as a plain add ("activated").
    await store.put(
      record({
        id: "icand1",
        content: "acme limit is 9",
        data: { subject: "acme", predicate: "limit", value: "9" },
        createdAt: "2026-07-13T01:00:00.000Z",
        updatedAt: "2026-07-13T01:00:00.000Z",
      }),
    )
    server = await startInspector(identityApp)
  })

  afterAll(async () => {
    await server?.stop()
    removeDawnDir(identityApp)
  })

  it("approve uses the route memory.ts custom identity keys", async () => {
    const res = await fetch(`${server.base}/api/memory/icand1/approve`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      action: string
      superseded: MemoryRecord[]
      identityKeys: string[]
      identityFallback: boolean
    }
    expect(body.identityFallback).toBe(false)
    expect(body.identityKeys).toEqual(["subject"])
    expect(body.action).toBe("superseded")
    expect(body.superseded[0]?.id).toBe("iactive1")
  })
})

describe.skipIf(!gated)("store resolution failures", () => {
  const missingRoot = join(pkgRoot, "test/fixtures/does-not-exist")
  let server: InspectorServer

  beforeAll(async () => {
    // Deliberately NO resetDawnDir: the app root must not exist. /healthz never
    // touches the store, so the server still becomes ready.
    server = await startInspector(missingRoot)
  })

  afterAll(async () => {
    await server?.stop()
  })

  it("routes surface resolveStore failures as JSON 500, not a generic error page", async () => {
    const res = await fetch(`${server.base}/api/memory/list`)
    expect(res.status).toBe(500)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("nonexistent directory")
    expect(body.error).toContain(missingRoot)
  })
})
