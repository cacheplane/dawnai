# Memory Distillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `dawn memory consolidate` and `dawn memory reflect` — a shared batch engine that reads accumulated memories, runs one LLM pass, and writes derived records (summaries, insights) with provenance.

**Architecture:** All clock-free selection/prompt/parse/record-building logic lives in a pure `distill.ts` in `@dawn-ai/memory` (unit-tested like `reconcile.ts`); the orchestrator in `@dawn-ai/cli` gathers via `browse`, calls the pure selectors, runs the model pass through an injected seam, and writes **before** it links (sources are superseded only after a summary lands). No store interface changes, no new package, no background scheduling.

**Tech Stack:** node:sqlite + pg (both stores, unchanged), `createChatModel` from `@dawn-ai/langchain` (has an `importer` seam for tests), hand-written output validation (memory stays zero-extra-dep), aimock for integration, vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-memory-distillation-design.md` — read it first.

**USER DIRECTIVE (every task):** verification must be extremely robust. Strict TDD with failing-first evidence quoted in each report. Enumerated edge cases are REQUIREMENTS. Gated runs marked MANDATORY (`DAWN_TEST_PGVECTOR=1` real Docker) may not be skipped.

**Working rules:** branch-pin (`git rev-parse --abbrev-ref HEAD` → `feat/memory-distill`) before every commit; never bare `biome check --write`; changesets are **patch** (fixed 0.x group); commands run from `/Users/blove/repos/dawn/.claude/worktrees/distill`.

---

## File map

| Area | Files |
|---|---|
| Pure logic | `packages/memory/src/distill.ts` (new), `packages/memory/src/index.ts`, `packages/memory/src/reconcile.ts` (reflection→append) |
| Config + guard | `packages/core/src/types.ts` (distill config), `packages/core/src/capabilities/built-in/memory.ts` (mirrored kind guard) |
| Engine | `packages/cli/src/lib/memory/distill.ts` (new), `packages/cli/src/lib/runtime/resolve-memory.ts` (`resolveDistillConfig`) |
| CLI | `packages/cli/src/commands/memory.ts` (two subcommands) |
| Conformance | `packages/testing/src/memory-conformance.ts` (episodic supersede case) |
| Docs/release | `apps/web/content/docs/memory.mdx`, `upgrading.mdx`, `docs/dev/memory-system.md`, `examples/memory/README.md`, `.changeset/memory-distillation.md` |
| Live smoke | `packages/testing/test/distill-live.smoke.test.ts` (new, doubly-gated) |

Task order: **D1 → D2 → D3 → D4 → D5 → D6 → D7 → D8**.

---

### Task D1: pure selection + watermark (`@dawn-ai/memory`)

**Files:**
- Create: `packages/memory/src/distill.ts`, `packages/memory/test/distill-select.test.ts`
- Modify: `packages/memory/src/index.ts`

- [ ] **Step 1: Write the failing tests**

`packages/memory/test/distill-select.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import {
  type MemoryRecord,
  selectConsolidationBatches,
  selectReflectionInput,
} from "../src/index.js"

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "episodic",
    namespace: "route=/a",
    content: over.id,
    data: {},
    source: { type: "run", id: over.id },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }
}
// 2026-07-06 is a Monday; week A = Jul 6-12, week B = Jul 13-19.
const wA = (d: number) => `2026-07-0${d}T12:00:00.000Z`
const wB = (d: number) => `2026-07-1${d}T12:00:00.000Z`

describe("selectConsolidationBatches", () => {
  it("groups by namespace and ISO week, ordering records by event time ascending", () => {
    const records = [
      rec({ id: "a3", effectiveAt: wA(9) }),
      rec({ id: "a1", effectiveAt: wA(7) }),
      rec({ id: "a2", effectiveAt: wA(8) }),
      rec({ id: "b1", namespace: "route=/b", effectiveAt: wA(7) }),
      rec({ id: "a4", effectiveAt: wB(3) }),
      rec({ id: "a5", effectiveAt: wB(4) }),
    ]
    const batches = selectConsolidationBatches(records, { minBatchSize: 2, maxBatchSize: 50 })
    // route=/a week A (3), route=/a week B (2), route=/b week A (1 → dropped by minBatchSize)
    expect(batches.length).toBe(2)
    const first = batches.find((b) => b.namespace === "route=/a" && b.records.length === 3)
    expect(first?.records.map((r) => r.id)).toEqual(["a1", "a2", "a3"])
    expect(first?.period.since <= wA(7)).toBe(true)
    expect(first?.period.until > wA(9)).toBe(true)
    expect(batches.every((b) => b.namespace !== "route=/b")).toBe(true)
  })
  it("falls back to createdAt when effectiveAt is absent", () => {
    const batches = selectConsolidationBatches(
      [rec({ id: "x", createdAt: wA(7), updatedAt: wA(7) }), rec({ id: "y", createdAt: wA(8), updatedAt: wA(8) })],
      { minBatchSize: 2, maxBatchSize: 50 },
    )
    expect(batches[0]?.records.map((r) => r.id)).toEqual(["x", "y"])
  })
  it("splits a group larger than maxBatchSize into ordered chunks", () => {
    const records = Array.from({ length: 7 }, (_, i) =>
      rec({ id: `r${i}`, effectiveAt: `2026-07-0${(i % 3) + 7}T0${i}:00:00.000Z` }),
    )
    const batches = selectConsolidationBatches(records, { minBatchSize: 2, maxBatchSize: 3 })
    expect(batches.map((b) => b.records.length)).toEqual([3, 3, 1])
    // chunks stay in ascending event order across the split
    const flat = batches.flatMap((b) => b.records.map((r) => r.id))
    expect(flat.length).toBe(7)
    expect(new Set(flat).size).toBe(7)
  })
  it("returns an empty array when nothing meets minBatchSize", () => {
    expect(selectConsolidationBatches([rec({ id: "lonely" })], { minBatchSize: 5, maxBatchSize: 50 })).toEqual([])
  })
})

describe("selectReflectionInput", () => {
  const opts = { minNewRecords: 2, maxRecords: 10 }
  it("filters to records strictly after the watermark", () => {
    const input = selectReflectionInput(
      [rec({ id: "old", effectiveAt: wA(7) }), rec({ id: "new1", effectiveAt: wA(9) }), rec({ id: "new2", effectiveAt: wB(3) })],
      { ...opts, coveredUntil: wA(8) },
    )
    expect(input?.records.map((r) => r.id)).toEqual(["new1", "new2"])
    expect(input?.coveredUntil).toBe(wB(3)) // the newest event time in the input
  })
  it("returns null below the threshold (the cheap no-op)", () => {
    expect(selectReflectionInput([rec({ id: "one", effectiveAt: wB(3) })], { ...opts, coveredUntil: wA(7) })).toBeNull()
  })
  it("treats a missing watermark as the epoch (first-ever pass)", () => {
    const input = selectReflectionInput(
      [rec({ id: "a", effectiveAt: wA(7) }), rec({ id: "b", effectiveAt: wA(8) })],
      opts,
    )
    expect(input?.records.map((r) => r.id)).toEqual(["a", "b"])
  })
  it("caps at maxRecords keeping the NEWEST, re-sorted ascending", () => {
    const records = [1, 2, 3, 4, 5].map((i) => rec({ id: `r${i}`, effectiveAt: `2026-07-0${i + 4}T00:00:00.000Z` }))
    const input = selectReflectionInput(records, { minNewRecords: 2, maxRecords: 3 })
    expect(input?.records.map((r) => r.id)).toEqual(["r3", "r4", "r5"])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @dawn-ai/memory test distill-select`
Expected: FAIL — `selectConsolidationBatches` / `selectReflectionInput` are not exported.

- [ ] **Step 3: Implement**

`packages/memory/src/distill.ts`:
```ts
import type { MemoryRecord } from "./types.js"

/** Event time for distillation ordering/grouping: when it happened, not when the row moved. */
export function eventTimeOf(record: MemoryRecord): string {
  return record.effectiveAt ?? record.createdAt
}

/** ISO-week key (UTC): "<isoYear>-W<isoWeek>", so a batch is one namespace-week. */
export function isoWeekKey(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  const thursday = new Date(d)
  thursday.setUTCDate(d.getUTCDate() - day + 3)
  const isoYear = thursday.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstDay = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3)
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${isoYear}-W${String(week).padStart(2, "0")}`
}

export interface ConsolidationBatch {
  readonly namespace: string
  readonly period: { readonly since: string; readonly until: string }
  readonly records: readonly MemoryRecord[]
}

/** Group active episodic records into per-(namespace, ISO week) batches, ordered by
 *  event time; groups below minBatchSize are dropped (summarizing 2 runs is noise),
 *  groups above maxBatchSize are chunked. Pure: the caller filters by age/status. */
export function selectConsolidationBatches(
  records: readonly MemoryRecord[],
  opts: { readonly minBatchSize: number; readonly maxBatchSize: number },
): ConsolidationBatch[] {
  const groups = new Map<string, MemoryRecord[]>()
  for (const r of records) {
    const key = `${r.namespace} ${isoWeekKey(eventTimeOf(r))}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }
  const batches: ConsolidationBatch[] = []
  for (const [key, bucket] of groups) {
    if (bucket.length < opts.minBatchSize) continue
    const namespace = key.slice(0, key.indexOf(" "))
    const sorted = [...bucket].sort((a, b) => (eventTimeOf(a) < eventTimeOf(b) ? -1 : eventTimeOf(a) > eventTimeOf(b) ? 1 : a.id < b.id ? -1 : 1))
    for (let i = 0; i < sorted.length; i += opts.maxBatchSize) {
      const chunk = sorted.slice(i, i + opts.maxBatchSize)
      const first = chunk[0]
      const last = chunk[chunk.length - 1]
      if (!first || !last) continue
      batches.push({
        namespace,
        period: { since: eventTimeOf(first), until: nextMillis(eventTimeOf(last)) },
        records: chunk,
      })
    }
  }
  return batches
}

/** `until` is exclusive everywhere in this codebase; +1ms makes the last record inclusive. */
function nextMillis(iso: string): string {
  return new Date(Date.parse(iso) + 1).toISOString()
}

export interface ReflectionInput {
  readonly namespace: string
  readonly records: readonly MemoryRecord[]
  /** The newest event time covered — becomes the next pass's watermark. */
  readonly coveredUntil: string
}

/** Records strictly newer than the watermark, newest-capped then re-sorted ascending.
 *  Returns null below the threshold — that null is what makes `dawn memory reflect`
 *  a cheap no-op for cron. Callers pass records from ONE namespace. */
export function selectReflectionInput(
  records: readonly MemoryRecord[],
  opts: {
    readonly minNewRecords: number
    readonly maxRecords: number
    readonly coveredUntil?: string
  },
): ReflectionInput | null {
  const watermark = opts.coveredUntil ?? new Date(0).toISOString()
  const fresh = records.filter((r) => eventTimeOf(r) > watermark)
  if (fresh.length < opts.minNewRecords) return null
  const byTimeDesc = [...fresh].sort((a, b) => (eventTimeOf(b) < eventTimeOf(a) ? -1 : 1))
  const capped = byTimeDesc.slice(0, opts.maxRecords)
  const ascending = [...capped].sort((a, b) => (eventTimeOf(a) < eventTimeOf(b) ? -1 : 1))
  const newest = capped[0]
  const namespace = ascending[0]?.namespace ?? ""
  if (!newest) return null
  return { namespace, records: ascending, coveredUntil: eventTimeOf(newest) }
}
```
Export `selectConsolidationBatches`, `selectReflectionInput`, `eventTimeOf`, `isoWeekKey`, and the two interfaces from `packages/memory/src/index.ts`.

- [ ] **Step 4: Run tests — pass, whole package green**

```bash
pnpm --filter @dawn-ai/memory test         # all existing + new
pnpm --filter @dawn-ai/memory typecheck && pnpm --filter @dawn-ai/memory lint
```

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/memory
git commit -m "feat(memory): pure distillation selection — namespace-week batches + reflection watermark"
```

---

### Task D2: pure prompts, output parsing, record builders

**Files:**
- Modify: `packages/memory/src/distill.ts`, `packages/memory/src/index.ts`
- Test: `packages/memory/test/distill-build.test.ts` (create)

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest"
import {
  buildConsolidationPrompt,
  buildReflectionPrompt,
  buildReflectionRecords,
  buildSummaryRecord,
  type MemoryRecord,
  parseConsolidationOutput,
  parseReflectionOutput,
} from "../src/index.js"

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "episodic", namespace: "route=/a", content: `content of ${over.id}`, data: {},
    source: { type: "run", id: over.id }, confidence: 1, tags: [], status: "active",
    createdAt: "2026-07-07T00:00:00.000Z", updatedAt: "2026-07-07T00:00:00.000Z", ...over,
  }
}
const BATCH = {
  namespace: "route=/a",
  period: { since: "2026-07-07T00:00:00.000Z", until: "2026-07-10T00:00:00.000Z" },
  records: [rec({ id: "e1", effectiveAt: "2026-07-07T09:00:00.000Z" }), rec({ id: "e2", effectiveAt: "2026-07-08T09:00:00.000Z" })],
}
const NOW = "2026-07-20T00:00:00.000Z"

describe("prompts", () => {
  it("consolidation prompt names the period and lists every record", () => {
    const p = buildConsolidationPrompt(BATCH)
    expect(p).toContain("route=/a")
    expect(p).toContain("2026-07-07")
    expect(p).toContain("content of e1")
    expect(p).toContain("content of e2")
    expect(p).toMatch(/summary/i)
  })
  it("reflection prompt asks for insights and lists the records", () => {
    const p = buildReflectionPrompt({ namespace: "route=/a", records: BATCH.records, coveredUntil: "2026-07-08T09:00:00.000Z" })
    expect(p).toContain("content of e1")
    expect(p).toMatch(/insight/i)
    expect(p).toMatch(/JSON/i)
  })
  it("is deterministic — same input, byte-identical prompt", () => {
    expect(buildConsolidationPrompt(BATCH)).toBe(buildConsolidationPrompt(BATCH))
  })
})

describe("parsing", () => {
  it("parses a clean consolidation summary", () => {
    expect(parseConsolidationOutput('{"summary":"three deploys, one rollback"}')).toEqual({ summary: "three deploys, one rollback" })
  })
  it("parses fenced JSON", () => {
    expect(parseConsolidationOutput('```json\n{"summary":"ok"}\n```')).toEqual({ summary: "ok" })
  })
  it("throws a typed error on garbage", () => {
    expect(() => parseConsolidationOutput("I am not JSON")).toThrow(/could not parse/i)
  })
  it("parses reflection insights and tolerates an empty list", () => {
    expect(parseReflectionOutput('{"insights":[{"insight":"deploys fail on Fridays","confidence":0.7,"tags":["ops"]}]}').insights[0]?.insight).toBe("deploys fail on Fridays")
    expect(parseReflectionOutput('{"insights":[]}').insights).toEqual([])
  })
  it("rejects insights missing required fields", () => {
    expect(() => parseReflectionOutput('{"insights":[{"confidence":0.5}]}')).toThrow(/insight/i)
  })
})

describe("record builders", () => {
  it("builds a summary record with provenance and a deterministic id", () => {
    const a = buildSummaryRecord(BATCH, "digest text", NOW)
    const b = buildSummaryRecord(BATCH, "digest text", NOW)
    expect(a.id).toBe(b.id)
    expect(a.id).toMatch(/^memory_sum_[0-9a-f]{16}$/)
    expect(a.kind).toBe("episodic")
    expect(a.status).toBe("active")
    expect(a.tags).toContain("consolidated")
    expect(a.content).toBe("digest text")
    expect(a.data.derivedFrom).toEqual(["e1", "e2"])
    expect(a.data.sourceCount).toBe(2)
    expect(a.effectiveAt).toBe(BATCH.period.since)
    expect(a.expiresAt).toBeUndefined()
    expect(a.source).toEqual({ type: "tool", id: "consolidate" })
  })
  it("honors an explicit summary ttl", () => {
    const withTtl = buildSummaryRecord(BATCH, "d", NOW, { ttlMs: 86_400_000 })
    expect(withTtl.expiresAt).toBe(new Date(Date.parse(NOW) + 86_400_000).toISOString())
  })
  it("builds candidate reflection records carrying the watermark", () => {
    const input = { namespace: "route=/a", records: BATCH.records, coveredUntil: "2026-07-08T09:00:00.000Z" }
    const out = buildReflectionRecords(input, [{ insight: "fridays are risky", confidence: 0.6, tags: ["ops"] }], NOW, { status: "candidate" })
    expect(out.length).toBe(1)
    const r = out[0]!
    expect(r.id).toMatch(/^memory_rfl_[0-9a-f]{16}$/)
    expect(r.kind).toBe("reflection")
    expect(r.status).toBe("candidate")
    expect(r.data.coveredUntil).toBe("2026-07-08T09:00:00.000Z")
    expect(r.data.derivedFrom).toEqual(["e1", "e2"])
    expect(r.source).toEqual({ type: "tool", id: "reflect" })
    expect(r.effectiveAt).toBe(NOW)
  })
  it("reflection ids differ per insight and are stable across calls", () => {
    const input = { namespace: "route=/a", records: BATCH.records, coveredUntil: "2026-07-08T09:00:00.000Z" }
    const insights = [{ insight: "one", confidence: 0.5, tags: [] }, { insight: "two", confidence: 0.5, tags: [] }]
    const first = buildReflectionRecords(input, insights, NOW, { status: "active" })
    const second = buildReflectionRecords(input, insights, NOW, { status: "active" })
    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id))
    expect(first[0]!.id).not.toBe(first[1]!.id)
    expect(first[0]!.status).toBe("active")
  })
})
```

- [ ] **Step 2: Verify failure** — `pnpm --filter @dawn-ai/memory test distill-build` → not exported.

- [ ] **Step 3: Implement** (append to `packages/memory/src/distill.ts`)

```ts
import { createHash } from "node:crypto"


const CONSOLIDATION_SCHEMA = z.object({ summary: z.string().min(1) })
const REFLECTION_SCHEMA = z.object({
  insights: z.array(z.object({ insight: z.string().min(1), confidence: z.number().min(0).max(1), tags: z.array(z.string()).default([]) })),
})

export function buildConsolidationPrompt(batch: ConsolidationBatch): string {
  const lines = batch.records.map((r) => `- [${eventTimeOf(r)}] ${r.content}`).join("\n")
  return [
    `You are compacting an agent's run history for namespace ${batch.namespace}.`,
    `Period: ${batch.period.since} to ${batch.period.until} (${batch.records.length} runs).`,
    "",
    "Runs:",
    lines,
    "",
    'Write ONE dense summary paragraph capturing what happened, recurring work, and notable failures.',
    'Respond with JSON only: {"summary": "..."}',
  ].join("\n")
}

export function buildReflectionPrompt(input: ReflectionInput): string {
  const lines = input.records.map((r) => `- [${eventTimeOf(r)}] (${r.kind}) ${r.content}`).join("\n")
  return [
    `You are deriving durable insights from an agent's recent memories in namespace ${input.namespace}.`,
    "",
    "Memories:",
    lines,
    "",
    "Identify patterns, preferences, or recurring problems worth remembering long-term.",
    "Report ONLY insights that generalize beyond a single event. Return an empty list if none do.",
    'Respond with JSON only: {"insights": [{"insight": "...", "confidence": 0.0-1.0, "tags": ["..."]}]}',
  ].join("\n")
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = (fenced?.[1] ?? raw).trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`could not parse model output as JSON: ${text.slice(0, 120)}`)
  }
}

export function parseConsolidationOutput(raw: string): { summary: string } {
  return CONSOLIDATION_SCHEMA.parse(extractJson(raw))
}

export interface ReflectionInsight {
  readonly insight: string
  readonly confidence: number
  readonly tags: readonly string[]
}

export function parseReflectionOutput(raw: string): { insights: ReflectionInsight[] } {
  return REFLECTION_SCHEMA.parse(extractJson(raw))
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16)
}

export function buildSummaryRecord(
  batch: ConsolidationBatch,
  summary: string,
  now: string,
  opts?: { readonly ttlMs?: number },
): MemoryRecord {
  return {
    id: `memory_sum_${shortHash(`${batch.namespace}|${batch.period.since}|${batch.period.until}`)}`,
    kind: "episodic",
    namespace: batch.namespace,
    content: summary,
    data: {
      period: { since: batch.period.since, until: batch.period.until },
      sourceCount: batch.records.length,
      derivedFrom: batch.records.map((r) => r.id),
    },
    source: { type: "tool", id: "consolidate" },
    confidence: 1,
    tags: ["consolidated"],
    status: "active",
    createdAt: now,
    updatedAt: now,
    effectiveAt: batch.period.since,
    ...(opts?.ttlMs !== undefined ? { expiresAt: new Date(Date.parse(now) + opts.ttlMs).toISOString() } : {}),
  }
}

export function buildReflectionRecords(
  input: ReflectionInput,
  insights: readonly ReflectionInsight[],
  now: string,
  opts: { readonly status: "candidate" | "active" },
): MemoryRecord[] {
  return insights.map((ins) => ({
    id: `memory_rfl_${shortHash(`${input.namespace}|${input.coveredUntil}|${ins.insight}`)}`,
    kind: "reflection" as const,
    namespace: input.namespace,
    content: ins.insight,
    data: {
      insight: ins.insight,
      confidence: ins.confidence,
      coveredUntil: input.coveredUntil,
      derivedFrom: input.records.map((r) => r.id),
    },
    source: { type: "tool" as const, id: "reflect" },
    confidence: ins.confidence,
    tags: [...ins.tags],
    status: opts.status,
    createdAt: now,
    updatedAt: now,
    effectiveAt: now,
  }))
}
```
**DECIDED — do NOT use zod here.** `@dawn-ai/memory`'s only dependency is
`@dawn-ai/sqlite-storage` (verified at plan time); that zero-extra-dep purity is
deliberate and this feature is not worth breaking it. Replace the two zod schemas
above with hand-written guards that throw the same messages the tests assert:

```ts
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`could not parse model output: expected a JSON object for ${what}`)
  }
  return value as Record<string, unknown>
}

export function parseConsolidationOutput(raw: string): { summary: string } {
  const obj = asRecord(extractJson(raw), "consolidation")
  const summary = obj.summary
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new Error('could not parse model output: "summary" must be a non-empty string')
  }
  return { summary }
}

export function parseReflectionOutput(raw: string): { insights: ReflectionInsight[] } {
  const obj = asRecord(extractJson(raw), "reflection")
  const list = obj.insights
  if (!Array.isArray(list)) {
    throw new Error('could not parse model output: "insights" must be an array')
  }
  const insights = list.map((entry, i) => {
    const e = asRecord(entry, `insight[${i}]`)
    if (typeof e.insight !== "string" || e.insight.trim() === "") {
      throw new Error(`could not parse model output: insight[${i}].insight must be a non-empty string`)
    }
    const confidence = typeof e.confidence === "number" && e.confidence >= 0 && e.confidence <= 1 ? e.confidence : 0.5
    const tags = Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : []
    return { insight: e.insight, confidence, tags }
  })
  return { insights }
}
```
Note the deliberate leniency asymmetry: a missing/garbage `confidence` defaults
to 0.5 and non-string tags are dropped (cosmetic fields — don't fail a whole
batch over them), while a missing `insight` string throws (the payload itself).
The D2 test `rejects insights missing required fields` covers exactly that line.
Export all new symbols from `index.ts`.

- [ ] **Step 4: Green + commit**

```bash
pnpm --filter @dawn-ai/memory test && pnpm --filter @dawn-ai/memory typecheck && pnpm --filter @dawn-ai/memory lint
git rev-parse --abbrev-ref HEAD
git add packages/memory
git commit -m "feat(memory): distillation prompts, output parsing, and derived-record builders"
```

---

### Task D3: `reflection` becomes append (memory + core lockstep)

**Files:**
- Modify: `packages/memory/src/reconcile.ts`, `packages/core/src/capabilities/built-in/memory.ts`
- Test: `packages/memory/test/write-policy.test.ts` (extend), `packages/core/test/memory-capability-episodic.test.ts` (extend)

- [ ] **Step 1: Failing tests**

In `packages/memory/test/write-policy.test.ts`, replace the reflection expectation:
```ts
  it("reflection appends (insights accumulate)", () => {
    expect(writePolicyFor("reflection")).toEqual({ mode: "append" })
  })
  it("procedural still throws", () => {
    expect(() => writePolicyFor("procedural")).toThrow(/not yet wired/)
  })
```
In `packages/core/test/memory-capability-episodic.test.ts` add (mirroring its existing procedural case, which must be updated to keep testing procedural only):
```ts
  it("accepts a reflection route and appends without reconciling", async () => {
    // Build the capability with defined.kind = "reflection" exactly like the
    // episodic case does, run remember twice with identical data, and assert:
    // two puts, zero supersede/update calls, status active in auto mode.
  })
```
Write it fully against the file's existing fake-store/log helpers (copy the episodic test's shape; only `kind` changes).

- [ ] **Step 2: Verify failure** — memory test fails (`{mode:"append"}` vs throw); core test fails ("not yet wired" returned as a tool error).

- [ ] **Step 3: Implement**

`packages/memory/src/reconcile.ts` — `writePolicyFor`: add `case "reflection": return { mode: "append" }` above the default; update the docblock (reflection = derived insights, accumulate; only `procedural` remains unwired) and keep the core-mirror back-pointer.
`packages/core/src/capabilities/built-in/memory.ts` — the mirrored guard: `append` becomes `kind === "episodic" || kind === "reflection"`; the not-yet-wired guard narrows to `procedural`. Keep both keep-in-sync comments accurate.

- [ ] **Step 4: Green + commit**

```bash
pnpm --filter @dawn-ai/memory test && pnpm --filter @dawn-ai/core test
pnpm turbo run typecheck --filter=@dawn-ai/memory --filter=@dawn-ai/core
git rev-parse --abbrev-ref HEAD
git add packages/memory packages/core
git commit -m "feat(memory): reflection kind appends; only procedural remains unwired"
```

---

### Task D4: config + `resolveDistillConfig`

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/cli/src/lib/runtime/resolve-memory.ts`
- Test: `packages/cli/test/resolve-memory.test.ts` (extend)

- [ ] **Step 1: Failing tests** (extend the file's existing temp-app fixture pattern — read how `resolveEpisodesConfig` is tested and mirror exactly):

```ts
  it("resolveDistillConfig returns documented defaults with no config", async () => {
    const appRoot = await makeAppWithConfig("export default {}")   // use the file's real helper
    expect(await resolveDistillConfig(appRoot)).toEqual({
      model: "gpt-5-mini",
      provider: "openai",
      maxBatches: 5,
      consolidate: { olderThanMs: 7 * 86_400_000, minBatchSize: 5, maxBatchSize: 50 },
      reflect: { minNewRecords: 10, maxRecords: 100, writes: "candidate" },
    })
  })
  it("resolveDistillConfig honors overrides", async () => {
    const appRoot = await makeAppWithConfig(
      `export default { memory: { distill: { model: "gpt-5", maxBatches: 2, consolidate: { minBatchSize: 3 }, reflect: { writes: "auto" } } } }`,
    )
    const c = await resolveDistillConfig(appRoot)
    expect(c.model).toBe("gpt-5")
    expect(c.maxBatches).toBe(2)
    expect(c.consolidate.minBatchSize).toBe(3)
    expect(c.consolidate.maxBatchSize).toBe(50)   // untouched default survives
    expect(c.reflect.writes).toBe("auto")
  })
```

- [ ] **Step 2: Verify failure** — not exported.

- [ ] **Step 3: Implement**

`packages/core/src/types.ts` — `DawnConfig.memory` gains the `distill` block exactly as the spec defines it (all fields optional, documented defaults in the doc comment; `provider` typed as the existing provider-id union used elsewhere in the file — read it).
`packages/cli/src/lib/runtime/resolve-memory.ts` — `resolveDistillConfig(appRoot)` mirroring `resolveEpisodesConfig`: `loadDawnConfig` in try/catch (defaults on failure), deep-merge per field, exported `ResolvedDistillConfig` type. `provider` default: read the config's own model/provider resolution if one exists for routes; else `"openai"` (report what you found).

- [ ] **Step 4: Green + commit**

```bash
pnpm --filter @dawn-ai/cli test resolve-memory && pnpm turbo run typecheck --filter=@dawn-ai/cli --filter=@dawn-ai/core
git rev-parse --abbrev-ref HEAD
git add packages/core packages/cli
git commit -m "feat(core): memory.distill config + resolveDistillConfig"
```

---

### Task D5: the engine (injected model seam)

**Files:**
- Create: `packages/cli/src/lib/memory/distill.ts`, `packages/cli/test/distill-engine.test.ts`

- [ ] **Step 1: Failing tests** — the engine's contract, with a stub model. Write these FULLY; they are the robustness core of this cycle:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MemoryRecord, sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runConsolidation, runReflection } from "../src/lib/memory/distill.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-distill-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function ep(id: string, day: number): MemoryRecord {
  const at = `2026-07-0${day}T09:00:00.000Z`
  return {
    id, kind: "episodic", namespace: "route=/a", content: `run ${id}`, data: {},
    source: { type: "run", id }, confidence: 1, tags: [], status: "active",
    createdAt: at, updatedAt: at, effectiveAt: at,
  }
}
const CONFIG = {
  model: "stub", provider: "openai", maxBatches: 5,
  consolidate: { olderThanMs: 0, minBatchSize: 2, maxBatchSize: 50 },
  reflect: { minNewRecords: 2, maxRecords: 100, writes: "candidate" as const },
}
const NOW = "2026-07-20T00:00:00.000Z"
const io = { stdout: () => {}, stderr: () => {} }

describe("runConsolidation", () => {
  it("dry-run makes ZERO model calls and writes nothing", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn()
    const res = await runConsolidation({ store, config: CONFIG, now: NOW, io, dryRun: true, createModel: async () => ({ invoke }) })
    expect(invoke).not.toHaveBeenCalled()
    expect(res.written).toBe(0)
    expect((await store.browse({ kind: "episodic" })).total).toBe(2)
    expect(res.batches).toBe(1)
  })
  it("exits cleanly when nothing qualifies", async () => {
    const store = makeStore()
    await store.put(ep("only", 7))    // below minBatchSize
    const invoke = vi.fn()
    const res = await runConsolidation({ store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(invoke).not.toHaveBeenCalled()
    expect(res).toMatchObject({ batches: 0, written: 0, failed: 0 })
  })
  it("writes the summary and supersedes EXACTLY the batch's sources", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    await store.put({ ...ep("other", 9), namespace: "route=/b" })   // different namespace, untouched
    const invoke = vi.fn(async () => ({ content: '{"summary":"two runs"}' }))
    const res = await runConsolidation({ store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await store.get("e1"))?.status).toBe("superseded")
    expect((await store.get("e2"))?.status).toBe("superseded")
    expect((await store.get("other"))?.status).toBe("active")
    const summaries = (await store.browse({ status: "active", kind: "episodic" })).records.filter((r) => r.tags.includes("consolidated"))
    expect(summaries.length).toBe(1)
    expect(summaries[0]?.data.derivedFrom).toEqual(["e1", "e2"])
  })
  it("write-then-link: a supersede failure leaves the summary written and sources ACTIVE, and reports failure", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const broken = { ...store, supersede: async () => { throw new Error("supersede boom") } }
    const invoke = vi.fn(async () => ({ content: '{"summary":"s"}' }))
    const res = await runConsolidation({ store: broken as typeof store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(res.failed).toBe(1)
    expect((await store.get("e1"))?.status).toBe("active")
    const summaries = (await store.browse({ kind: "episodic" })).records.filter((r) => r.tags.includes("consolidated"))
    expect(summaries.length).toBe(1)   // the write survived; only linking failed
  })
  it("isolates a failing batch and still processes the next", async () => {
    const store = makeStore()
    for (const r of [ep("a1", 7), ep("a2", 8)]) await store.put(r)
    for (const r of [{ ...ep("b1", 7), namespace: "route=/b" }, { ...ep("b2", 8), namespace: "route=/b" }]) await store.put(r)
    let call = 0
    const invoke = vi.fn(async () => {
      call += 1
      if (call === 1) throw new Error("model boom")
      return { content: '{"summary":"ok"}' }
    })
    const res = await runConsolidation({ store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(res).toMatchObject({ batches: 2, written: 1, failed: 1 })
  })
  it("honors maxBatches", async () => {
    const store = makeStore()
    for (const ns of ["route=/a", "route=/b", "route=/c"]) {
      for (const d of [7, 8]) await store.put({ ...ep(`${ns}-${d}`, d), namespace: ns })
    }
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({ store, config: { ...CONFIG, maxBatches: 2 }, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(res.written).toBe(2)
  })
  it("is idempotent — a second identical run writes no duplicate summary", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"summary":"same"}' }))
    const args = { store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) }
    await runConsolidation(args)
    const second = await runConsolidation(args)   // sources now superseded → nothing qualifies
    expect(second.batches).toBe(0)
    const summaries = (await store.browse({ kind: "episodic" })).records.filter((r) => r.tags.includes("consolidated"))
    expect(summaries.length).toBe(1)
  })
})

describe("runReflection", () => {
  it("writes candidate insights carrying the watermark and skips below threshold on re-run", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"insights":[{"insight":"fridays are risky","confidence":0.6,"tags":["ops"]}]}' }))
    const first = await runReflection({ store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(first.written).toBe(1)
    const insights = (await store.browse({ kind: "reflection" })).records
    expect(insights[0]?.status).toBe("candidate")
    expect(insights[0]?.data.coveredUntil).toBe("2026-07-08T09:00:00.000Z")
    const second = await runReflection({ store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(second.written).toBe(0)   // watermark consumed the input
  })
  it("writes active insights when configured", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"insights":[{"insight":"x","confidence":0.5,"tags":[]}]}' }))
    await runReflection({ store, config: { ...CONFIG, reflect: { ...CONFIG.reflect, writes: "auto" } }, now: NOW, io, createModel: async () => ({ invoke }) })
    expect((await store.browse({ kind: "reflection" })).records[0]?.status).toBe("active")
  })
  it("an empty insight list is a clean no-write", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"insights":[]}' }))
    const res = await runReflection({ store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) })
    expect(res).toMatchObject({ written: 0, failed: 0 })
  })
})
```

- [ ] **Step 2: Verify failure** — module not found.

- [ ] **Step 3: Implement `packages/cli/src/lib/memory/distill.ts`**

Requirements (write it cleanly; the tests above are the contract):
- Types: `DistillIo` = the repo's `CommandIo`; `ModelLike = { invoke(prompt: string): Promise<{ content: unknown }> }`; `DistillResult = { batches: number; written: number; failed: number }`.
- `runConsolidation(args)`: gather actives via `store.browse({ kind: "episodic", status: "active", limit: 10_000 })`, filter out records whose `data.derivedFrom` exists (never re-consolidate a summary) and whose event time is newer than `now - olderThanMs`, then `selectConsolidationBatches`. Dry-run → print one line per batch (`namespace  period  N records`) + totals, return early with `written: 0`. Otherwise construct the model ONCE (`await args.createModel()`), loop batches up to `maxBatches`: prompt → `invoke` → `parseConsolidationOutput(String(res.content))` → `buildSummaryRecord` → `store.put` → then `store.supersede(sourceId, summary.id)` for each source. Any throw inside a batch increments `failed`, logs to `io.stderr`, and continues.
- `runReflection(args)`: for EACH namespace present (derive from `store.stats()`'s `byNamespace`, optionally narrowed by `namespacePrefix`): read the newest existing reflection (`browse({ kind: "reflection", namespacePrefix: ns, limit: 1 })` — note browse orders by `updated_at DESC`, which is correct for "most recent pass") to get `data.coveredUntil`; gather that namespace's active episodic + active semantic records; `selectReflectionInput`; null → skip; else prompt → invoke → `parseReflectionOutput` → `buildReflectionRecords(..., { status: writes === "auto" ? "active" : "candidate" })` → `put` each. Same per-namespace failure isolation + `maxBatches` cap (a namespace is a batch here).
- Both functions accept `{ store, config, now, io, dryRun?, namespacePrefix?, createModel }` and NEVER construct a model when there is nothing to do (assert-by-test above).

- [ ] **Step 4: Green + commit**

```bash
pnpm --filter @dawn-ai/cli test distill-engine
pnpm --filter @dawn-ai/cli test        # full suite, no regressions
pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
git rev-parse --abbrev-ref HEAD
git add packages/cli
git commit -m "feat(cli): distillation engine — batch model pass with write-then-link ordering"
```

---

### Task D6: CLI subcommands + aimock integration

**Files:**
- Modify: `packages/cli/src/commands/memory.ts`
- Test: `packages/cli/test/memory-command.test.ts` (extend), `packages/cli/test/distill-aimock.test.ts` (create)

- [ ] **Step 1: Failing CLI tests** (reuse the file's app/store seeding + `io` capture):

```ts
  test("consolidate is a no-op with nothing to do", async () => {
    // seed one episodic row; runMemoryCommand(["consolidate"], {cwd: appRoot}, io)
    // assert stdout matches /nothing to consolidate/ and no reflection/summary rows exist
  })
  test("consolidate --dry-run prints batches without writing", async () => {
    // seed 5 episodic rows in one namespace-week; run ["consolidate", "--dry-run"]
    // assert stdout mentions the namespace and "5", and store has no consolidated tag
  })
  test("reflect is a no-op below the threshold", async () => {
    // seed 1 episodic row; run ["reflect"]; assert /nothing to reflect/
  })
```
Write them fully against the file's real helpers.

- [ ] **Step 2: Implement the subcommands** — `consolidate` and `reflect` in `runMemoryCommand`'s dispatch. Parse `--dry-run`, `--namespace <prefix>`, `--model <id>`, `--max-batches <n>` from the argv array with the same local parse-loop style `prune` uses (read it). Build config via `resolveDistillConfig(appRoot)` overridden by flags; `createModel` wires `createChatModel({ model, provider })` lazily (import from `@dawn-ai/langchain`) and wraps it so `invoke(prompt)` returns `{ content }` — read `createChatModel`'s return shape and adapt (it returns the LangChain chat model; call `.invoke(prompt)` and pass through `.content`). Print totals; exit non-zero (`CliError`) when `failed > 0`. Update USAGE.

- [ ] **Step 3: aimock integration test** — `packages/cli/test/distill-aimock.test.ts`: drive `runConsolidation` and `runReflection` through the REAL `createChatModel` path against aimock (mirror how existing aimock-based cli tests set `OPENAI_BASE_URL`/fixtures — read `packages/cli/test/episodic-recorder.test.ts` and the testing harness for the fixture mechanism). Two cases: a consolidation fixture returns a summary → summary row written + sources superseded; a reflection fixture returns one insight → candidate row written. This proves prompt→response→record end to end without a live key.

- [ ] **Step 4: Green + commit**

```bash
pnpm --filter @dawn-ai/cli test memory-command distill-aimock
pnpm --filter @dawn-ai/cli test
pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
git rev-parse --abbrev-ref HEAD
git add packages/cli
git commit -m "feat(cli): dawn memory consolidate|reflect subcommands"
```

---

### Task D7: conformance addition (GATED RUN MANDATORY)

**Files:**
- Modify: `packages/testing/src/memory-conformance.ts`

- [ ] **Step 1: Add the contract test** — consolidation depends on `supersede` working for episodic records across both backends:

```ts
    test("supersede links and demotes an episodic record (consolidation's dependency)", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "src1", namespace: "ns", content: "run one" }))
        await s.put(ep({ id: "src2", namespace: "ns", content: "run two" }))
        await s.put(ep({ id: "sum", namespace: "ns", content: "summary", tags: ["consolidated"] }))
        await s.supersede("src1", "sum")
        await s.supersede("src2", "sum")
        expect((await s.get("src1"))?.status).toBe("superseded")
        expect((await s.get("src2"))?.status).toBe("superseded")
        expect((await s.get("sum"))?.supersedes).toEqual(expect.arrayContaining(["src1", "src2"]))
        // active-only browse no longer surfaces the sources
        expect((await s.browse({ status: "active", kind: "episodic" })).records.map((r) => r.id)).toEqual(["sum"])
      } finally {
        await close?.(s)
      }
    })
```
(Use the kit's real `ep()`/`rec()` helper names — read the file.)

- [ ] **Step 2: sqlite run** — `pnpm --filter @dawn-ai/memory build && pnpm --filter @dawn-ai/testing test` → green.

- [ ] **Step 3: MANDATORY gated run** (real Docker; start it if down):

```bash
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
```
Report exact counts (was 48 passed/1 skipped; expect +1).

- [ ] **Step 4: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/testing
git commit -m "test(conformance): supersede on episodic records (consolidation's contract)"
```

---

### Task D8: docs, changeset, live smoke file, full validate

**Files:**
- Modify: `apps/web/content/docs/memory.mdx`, `apps/web/content/docs/upgrading.mdx`, `apps/web/content/docs/cli.mdx`, `docs/dev/memory-system.md`, `examples/memory/README.md`
- Create: `.changeset/memory-distillation.md`, `packages/testing/test/distill-live.smoke.test.ts`

- [ ] **Step 1: Docs**
  - `memory.mdx` — new "## Distillation" section after Episodic: what the two commands do; consolidation (aging episodes → one summary per namespace-week; sources superseded and reaped by TTL; recall stops surfacing them immediately, Inspector keeps receipts); reflection (insights, **candidates by default**, approve in the Inspector or `dawn memory approve`); the `memory.distill` config block with every default; **cost note** ("these commands spend model tokens; `--dry-run` shows what would run for free"); the cron recipe:
    ```bash
    0 3 * * * cd /srv/app && npx dawn memory consolidate && npx dawn memory reflect
    ```
    and provenance (`data.derivedFrom` + `supersedes` links; the memory graph stays deferred).
  - `upgrading.mdx` — `kind: "reflection"` is now accepted by `remember` and by distillation (previously threw "not yet wired"); `procedural` still throws.
  - `cli.mdx` — add `consolidate [...]` and `reflect [...]` to the `dawn memory` subcommand list + bullets (the docs checker enforces the code block; hand-parsed flags aren't checked but document them).
  - `docs/dev/memory-system.md` — architecture note (pure distill module + cli engine + write-then-link ordering); deferred list shrinks to procedural, graph, BM25, sqlite-vec, higher-order consolidation.
  - `examples/memory/README.md` — a "Distillation" paragraph showing both commands.
  - Run `node scripts/check-docs.mjs` — green REQUIRED.

- [ ] **Step 2: Live smoke file** (write it; the controller runs it) — `packages/testing/test/distill-live.smoke.test.ts`, mirroring `episodic-live.smoke.test.ts`'s header/gating/fixtures. Two tests, both `it.skipIf(!live)`, timeout 240_000:
  1. **consolidate → recall**: seed 5 episodic records (direct `store.put`, backdated 10 days) in the probe app's namespace; call `runConsolidation` with the real `createChatModel`; assert one `consolidated`-tagged record exists and all 5 sources are `superseded`; then run the harness live asking "What did you work on last week?" and assert `expectToolCalled(r, "recall")` and the final message references content from the summary.
  2. **reflect → approve → recall**: seed 10 records; `runReflection`; assert ≥1 candidate reflection; approve it via `runMemoryCommand(["approve", id])`; run live asking about the insight topic and assert recall returns it.

- [ ] **Step 3: Changeset** — `.changeset/memory-distillation.md`:
```md
---
"@dawn-ai/memory": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Memory distillation: `dawn memory consolidate` compacts aging episodes into
per-namespace-week summaries (sources are superseded and linked via
`data.derivedFrom`, then reaped by the existing TTL/cap prune), and `dawn memory
reflect` derives durable insights from recent memories as **candidate**
`reflection` records for review. Both are threshold-aware no-ops safe to run from
cron, support `--dry-run` (zero model calls), and are configured under
`memory.distill`. The `reflection` kind is now accepted by `remember` (append-only);
`procedural` remains unwired.
```

- [ ] **Step 4: Full validate + MANDATORY lanes**

```bash
pnpm build && pnpm turbo run typecheck && pnpm test 2>&1 | tail -8
pnpm lint && pnpm pack:check 2>&1 | tail -3
node scripts/check-docs.mjs && node scripts/check-changesets.mjs
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
pnpm verify:harness:framework
pnpm verify:harness:runtime
pnpm verify:harness:smoke
```
All green; report counts and durations for each.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add apps docs examples packages/testing .changeset
git commit -m "docs(memory): distillation docs + cron recipe; live smoke; changeset (patch, additive)"
```

---

## Post-plan notes for the controller

- No new package → no OIDC bootstrap. Patch changeset; the next Version PR also carries #384's Node-24 `feat!` from another session — **verify the resolved version before admin-merging** (GOTCHA 6: a `major`-flavored changeset in the fixed 0.x group would jump to 1.0.0).
- Reviewers must check gated-run evidence in implementer reports; a DONE without the mandatory pgvector counts gets bounced.
- The write-then-link ordering test (D5) and the dry-run-zero-model-calls test are the two that most directly encode this cycle's risk — spec reviewers should verify they exist exactly as written.
- Live smoke (D8) is controller-run with the local key after D8's validate passes.
