# pgvector Memory Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@dawn-ai/memory-pgvector` — a Postgres + pgvector `MemoryStore` backend with recall ranking byte-identical to the sqlite backend, per `docs/superpowers/specs/2026-07-07-pgvector-backend-design.md`.

**Architecture:** Extract the hybrid ranking into pure, backend-agnostic functions in `@dawn-ai/memory` (`hybrid.ts`); both stores do their own retrieval (SQL) then call the shared core. pgvector does two indexed retrievals (HNSW `<=>` vector top-K + keyword pool) and reuses the pure fusion. A shared `MemoryStore` conformance kit runs against sqlite (always) and real pgvector (gated, Testcontainers). A dedicated `examples/memory` app is the continuous dogfood.

**Tech Stack:** TypeScript, `pg` + `pgvector` (pure-JS), `@testcontainers/postgresql` (`pgvector/pgvector:pg16`), vitest, biome. Branch: `feat/memory-pgvector` (created off origin/main; spec committed).

**Working dir:** `/Users/blove/repos/dawn` (primary checkout, on branch). Every Bash cmd starts `cd /Users/blove/repos/dawn`.

**Guardrails (every subagent, every task):**
- BRANCH PIN: before ANY commit, `git rev-parse --abbrev-ref HEAD` MUST print `feat/memory-pgvector`; else STOP + report BLOCKED. Never switch branches / commit detached.
- LINT: only `pnpm exec biome check --config-path packages/config-biome/biome.json <files>` (scoped `--write` OK). NEVER bare `biome check --write`. Style: no semicolons, 2-space, double quotes.
- Determinism: no `Date.now()`/argless `new Date()` in `packages/*/src` (tests may). Pure fns stay pure.
- `pnpm test` in a CLEAN shell (do NOT source `.env`).
- Testcontainers needs a running Docker daemon; pgvector tests are gated on `DAWN_TEST_PGVECTOR=1` and SKIP otherwise.
- `.env` (`OPENAI_API_KEY`) is LOCAL-only for the doubly-gated dogfood smoke; never print, never CI.
- Monorepo build ordering: rebuild changed dep dists (`pnpm --filter @dawn-ai/memory --filter @dawn-ai/core build`) before typechecking downstream packages.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/memory/src/hybrid.ts` (create) | Pure `rankKeywordCandidates` + `fuseHybrid` (extracted ranking core) |
| `packages/memory/src/sqlite-store.ts` (modify) | Refactor `rankKeyword`/hybrid gate to call `hybrid.ts` (retrieval stays) |
| `packages/memory/src/index.ts` (modify) | Export `rankKeywordCandidates`, `fuseHybrid` |
| `packages/memory/test/hybrid.test.ts` (create) | Pure ranking-core units |
| `packages/testing/src/memory-conformance.ts` (create) | `runMemoryStoreConformance` kit |
| `packages/testing/src/index.ts` (modify) | Export the kit |
| `packages/testing/test/sqlite-conformance.test.ts` (create) | Kit against sqlite (always) |
| `packages/memory-pgvector/**` (create) | New package: `pgvectorMemoryStore`, schema, queries |
| `.github/workflows/ci.yml` (modify) | `pgvector-docker` gated lane |
| `examples/memory/**` (create) | Dedicated memory example (backend-switch) |
| `apps/web/content/docs/memory.mdx` + `docs/dev/memory-system.md` (modify) | Postgres backend docs |
| `.changeset/pgvector-backend.md` (create) | patch: memory, testing, memory-pgvector |

---

### Task 1: Extract the shared ranking core into `@dawn-ai/memory/hybrid.ts`

**Files:** create `packages/memory/src/hybrid.ts`, `packages/memory/test/hybrid.test.ts`; modify `packages/memory/src/sqlite-store.ts`, `packages/memory/src/index.ts`.

The sqlite hybrid path (read `packages/memory/src/sqlite-store.ts` lines ~215–445) has two reusable pure pieces. Extract them so pgvector reuses identical ranking. The 60 shipped memory tests are the refactor guard.

- [ ] **Step 1: Write failing tests** — `packages/memory/test/hybrid.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { fuseHybrid, rankKeywordCandidates } from "../src/hybrid.js"
import type { MemoryRecord } from "../src/types.js"

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content">): MemoryRecord {
  return {
    kind: "semantic", namespace: "ns", data: {}, source: { type: "run", id: "r" },
    confidence: 1, tags: [], status: "active",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

describe("rankKeywordCandidates", () => {
  it("ranks by IDF relevance; rare-token match beats common-token match", () => {
    const cands = [
      rec({ id: "rare", content: "acme threshold" }),
      rec({ id: "common", content: "acme owner jordan" }),
    ]
    const df = new Map([["acme", 2], ["threshold", 1]])
    const out = rankKeywordCandidates(cands, df, 2, ["acme", "threshold"], "2026-07-05T00:00:00.000Z")
    expect(out[0]?.id).toBe("rare")
  })
  it("relevance-only weights ignore recency (for the hybrid keyword list)", () => {
    const cands = [
      rec({ id: "old", content: "billing threshold", updatedAt: "2026-05-01T00:00:00.000Z" }),
      rec({ id: "new", content: "billing note", updatedAt: "2026-07-01T00:00:00.000Z" }),
    ]
    const df = new Map([["billing", 2], ["threshold", 1]])
    const out = rankKeywordCandidates(cands, df, 2, ["billing", "threshold"],
      "2026-07-05T00:00:00.000Z", { weights: { relevance: 1, recency: 0, confidence: 0 } })
    expect(out[0]?.id).toBe("old") // 2/2 tokens beats 1/2 despite being older
  })
})

describe("fuseHybrid", () => {
  it("a semantic-only match (only in the vector list) is fused in and can win", () => {
    const kw = [rec({ id: "kwonly", content: "acme billing" })]
    const vec = [rec({ id: "semonly", content: "faster shipping" }), rec({ id: "kwonly", content: "acme billing" })]
    const out = fuseHybrid({ keywordRanked: kw, vectorRanked: vec, now: "2026-07-05T00:00:00.000Z" })
    expect(out.map((r) => r.id)).toContain("semonly")
    expect(out[0]?.id).toBe("semonly") // rank1 in vector, absent from keyword; kwonly is rank2 vector + rank1 keyword
  })
  it("co-equal RRF: an exact keyword hit is not buried by a strong vector list", () => {
    const kw = [rec({ id: "exact", content: "order ALPHA-111" })]
    const vec = [rec({ id: "near", content: "delivery" }), rec({ id: "exact", content: "order ALPHA-111" })]
    const out = fuseHybrid({ keywordRanked: kw, vectorRanked: vec, now: "2026-07-05T00:00:00.000Z" })
    expect(out.map((r) => r.id)).toContain("exact")
  })
  it("NaN tuning weights degrade to defaults (finite, deterministic order)", () => {
    const kw = [rec({ id: "a", content: "x" })]
    const vec = [rec({ id: "a", content: "x" })]
    const out = fuseHybrid({ keywordRanked: kw, vectorRanked: vec, now: "2026-07-05T00:00:00.000Z",
      options: { recencyWeight: Number.NaN } })
    expect(out.map((r) => r.id)).toEqual(["a"])
  })
})
```

- [ ] **Step 2: Run — expect fail** (`Cannot find module '../src/hybrid.js'`):
  `pnpm --filter @dawn-ai/memory exec vitest run test/hybrid.test.ts`

- [ ] **Step 3: Implement `hybrid.ts`.** Move the pure logic out of `sqlite-store.ts`. Create `packages/memory/src/hybrid.ts`:

```ts
// Pure, backend-agnostic hybrid ranking core. Both sqliteMemoryStore and
// @dawn-ai/memory-pgvector call these after doing their own retrieval, so recall
// ranking is byte-identical across backends. No I/O, no clock, no randomness.
import { recencyDecay, type RecallRankingOptions, type RecallWeights, scoreMemory } from "./score.js"
import type { MemoryRecord, VectorRankingOptions } from "./types.js"
import { fuseRRF } from "./vector.js"

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
function newestUpdatedAt(records: readonly MemoryRecord[]): string {
  return records.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), "")
}
function tokensFor(rec: MemoryRecord, tokenize: (s: string) => string[]): string[] {
  const values = Object.values(rec.data).filter((v) => typeof v === "string") as string[]
  return tokenize([rec.content, rec.tags.join(" "), values.join(" ")].join(" "))
}

/**
 * Rank keyword candidates by IDF relevance (+ recency/confidence per weights).
 * `candidates` are the rows the store retrieved as matching ≥1 query token;
 * `dfByToken`/`corpusSize` are the store's live stats. Returns the full sorted
 * list (caller pages + tag-filters). `now` absent → newest candidate's updatedAt.
 */
export function rankKeywordCandidates(
  candidates: readonly MemoryRecord[],
  dfByToken: ReadonlyMap<string, number>,
  corpusSize: number,
  queryTokens: readonly string[],
  now: string | undefined,
  options?: RecallRankingOptions,
  tokenize?: (s: string) => string[],
): MemoryRecord[] {
  if (candidates.length === 0) return []
  const tk = tokenize ?? ((s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1))
  const referenceNow = now ?? newestUpdatedAt(candidates)
  const scored = candidates.map((record) => ({
    record,
    score: scoreMemory({
      memoryTokens: new Set(tokensFor(record, tk)),
      queryTokens: [...queryTokens],
      dfByToken,
      corpusSize,
      updatedAt: record.updatedAt,
      confidence: record.confidence,
      referenceNow,
      ...(options ? { options } : {}),
    }),
  }))
  scored.sort(
    (a, b) => b.score - a.score || cmp(b.record.updatedAt, a.record.updatedAt) || cmp(a.record.id, b.record.id),
  )
  return scored.map((s) => s.record)
}

function finite(n: unknown, d: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : d
}

/**
 * Fuse a keyword-ranked list and a vector-ranked list (already cosine-sorted and
 * sliced to vectorK by the store) via co-equal RRF, then a bounded recency/
 * confidence second stage. Returns the fused sorted records (caller pages +
 * tag-filters). `options.recencyHalfLifeMs` should be pre-resolved by the caller
 * (the pure fn cannot see recall config).
 */
export function fuseHybrid(args: {
  readonly keywordRanked: readonly MemoryRecord[]
  readonly vectorRanked: readonly MemoryRecord[]
  readonly now?: string
  readonly options?: VectorRankingOptions
}): MemoryRecord[] {
  const v = args.options ?? {}
  const wKeyword = finite(v.weights?.keyword, 1)
  const wVector = finite(v.weights?.vector, 1)
  const wRec = finite(v.recencyWeight, 0.3)
  const wConf = finite(v.confidenceWeight, 0.1)

  const byId = new Map<string, MemoryRecord>()
  for (const r of args.keywordRanked) byId.set(r.id, r)
  for (const r of args.vectorRanked) if (!byId.has(r.id)) byId.set(r.id, r)
  if (byId.size === 0) return []

  const rrf = fuseRRF(
    [
      { ids: args.keywordRanked.map((r) => r.id), weight: wKeyword },
      { ids: args.vectorRanked.map((r) => r.id), weight: wVector },
    ],
    typeof v.rrfK === "number" ? { k: v.rrfK } : undefined,
  )
  const referenceNow = args.now ?? newestUpdatedAt([...byId.values()])
  const fused = [...byId.values()].map((record) => {
    const base = rrf.get(record.id) ?? 0
    const rec = recencyDecay(record.updatedAt, referenceNow, v.recencyHalfLifeMs)
    const conf = record.confidence < 0 ? 0 : record.confidence > 1 ? 1 : record.confidence
    return { record, score: base * (1 + wRec * rec + wConf * conf) }
  })
  fused.sort(
    (a, b) => b.score - a.score || cmp(b.record.updatedAt, a.record.updatedAt) || cmp(a.record.id, b.record.id),
  )
  return fused.map((s) => s.record)
}

export type { RecallWeights }
```

Note: the keyword-token recomputation must match `sqlite-store.ts`'s `tokensFor` — pass the real `tokenize` from the caller (sqlite passes its imported `tokenize`; the default arg mirrors it for the pure tests). Confirm the default matches `tokenize.ts` behavior (lowercase, split non-alnum, drop <2). If they can differ, ALWAYS pass the real `tokenize` from callers and drop the default (safer — do that if unsure).

- [ ] **Step 4: Refactor `sqlite-store.ts` to call the core.** Replace the JS body of `rankKeyword` so it does only SQL (fetch candidate pool + df/N) then `return rankKeywordCandidates(candidates, dfByToken, corpusSize, terms, q.now, options, tokenize)`. Replace the hybrid gate's fusion tail (from `const byId = ...` through the final `fused.sort`) with: build `kwRecords` (relevance-only via `rankKeyword` as today), do the vector cosine+sort+slice(vectorK) as today to get `vectorRanked: MemoryRecord[]` (look up records by id), then `return pageAndTagFilter(fuseHybrid({ keywordRanked: kwRecords, vectorRanked, now: q.now, options: { ...v, recencyHalfLifeMs: v.recencyHalfLifeMs ?? opts.recall?.recencyHalfLifeMs } }), limit, q)`. Import `{ fuseHybrid, rankKeywordCandidates }` from `./hybrid.js`. Delete the now-inlined scoring/fusion code. Keep all SQL + `pageAndTagFilter` + query-less path unchanged.

- [ ] **Step 5: Export** — add to `packages/memory/src/index.ts`: `export { fuseHybrid, rankKeywordCandidates } from "./hybrid.js"`.

- [ ] **Step 6: Run — ALL green, unchanged behavior.** `pnpm --filter @dawn-ai/memory test` (expect the shipped 60 + new hybrid units). The shipped smarter-recall + vector-recall ordering tests are the guard — if any reorders, the extraction diverged; fix `hybrid.ts`, NOT the test. `pnpm --filter @dawn-ai/memory typecheck` clean.

- [ ] **Step 7: Lint + commit**:
```bash
cd /Users/blove/repos/dawn
pnpm exec biome check --config-path packages/config-biome/biome.json packages/memory/src packages/memory/test
git add packages/memory/src packages/memory/test
git commit -m "refactor(memory): extract pure hybrid ranking core (rankKeywordCandidates + fuseHybrid)"
```

---

### Task 2: `runMemoryStoreConformance` kit + run it against sqlite

**Files:** create `packages/testing/src/memory-conformance.ts`, `packages/testing/test/sqlite-conformance.test.ts`; modify `packages/testing/src/index.ts`.

Mirror `packages/sandbox/src/testing/conformance.ts` (`runProviderConformance` — inject `describe`, import `test`/`expect` from vitest).

- [ ] **Step 1: Implement the kit** — `packages/testing/src/memory-conformance.ts`:

```ts
import type { MemoryRecord, MemoryStore } from "@dawn-ai/memory"
import { expect, test } from "vitest"

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace" | "content">): MemoryRecord {
  return {
    kind: "semantic", data: {}, source: { type: "eval", id: "seed" }, confidence: 1, tags: [],
    status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
  }
}
const vec = (...xs: number[]) => new Float32Array(xs)

/**
 * The contract every MemoryStore must satisfy. Run against sqlite (in-process,
 * always) and pgvector (real Postgres, gated) so backends cannot drift. Pass
 * vitest's `describe`; `makeStore` returns a FRESH empty store per call.
 */
export function runMemoryStoreConformance(opts: {
  readonly name: string
  readonly makeStore: () => Promise<MemoryStore> | MemoryStore
  readonly describe: (name: string, fn: () => void) => void
  readonly close?: (store: MemoryStore) => Promise<void> | void
}): void {
  const { name, makeStore, describe, close } = opts
  describe(`MemoryStore conformance: ${name}`, () => {
    test("put + get round-trips", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns", content: "hello billing" }))
        expect((await s.get("a"))?.content).toBe("hello billing")
      } finally { await close?.(s) }
    })
    test("search is namespace-isolated", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns1", content: "billing escalation" }))
        await s.put(rec({ id: "b", namespace: "ns2", content: "billing escalation" }))
        expect((await s.search({ namespace: "ns1", query: "billing" })).map((r) => r.id)).toEqual(["a"])
      } finally { await close?.(s) }
    })
    test("query-less search is pure recency order", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "old", namespace: "ns", content: "x", updatedAt: "2026-07-01T00:00:00.000Z" }))
        await s.put(rec({ id: "new", namespace: "ns", content: "y", updatedAt: "2026-07-04T00:00:00.000Z" }))
        expect((await s.search({ namespace: "ns" })).map((r) => r.id)).toEqual(["new", "old"])
      } finally { await close?.(s) }
    })
    test("supersede: old→superseded, new active, link recorded", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "old", namespace: "ns", content: "v1" }))
        await s.put(rec({ id: "new", namespace: "ns", content: "v2" }))
        await s.supersede("old", "new")
        expect((await s.get("old"))?.status).toBe("superseded")
        expect((await s.get("new"))?.supersedes).toContain("old")
      } finally { await close?.(s) }
    })
    test("candidate listing + delete", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "c", namespace: "ns", content: "cand", status: "candidate" }))
        expect((await s.listCandidates("")).map((r) => r.id)).toContain("c")
        await s.delete("c")
        expect(await s.get("c")).toBeNull()
      } finally { await close?.(s) }
    })
    test("update preserves the stored embedding (vector recall still finds it)", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "e", namespace: "ns", content: "faster shipping" }),
          { embedding: vec(1, 0, 0), embeddingModel: "fake:test" })
        await s.update("e", { confidence: 0.5 })
        const out = await s.search({ namespace: "ns", query: "expedite delivery",
          queryEmbedding: vec(1, 0, 0), embedderId: "fake:test", now: "2026-07-05T00:00:00.000Z" })
        expect(out.map((r) => r.id)).toContain("e")
      } finally { await close?.(s) }
    })
    test("hybrid: a 0-shared-token semantic match is recalled via the vector list", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "sem", namespace: "ns", content: "faster shipping preferred" }),
          { embedding: vec(1, 0, 0), embeddingModel: "fake:test" })
        await s.put(rec({ id: "kw", namespace: "ns", content: "acme billing" }),
          { embedding: vec(0, 1, 0), embeddingModel: "fake:test" })
        const out = await s.search({ namespace: "ns", query: "expedite delivery",
          queryEmbedding: vec(0.95, 0.05, 0), embedderId: "fake:test", now: "2026-07-05T00:00:00.000Z" })
        expect(out.map((r) => r.id)).toContain("sem")
        expect(out[0]?.id).toBe("sem")
      } finally { await close?.(s) }
    })
    test("hybrid: mismatched embedder tag is excluded from the vector list", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "stale", namespace: "ns", content: "faster shipping" }),
          { embedding: vec(1, 0, 0), embeddingModel: "old:model" })
        const out = await s.search({ namespace: "ns", query: "expedite delivery",
          queryEmbedding: vec(1, 0, 0), embedderId: "fake:test", now: "2026-07-05T00:00:00.000Z" })
        expect(out.map((r) => r.id)).not.toContain("stale")
      } finally { await close?.(s) }
    })
  })
}
```

- [ ] **Step 2: Export** — `packages/testing/src/index.ts`: `export { runMemoryStoreConformance } from "./memory-conformance.js"`.

- [ ] **Step 3: Run the kit against sqlite** — `packages/testing/test/sqlite-conformance.test.ts`:
```ts
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { describe } from "vitest"
import { runMemoryStoreConformance } from "../src/memory-conformance.js"

runMemoryStoreConformance({
  name: "sqliteMemoryStore",
  makeStore: () => sqliteMemoryStore({ path: ":memory:" }),
  describe,
})
```

- [ ] **Step 4: Run — green** (`pnpm build` first for dists): `pnpm --filter @dawn-ai/testing exec vitest run test/sqlite-conformance.test.ts` (8 conformance tests pass — this both proves the kit and backfills formal sqlite conformance). Typecheck clean.

- [ ] **Step 5: Lint + commit** `feat(testing): shared MemoryStore conformance kit (run against sqlite)`.

---

### Task 3: Scaffold `@dawn-ai/memory-pgvector`

**Files:** create `packages/memory-pgvector/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/pgvector-store.ts}`; modify root `pnpm-workspace.yaml` if needed (workspaces are globbed — likely no change), `tsconfig.json` references if the repo uses project refs.

- [ ] **Step 1: package.json** (mirror `packages/sqlite-storage/package.json`, adapt):
```json
{
  "name": "@dawn-ai/memory-pgvector",
  "version": "0.8.8",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/cacheplane/dawnai/tree/main/packages/memory-pgvector#readme",
  "repository": { "type": "git", "url": "git+https://github.com/cacheplane/dawnai.git", "directory": "packages/memory-pgvector" },
  "bugs": { "url": "https://github.com/cacheplane/dawnai/issues" },
  "engines": { "node": ">=22.13.0" },
  "files": ["dist"],
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src test tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dawn-ai/memory": "workspace:*",
    "pg": "^8.13.1",
    "pgvector": "^0.2.0"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@testcontainers/postgresql": "^10.13.2",
    "@types/node": "26.1.0",
    "@types/pg": "^8.11.10"
  }
}
```
(Confirm latest resolvable versions during `pnpm install`; pin to what resolves.)

- [ ] **Step 2:** `tsconfig.json` + `vitest.config.ts` — copy from `packages/sqlite-storage/` verbatim (same compiler + vitest setup). `src/index.ts` barrel `export { pgvectorMemoryStore } from "./pgvector-store.js"` (stub the store for now: a factory that throws `new Error("not implemented")` so the package builds).

- [ ] **Step 3: Install + build + typecheck**:
```bash
cd /Users/blove/repos/dawn
pnpm install
pnpm --filter @dawn-ai/memory-pgvector build
pnpm --filter @dawn-ai/memory-pgvector typecheck
```
Expected: package builds (stub). Report the resolved `pg`/`pgvector`/`@testcontainers/postgresql` versions.

- [ ] **Step 4: Lint + commit** `feat(memory-pgvector): scaffold package`.

---

### Task 4: pgvector schema (dimension branch + idempotent DDL)

**Files:** create `packages/memory-pgvector/src/schema.ts`, `packages/memory-pgvector/test/schema.test.ts`.

- [ ] **Step 1: Write failing PURE tests** (dimension branch is pure — no PG needed) — `test/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { vectorColumnDef } from "../src/schema.js"

describe("vectorColumnDef", () => {
  it("dims ≤ 2000 → plain vector + vector_cosine_ops", () => {
    expect(vectorColumnDef(1536)).toEqual({ type: "vector(1536)", ops: "vector_cosine_ops" })
  })
  it("2000 < dims ≤ 4000 → halfvec + halfvec_cosine_ops (text-embedding-3-large)", () => {
    expect(vectorColumnDef(3072)).toEqual({ type: "halfvec(3072)", ops: "halfvec_cosine_ops" })
  })
  it("dims > 4000 → throws a clear error naming the ceiling", () => {
    expect(() => vectorColumnDef(5000)).toThrow(/4000/)
  })
  it("non-positive/non-integer dims throw", () => {
    expect(() => vectorColumnDef(0)).toThrow()
    expect(() => vectorColumnDef(1.5)).toThrow()
  })
})
```

- [ ] **Step 2: Run — expect fail.** `DAWN_TEST_PGVECTOR= pnpm --filter @dawn-ai/memory-pgvector exec vitest run test/schema.test.ts`

- [ ] **Step 3: Implement `schema.ts`** — the pure dimension branch + the DDL builder:
```ts
import type { PoolClient } from "pg"

/** pgvector index dimension ceilings: plain vector ≤2000, halfvec ≤4000. */
export function vectorColumnDef(dimensions: number): { type: string; ops: string } {
  if (!Number.isInteger(dimensions) || dimensions <= 0)
    throw new Error(`pgvector: dimensions must be a positive integer, got ${dimensions}`)
  if (dimensions <= 2000) return { type: `vector(${dimensions})`, ops: "vector_cosine_ops" }
  if (dimensions <= 4000) return { type: `halfvec(${dimensions})`, ops: "halfvec_cosine_ops" }
  throw new Error(
    `pgvector: ${dimensions} dims exceeds the 4000 halfvec index ceiling; reduce embedding dimensions or use a smaller model`,
  )
}

/** Idempotent schema init. Safe to call repeatedly (IF NOT EXISTS everywhere). */
export async function initSchema(
  client: PoolClient,
  opts: { prefix: string; schema: string; dimensions: number; m: number; efConstruction: number },
): Promise<void> {
  const { prefix, schema, dimensions, m, efConstruction } = opts
  const t = `${schema}.${prefix}_memories`
  const tk = `${schema}.${prefix}_tokens`
  const { type, ops } = vectorColumnDef(dimensions)
  await client.query("CREATE EXTENSION IF NOT EXISTS vector")
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  await client.query(`CREATE TABLE IF NOT EXISTS ${t} (
    id text PRIMARY KEY, kind text NOT NULL, namespace text NOT NULL, content text NOT NULL,
    data jsonb NOT NULL, source jsonb NOT NULL, confidence real NOT NULL, tags jsonb NOT NULL,
    status text NOT NULL, supersedes jsonb, created_at text NOT NULL, updated_at text NOT NULL,
    effective_at text, expires_at text, embedding ${type}, embedding_model text)`)
  await client.query(`CREATE TABLE IF NOT EXISTS ${tk} (
    memory_id text NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE, token text NOT NULL)`)
  await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_ns_status_updated ON ${t} (namespace, status, updated_at DESC)`)
  await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_tok ON ${tk} (token)`)
  await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_tok_mem ON ${tk} (memory_id)`)
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${prefix}_hnsw ON ${t} USING hnsw (embedding ${ops}) WITH (m = ${m}, ef_construction = ${efConstruction})`,
  )
}
```

- [ ] **Step 4: Run — pure tests pass.** (DDL is exercised in Task 6 against real PG.)

- [ ] **Step 5: Lint + commit** `feat(memory-pgvector): schema + dimension branch (vector/halfvec ceilings)`.

---

### Task 5: `pgvectorMemoryStore` implementation

**Files:** create `packages/memory-pgvector/src/queries.ts` (SQL) + implement `packages/memory-pgvector/src/pgvector-store.ts`.

Implement the full `MemoryStore` (from `@dawn-ai/memory`). The store owns retrieval; ranking reuses `rankKeywordCandidates` + `fuseHybrid`. Use the `pgvector` package's `toSql`/registration for the vector param. Key points (no test in this task — Task 6's conformance kit is the test, gated on real PG):

- Constructor: `pgvectorMemoryStore({ connectionString?, pool?, dimensions, index?, schema="public", tablePrefix="dawn_memory" })`. Build a `pg.Pool` from `connectionString` (or use injected `pool`). Lazy idempotent `initSchema` guarded by a memoized `initP: Promise<void>` (await it at the top of every method). Register `pgvector` types on the pool.
- `put(rec, opts?)`: `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` all columns incl `embedding` (serialize the Float32Array via `pgvector.toSql([...embedding])` — or the package's helper) + `embedding_model`; then delete+reinsert `memory_tokens` via the same `tokenize` from `@dawn-ai/memory`. On UPDATE with no embedding opts, preserve the existing embedding (read-then-write, parity with sqlite `getEmbeddingRow`).
- `get`/`delete`/`listCandidates`/`update`/`supersede`: direct SQL translations of the sqlite behaviors (row↔record JSON parse/stringify).
- `search(q)`:
  - Query-less (no `query`): `WHERE namespace/status[/kind] ORDER BY updated_at DESC, id ASC LIMIT`.
  - Keyword-only (no `queryEmbedding`): fetch candidate pool (rows matching ≥1 token, `LIMIT candidatePool`) + `df`/`N` stats → `rankKeywordCandidates(...)` → `pageAndTagFilter`.
  - Hybrid: (a) `SET LOCAL hnsw.ef_search = $efSearch` then vector top-K — `SELECT id FROM <t> WHERE ... AND embedding_model = $model AND embedding IS NOT NULL ORDER BY embedding <=> $vec LIMIT $vectorK`; look up those records; (b) keyword candidate pool + stats → `rankKeywordCandidates` with relevance-only weights; then `fuseHybrid({ keywordRanked, vectorRanked, now: q.now, options: { ...q.vector, recencyHalfLifeMs: q.vector?.recencyHalfLifeMs } })` → `pageAndTagFilter`.
  - Reuse a shared `pageAndTagFilter` + `rowToRecord` (copy the sqlite versions into `queries.ts`).
- `close()`: `await pool.end()`.

- [ ] **Step 1:** Write `queries.ts` (rowToRecord, tokenize import, the SQL strings, pageAndTagFilter) + `pgvector-store.ts` (the factory + methods above). Full code is mechanical translation of `sqlite-store.ts` to `pg` async SQL — follow the sqlite method bodies exactly, swapping `db.prepare().all/get/run` for `await client.query(text, params)` and `?`→`$1..$n`.
- [ ] **Step 2:** `pnpm --filter @dawn-ai/memory-pgvector build && typecheck` — clean (no runtime test yet).
- [ ] **Step 3: Lint + commit** `feat(memory-pgvector): pgvectorMemoryStore (full MemoryStore over pg + pgvector)`.

---

### Task 6: Gated conformance + pgvector integration against real Postgres

**Files:** create `packages/memory-pgvector/test/pgvector-conformance.test.ts`, `packages/memory-pgvector/test/pgvector-integration.test.ts`.

- [ ] **Step 1: Gated conformance** — `pgvector-conformance.test.ts`:
```ts
import { runMemoryStoreConformance } from "@dawn-ai/testing"
import { afterAll, beforeAll, describe } from "vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { pgvectorMemoryStore } from "../src/index.js"

const enabled = process.env.DAWN_TEST_PGVECTOR === "1"
let container: StartedPostgreSqlContainer
let url: string

describe.skipIf(!enabled)("pgvector real-Postgres conformance", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    url = container.getConnectionUri()
  }, 120_000)
  afterAll(async () => { await container?.stop() })

  runMemoryStoreConformance({
    name: "pgvectorMemoryStore",
    // Fresh isolated store per test via a unique table prefix (no cross-test bleed).
    makeStore: () => pgvectorMemoryStore({ connectionString: url, dimensions: 3, tablePrefix: `t_${Math.random().toString(36).slice(2)}` }),
    describe,
    close: (s) => (s as { close(): Promise<void> }).close(),
  })
})
```
Note: `dimensions: 3` matches the conformance kit's `vec(1,0,0)` fixtures. (Deviation from Math.random determinism rule is TEST-ONLY and acceptable — it just isolates tables; if biome/policy flags it, use a beforeAll counter instead.)

- [ ] **Step 2: pgvector-specific integration** — `pgvector-integration.test.ts` (gated, same container): schema idempotency (`initSchema` twice → no error), the dimension branch on real PG (create a 1536 `vector` store and a 3072 `halfvec` store, both init cleanly), HNSW index exists (`SELECT indexname ... WHERE indexdef LIKE '%hnsw%'`), and a concurrency check (10 parallel `put`s + a `search`, all resolve). Each with `describe.skipIf(!enabled)`.

- [ ] **Step 3: Run gated locally (needs Docker):**
```bash
cd /Users/blove/repos/dawn
pnpm build
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
```
Expected: the 8 conformance tests + integration tests pass against real pgvector. Also confirm they SKIP without the flag: `pnpm --filter @dawn-ai/memory-pgvector test` → skipped.
Report both. If the vector-ordering conformance tests are flaky under HNSW at tiny N, note it — at N≤2 HNSW recall is effectively exact, so they should be stable; if not, the retrieval SQL is wrong, not the test.

- [ ] **Step 4: Lint + commit** `test(memory-pgvector): gated real-Postgres conformance + integration`.

---

### Task 7: CI gated lane

**Files:** modify `.github/workflows/ci.yml`.

- [ ] **Step 1:** Add a `pgvector-docker` job mirroring `sandbox-docker` (read it at ci.yml ~line 97). Same checkout/pnpm/node(22.14.0)/install; then:
```yaml
  pgvector-docker:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      # ... same checkout / setup-pnpm / setup-node(22.14.0, cache pnpm) / install as sandbox-docker ...
      - name: Build memory-pgvector + deps
        run: pnpm --filter @dawn-ai/memory --filter @dawn-ai/testing --filter @dawn-ai/memory-pgvector build
      - name: Real-Postgres pgvector conformance + integration
        run: DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
```
(Testcontainers pulls `pgvector/pgvector:pg16` itself; the ubuntu runner has Docker. No `services:` block needed.)

- [ ] **Step 2:** Validate the workflow YAML parses (`node -e "require('js-yaml')"` if available, or `gh workflow view` after push). Commit `ci: gated pgvector real-Postgres lane`.

---

### Task 8: `examples/memory` app + continuous dogfood

**Files:** create `examples/memory/**` (package.json, dawn.config.ts, src/app/notes/{index.ts,memory.ts}, tsconfig); create `packages/testing/test/memory-example-dogfood.test.ts` OR co-locate under the example. Read `examples/chat/server` for the example-app shape.

- [ ] **Step 1: The example app.** Minimal: one route `src/app/notes/` with `index.ts` (`agent({ model: "gpt-5-mini", systemPrompt: "You are a note-taking assistant with long-term memory. Use remember/recall." })`) + `memory.ts` (`defineMemory({ kind: "semantic", scope: ["route"], schema: z.object({ subject, predicate, value }) })`). `dawn.config.ts` backend-switch:
```ts
import { openaiEmbedder } from "@dawn-ai/langchain"
const url = process.env.DATABASE_URL
export default {
  appDir: "src/app",
  memory: {
    writes: "auto",
    ...(process.env.OPENAI_API_KEY || url ? { vector: { embedder: openaiEmbedder() } } : {}),
    ...(url
      ? { store: (await import("@dawn-ai/memory-pgvector")).pgvectorMemoryStore({ connectionString: url, dimensions: 1536 }) }
      : {}),
  },
}
```
(If top-level await in the config is a problem for the loader, use a synchronous import + a factory that connects lazily — verify against how `loadDawnConfig` evaluates the config; adjust to a non-async default export if needed.)

- [ ] **Step 2: Continuous dogfood test** (CI-safe path always; pgvector path gated). Using `createAgentHarness` against the example appRoot with a scripted `fakeEmbedder`-backed run: remember a fact → assert it persisted (store search finds it) → recall returns it. Run the sqlite path always; add a `describe.skipIf(!DAWN_TEST_PGVECTOR)` block that points the example at a Testcontainers Postgres (set `DATABASE_URL`) and re-runs the same flow, asserting recall works through pgvector. Model this on `packages/testing/test/memory-vector-e2e.test.ts`.

- [ ] **Step 3:** Add root scripts: `"dogfood:pgvector"` in root package.json that starts a pgvector container (or documents `docker run -e POSTGRES_PASSWORD=x -p 5432:5432 pgvector/pgvector:pg16`) + runs the example's dogfood flow with a real `OPENAI_API_KEY` (documented as local-only). Write `examples/memory/README.md` with the sqlite default + the `DATABASE_URL` pgvector toggle + the docker one-liner.

- [ ] **Step 4:** Run the CI-safe dogfood (`pnpm --filter ... exec vitest run memory-example-dogfood`) green; run the gated pgvector dogfood locally (Docker) green. `pnpm build` first. Commit `feat(examples): memory example app + continuous pgvector dogfood`.

---

### Task 9: Local doubly-gated real-embedder smoke

**Files:** add to `packages/memory-pgvector/test/pgvector-live.smoke.test.ts` (or extend the example dogfood).

- [ ] **Step 1:** `describe.skipIf(!(process.env.DAWN_TEST_PGVECTOR === "1" && process.env.OPENAI_API_KEY))`: boot the `examples/memory` app against a Testcontainers Postgres + real `openaiEmbedder`, remember "the customer wants faster shipping", recall with "expedite delivery options" (zero shared tokens), assert the recalled content contains "shipping". Proves real embeddings + real pgvector end-to-end.
- [ ] **Step 2:** Confirm it SKIPS without both flags. Run locally with `.env` loaded ONLY in the smoke shell (`set -a; . ./.env; set +a`) + `DAWN_TEST_PGVECTOR=1`; never print the key. Report pass + recalled content (no secret).
- [ ] **Step 3: Lint + commit** `test(memory-pgvector): doubly-gated real-embedder paraphrase smoke`.

---

### Task 10: Docs, changeset, validate, PR

**Files:** modify `apps/web/content/docs/memory.mdx`, `docs/dev/memory-system.md`; create `.changeset/pgvector-backend.md`.

- [ ] **Step 1: `memory.mdx`** — a "### Postgres backend (pgvector)" subsection under long-term memory: enable via `config.memory.store = pgvectorMemoryStore({ connectionString, dimensions })`; HNSW + cosine; the dimension note (1536 fits `vector`; 3072 uses `halfvec`); that **ranking is identical to the sqlite backend** (shared pure core); needs a running Postgres with the `vector` extension; local `docker run` one-liner. Note it's a production/multi-instance option; sqlite stays the local-first default.

- [ ] **Step 2: `docs/dev/memory-system.md`** — §2 file map add `hybrid.ts` + `@dawn-ai/memory-pgvector`; a new section on the shared ranking core (both backends retrieve then call `fuseHybrid`); note the conformance kit + gated lane; pgvector now shipped (Tier-2), DiskANN/pgvectorscale + in-SQL RRF still deferred.

- [ ] **Step 3:** `node scripts/check-docs.mjs` — pass (reword banned phrases if flagged).

- [ ] **Step 4: Changeset** `.changeset/pgvector-backend.md` (PATCH — fixed 0.x group; minor bumps the whole group to 1.0.0):
```markdown
---
"@dawn-ai/memory": patch
"@dawn-ai/testing": patch
"@dawn-ai/memory-pgvector": patch
---

Add `@dawn-ai/memory-pgvector` — a Postgres + pgvector MemoryStore backend for
production/multi-instance vector memory. Enable with
`memory: { store: pgvectorMemoryStore({ connectionString, dimensions }) }`. Uses
an HNSW index (cosine) for vector retrieval and reuses the exact same pure hybrid
ranking (RRF + recency/confidence) as the default sqlite backend, so recall
ordering is identical across backends. Ships a shared `runMemoryStoreConformance`
kit (@dawn-ai/testing) run against both backends. Dimensions ≤2000 use `vector`,
≤4000 use `halfvec` (text-embedding-3-large); pgvectorscale/DiskANN and in-SQL RRF
are deferred.
```

- [ ] **Step 5: Full validate** (clean shell, no `.env`, no `DAWN_TEST_PGVECTOR`):
  `pnpm lint && pnpm build && pnpm typecheck && pnpm test` — all green; pgvector conformance/integration/live SKIP (no flag). Report the final summary line.

- [ ] **Step 6: Commit, push, open PR (do NOT auto-merge — coordinator runs the final whole-branch review + a gated-lane check first):**
```bash
cd /Users/blove/repos/dawn
git add apps/web/content/docs/memory.mdx docs/dev/memory-system.md .changeset/pgvector-backend.md
git commit -m "docs+changeset: pgvector memory backend"
git push -u origin feat/memory-pgvector
gh pr create --base main --head feat/memory-pgvector --title "feat(memory): pgvector backend (@dawn-ai/memory-pgvector)" --body "<summary: production Postgres+pgvector MemoryStore, HNSW+cosine, retrieve-in-PG + shared pure fusion (identical ranking to sqlite), dimension branch vector/halfvec, shared conformance kit run against both backends, gated real-Postgres CI lane, examples/memory continuous dogfood; new-package OIDC bootstrap needed at release; research: docs/superpowers/specs/2026-07-07-pgvector-backend-design.md>. End with Generated-with-Claude-Code."
```

---

## Self-review

- **Spec coverage:** shared core extract + sqlite refactor (T1); conformance kit + sqlite run (T2); package scaffold (T3); schema + dimension branch (T4); full store (T5); gated conformance + integration (T6); gated CI lane (T7); examples/memory + continuous dogfood (T8); doubly-gated real smoke (T9); docs + changeset + validate + PR (T10). App-side fusion via shared core ✓. New-package OIDC bootstrap noted (T10 PR body + release memory). ✓
- **Type consistency:** `MemoryStore` (from @dawn-ai/memory) implemented in full by pgvector incl `delete`/`listCandidates`; `fuseHybrid`/`rankKeywordCandidates` signatures identical across T1 (def), sqlite refactor (T1), and pgvector store (T5); `pgvectorMemoryStore(opts)` shape identical across T3/T5/T6/T8; `VectorRankingOptions` reused. ✓
- **Traps flagged inline:** branch pin; scoped biome; patch-not-minor; `.env` + `DAWN_TEST_PGVECTOR` gating; Testcontainers needs Docker; monorepo dist rebuild ordering; the sqlite refactor guarded by shipped tests (fix extraction not test); top-level-await-in-config caveat (T8); HNSW-at-tiny-N stability note (T6); new-package OIDC bootstrap at release.
- **Biggest risk:** T1 extraction (parity) and T5 SQL translation (correctness, only caught by T6's gated lane — so T6 must actually run against Docker locally before the PR, not just be written).
