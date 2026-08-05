import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { approveWithReconcile, type MemoryRecord, sqliteMemoryStore } from "../src/index.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-rec-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "status">): MemoryRecord {
  return {
    kind: "semantic",
    namespace: "route=/notes",
    content: over.id,
    data: { subject: "acme", predicate: "threshold", value: "500" },
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }
}
const KEYS = ["subject", "predicate"] as const
const NOW = "2026-07-13T00:00:00.000Z"

describe("approveWithReconcile", () => {
  it("plain activate when no identity match", async () => {
    const s = makeStore()
    await s.put(rec({ id: "cand", status: "candidate" }))
    const res = await approveWithReconcile(s, "cand", { identityKeys: KEYS, now: NOW })
    expect(res.action).toBe("activated")
    expect((await s.get("cand"))?.status).toBe("active")
  })
  it("supersedes a contradicting active row (the two-actives bug)", async () => {
    const s = makeStore()
    await s.put(rec({ id: "old", status: "active" }))
    await s.put(
      rec({
        id: "cand",
        status: "candidate",
        data: { subject: "acme", predicate: "threshold", value: "750" },
      }),
    )
    const res = await approveWithReconcile(s, "cand", { identityKeys: KEYS, now: NOW })
    expect(res.action).toBe("superseded")
    expect(res.superseded.map((r) => r.id)).toEqual(["old"])
    expect((await s.get("old"))?.status).toBe("superseded")
    const approved = await s.get("cand")
    expect(approved?.status).toBe("active")
    expect(approved?.supersedes).toContain("old")
    expect(approved?.updatedAt).toBe(NOW)
  })
  it("dedupes an identical-data candidate instead of double-activating", async () => {
    const s = makeStore()
    await s.put(rec({ id: "old", status: "active" }))
    await s.put(rec({ id: "cand", status: "candidate" }))
    const res = await approveWithReconcile(s, "cand", { identityKeys: KEYS, now: NOW })
    expect(res.action).toBe("deduped")
    expect(res.approved.id).toBe("old")
    expect(await s.get("cand")).toBeNull()
  })
  it("rejects a non-candidate", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", status: "active" }))
    await expect(approveWithReconcile(s, "a", { identityKeys: KEYS, now: NOW })).rejects.toThrow(
      /candidate/,
    )
  })
  it("rejects an unknown id", async () => {
    const s = makeStore()
    await expect(approveWithReconcile(s, "nope", { identityKeys: KEYS, now: NOW })).rejects.toThrow(
      /not found/,
    )
  })
})
