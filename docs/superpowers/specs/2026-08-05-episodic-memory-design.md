# Episodic Memory Design (Phase 4 — memory follow-up)

Date: 2026-08-05
Status: approved design, pending implementation plan
Branch: `feat/episodic-memory` (created off origin/main @ 0.8.14)
Prior art: long-term memory (#250), hybrid recall (#313), pgvector backend (#318),
Memory Inspector (#377)

## Goal

Wire the **episodic kind end-to-end**: Dawn apps automatically remember *what
happened* — one episode per agent run, recorded from the trace the runtime
already holds — and agents can additionally author salient episodes themselves.
Episodes accumulate (append-only, never supersede), live in time (`effectiveAt`
is real, `expiresAt` drives retention), answer temporal questions ("what
happened in yesterday's runs?") through time-windowed recall, and render as a
timeline in the Inspector.

Success = a developer flips `memory.episodes.enabled`, runs their agent a few
times, asks "what did you do for me this week?", and the agent answers from
recorded episodes — while `dawn inspect` shows the same history as a
day-grouped timeline.

## Background — what exists today

- `MemoryKind` includes `"episodic"` at every layer (types, `defineMemory`,
  capability, stores) but **nothing writes or special-cases it**. The only
  kind-specific behavior anywhere is the semantic identity default
  (`["subject","predicate"]`).
- `effectiveAt`/`expiresAt` are **persisted but dormant**: columns exist in both
  backends (sqlite `effective_at`/`expires_at`, pgvector likewise), typed on
  `MemoryRecord`, written by nobody, read by no query.
- Reconciliation is supersede-shaped everywhere (capability auto path,
  `classifyWrite`, `approveWithReconcile`) — correct for beliefs, wrong for
  events: an episode is never "contradicted" by a later one.
- `MemoryQuery` has no time window; recency is decay-based ranking, not
  filtering. `BrowseQuery` likewise.
- No producer exists: `remember` writes whatever kind the route declares, and
  the runtime records nothing.
- The Inspector (just shipped, #377) gives episodes a free tier automatically:
  kind filter, browse, detail sheet, `stats.byKind`.

## Decisions (locked in brainstorming)

- **Episodic first** among the deferred items — it is the dependency root:
  reflection derives from episodes, consolidation consumes them, the graph is
  orthogonal and speculative. Procedural/reflection stay typed-but-deferred.
- **Both producers**: a deterministic **runtime auto-recorder** (one episode per
  run, from the trace, zero model cost) AND **agent-authored** episodes via
  `remember` on routes that declare `kind: "episodic"`. The auto-recorder ships
  first inside the cycle; agent-authored rides the same append policy.
- **Recall extends, no new tool**: the existing `recall` tool gains
  `since`/`until` (ISO or relative like `"-24h"`, `"-7d"`); `MemoryQuery` gains
  the window, honored by both backends. One tool, one mental model.
- **Retention = TTL + cap (belt and braces)**: auto-episodes expire via
  `expiresAt` (default 30 days) AND a per-namespace cap (default 500) bounds
  burst traffic. Agent-authored episodes get NO default expiry — the model
  recorded them as durable.
- **Inspector timeline view in-cycle**: a list/timeline toggle inside the
  existing Memory panel (day-grouped, outcome badges, durations) — not a
  separate panel.
- **Approach A — post-run hook + per-kind policy seam** (chosen over a
  middleware recorder and checkpoint-derived batch): `executeRoute` completion
  fires the recorder in-process (it holds input, tool calls, outcome, timing,
  and the memory context); per-kind write behavior becomes a pure
  `writePolicyFor(kind)` seam in `@dawn-ai/memory`. Live, no model cost,
  smallest new surface, and the seam is what procedural/reflection will need.
- **Governance**: auto-episodes **bypass** `writes` modes — they are
  observations, not beliefs; flooding the candidate queue with run logs would
  bury real candidates. `writes: "off"` still disables ALL memory writes,
  including the recorder. Agent-authored episodic `remember` honors the normal
  modes (candidate/auto/ask) but never supersedes; in `ask` mode there is no
  supersede branch to gate, so episodic asks never interrupt (documented).
- **Auto-episodes are NOT embedded by default** (`episodes.embed`, default
  `false`): embedding every run costs an API call per run; keyword + time-window
  recall is the 90% case. Agent-authored episodes follow the capability's
  normal embed path (they flow through `remember`).

## Non-goals (deferred, noted)

Procedural/reflection wiring; background consolidation ("summarize then
delete" — retention here is mechanical TTL/cap only); memory graph; BM25/FTS5;
sqlite-vec ANN; cross-run correlation or session stitching; a dedicated
timeline *panel* (this cycle adds a view toggle inside the Memory panel);
recording episodes for routes without `memory.ts` (no namespace to write into).

## Architecture

### 1. `@dawn-ai/memory` — the pure layer

**`writePolicyFor(kind)`** (new, `reconcile.ts`): returns the write discipline
for a kind:

```ts
export type WritePolicy =
  | { mode: "reconcile" }   // semantic: classifyWrite → add/update/supersede
  | { mode: "append" }      // episodic: always add; no identity, no supersession
export function writePolicyFor(kind: MemoryKind): WritePolicy
```

`"semantic"` → `reconcile`; `"episodic"` → `append`; `"procedural"` /
`"reflection"` → **throw** a clear "kind not yet wired" error (they are
deferred, and silently treating them as either policy would bake in accidental
semantics). `approveWithReconcile` consults the policy: approving an episodic
candidate is a plain activation (no identity scan).

**Time windows** (`types.ts`): `MemoryQuery` and `BrowseQuery` gain
`since?: string` / `until?: string` (ISO only — the store stays clock-free and
parse-free; relative forms are resolved by callers). The filter column is
`COALESCE(effective_at, created_at)` in both backends, so records that predate
this feature (no `effectiveAt`) still window correctly. Semantics: `since` is
inclusive, `until` exclusive.

**Expiry exclusion**: `search` and `browse` exclude rows with
`expires_at <= :now` when the caller supplies `now` (both queries already/now
accept it; the library never reads a clock). Callers that omit `now` see
everything — `dawn memory inspect` and debugging stay honest.

**`prune`** (new REQUIRED `MemoryStore` method — same pre-1.0 no-back-compat
stance as `browse`/`stats`, conformance-kit enforced):

```ts
prune(opts: {
  readonly now: string
  readonly namespacePrefix?: string
  readonly cap?: number          // per-namespace: keep newest `cap` episodic rows
}): Promise<{ readonly deletedExpired: number; readonly deletedOverCap: number }>
```

Deletes (a) rows of any kind with `expires_at <= now`, (b) when `cap` is set,
the oldest **episodic** rows beyond `cap` per namespace (ordered by
`COALESCE(effective_at, created_at)`, tiebreak `id COLLATE "C"` — the
established cross-backend ordering). Implemented in SQL in both backends;
byte-identical semantics via the conformance kit.

**Ordering**: query-less `search` with a time window, and the timeline surfaces,
order by `COALESCE(effective_at, created_at) DESC, id ASC` — event time, not
update time (id tiebreak uses the established cross-backend discipline:
BINARY on sqlite, `COLLATE "C"` on Postgres — same as browse/prune). Ranked
(query) search inside a window keeps relevance ranking.

**Indexes**: sqlite migration v3 adds
`idx_mem_ns_kind_effective (namespace, kind, effective_at DESC)`; pgvector adds
the equivalent `CREATE INDEX IF NOT EXISTS` (idempotent init, existing
pattern). Existing databases migrate transparently (additive index only — no
row rewrites).

### 2. Auto-recorder — CLI runtime

New `recordEpisode` in `packages/cli/src/lib/runtime/` fired from
`executeRoute`'s completion path (both success and failure) when:
`config.memory.episodes?.enabled === true` AND the route has a memory context
(namespace exists) AND `writes !== "off"`.

Config (`DawnConfig.memory.episodes`):

```ts
episodes?: {
  enabled?: boolean        // default false — opt-in
  ttlMs?: number           // default 30 days
  cap?: number             // default 500 per namespace
  includeFailedRuns?: boolean  // default true
  embed?: boolean          // default false
}
```

The episode record:

- `kind: "episodic"`, `status: "active"` (bypasses writes modes by design),
  `namespace` = the route's memory namespace (same derivation as remember).
- `content` = one summary line: `run ok: <first ~80 chars of user input> (3 tools, 4.2s)`.
- `data` = `{ input: string (truncated ~500 chars), outcome: "ok" | "error",
  toolsUsed: string[], durationMs: number, threadId?: string, runId?: string }`.
- `source` = `{ type: "run", id: <runId or thread id> }` — the dormant `"run"`
  source type finally used.
- `effectiveAt` = run start (ISO); `expiresAt` = start + ttl;
  `createdAt`/`updatedAt` = write time.
- `id` = `memory_ep_<sha1(namespace|runId|startedAt)[:16]>` — deterministic, so
  a retried write is idempotent.

After each write the recorder runs **lazy retention**:
`store.prune({ now, namespacePrefix: namespace, cap })`. Recorder failures are
logged and swallowed — an episode write must never fail a user's run.

### 3. Agent-authored episodes — capability

Routes declare `defineMemory({ kind: "episodic", schema, ... })`. The
capability's `remember` consults `writePolicyFor(kind)`:

- `append` → no identity scan, no supersede; `put` as `active` (auto/ask) or
  `candidate` (candidate mode). `ask` never gates (no supersede branch) —
  documented in the mode docs.
- `effectiveAt` = request time; **no default `expiresAt`**.
- Embedding follows the existing capability embed path.
- The route schema is the author's own episode shape (e.g.
  `{ event, detail, at? }`) — validated exactly like semantic data.

### 4. Recall — capability + tool schema

`recall` gains `since?: string` / `until?: string`, described in the tool
schema as ISO timestamps or relative offsets (`"-24h"`, `"-7d"`, `"-30m"`).
The capability parses relative forms against request time into ISO before
calling `search` (pure helper `resolveTimeExpr(expr, now)` in the capability,
unit-tested; the store never sees relative forms). `recall` always passes
`now`, so expired rows are excluded from agent recall automatically. A window
with no `query` returns timeline order; with a `query`, ranked recall within
the window.

### 5. Inspector — API + timeline view

- `/api/memory/list` passes through `since`/`until` (ISO; 400 on unparseable)
  and supplies `now` (expired rows hidden from the UI by default; a
  `includeExpired=1` param keeps the debugging path open).
- **Timeline toggle** in the Memory panel toolbar (`list | timeline`).
  Timeline mode: fetches with `kind=episodic` default (switchable), groups rows
  by day on `effectiveAt`, renders per-episode rows with an outcome badge
  (`ok`/`error` from `data.outcome`, neutral for agent-authored), duration when
  present, and the content line; row click opens the existing detail sheet.
  Component-tested like the list view; no new route, no new panel.
- `stats`/facets unchanged (byKind already serves the filter).

### 6. CLI

- `dawn memory prune [--cap N] [--namespace prefix]` — manual retention pass;
  prints `{deletedExpired, deletedOverCap}`. Uses the same store method.
- `dawn memory list/search/inspect` already handle episodes (kind-agnostic).

## Error handling

- Recorder: never throws into the run path; failures log once per process kind
  (no log spam on a broken store).
- `prune` with an unparseable `now`/window input: store throws (caller bug);
  CLI/API validate first (400 / CliError).
- `procedural`/`reflection` writes: `writePolicyFor` throws the "not yet wired"
  error → `remember` surfaces it as a tool error (visible, not silent).
- Relative time parse failure in recall: tool returns an actionable message
  listing accepted forms (not a thrown 500).

## Testing strategy

1. **Pure units** (`@dawn-ai/memory`): `writePolicyFor` (all four kinds),
   window-filter SQL via store tests, `prune` TTL/cap/tiebreak, COALESCE
   fallback for legacy rows, inclusive/exclusive bounds.
2. **Conformance kit** additions (sqlite always, pgvector gated): since/until
   filtering, expiry exclusion with `now`, `prune` semantics + ordering,
   append-policy approve (episodic candidate → plain activation).
3. **Recorder integration** (CLI, aimock harness): run a route with
   `episodes.enabled` → episode appears with correct shape/namespace/TTL;
   failure runs recorded with `outcome: "error"`; `enabled: false` (default)
   and `writes: "off"` record nothing; deterministic id = idempotent retry;
   cap enforcement after burst of runs.
4. **Agent-authored e2e** (aimock): episodic route's `remember` appends twice
   (no supersession between same-identity-looking episodes); candidate mode
   queues; recall with `since` returns only in-window episodes.
5. **Inspector**: component tests for the timeline toggle/grouping/badges;
   gated e2e extends the API tests with since/until + includeExpired.
6. **Live smoke** (doubly-gated, existing pattern): real model asked "what did
   you do in the last day?" after two recorded runs → answer cites episode
   content.
7. **examples/memory dogfood**: enable `episodes` in the example config so the
   standing example (and its Inspector script) exercises the recorder
   continuously.

## Distribution & release

- No new package. Changed: `@dawn-ai/memory` (policy seam, windows, prune,
  migration v3), `@dawn-ai/memory-pgvector` (windows, prune, index),
  `@dawn-ai/core` (episodes config type, capability changes, MemoryStoreLike
  prune/window parity), `@dawn-ai/cli` (recorder, prune command, recall
  threading), `@dawn-ai/inspector` (API params + timeline), `@dawn-ai/testing`
  (conformance additions).
- Changeset: **patch** (fixed 0.x group, GOTCHA 6). Body states the break
  plainly: *"`MemoryStore` now requires `prune`; `search`/`browse` accept
  `since`/`until` and exclude expired rows when `now` is supplied. Custom
  stores must implement `prune`."* — same pattern as browse/stats.
- Docs: memory.mdx episodic section (producers, retention, time-window recall,
  governance interaction), upgrading.mdx (`prune` requirement), inspector.mdx
  (timeline), dev memory-system doc.

## Open questions (validate during build, not blockers)

- Summary-line format for failure outcomes (include error class? keep short).
- Whether the timeline's default kind filter should show agent-authored
  episodic alongside auto (yes, likely — same kind).
- `includeFailedRuns` naming vs `outcomes: ["ok","error"]` allowlist — pick at
  plan time, default behavior identical.
