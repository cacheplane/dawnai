# Episodic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the episodic memory kind end-to-end — runtime auto-recorder (one episode per run), agent-authored episodes, time-windowed recall, TTL+cap retention via a new required `prune`, and an Inspector timeline view.

**Architecture:** A pure `writePolicyFor(kind)` seam in `@dawn-ai/memory` makes episodic append-only while semantic keeps its reconcile flow; `MemoryQuery`/`BrowseQuery` gain ISO `since`/`until` windows on `COALESCE(effective_at, created_at)` with expiry exclusion when `now` is supplied; a post-run hook in `executeRoute` records episodes deterministically from the trace; the Inspector's Memory panel gains a list/timeline toggle.

**Tech Stack:** node:sqlite + pg (both MemoryStore backends), conformance kit in `@dawn-ai/testing`, aimock harness for recorder integration, Next.js/React 19 inspector, vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-episodic-memory-design.md` — read it first.

**USER DIRECTIVE (applies to every task):** verification and testing must be EXTREMELY robust. Strict TDD with failing-first evidence reported per task. Gated real-backend runs are MANDATORY where marked (`DAWN_TEST_PGVECTOR=1` with real Docker, `DAWN_TEST_INSPECTOR=1` with the built standalone server) — an implementer may not claim DONE without running them. Edge/property tests are enumerated per task and are requirements, not suggestions.

**Working rules (repo memory):** branch-pin (`git rev-parse --abbrev-ref HEAD` → `feat/episodic-memory`) before every commit; never bare `biome check --write`; changesets in the fixed 0.x group are always **patch**; all commands from the worktree root `/Users/blove/repos/dawn/.claude/worktrees/episodic-memory`.

---

## File map

| Area | Files |
|---|---|
| Policy seam | `packages/memory/src/reconcile.ts` (writePolicyFor + approveWithReconcile consult), `packages/memory/src/index.ts` |
| Time windows + expiry | `packages/memory/src/types.ts` (MemoryQuery/BrowseQuery since/until, BrowseQuery.now), `packages/memory/src/sqlite-store.ts` (filters + migration v3 index), `packages/memory-pgvector/src/pgvector-store.ts` + `schema.ts` (filters + index) |
| prune | `packages/memory/src/types.ts` (required method), both stores, `packages/core/src/capabilities/types.ts` (MemoryStoreLike parity) |
| Conformance | `packages/testing/src/memory-conformance.ts` |
| Capability | `packages/core/src/capabilities/built-in/memory.ts` (policy consult in remember, recall since/until, resolveTimeExpr), `packages/core/src/types.ts` (episodes config) |
| Recorder | `packages/cli/src/lib/runtime/record-episode.ts` (new), `packages/cli/src/lib/runtime/execute-route.ts` (hook), `packages/cli/src/lib/runtime/resolve-memory.ts` (episodes config resolution) |
| CLI | `packages/cli/src/commands/memory.ts` (prune subcommand) |
| Inspector | `packages/inspector/app/api/memory/list/route.ts`, `src/components/memory/{list-page,timeline-view}.tsx`, tests |
| Dogfood/docs | `examples/memory/server/dawn.config.ts`, `apps/web/content/docs/{memory,upgrading,inspector}.mdx`, `docs/dev/memory-system.md`, `.changeset/episodic-memory.md` |

Task order: EP1 → EP2 → EP3 → EP4 → EP5 → EP6 → EP7 → EP8 → EP9 → EP10. EP7 (CLI prune) may interleave after EP4.

---

### Task EP1: `writePolicyFor` seam + policy-aware approve

**Files:**
- Modify: `packages/memory/src/reconcile.ts`, `packages/memory/src/index.ts`
- Test: `packages/memory/test/write-policy.test.ts` (create), `packages/memory/test/reconcile-approve.test.ts` (extend)

- [ ] **Step 1: Failing tests**

`packages/memory/test/write-policy.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { writePolicyFor } from "../src/index.js"

describe("writePolicyFor", () => {
  it("semantic reconciles", () => {
    expect(writePolicyFor("semantic")).toEqual({ mode: "reconcile" })
  })
  it("episodic appends", () => {
    expect(writePolicyFor("episodic")).toEqual({ mode: "append" })
  })
  it("procedural and reflection throw a not-yet-wired error", () => {
    expect(() => writePolicyFor("procedural")).toThrow(/not yet wired/)
    expect(() => writePolicyFor("reflection")).toThrow(/not yet wired/)
  })
})
```
Extend `packages/memory/test/reconcile-approve.test.ts` (reuse its `makeStore`/`rec` helpers):
```ts
  it("approves an episodic candidate as a plain activation (no identity scan, no supersession)", async () => {
    const s = makeStore()
    // Two episodic rows with IDENTICAL data — under semantic policy this would
    // dedupe/supersede; append policy must activate without touching the other.
    await s.put(rec({ id: "ep-old", status: "active", kind: "episodic" }))
    await s.put(rec({ id: "ep-cand", status: "candidate", kind: "episodic" }))
    const res = await approveWithReconcile(s, "ep-cand", { identityKeys: KEYS, now: NOW })
    expect(res.action).toBe("activated")
    expect(res.superseded).toEqual([])
    expect((await s.get("ep-old"))?.status).toBe("active")
    expect((await s.get("ep-cand"))?.status).toBe("active")
  })
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @dawn-ai/memory test write-policy`
Expected: FAIL — `writePolicyFor` not exported. The approve test fails with action `"deduped"` (semantic policy applied to identical data).

- [ ] **Step 3: Implement**

In `packages/memory/src/reconcile.ts`:
```ts
export type WritePolicy = { readonly mode: "reconcile" } | { readonly mode: "append" }

/** Per-kind write discipline. Semantic facts reconcile (identity match →
 *  update/supersede); episodic events append (a later episode never
 *  contradicts an earlier one). Procedural/reflection are typed but not yet
 *  wired — throwing beats baking in accidental semantics. */
export function writePolicyFor(kind: MemoryKind): WritePolicy {
  switch (kind) {
    case "semantic":
      return { mode: "reconcile" }
    case "episodic":
      return { mode: "append" }
    default:
      throw new Error(`memory kind '${kind}' is not yet wired (semantic and episodic are)`)
  }
}
```
In `approveWithReconcile`, immediately after the candidate-status check:
```ts
  if (writePolicyFor(candidate.kind).mode === "append") {
    // Append-only kinds: approval is a plain activation — no identity scan.
    await store.update(id, { status: "active", updatedAt: opts.now })
    const approved = await store.get(id)
    if (!approved) throw new Error(`approved memory ${id} vanished`)
    return { approved, action: "activated", superseded: [], identityKeys: opts.identityKeys }
  }
```
Export `writePolicyFor` + `WritePolicy` from `packages/memory/src/index.ts`.

- [ ] **Step 4: Green + guard**

Run: `pnpm --filter @dawn-ai/memory test` — ALL memory tests green (the existing 90+ must not change).
Run: `pnpm --filter @dawn-ai/memory typecheck && pnpm --filter @dawn-ai/memory lint`

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/memory
git commit -m "feat(memory): writePolicyFor kind seam; approve treats append kinds as plain activation"
```

---

### Task EP2: time windows + expiry exclusion — types + sqlite (+ migration v3 index)

**Files:**
- Modify: `packages/memory/src/types.ts`, `packages/memory/src/sqlite-store.ts`
- Test: `packages/memory/test/time-window.test.ts` (create)

- [ ] **Step 1: Types**

`packages/memory/src/types.ts` — add to `MemoryQuery` AND `BrowseQuery`:
```ts
  /** ISO lower bound (inclusive) on COALESCE(effectiveAt, createdAt). */
  readonly since?: string
  /** ISO upper bound (exclusive) on COALESCE(effectiveAt, createdAt). */
  readonly until?: string
```
`BrowseQuery` additionally gains:
```ts
  /** When supplied, rows with expiresAt <= now are excluded (matches search's `now`). */
  readonly now?: string
```
(`MemoryQuery.now` already exists for ranking; its meaning EXTENDS to expiry exclusion — documented on the field: append to its doc comment "Also excludes rows with expiresAt <= now.")

- [ ] **Step 2: Failing tests** — `packages/memory/test/time-window.test.ts`

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MemoryRecord, sqliteMemoryStore } from "../src/index.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-tw-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "episodic",
    namespace: "route=/n",
    content: over.id,
    data: {},
    source: { type: "run", id: "r" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}
const D = (day: number) => `2026-08-0${day}T00:00:00.000Z`

describe("search time windows", () => {
  it("filters on effectiveAt with inclusive since / exclusive until", async () => {
    const s = makeStore()
    await s.put(rec({ id: "d1", effectiveAt: D(1) }))
    await s.put(rec({ id: "d2", effectiveAt: D(2) }))
    await s.put(rec({ id: "d3", effectiveAt: D(3) }))
    const out = await s.search({ namespace: "route=/n", since: D(2), until: D(3) })
    expect(out.map((r) => r.id)).toEqual(["d2"]) // since inclusive, until exclusive
  })
  it("falls back to createdAt for legacy rows without effectiveAt", async () => {
    const s = makeStore()
    await s.put(rec({ id: "legacy", createdAt: D(2), updatedAt: D(2) })) // no effectiveAt
    await s.put(rec({ id: "outside", createdAt: D(5), updatedAt: D(5) }))
    const out = await s.search({ namespace: "route=/n", since: D(1), until: D(3) })
    expect(out.map((r) => r.id)).toEqual(["legacy"])
  })
  it("windowed query-less search returns event-time order (effectiveAt DESC, id ASC)", async () => {
    const s = makeStore()
    // updatedAt order is DELIBERATELY the reverse of effectiveAt order —
    // proves windowed ordering uses event time, not update time.
    await s.put(rec({ id: "b", effectiveAt: D(3), updatedAt: D(1) }))
    await s.put(rec({ id: "a", effectiveAt: D(1), updatedAt: D(3) }))
    await s.put(rec({ id: "c", effectiveAt: D(3), updatedAt: D(2) }))
    const out = await s.search({ namespace: "route=/n", since: D(1) })
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]) // D3 pair id-ASC, then D1
  })
})

describe("expiry exclusion", () => {
  it("search with now excludes expired rows; without now shows everything", async () => {
    const s = makeStore()
    await s.put(rec({ id: "live", expiresAt: D(9) }))
    await s.put(rec({ id: "dead", expiresAt: D(2) }))
    const withNow = await s.search({ namespace: "route=/n", now: D(5) })
    expect(withNow.map((r) => r.id)).toEqual(["live"])
    const withoutNow = await s.search({ namespace: "route=/n" })
    expect(withoutNow.map((r) => r.id).sort()).toEqual(["dead", "live"])
  })
  it("boundary: expiresAt exactly equal to now is excluded", async () => {
    const s = makeStore()
    await s.put(rec({ id: "edge", expiresAt: D(5) }))
    expect((await s.search({ namespace: "route=/n", now: D(5) })).length).toBe(0)
  })
  it("browse honors now + since/until the same way", async () => {
    const s = makeStore()
    await s.put(rec({ id: "live", effectiveAt: D(2), expiresAt: D(9) }))
    await s.put(rec({ id: "dead", effectiveAt: D(2), expiresAt: D(3) }))
    const page = await s.browse({ since: D(1), until: D(4), now: D(5) })
    expect(page.records.map((r) => r.id)).toEqual(["live"])
    expect(page.total).toBe(1) // COUNT shares the full WHERE incl. expiry+window
  })
  it("ranked (query) search also excludes expired and honors the window", async () => {
    const s = makeStore()
    await s.put(rec({ id: "hit", content: "deploy failed on staging", effectiveAt: D(2), expiresAt: D(9) }))
    await s.put(rec({ id: "expired", content: "deploy failed on prod", effectiveAt: D(2), expiresAt: D(3) }))
    await s.put(rec({ id: "outside", content: "deploy failed early", effectiveAt: D(1) }))
    const out = await s.search({ namespace: "route=/n", query: "deploy failed", since: D(2), now: D(5) })
    expect(out.map((r) => r.id)).toEqual(["hit"])
  })
})
```

- [ ] **Step 3: Verify failure**

Run: `pnpm --filter @dawn-ai/memory test time-window`
Expected: FAIL — since/until silently ignored (rows leak through), expiry not excluded.

- [ ] **Step 4: Implement in sqlite-store.ts**

Read the current WHERE assembly in `search` (query-less, ranked, hybrid paths share `baseSql`/`baseParams`) and `browse`. Add to the SHARED base-clause builder used by every search path:
```ts
      if (q.since) {
        conditions.push("COALESCE(m.effective_at, m.created_at) >= ?")
        params.push(q.since)
      }
      if (q.until) {
        conditions.push("COALESCE(m.effective_at, m.created_at) < ?")
        params.push(q.until)
      }
      if (q.now) {
        conditions.push("(m.expires_at IS NULL OR m.expires_at > ?)")
        params.push(q.now)
      }
```
(Adapt alias `m.` to each site's actual alias; browse has no alias.) Query-less ordering: when `since` or `until` is present, ORDER BY becomes
`COALESCE(effective_at, created_at) DESC, id ASC` (unwindowed query-less path keeps its existing `updated_at DESC, id ASC` — byte-stable for old callers). Ranked/hybrid paths keep relevance ranking; the window/expiry only filter the candidate pool.
Browse: same three conditions in its dynamic WHERE (shared by rows + COUNT).
**Migration v3**: in the schema-migration block (read how v2 added embedding columns), bump the version and add
`CREATE INDEX IF NOT EXISTS idx_mem_ns_kind_effective ON memories (namespace, kind, effective_at DESC)`.
Migration test: extend the existing migration test file (find it: `grep -rn "schema_version" packages/memory/test/`) with a v2→v3 open-existing-db case asserting the index exists (`SELECT name FROM sqlite_master WHERE type='index'`).

- [ ] **Step 5: Green + full package + commit**

```bash
pnpm --filter @dawn-ai/memory test          # all green incl. new file
pnpm --filter @dawn-ai/memory typecheck && pnpm --filter @dawn-ai/memory lint
git rev-parse --abbrev-ref HEAD
git add packages/memory
git commit -m "feat(memory): since/until time windows + expiry exclusion (sqlite, migration v3 index)"
```

---

### Task EP3: `prune` — required MemoryStore method, sqlite implementation

**Files:**
- Modify: `packages/memory/src/types.ts`, `packages/memory/src/sqlite-store.ts`
- Test: `packages/memory/test/prune.test.ts` (create)

- [ ] **Step 1: Type** — add to `MemoryStore` (REQUIRED):

```ts
  /** Delete (a) rows of any kind with expiresAt <= now, and (b) when cap is
   *  set, the oldest episodic rows beyond `cap` per namespace (ordered by
   *  COALESCE(effectiveAt, createdAt), id tiebreak). */
  prune(opts: {
    readonly now: string
    readonly namespacePrefix?: string
    readonly cap?: number
  }): Promise<{ readonly deletedExpired: number; readonly deletedOverCap: number }>
```

- [ ] **Step 2: Failing tests** — `packages/memory/test/prune.test.ts` (same makeStore/rec/D helpers as EP2's file — import nothing across test files; copy the ~20 helper lines):

```ts
describe("prune", () => {
  it("deletes expired rows of any kind and reports the count", async () => {
    const s = makeStore()
    await s.put(rec({ id: "sem-dead", kind: "semantic", expiresAt: D(2) }))
    await s.put(rec({ id: "ep-dead", expiresAt: D(2) }))
    await s.put(rec({ id: "ep-live", expiresAt: D(9) }))
    const res = await s.prune({ now: D(5) })
    expect(res).toEqual({ deletedExpired: 2, deletedOverCap: 0 })
    expect(await s.get("sem-dead")).toBeNull()
    expect((await s.get("ep-live"))?.id).toBe("ep-live")
  })
  it("caps episodic rows per namespace, keeping the newest by event time", async () => {
    const s = makeStore()
    for (let i = 1; i <= 5; i++)
      await s.put(rec({ id: `e${i}`, effectiveAt: D(i) }))
    const res = await s.prune({ now: D(9), cap: 3 })
    expect(res.deletedOverCap).toBe(2)
    expect((await s.browse({ kind: "episodic" })).records.map((r) => r.id).sort()).toEqual(["e3", "e4", "e5"])
  })
  it("cap is PER namespace and never touches non-episodic rows", async () => {
    const s = makeStore()
    await s.put(rec({ id: "sem", kind: "semantic", namespace: "route=/n" }))
    for (let i = 1; i <= 3; i++) await s.put(rec({ id: `a${i}`, namespace: "route=/a", effectiveAt: D(i) }))
    for (let i = 1; i <= 3; i++) await s.put(rec({ id: `b${i}`, namespace: "route=/b", effectiveAt: D(i) }))
    const res = await s.prune({ now: D(9), cap: 2 })
    expect(res.deletedOverCap).toBe(2) // one from each namespace
    expect(await s.get("a1")).toBeNull()
    expect(await s.get("b1")).toBeNull()
    expect((await s.get("sem"))?.id).toBe("sem")
  })
  it("equal event times evict by id order (deterministic tiebreak)", async () => {
    const s = makeStore()
    // Same effectiveAt; codepoint id order decides. Oldest = LOWEST id first out.
    await s.put(rec({ id: "B10", effectiveAt: D(2) }))
    await s.put(rec({ id: "a9", effectiveAt: D(2) }))
    await s.put(rec({ id: "b2", effectiveAt: D(2) }))
    await s.prune({ now: D(9), cap: 2 })
    // Keep the NEWEST 2 under (effective DESC, id ASC) ordering ⇒ evict the last
    // in that ordering: "b2" (0x62 highest codepoint sorts last among equals).
    expect(await s.get("b2")).toBeNull()
    expect((await s.get("B10"))?.id).toBe("B10")
    expect((await s.get("a9"))?.id).toBe("a9")
  })
  it("namespacePrefix narrows both TTL and cap passes", async () => {
    const s = makeStore()
    await s.put(rec({ id: "in", namespace: "route=/a", expiresAt: D(2) }))
    await s.put(rec({ id: "out", namespace: "route=/b", expiresAt: D(2) }))
    const res = await s.prune({ now: D(5), namespacePrefix: "route=/a" })
    expect(res.deletedExpired).toBe(1)
    expect((await s.get("out"))?.id).toBe("out")
  })
  it("is idempotent — a second identical prune deletes nothing", async () => {
    const s = makeStore()
    for (let i = 1; i <= 4; i++) await s.put(rec({ id: `e${i}`, effectiveAt: D(i), expiresAt: i === 1 ? D(2) : undefined }))
    await s.prune({ now: D(5), cap: 2 })
    const second = await s.prune({ now: D(5), cap: 2 })
    expect(second).toEqual({ deletedExpired: 0, deletedOverCap: 0 })
  })
})
```

- [ ] **Step 3: Verify failure** — `pnpm --filter @dawn-ai/memory test prune` → FAIL (`s.prune is not a function`).

- [ ] **Step 4: Implement** in sqlite-store.ts (next to browse/stats; byte-exact prefix pattern from browse):

```ts
    async prune(opts) {
      const prefixCond = opts.namespacePrefix ? " AND substr(namespace, 1, length(?)) = ?" : ""
      const prefixParams: SQLInputValue[] = opts.namespacePrefix
        ? [opts.namespacePrefix, opts.namespacePrefix]
        : []
      const expired = db
        .prepare(`DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?${prefixCond}`)
        .run(opts.now, ...prefixParams)
      let deletedOverCap = 0
      if (opts.cap !== undefined) {
        const cap = Math.max(0, Math.trunc(opts.cap))
        // Rank episodic rows per namespace by event time (newest first, id ASC
        // tiebreak — the established cross-backend ordering) and delete beyond cap.
        const over = db
          .prepare(
            `DELETE FROM memories WHERE id IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (
                   PARTITION BY namespace
                   ORDER BY COALESCE(effective_at, created_at) DESC, id ASC
                 ) AS rn
                 FROM memories WHERE kind = 'episodic'${prefixCond.replace(" AND ", " AND ")}
               ) WHERE rn > ?
             )`,
          )
          .run(...prefixParams, cap)
        deletedOverCap = Number(over.changes)
      }
      return { deletedExpired: Number(expired.changes), deletedOverCap }
    },
```
ADAPT: the inner `${prefixCond}` inside the window subquery needs `WHERE kind='episodic' AND substr(...)` — construct the two SQL strings explicitly rather than string-replacing (the snippet marks intent; write it clean). node:sqlite supports window functions (SQLite ≥3.25) — verify with the test run.

- [ ] **Step 5: Green + typecheck + lint + commit**

Note: `@dawn-ai/memory-pgvector` typecheck now BREAKS (missing prune) — expected, EP4 fixes it; do not touch it.
```bash
pnpm --filter @dawn-ai/memory test && pnpm --filter @dawn-ai/memory typecheck && pnpm --filter @dawn-ai/memory lint
git rev-parse --abbrev-ref HEAD
git add packages/memory
git commit -m "feat(memory): required MemoryStore.prune — TTL expiry + per-namespace episodic cap (sqlite)"
```

---

### Task EP4: pgvector windows/expiry/prune + conformance kit (GATED RUN MANDATORY)

**Files:**
- Modify: `packages/memory-pgvector/src/pgvector-store.ts`, `packages/memory-pgvector/src/schema.ts`, `packages/testing/src/memory-conformance.ts`

- [ ] **Step 1: Conformance kit FIRST** (the cross-backend contract is the test). Add to `packages/testing/src/memory-conformance.ts`, mirroring EP2/EP3's cases in kit style (`rec()` helper, try/finally close). REQUIRED cases (port each from EP2/EP3 with kit fixtures — write them out fully in the kit):
  1. window inclusive/exclusive bounds
  2. legacy-row createdAt fallback
  3. windowed query-less event-time ordering (use the mixed-case id fixture style `["b2","B10","a9"]` to keep pinning C-collation)
  4. expiry exclusion with `now` / visibility without `now` / boundary `expiresAt == now`
  5. browse window+expiry with total sharing the clause
  6. prune TTL count + cap-per-namespace + non-episodic immunity + equal-time id tiebreak + idempotency
  7. episodic approve = plain activation (from EP1)

- [ ] **Step 2: Run kit vs sqlite** — `pnpm --filter @dawn-ai/memory build && pnpm --filter @dawn-ai/testing test` → sqlite conformance green (sqlite already implements everything; if any kit case fails against sqlite, fix the EP2/EP3 implementation NOW — the kit is authoritative).

- [ ] **Step 3: pgvector implementation** — in `pgvector-store.ts` (match its `$n` param, `COUNT(*)::int`, `COLLATE "C"` conventions):
  - search/browse WHERE additions: `COALESCE(effective_at, created_at) >= $n` / `< $n` / `(expires_at IS NULL OR expires_at > $n)`.
  - windowed query-less ordering `COALESCE(effective_at, created_at) DESC, id COLLATE "C" ASC`.
  - `prune`: expired DELETE + cap via `ROW_NUMBER() OVER (PARTITION BY namespace ORDER BY COALESCE(effective_at, created_at) DESC, id COLLATE "C" ASC)`, `left(namespace, length($n)) = $n+1` prefix narrowing, counts via `RETURNING`-free `rowCount`.
  - `schema.ts`: idempotent `CREATE INDEX IF NOT EXISTS <prefix>_ns_kind_effective ON <prefix>_memories (namespace, kind, effective_at DESC)` in `initSchema`.

- [ ] **Step 4: MANDATORY gated run (real Docker — do NOT skip; report the counts)**

```bash
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
```
Expected: all green, count grows by the new kit cases (was 32 passed/1 skipped). If Docker is down, start it (`open -a Docker`, wait) — a DONE report without this run is invalid.

- [ ] **Step 5: Typecheck heals + commit**

```bash
pnpm turbo run typecheck --filter=@dawn-ai/memory --filter=@dawn-ai/memory-pgvector --filter=@dawn-ai/testing
pnpm --filter @dawn-ai/memory-pgvector lint && pnpm --filter @dawn-ai/testing lint
git rev-parse --abbrev-ref HEAD
git add packages/memory-pgvector packages/testing packages/memory
git commit -m "feat(memory-pgvector): windows/expiry/prune; conformance kit enforces the episodic contract"
```

---

### Task EP5: config type, capability — policy-aware remember, windowed recall, resolveTimeExpr

**Files:**
- Modify: `packages/core/src/types.ts` (episodes config), `packages/core/src/capabilities/types.ts` (MemoryStoreLike parity: since/until/now on search+browse, prune), `packages/core/src/capabilities/built-in/memory.ts`
- Create: `packages/core/src/capabilities/built-in/time-expr.ts`
- Test: `packages/core/test/time-expr.test.ts`, `packages/core/test/memory-capability-episodic.test.ts` (create; model on the existing memory-capability tests' fake-store pattern)

- [ ] **Step 1: Config type** — `DawnConfig.memory` gains:

```ts
  episodes?: {
    readonly enabled?: boolean
    readonly ttlMs?: number
    readonly cap?: number
    readonly includeFailedRuns?: boolean
    readonly embed?: boolean
  }
```
`MemoryStoreLike`: add `since`/`until` to its search q + browse q, `now` to browse q, and the full `prune` signature (structural mirror — keep the no-core-imports-memory rule; extend the parity tripwire expectations implicitly, the mutual-assignability test in packages/testing will enforce).

- [ ] **Step 2: resolveTimeExpr (TDD)** — `packages/core/test/time-expr.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { resolveTimeExpr } from "../src/capabilities/built-in/time-expr.js"

const NOW = "2026-08-05T12:00:00.000Z"
describe("resolveTimeExpr", () => {
  it("passes ISO timestamps through unchanged", () => {
    expect(resolveTimeExpr("2026-08-01T00:00:00.000Z", NOW)).toBe("2026-08-01T00:00:00.000Z")
  })
  it("resolves relative offsets against now", () => {
    expect(resolveTimeExpr("-24h", NOW)).toBe("2026-08-04T12:00:00.000Z")
    expect(resolveTimeExpr("-7d", NOW)).toBe("2026-07-29T12:00:00.000Z")
    expect(resolveTimeExpr("-30m", NOW)).toBe("2026-08-05T11:30:00.000Z")
  })
  it("rejects garbage with an actionable error", () => {
    expect(() => resolveTimeExpr("yesterday", NOW)).toThrow(/ISO timestamp or relative/)
    expect(() => resolveTimeExpr("-3y", NOW)).toThrow(/ISO timestamp or relative/)
  })
})
```
Implementation (`time-expr.ts`):
```ts
const RELATIVE = /^-(\d+)([mhd])$/
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** "-24h" | "-7d" | "-30m" | ISO → ISO, resolved against `now`. Pure. */
export function resolveTimeExpr(expr: string, now: string): string {
  const rel = RELATIVE.exec(expr)
  if (rel) {
    const [, n, unit] = rel
    return new Date(Date.parse(now) - Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS]).toISOString()
  }
  const parsed = Date.parse(expr)
  if (Number.isNaN(parsed)) {
    throw new Error(
      `invalid time '${expr}' — use an ISO timestamp or relative offset like "-24h", "-7d", "-30m"`,
    )
  }
  return new Date(parsed).toISOString()
}
```

- [ ] **Step 3: Capability changes** (`built-in/memory.ts`) — read the file top-to-bottom first:
  - `recallSchema` gains `since: z.string().optional().describe('ISO timestamp or relative offset ("-24h", "-7d") — inclusive lower bound on when the memory happened.')` and matching `until` (exclusive). In `run`, resolve via `resolveTimeExpr` inside try/catch → on error return the tool-error message (not a throw), then thread `since`/`until` into `store.search`.
  - `remember`: consult `writePolicyFor` — BUT core cannot import `@dawn-ai/memory`. Duplicate the 12-line policy switch locally (mirror-comment both sides: `// mirrored in packages/memory/src/reconcile.ts writePolicyFor — keep in sync`), OR (preferred if trivially possible) inline: `const append = mem.defined.kind === "episodic"`. Choose the inline boolean + comment — the full policy fn's throw-on-deferred already happens because remember only runs for the route's declared kind, and `loadRouteMemory` accepts all four; so ADD an explicit guard: if kind is procedural/reflection, return a tool error "kind not yet wired". For `append`: skip the identity/reconcile block entirely; put as active (auto/ask) or candidate; set `effectiveAt: new Date(now).toISOString()` (request time — the capability already has a now source; check how updatedAt is stamped and reuse), NO expiresAt.
  - `ask` mode + append: no gate fires (no supersede branch) — add the doc comment.

- [ ] **Step 4: Capability tests** — `packages/core/test/memory-capability-episodic.test.ts` (copy the fake-store scaffolding from `memory-capability-recall.test.ts`; the fake must now also implement prune):
  1. episodic remember appends twice with identical data → two puts, zero supersede/update calls (assert via fake-store call log)
  2. candidate mode → status candidate
  3. procedural kind → tool result contains "not yet wired", no store calls
  4. recall passes resolved ISO since/until to search (fake asserts args; relative "-24h" resolved against the request clock)
  5. recall with garbage since → tool result contains the actionable message, search NOT called

- [ ] **Step 5: Green + commit**

```bash
pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/core typecheck && pnpm --filter @dawn-ai/core lint
pnpm --filter @dawn-ai/testing test   # parity tripwire must still hold
git rev-parse --abbrev-ref HEAD
git add packages/core packages/testing
git commit -m "feat(core): episodic remember appends; recall gains since/until with relative time parsing"
```

---

### Task EP6: runtime auto-recorder (+ concurrency + burst tests)

**Files:**
- Create: `packages/cli/src/lib/runtime/record-episode.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`, `packages/cli/src/lib/runtime/resolve-memory.ts` (export a `resolveEpisodesConfig(appRoot)` reading `config.memory.episodes` with defaults)
- Test: `packages/cli/test/record-episode.test.ts` (unit), `packages/cli/test/episodic-recorder.test.ts` (harness integration; model on existing aimock harness tests — read `packages/testing/src/harness.ts` usage in `packages/cli/test/` first)

- [ ] **Step 1: Pure unit — episode construction (TDD)** — `record-episode.test.ts` against an exported pure builder:

```ts
import { describe, expect, it } from "vitest"
import { buildEpisode } from "../src/lib/runtime/record-episode.js"

const BASE = {
  namespace: "workspace=app|route=/chat",
  input: "Please summarize the Q3 report and email it to the team",
  outcome: "ok" as const,
  toolsUsed: ["readFile", "sendEmail"],
  startedAt: 1754630400000, // 2026-08-08T04:40:00.000Z? use real: Date "2026-08-08..." — compute in test via Date.parse
  finishedAt: 1754630404200,
  ttlMs: 30 * 86_400_000,
  runId: "run-123",
  threadId: "th-9",
}

describe("buildEpisode", () => {
  it("builds a deterministic, idempotent record", () => {
    const a = buildEpisode(BASE)
    const b = buildEpisode(BASE)
    expect(a.id).toBe(b.id)
    expect(a.id).toMatch(/^memory_ep_[0-9a-f]{16}$/)
    expect(a.kind).toBe("episodic")
    expect(a.status).toBe("active")
    expect(a.source).toEqual({ type: "run", id: "run-123" })
    expect(a.effectiveAt).toBe(new Date(BASE.startedAt).toISOString())
    expect(a.expiresAt).toBe(new Date(BASE.startedAt + BASE.ttlMs).toISOString())
    expect(a.data.durationMs).toBe(4200)
    expect(a.content).toMatch(/^run ok: /)
    expect(a.content).toContain("(2 tools, 4.2s)")
  })
  it("truncates input in content (~80 chars) and data (~500 chars)", () => {
    const long = buildEpisode({ ...BASE, input: "x".repeat(1000) })
    expect(long.content.length).toBeLessThan(120)
    expect((long.data.input as string).length).toBeLessThanOrEqual(500)
  })
  it("failure outcome renders and records", () => {
    const f = buildEpisode({ ...BASE, outcome: "error" })
    expect(f.content).toMatch(/^run error: /)
    expect(f.data.outcome).toBe("error")
  })
  it("different runIds produce different ids", () => {
    expect(buildEpisode(BASE).id).not.toBe(buildEpisode({ ...BASE, runId: "run-124" }).id)
  })
})
```

- [ ] **Step 2: Implement `record-episode.ts`**

```ts
import { createHash } from "node:crypto"
import type { MemoryRecord, MemoryStore } from "@dawn-ai/memory"

export interface EpisodeInput {
  readonly namespace: string
  readonly input: string
  readonly outcome: "ok" | "error"
  readonly toolsUsed: readonly string[]
  readonly startedAt: number
  readonly finishedAt: number
  readonly ttlMs: number
  readonly runId?: string
  readonly threadId?: string
}

export function buildEpisode(ep: EpisodeInput): MemoryRecord {
  const startedIso = new Date(ep.startedAt).toISOString()
  const sourceId = ep.runId ?? ep.threadId ?? startedIso
  const id = `memory_ep_${createHash("sha1")
    .update(`${ep.namespace}|${sourceId}|${startedIso}`)
    .digest("hex")
    .slice(0, 16)}`
  const durationMs = Math.max(0, ep.finishedAt - ep.startedAt)
  const seconds = (durationMs / 1000).toFixed(1)
  const inputLine = ep.input.replaceAll("\n", " ").slice(0, 80)
  const writtenAt = new Date(ep.finishedAt).toISOString()
  return {
    id,
    kind: "episodic",
    namespace: ep.namespace,
    content: `run ${ep.outcome}: ${inputLine} (${ep.toolsUsed.length} tools, ${seconds}s)`,
    data: {
      input: ep.input.slice(0, 500),
      outcome: ep.outcome,
      toolsUsed: [...ep.toolsUsed],
      durationMs,
      ...(ep.threadId ? { threadId: ep.threadId } : {}),
      ...(ep.runId ? { runId: ep.runId } : {}),
    },
    source: { type: "run", id: sourceId },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: writtenAt,
    updatedAt: writtenAt,
    effectiveAt: startedIso,
    expiresAt: new Date(ep.startedAt + ep.ttlMs).toISOString(),
  }
}

/** Write an episode + lazy retention. NEVER throws — recorder failures must not
 *  fail a user's run; logged once per process. */
let warnedOnce = false
export async function recordEpisode(
  store: MemoryStore,
  ep: EpisodeInput,
  opts: { readonly cap: number },
): Promise<void> {
  try {
    const record = buildEpisode(ep)
    await store.put(record)
    await store.prune({
      now: new Date(ep.finishedAt).toISOString(),
      namespacePrefix: ep.namespace,
      cap: opts.cap,
    })
  } catch (error) {
    if (!warnedOnce) {
      warnedOnce = true
      console.warn(`[dawn] episode recording failed (further failures muted): ${String(error)}`)
    }
  }
}
```

- [ ] **Step 3: executeRoute wiring** — read `execute-route.ts`'s success/failure return sites (~1097/1110) and the memory-context block (~784-793). Requirements (adapt precisely to the file):
  - Resolve episodes config alongside the memory context (only when a memory context exists). `resolveEpisodesConfig(appRoot)` in resolve-memory.ts: reads `loadDawnConfig` (same cached loader), returns `{ enabled: false }` defaults; DEFAULTS: ttlMs 30d, cap 500, includeFailedRuns true, embed false.
  - After the run settles (both the success return and the execution-error catch), when `episodes.enabled && memoryContext && writes !== "off"` and (outcome === "ok" || includeFailedRuns): fire `recordEpisode` with namespace from the memory context, input = the user's message text (extract the same way the run input was built — find where the human message text is available; truncation happens in the builder), toolsUsed = tool names extracted from the output messages (AIMessage tool_calls / ToolMessage names — write a small pure `extractToolNames(output): string[]` in record-episode.ts with its own unit test: AIMessage with 2 tool_calls + unrelated messages → 2 unique names), outcome, startedAt = options.startedAt, finishedAt = Date.now(), runId = <the run/thread identifier available — investigate what execute-route has; threadId exists>, ttl/cap from config. AWAIT it (it never throws) — do not fire-and-forget (test determinism + process exit safety).
  - `embed: false` this cycle means: recorder never calls the embedder (episodes are keyword+time recalled). The config flag exists but only `false` ships; a `true` value logs a one-line "not yet supported" warning at resolve time (honest, forward-compatible).

- [ ] **Step 4: Harness integration tests** — `packages/cli/test/episodic-recorder.test.ts`, aimock harness + a probe app fixture with memory.ts (copy the memory probe fixture pattern from existing memory e2e tests — find with `grep -rn "memory-chat" packages/cli/test packages/testing/test`). REQUIRED cases:
  1. enabled run → exactly one episode in the store, correct namespace/kind/source.type "run", effectiveAt==run start, expiresAt==start+ttl, toolsUsed non-empty when the fixture calls a tool
  2. default (episodes absent) → zero episodes
  3. `writes: "off"` + enabled → zero episodes
  4. failed run (fixture that throws) with includeFailedRuns default → episode with outcome "error"; with includeFailedRuns false → none
  5. idempotent retry: call the recorder twice with the same inputs (unit-level via recordEpisode against a real sqlite store) → one row
  6. burst + cap: config cap 3, run 5 harness runs → store holds exactly 3 episodes, newest by event time
  7. CONCURRENCY: `Promise.all` of 8 `recordEpisode` calls (distinct runIds, same namespace, real sqlite store, cap 5) → no throw, exactly 5 rows remain, all rows well-formed (WAL handles concurrent writers in-process; this pins no-lost-write/no-crash behavior)

- [ ] **Step 5: Green + full cli suite + commit**

```bash
pnpm --filter @dawn-ai/cli test record-episode episodic-recorder
pnpm --filter @dawn-ai/cli test        # FULL suite — no regressions
pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
git rev-parse --abbrev-ref HEAD
git add packages/cli
git commit -m "feat(cli): episodic auto-recorder — one episode per run, TTL+cap retention, never fails a run"
```

---

### Task EP7: `dawn memory prune` command

**Files:**
- Modify: `packages/cli/src/commands/memory.ts`
- Test: `packages/cli/test/memory-command.test.ts` (extend)

- [ ] **Step 1: Failing test** (reuse the file's seeding pattern):

```ts
  test("prune deletes expired rows and reports counts", async () => {
    // Seed: one expired row (expiresAt in the past), one live episodic row.
    // Run: runMemoryCommand(["prune"], { cwd: appRoot }, io)
    // Assert: stdout contains "deleted 1 expired" and "0 over-cap"; live row remains.
  })
  test("prune --cap enforces the episodic cap", async () => {
    // Seed 4 episodic rows with ascending effectiveAt; run ["prune", "--cap", "2"];
    // assert 2 oldest gone, stdout reports "2 over-cap".
  })
```
Write both fully against the file's real helpers (same instruction as the approve tests — the harness exists in the file).

- [ ] **Step 2: Implement** — new subcommand in `runMemoryCommand` dispatch: `prune` with optional `--cap <n>` and `--namespace <prefix>` args (parse from argv the way the file parses subcommand args; commander options exist only for --cwd, so parse `--cap`/`--namespace` from the args array — read how other subcommands take args first and match). Calls `store.prune({ now: new Date().toISOString(), ...(cap ? { cap } : {}), ...(ns ? { namespacePrefix: ns } : {}) })`, prints `pruned: N expired, M over-cap`. Update the USAGE string.

- [ ] **Step 3: Green + commit**

```bash
pnpm --filter @dawn-ai/cli test memory-command && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
git rev-parse --abbrev-ref HEAD
git add packages/cli
git commit -m "feat(cli): dawn memory prune — manual TTL + cap retention pass"
```

---

### Task EP8: Inspector — API windows + timeline view (GATED RUN MANDATORY)

**Files:**
- Modify: `packages/inspector/app/api/memory/list/route.ts`, `packages/inspector/src/components/memory/list-page.tsx`
- Create: `packages/inspector/src/components/memory/timeline-view.tsx`
- Test: `packages/inspector/test/components/timeline.test.tsx` (create), `packages/inspector/test/api.e2e.test.ts` (extend)

- [ ] **Step 1: API** — list route passes through `since`/`until` (validate: `Date.parse` finite else 400 `{error}`), supplies `now: new Date().toISOString()` to browse by DEFAULT; `includeExpired=1` omits `now`. (Mirror the route's existing parseEnum/400 style.)

- [ ] **Step 2: Timeline component** — `timeline-view.tsx`:

```tsx
"use client"
import type { MemoryRecord } from "@dawn-ai/memory"
import { Badge } from "../ui/badge"

function dayOf(r: MemoryRecord): string {
  return (r.effectiveAt ?? r.createdAt).slice(0, 10)
}

export function TimelineView({
  records,
  onSelect,
}: {
  records: readonly MemoryRecord[]
  onSelect: (id: string) => void
}) {
  const days = new Map<string, MemoryRecord[]>()
  for (const r of records) {
    const day = dayOf(r)
    const bucket = days.get(day)
    if (bucket) bucket.push(r)
    else days.set(day, [r])
  }
  return (
    <div className="p-4" data-testid="timeline-view">
      {[...days.entries()].map(([day, rows]) => (
        <section key={day} className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{day}</h2>
          <ol className="space-y-1">
            {rows.map((r) => {
              const outcome = typeof r.data.outcome === "string" ? r.data.outcome : undefined
              const durationMs = typeof r.data.durationMs === "number" ? r.data.durationMs : undefined
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-zinc-50"
                    aria-label={`Open episode: ${r.content}`}
                  >
                    <span className="w-14 shrink-0 font-mono text-xs text-zinc-400">
                      {(r.effectiveAt ?? r.createdAt).slice(11, 16)}
                    </span>
                    {outcome ? (
                      <Badge variant={outcome === "ok" ? "active" : "candidate"}>{outcome}</Badge>
                    ) : (
                      <Badge>authored</Badge>
                    )}
                    <span className="truncate" title={r.content}>{r.content}</span>
                    {durationMs !== undefined ? (
                      <span className="ml-auto shrink-0 text-xs text-zinc-400">{(durationMs / 1000).toFixed(1)}s</span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
      {records.length === 0 ? <p className="text-sm text-zinc-400">No episodes in this window.</p> : null}
    </div>
  )
}
```
(NOTE: outcome "error" should read as an error — add a `danger` Badge variant `bg-red-100 text-red-800` in badge.tsx and use it for `outcome === "error"`; adjust the snippet accordingly.)

- [ ] **Step 3: list-page toggle** — add `view: "list" | "timeline"` state + toolbar toggle buttons (aria-pressed); timeline mode sets the fetch's `kind` default to `episodic` (still user-overridable via the kind select) and renders `<TimelineView records={records} onSelect={setSelectedId} />` instead of the grid; detail sheet unchanged (episodes open in it). Sorting note: timeline consumes browse's windowed event-time order when since/until set — ALSO thread optional `since` from a small "window" select in timeline mode (`24h | 7d | 30d | all`, computed client-side to ISO with `Date.now()`).

- [ ] **Step 4: Component tests** — `timeline.test.tsx` (stubGlobal fetch pattern from list.test.tsx):
  1. two records across two days → two day headings, rows under each, ok/error badges + duration rendered
  2. agent-authored record (no outcome) → "authored" badge
  3. click row → onSelect wired through ListPage (render ListPage in timeline mode, click, detail-sheet testid appears)
  4. empty window → "No episodes in this window."

- [ ] **Step 5: e2e extension** (`api.e2e.test.ts`) — seed episodes with distinct effectiveAt + one expired; assert: since/until filtering over HTTP; expired hidden by default; `includeExpired=1` reveals; invalid since → 400 `{error}`.

- [ ] **Step 6: MANDATORY gated run + commit**

```bash
pnpm --filter @dawn-ai/inspector build           # zero warnings
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test    # ALL green — do not skip
pnpm --filter @dawn-ai/inspector typecheck && pnpm --filter @dawn-ai/inspector lint
git rev-parse --abbrev-ref HEAD
git add packages/inspector
git commit -m "feat(inspector): timeline view + since/until/includeExpired on the list API"
```

---

### Task EP9: dogfood, live smoke, docs, changeset

**Files:**
- Modify: `examples/memory/server/dawn.config.ts` (enable episodes), `apps/web/content/docs/memory.mdx`, `apps/web/content/docs/upgrading.mdx`, `apps/web/content/docs/inspector.mdx`, `docs/dev/memory-system.md`
- Create: `packages/testing/test/episodic-live.smoke.test.ts` (doubly-gated), `.changeset/episodic-memory.md`

- [ ] **Step 1: Dogfood** — `examples/memory/server/dawn.config.ts`: add `episodes: { enabled: true }` to the memory block (defaults for the rest). Run the example's tests (`pnpm --filter @dawn-example/memory test`) — must stay green.

- [ ] **Step 2: Live smoke** (model on `packages/testing/test/memory-live.smoke.test.ts` — same gating comment header, `it.skipIf(!live)`, probe-app fixture WITH `episodes: { enabled: true }` in its dawn.config):
  - Run the harness live twice with distinct inputs; then ask: `"Using your long-term memory, what did you do in the last day? Use recall with since set."`; assert `expectToolCalled(r, "recall")` and the final message references content from at least one recorded episode (assert on a distinctive token from run 1's input).
  - NEVER add to CI; key loaded only via the established `.env` pattern. This test is run LOCALLY by the controller at the end (doubly-gated: OPENAI_API_KEY).

- [ ] **Step 3: Docs**
  - `memory.mdx`: new "Episodic memory" section — enabling (`memory.episodes`), what gets recorded (shape, one per run, `source.type: "run"`), retention (TTL 30d + cap 500, `dawn memory prune`), time-windowed recall (`since`/`until`, relative forms), governance (auto-episodes bypass writes modes except `"off"`; agent-authored honor modes; ask never gates appends), agent-authored episodic routes (`defineMemory({ kind: "episodic" })`), auto-episodes not embedded (keyword+time recall).
  - `upgrading.mdx`: "MemoryStore now requires `prune`" section (signature + semantics; conformance kit covers it; search/browse accept since/until and exclude expired when now supplied).
  - `inspector.mdx`: timeline view paragraph (+ includeExpired note).
  - `docs/dev/memory-system.md`: episodic now shipped — recorder architecture, policy seam, deferred list shrinks to procedural/reflection/consolidation/graph.
  - Run the docs checker (`node scripts/check-docs.mjs`).

- [ ] **Step 4: Changeset** — `.changeset/episodic-memory.md`:

```md
---
"@dawn-ai/memory": patch
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/inspector": patch
"@dawn-ai/testing": patch
---

Episodic memory: Dawn apps can now remember what happened. An opt-in runtime
recorder (`memory.episodes.enabled`) writes one episode per agent run from the
trace — input, outcome, tools used, duration — with TTL + per-namespace cap
retention; routes can also author episodes via `defineMemory({ kind: "episodic" })`
(append-only, never superseded). `recall` gains `since`/`until` time windows
(ISO or relative like "-24h"); the Inspector gains a timeline view; `dawn memory
prune` runs retention manually.

BREAKING: `MemoryStore` now requires `prune(opts)`; `search`/`browse` accept
`since`/`until` and exclude expired rows when `now` is supplied. Custom stores
must implement `prune` (`runMemoryStoreConformance` enforces the contract).
```
(PATCH — fixed 0.x group, GOTCHA 6.)

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add examples apps docs packages/testing .changeset
git commit -m "docs(memory): episodic docs + upgrade notes; examples/memory records episodes; changeset (patch, breaking prune stated)"
```

---

### Task EP10: full validate + harness lanes (MANDATORY before final report)

- [ ] **Step 1: Full workspace**

```bash
pnpm build && pnpm turbo run typecheck && pnpm test 2>&1 | tail -8
pnpm pack:check 2>&1 | tail -3
node scripts/check-docs.mjs
```
All green.

- [ ] **Step 2: Gated lanes (ALL MANDATORY — report each count)**

```bash
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
```

- [ ] **Step 3: All three harness lanes (MANDATORY — the user directive)**

```bash
pnpm verify:harness:framework
pnpm verify:harness:runtime
pnpm verify:harness:smoke
```
(macOS /private/tmp known-false runtime failures exempt per repo memory — note if seen.)

- [ ] **Step 4: Commit any stragglers; report full results.** The controller then runs the doubly-gated live smoke locally (`set -a; . ./.env; set +a` in the one smoke shell — key never printed, never in CI) before the PR.

---

## Post-plan notes for the controller

- No new package → NO OIDC bootstrap this cycle. Patch changeset; verify the Version PR shows 0.8.15 for the fixed group before admin-merge.
- Review cadence per user directive: two-stage review per task + final whole-branch review; reviewers must check the gated-run evidence in implementer reports (a DONE without the mandatory gated counts gets bounced).
- The concurrency and burst tests (EP6) and the boundary/property tests (EP2-EP4) are the robustness backbone — spec reviewers should verify they exist EXACTLY as enumerated, not sampled.
- Live smoke (EP9) is controller-run with the local key, after EP10 goes green.
