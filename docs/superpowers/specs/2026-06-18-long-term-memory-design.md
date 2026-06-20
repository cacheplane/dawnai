# Long-Term Memory Design (Phase 4)

**Status:** Approved (design phase) — 2026-06-18
**Phase:** 4 sub-project — long-term (cross-thread) memory
**Direction:** Path B — structured, typed memory store (chosen over the deepagents filesystem-as-memory model after evaluating both)
**Informed by:** the author's research brief (`dawn-ai-agentic-memory-learning.md`), an external deep-research report (CoALA / Generative Agents / Mem0 / LangMem / LangGraph Store / Zep), and the deepagents long-term-memory model.

## Goal

Give Dawn agents **cross-thread persistent memory**: many discrete, typed, scoped memories that the agent writes and selectively recalls across sessions — going beyond today's single always-injected `workspace/AGENTS.md` blob. Memory should feel as structured, typed, inspectable, and route-local as Dawn's tools, state, plans, and skills.

## Background: what exists today

- **`workspace/AGENTS.md`** (capability `built-in/agents-md.ts`): an always-on *profile* — one markdown doc injected under `# Memory`, re-read every turn, edited by the agent via the workspace `writeFile` tool. 64 KiB cap. This is a single blob; it does not scale to many discrete facts and has no selective recall.
- **In-thread summarization** (`@dawn-ai/langchain/summarization`): a `preModelHook` that condenses old turns into a `runningSummary` state channel — ephemeral, per-thread working memory. Distinct from long-term memory.
- **Capability autowiring** (`@dawn-ai/core` `capabilities/`): a `CapabilityMarker { name, detect, load }` contributes `{ tools?, stateFields?, promptFragment?, streamTransformers? }`; detection is filesystem-convention-based; registered in `packages/cli/src/lib/runtime/execute-route.ts`; typed tools surface via `run-typegen.ts` EXTRA_TOOLS constants.
- **`@dawn-ai/sqlite-storage`**: `openDb(path)` (WAL + FK pragmas, no native deps — `node:sqlite`), `runMigrations(db, migrations)`, and a `threads` store as a CRUD template.
- **`@dawn-ai/workspace`**: `FilesystemBackend` + `localFilesystem`, path-jail, permissions HITL gating writes.
- **`@dawn-ai/permissions`**: HITL interrupt/resume with Once/Always/Deny scopes, persisted decisions.

## Key technical constraints (verified)

- **`node:sqlite` does NOT ship FTS5** (Node 22.14 → SQLite 3.47.2, `no such module: fts5`). Deterministic keyword recall therefore uses **tokenized `LIKE`** (lowercase token match over content/subject/tags) + recency ordering, NOT BM25. FTS5/vector ranking is deferred (it would require a vendored SQLite or a non-`node:sqlite` driver, breaking the no-native-deps rule).
- **Determinism**: recall must be deterministic so it replays under the aimock wire-mock harness. Keyword + recency are deterministic; embeddings are not (deferred behind a pluggable retriever).

## Architecture: three coexisting layers (all in v1)

- **L1 — `workspace/AGENTS.md`** (exists): global, always-injected *profile*. Reframed in docs as "workspace prompt memory."
- **L2 — route-local `memory.md`** (new, small): a route-scoped *profile*, injected after AGENTS.md, re-read per turn, size-capped. A prompt-fragment-only capability mirroring `agents-md.ts`.
- **L3 — typed memory *collection*** (new, the core): many discrete typed memories in `node:sqlite`, namespace-scoped, written and selectively recalled via generated typed tools.

Prompt assembly order: `systemPrompt → AGENTS.md → route memory.md → memory index (L3) → planning fragment → skills fragment → current messages`.

## Components

### Memory object model (`@dawn-ai/memory`)

A single base row; `kind` discriminates:

```ts
interface MemoryRecord {
  id: string
  kind: "semantic" | "episodic" | "procedural" | "reflection"
  namespace: string            // serialized scope tuple (see Scoping), e.g. "ws=acme|route=/support"
  content: string              // human-readable rendering — what gets injected/recalled
  data: Record<string, unknown> // typed payload, validated against the route's zod schema
  source: { type: "run" | "user" | "tool" | "eval" | "human"; id: string }
  confidence: number           // 0..1
  tags: readonly string[]
  status: "candidate" | "active" | "superseded"
  supersedes?: readonly string[]
  createdAt: string; updatedAt: string
  effectiveAt?: string; expiresAt?: string
}
```

Supersession over deletion: contradicted/updated memories flip to `status:"superseded"` (history retained), matching the brief and Zep's "invalidate, don't delete." Hard delete exists for privacy (`dawn memory` CLI) but is not the default path.

### Storage (`@dawn-ai/memory`)

- New package `@dawn-ai/memory` exporting a `MemoryStore` interface and a default `sqliteMemoryStore` built on `@dawn-ai/sqlite-storage`'s `openDb` + `runMigrations`. Default DB path `.dawn/memory.sqlite`.
- `MemoryStore` interface (adapter seam — Postgres/pgvector later):

```ts
interface MemoryStore {
  put(rec: MemoryRecord): Promise<void>
  get(id: string): Promise<MemoryRecord | null>
  search(q: MemoryQuery): Promise<readonly MemoryRecord[]>   // namespace-filtered, keyword+recency
  update(id: string, patch: Partial<MemoryRecord>): Promise<void>
  supersede(id: string, bySupersedingId: string): Promise<void>
  delete(id: string): Promise<void>                          // hard delete (privacy)
  listCandidates(namespacePrefix: string): Promise<readonly MemoryRecord[]>
}
interface MemoryQuery {
  namespace: string
  query?: string               // tokenized to lowercase terms; LIKE-matched against content+tags
  kind?: MemoryRecord["kind"]
  tags?: readonly string[]
  status?: MemoryRecord["status"]   // defaults to "active"
  limit?: number               // default 8
}
```

- Schema: one `memories` table + indexes on `(namespace, status, updated_at)` and a `memory_tokens` helper table (memory_id, token) populated on write so token `LIKE`/equality match is index-assisted (the FTS5 substitute). Migrations live in the package.

### Typed schemas + typegen + tools

- A route declares memory by adding **`memory.ts`** exporting `defineMemory({ kind, scope, schema })`:

```ts
// src/app/support/[tenant]/memory.ts
import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route", "tenant"],
  schema: z.object({
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
  }),
})
```

- **Typegen** (`run-typegen.ts`): when `memory.ts` is present, emit `MEMORY_EXTRA_TOOLS` — typed `remember` (input typed to the route's `schema`) and `recall` (returns typed records). Mirrors `PLANNING_EXTRA_TOOL` / `SKILLS_EXTRA_TOOL` / `WORKSPACE_EXTRA_TOOLS`. Detection added alongside `hasSkills`/`hasWorkspace`.
- **v1 ships the `semantic` kind only**, end-to-end typed. `episodic` / `procedural` / `reflection` schemas (and episodic-from-traces) are deferred; the base row already supports them so it's additive.

### Recall

- Generated **`recall({ query?, kind?, tags?, limit? })`** tool → `store.search` scoped to the current namespace; tokenized-`LIKE` keyword match + recency ordering; returns typed records. Deterministic → aimock-replayable.
- A small **auto-injected "memory index"** prompt fragment each turn: the subjects/tags of *active* in-scope memories, capacity-bounded (e.g. ≤ N entries / ≤ K chars), so the agent knows what is recallable without pulling full bodies. Full bodies come only via `recall`. The index is tiny, so it composes with the summarization token budget without contention.
- Vectors / importance-weighted ranking are deferred behind the `MemoryStore.search` seam.

### Write governance

- Generated **`remember({ ...typed })`** tool. Config `memory: { writes: "off" | "candidate" | "auto" }` (default **`candidate`**).
  - **candidate**: writes `status:"candidate"`; promoted via `dawn memory approve <id>` / `reject <id>`.
  - **auto**: writes `status:"active"`, gated through `@dawn-ai/permissions` HITL (first write of a pattern interrupts with Once/Always/Deny, like `runBash`).
  - **off**: the `remember` tool is not contributed.
- **Reconciliation on write** (deterministic, no extra LLM call so it stays testable): against the top-N namespace+keyword matches, classify ADD (no equivalent), UPDATE (same identity key, same value → patch + bump `updatedAt`), or SUPERSEDE (same identity key, different value → write new + flip old to `superseded`). The **identity key is per-kind**; for the v1 `semantic` kind it is `(subject, predicate)`. Identity and equivalence are computed from the typed `data`, never embeddings. (A future `defineMemory({ identity })` hook can declare the key for other kinds.)
- **`dawn memory` CLI** (v1 surface): `list`, `search <query>`, `inspect <id>`, `approve <id>`, `reject <id>`, `forget <id>` (hard delete). The dev-server **Memory Inspector UI is deferred**.

### Scoping

- Namespace = a tuple resolved at runtime: **`workspace`** (always) + **`route`** (always) + an optional **app-supplied dimension** (`tenant`/`user`/…). The app supplies the extra dimension via `dawn.config` (`memory.resolveScope(ctx)`), a `[tenant]`-style route param, or middleware-attached context; `defineMemory({ scope: [...] })` declares which dimensions a route's memory uses. Serialized to the `namespace` string (stable key order). Isolation is enforced by namespace-prefixed queries — a route can only read its declared scope.
- v1 supports `workspace` + `route` out of the box; `tenant`/`user` work as soon as the app provides the key.

### Config surface (`DawnConfig.memory`)

```ts
memory?: {
  enabled?: boolean              // default: true when any memory.ts / memory.md exists
  store?: MemoryStore            // pluggable; default sqliteMemoryStore(.dawn/memory.sqlite)
  writes?: "off" | "candidate" | "auto"   // default "candidate"
  indexMaxEntries?: number       // memory-index injection cap; default 20
  resolveScope?: (ctx) => Record<string, string>  // app-supplied scope dimensions
}
```

Resolved in `execute-route.ts` following the `resolveThreadsStore` pattern.

## Error handling

- Missing `node:sqlite` FTS5 → already handled by the tokenized-`LIKE` design (no runtime fallback needed).
- `remember` with a payload failing the route's zod schema → tool returns a validation error to the agent (typed tool boundary); nothing written.
- `recall`/`remember` when no `memory.ts` exists → tools absent (capability not contributed); `memory.md`-only routes still get L2 injection.
- Namespace isolation is fail-closed: a query without a resolved namespace throws rather than scanning all rows.
- CLI `approve`/`reject` on a non-candidate id → clear error.

## Testing

- **`@dawn-ai/memory` unit tests**: store CRUD + tokenized search ranking + supersede/reconciliation classification (ADD/UPDATE/SUPERSEDE), all against `:memory:` SQLite — deterministic, no LLM.
- **`@dawn-ai/testing`**: `seedMemory([...])` helper + memory assertions; an aimock-deterministic e2e where the agent `recall`s a seeded memory and the answer reflects it, and a `remember` round writes a candidate.
- **Memory eval helpers** (`@dawn-ai/evals`): recall-correctness (expected memory recalled, irrelevant excluded), **isolation** (namespace A cannot read namespace B), **freshness** (a superseding write makes the newer value win). Dogfood in the research template.
- **Typegen test**: `memory.ts` present → generated `remember`/`recall` types match the route's zod schema.

## Packaging & files (seams)

- New package **`@dawn-ai/memory`**: `MemoryRecord`/`MemoryStore`/`MemoryQuery` types, `sqliteMemoryStore`, namespace + reconciliation + search logic, migrations.
- `@dawn-ai/core`: `built-in/memory.ts` (L3 capability: contributes `remember`/`recall` tools + the memory-index prompt fragment) and `built-in/memory-md.ts` (L2 prompt fragment). `DawnConfig.memory` type. `defineMemory` exported from `@dawn-ai/sdk`.
- `@dawn-ai/cli`: register both markers in `execute-route.ts`; `MEMORY_EXTRA_TOOLS` + detection in `run-typegen.ts`; `resolveMemoryStore()` resolver; new `dawn memory` command.
- `@dawn-ai/testing`: `seedMemory` + matchers. `@dawn-ai/evals`: memory eval helpers.
- Research template: a `memory.ts` + seeded memories + a memory eval (dogfood).

## Implementation phasing (the plan will follow this order; each phase ships working software)

1. Route-local `memory.md` capability (L2) — smallest, self-contained.
2. `@dawn-ai/memory` package: `MemoryRecord` + `sqliteMemoryStore` + search/supersede + unit tests.
3. `memory.ts` / `defineMemory` + typegen `MEMORY_EXTRA_TOOLS` + generated `recall`/`remember` (semantic) + capability wiring.
4. Write governance: `writes` modes, candidate status, reconciliation, permissions-gated `auto`.
5. Memory-index injection (L3 prompt fragment) + scope resolution.
6. `dawn memory` CLI + `@dawn-ai/testing` seeding + memory evals + research-template dogfood.

## Out of scope (deferred, explicit — not half-built)

- `episodic` / `procedural` / `reflection` typed kinds; episodic-memory-from-run-traces; automatic background reflection/consolidation.
- Vector / semantic (embedding) recall; importance-weighted ranking; BM25/FTS5.
- Memory graph (edges/relations) and graph-traversal retrieval.
- Dev-server Memory Inspector UI.
- Postgres / pgvector adapters (the `MemoryStore` interface leaves room).
- Cross-route / shared-library memory beyond the namespace tuple.
