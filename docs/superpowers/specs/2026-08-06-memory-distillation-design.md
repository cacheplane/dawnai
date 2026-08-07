# Memory Distillation: Consolidation + Reflection (Phase 4 — memory follow-up)

Date: 2026-08-06
Status: approved design, pending implementation plan
Branch: `feat/memory-distill` (created off origin/main @ 0.8.15+)
Prior art: long-term memory (#250), hybrid recall (#313), pgvector (#318),
Inspector (#377), episodic memory (#386)

## Goal

Ship **memory distillation** — a shared batch engine that reads accumulated
memories, runs one LLM pass, and writes *derived* records with provenance — and
its two policies:

- **Consolidation**: compress aging episodes into summary records before TTL
  deletes them outright, superseding the sources (the deferred "summarize then
  delete", made reversible).
- **Reflection**: derive higher-level insights from recent memories, wiring the
  `reflection` kind that `writePolicyFor` currently refuses.

Success = a developer runs `dawn memory consolidate` after a week of agent
traffic and sees one summary per namespace-week replacing 50 raw episodes (still
inspectable until TTL); runs `dawn memory reflect` and reviews candidate
insights in the Inspector before they become recallable.

## Background — what exists today

- **Episodes accumulate and then vanish.** The recorder writes one episode per
  run; `prune` deletes them at TTL (30d) or over the per-namespace cap (500).
  Nothing summarizes them first — a month of history is simply lost.
- **`reflection` is typed but refused.** `writePolicyFor` (packages/memory/src/
  reconcile.ts) throws "not yet wired" for `procedural`/`reflection`; core's
  `remember` has the mirrored guard.
- **No background scheduler exists** anywhere in Dawn — and none is wanted
  (serverless targets, cost visibility).
- **No model is invoked outside route execution today.** `createChatModel`
  (packages/langchain) is the constructor, and it accepts an `importer` seam,
  so a batch pass can build a model without network in tests.
- **Provenance primitives already exist**: `supersede(old, new)` links + flips
  status; `data` is an arbitrary JSON bag. The memory *graph* stays deferred.
- **The Inspector already renders everything this feature produces**: candidate
  queue + approve flow, kind filters, timeline, detail sheet with `supersedes`
  links. Zero UI work is required this cycle.

## Decisions (locked in brainstorming)

- **Both policies, one shared engine, one cycle.** The engine (select → batch →
  LLM → validate → write + link) is ~80% of the work; two thin policies amortize
  it and prevent building it twice.
- **Trigger = CLI command + documented cron recipe.** `dawn memory consolidate`
  and `dawn memory reflect` are the only entrypoints. Both are **threshold-aware
  no-ops** — cron/CI can call them blindly and pay nothing when nothing
  qualifies. Rejected: opt-in post-run trigger (injects model spend + latency
  into user runs, hits the known serverless fire-and-forget durability gap) and
  a dev-server interval loop (silent spend, dead in serverless, untestable).
- **Consolidation supersedes sources, prune reaps them later.** Sources flip to
  `superseded` and are linked from the summary; recall (active-only) stops
  surfacing them immediately, the Inspector keeps the receipts until TTL. No new
  deletion machinery. Rejected: immediate delete (destroys the audit trail; a bad
  summary silently loses history) and keep-active (double-counts events in
  recall; not compaction at all).
- **Engine hosted in `@dawn-ai/cli`; pure parts in `@dawn-ai/memory`.** Mirrors
  the episode-recorder precedent: cli owns orchestration (it already depends on
  `@dawn-ai/langchain`), memory owns the clock-free pure logic (selection,
  batching, watermark, prompt construction, output validation). Rejected: a new
  `@dawn-ai/memory-distill` package (release ceremony for ~2 files) and a core
  capability (capabilities are route-scoped and run inside turns; distillation is
  cross-namespace batch work triggered from outside runs).
- **Reflections are candidates by default; summaries are active.** Reflections
  are LLM-authored *beliefs* — exactly what Dawn's reviewable-memory ethos gates.
  Consolidation summaries are mechanical compaction of events that already
  happened, so they write `active`.
- **No store interface changes.** Everything uses the existing surface
  (`browse`, `search`, `put`, `update`, `supersede`, `prune`). The conformance
  kit is untouched.

## Non-goals (deferred, noted)

The memory graph (provenance is `supersedes` + a `data.derivedFrom` array, not
edge tables); `procedural` kind; background/automatic scheduling of any kind;
distillation across namespaces (each namespace distills independently);
re-consolidating summaries into higher-order summaries (single level this
cycle); Inspector UI work (everything renders on existing surfaces); embedding
derived records beyond the capability's existing embed path.

## Architecture

### 1. Pure layer — `@dawn-ai/memory` (`distill.ts`, new)

All clock-free, no I/O, unit-tested like `reconcile.ts`:

- `selectConsolidationBatches(records, opts) → ConsolidationBatch[]`
  Groups **active episodic** records older than `olderThan` (ISO) by
  `(namespace, ISO-week of effectiveAt ?? createdAt)`, drops groups smaller than
  `minBatchSize` (default 5 — summarizing 2 episodes is noise), splits groups
  above `maxBatchSize` (default 50) into chunks, orders records within a batch by
  event time ascending. Returns `{ namespace, period: {since, until}, records }`.
- `selectReflectionInput(records, opts) → ReflectionInput | null`
  Filters to records with event time `> coveredUntil` (the watermark), requires
  at least `minNewRecords` (default 10), caps at `maxRecords` (default 100,
  newest-first then re-sorted ascending). Returns `null` when the threshold
  isn't met — this is what makes the command a cheap no-op.
- `buildConsolidationPrompt(batch) → string` and
  `buildReflectionPrompt(input) → string` — deterministic prompt text from
  records (id, event time, content, key data fields); snapshot-tested.
- `parseConsolidationOutput(raw) → { summary: string }` and
  `parseReflectionOutput(raw) → { insights: {insight, confidence, tags}[] }` —
  zod-validated, tolerant of fenced JSON, throwing typed errors on garbage.
- `buildSummaryRecord(batch, summary, now) → MemoryRecord` and
  `buildReflectionRecords(input, insights, now) → MemoryRecord[]` — the record
  shapes below, with deterministic ids
  (`memory_sum_<sha1(namespace|since|until)[:16]>`,
  `memory_rfl_<sha1(namespace|coveredUntil|insight)[:16]>`) so a retried pass is
  idempotent.

### 2. Record shapes

**Summary** (consolidation): `kind: "episodic"`, `status: "active"`,
`tags: ["consolidated"]`, `content` = the digest text, `data = { period: {since,
until}, sourceCount, derivedFrom: string[] }`, `source: { type: "tool", id:
"consolidate" }` (the `MemorySource` union has no "system" member; `tool` is the
honest closest, and provenance stays queryable via `data.derivedFrom` and the
`consolidated` tag), `effectiveAt` = period start, `expiresAt` = **unset** by
default (summaries outlive raw episodes; `consolidate.ttlMs` may set one).

**Reflection**: `kind: "reflection"`, `status` = `"candidate"` (default) or
`"active"`, `content` = the insight text, `data = { insight, confidence,
coveredUntil, derivedFrom: string[] }`, `source: { type: "tool", id: "reflect" }`,
`effectiveAt` = pass time, no expiry. `data.coveredUntil` is the **watermark**
the next pass reads.

### 3. Engine — `@dawn-ai/cli` (`src/lib/memory/distill.ts`, new)

One orchestrator with a policy parameter:

1. Resolve the store (`resolveMemoryStore`) and config (`memory.distill`).
2. **Gather** candidates via `store.browse` (kind + status filters, paged) —
   consolidation reads active episodic; reflection reads active episodic +
   active semantic, plus the newest existing reflection per namespace to read
   its watermark.
3. **Select** via the pure functions. If nothing qualifies → print
   `nothing to <verb>` and exit 0 (the cheap no-op).
4. `--dry-run` → print the batch table (namespace, period, record count,
   estimated prompt chars) and exit **without any model call**.
5. **Model pass** per batch, capped by `maxBatches` (default 5 per invocation):
   `createChatModel({ model, provider })` once, reused across batches; prompt
   from the pure builder; response parsed by the pure validator.
6. **Write, then link** (ordering matters): `put` the derived record(s) first;
   only on success do consolidation's sources get `supersede(sourceId,
   summaryId)`. A failed batch is reported and skipped — never partially linked.
7. Print a summary line per batch and totals.

The model client is injected (`createModel?: () => Promise<Model>`) so tests
drive it with aimock or a stub; the CLI wires the real one.

### 4. Policy wiring: `reflection` becomes append

`writePolicyFor("reflection")` returns `{ mode: "append" }` (insights
accumulate; a later insight never contradicts an earlier one — supersession of
stale insights is a future concern, noted). `procedural` keeps throwing. Core's
mirrored guard in `remember` updates in lockstep, so a route may now declare
`defineMemory({ kind: "reflection" })` and have the model author insights
directly — same append semantics, honoring `writes` modes.

### 5. Config — `DawnConfig.memory.distill`

```ts
distill?: {
  readonly model?: string          // default "gpt-5-mini"
  readonly provider?: string       // default: the app's configured provider
  readonly maxBatches?: number     // default 5 per invocation
  readonly consolidate?: {
    readonly olderThanMs?: number  // default 7d
    readonly minBatchSize?: number // default 5
    readonly maxBatchSize?: number // default 50
    readonly ttlMs?: number        // default: unset (summaries don't expire)
  }
  readonly reflect?: {
    readonly minNewRecords?: number // default 10
    readonly maxRecords?: number    // default 100
    readonly writes?: "candidate" | "auto"  // default "candidate"
  }
}
```

### 6. CLI surface

`dawn memory consolidate [--dry-run] [--namespace <prefix>] [--model <id>] [--max-batches <n>]`
`dawn memory reflect [same flags]`

Both print a per-batch line and a totals line; both exit 0 on "nothing to do".
Docs ship a cron recipe (`0 3 * * * cd /app && npx dawn memory consolidate && npx dawn memory reflect`)
and state plainly that these commands spend model tokens.

## Error handling

- No qualifying input → exit 0 with `nothing to consolidate|reflect` (never an
  error; cron-friendly).
- Model construction failure (missing provider package/key) → `CliError` with
  the existing actionable provider message; nothing written.
- A batch's model call or output validation fails → log the batch, continue to
  the next, exit non-zero at the end with a count of failed batches (partial
  progress is kept — successful batches are already written and linked).
- `supersede` failure after a successful summary write → report loudly; the
  summary exists and sources remain active (safe, idempotent: a re-run finds the
  same batch, writes the same deterministic id — an upsert — and retries the
  links).
- Reflection with no watermark (first ever pass) → treat `coveredUntil` as the
  epoch; the `maxRecords` cap bounds the first pass.

## Testing strategy

1. **Pure units (`@dawn-ai/memory`)**: batching by namespace+week, min/max batch
   sizes, ordering, watermark filtering, threshold returns `null`, deterministic
   ids stable across calls, prompt snapshots, output parsing (clean JSON, fenced
   JSON, garbage → typed error, empty insight list).
2. **Engine tests (`@dawn-ai/cli`, injected model stub)**: dry-run makes zero
   model calls; nothing-qualifies exits 0 silently; happy path writes summary +
   supersedes exactly the batch's sources; write-then-link ordering (stub that
   fails supersede → summary exists, sources still active, non-zero exit); a
   failing batch skips and the next still writes; `maxBatches` cap honored;
   idempotent re-run produces no duplicate records.
3. **aimock integration**: the real `createChatModel` path against aimock
   fixtures for both policies, proving prompt→response→record end to end.
4. **Conformance**: untouched (no store interface change) — but add a
   `runMemoryStoreConformance` case asserting `supersede` on an episodic record
   behaves (links + status) since consolidation now depends on it for that kind.
5. **CLI tests**: both subcommands' flag parsing, no-op exit codes, output text.
6. **Doubly-gated live smoke**: record real episodes → `consolidate` → the
   summary's content mentions a distinctive token from the sources and sources
   are superseded → `reflect` → a candidate reflection appears → approve it →
   `recall` surfaces the insight.
7. **examples/memory dogfood**: document the two commands in its README; no
   config change (distillation is explicitly invoked).

## Distribution & release

- No new package. Changed: `@dawn-ai/memory` (pure distill module + reflection
  policy), `@dawn-ai/core` (config type + mirrored kind guard), `@dawn-ai/cli`
  (engine + two subcommands), `@dawn-ai/testing` (conformance addition).
- Changeset: **patch** (fixed 0.x group, GOTCHA 6). Not breaking — additive
  config, additive commands, `reflection` moving from throw to append only
  widens what's accepted.
- Docs: `memory.mdx` distillation section (both commands, cron recipe, cost
  note, provenance, governance defaults); `upgrading.mdx` note that
  `kind: "reflection"` is now accepted by `remember`; dev doc architecture note.

## Open questions (validate during build, not blockers)

- Whether consolidation should also fold *existing summaries* older than N weeks
  into higher-order summaries (deferred this cycle; single level).
- Whether reflection should read consolidated summaries as input (leaning yes —
  they're active episodic records, so they arrive naturally; confirm the prompt
  doesn't double-count when both a summary and its not-yet-reaped sources are
  active... it can't: sources are superseded at consolidation time).
- Default `gpt-5-mini` vs the app's own configured model as the distill default
  (leaning explicit default for cost predictability).

## Amendments (shipped)

The design above is the pre-build document. Where the shipped implementation
diverges, the shipped behavior wins — recorded here so the spec is not read as a
description of what the code does.

- **A summary's `effectiveAt` is the period's END, not its start.** `effectiveAt`
  is not a second copy of `data.period.since`: it drives retention ranking, and
  `prune`'s per-namespace episodic cap is status-agnostic. Stamped with the
  window's start, a summary sorts as the OLDEST row of its own batch and the cap
  evicts it *before* the superseded sources it replaced. A summary stands for the
  whole window, so it ranks at the window's end.
- **The summary id folds in the source-id list**, not just `(namespace, period)`.
  When every record in a namespace-week shares an exactly equal event time (bulk
  import, backfill) and `maxBatchSize` splits them, each chunk derives the same
  `since`/`until` — two distinct batches, one id, and the second summary silently
  overwrites the first.
- **`--dry-run` prints namespaces, windows, and record counts** — no character or
  token estimate. A character count would read as a cost prediction the command
  cannot honestly make.
- **No `zod`.** `@dawn-ai/memory` stays zero-extra-dependency; model output is
  validated by hand-written narrowing in `distill.ts`.
- **`--provider` flag and `providerAuthored` provenance.** The distill config
  carries an explicit provider, and `--model` re-infers the provider *unless* one
  was authored — so overriding the model on the CLI cannot silently pin a
  mismatched provider.
- **`consolidate.sourceTtlMs`** (default 7 days) is stamped on each source once
  ITS supersede succeeded. A superseded source is invisible to recall but still
  occupies a slot in the status-agnostic per-namespace cap; without an expiry the
  compacted rows would keep evicting live ones forever.
- **A zero-insight reflection pass still writes a watermark.** It persists one
  sentinel record (`kind: "reflection"`, `status: "superseded"`, content
  `(no insights from this pass)`, id `memory_rfl_pass_<hash>`) carrying
  `data.coveredUntil`. Without it, `readWatermark` finds nothing to advance past
  and cron re-pays for the same barren namespace on every run, forever. The
  `superseded` status keeps the sentinel out of recall while leaving it visible
  to `browse`.
- **Placeholder payloads are rejected as parse failures.** Both prompts end with
  their own schema example (`{"summary": "..."}`); a model that echoes it returns
  a structurally valid, semantically empty payload that would clear a non-empty
  check, get written, and then supersede the real episodes it claims to
  summarize. A summary or insight carrying no letter and no digit anywhere throws
  the "could not parse model output" error, so the batch fails loudly and its
  sources stay active.
- **Each source's link is isolated from its siblings.** A batch is the atom of
  idempotency (its summary id hashes its own source-id list), so a failure on
  source *k* must not abort *k+1..n* — the survivors would form a different chunk
  next run, yielding a different id and a second overlapping summary. The batch
  still counts as failed.
