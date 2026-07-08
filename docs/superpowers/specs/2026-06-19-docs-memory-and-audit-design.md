# Docs: long-term memory update + accuracy audit fixes

Date: 2026-06-19
Status: Approved (design)
Branch: blove/optimistic-brahmagupta-92c3e5

## Goal

Bring the Dawn docs website (`apps/web/content/docs/`) into alignment with the
shipped state of the codebase, with a focus on the new long-term memory feature
(PR #250, `@dawn-ai/memory`). Two outcomes:

1. The memory documentation accurately describes the three coexisting memory
   mechanisms and the shipped behavior (no false promises).
2. A batch of verified accuracy/clarity fixes across the rest of the docs.

This is a documentation-only change. No package source is modified.

## Ground truth (verified against source)

Dawn has **three coexisting memory mechanisms**:

- **L1 — `workspace/AGENTS.md`** (pre-existing): global, always-injected profile
  blob, shared by every route, re-read each turn, agent-edited via the workspace
  `writeFile` tool. Capability `createAgentsMdMarker()`. Injected heading
  `# Memory`. 64 KiB cap.
- **L2 — route-local `memory.md`** (new): route-scoped profile text, opt-in by
  presence, re-read each turn, prompt-fragment-only. Capability
  `createMemoryMdMarker()`. Injected heading `# Route Memory`. 32 KiB cap.
- **L3 — typed collection via `memory.ts` + `defineMemory`** (new, the core):
  many discrete typed namespace-scoped records the agent writes/recalls across
  sessions. Backed by `@dawn-ai/memory` on `node:sqlite` (no FTS5 → tokenized
  keyword match + recency ordering; deterministic, replayable under aimock).
  Capability `createMemoryMarker()` contributes `remember`/`recall` tools plus an
  auto-injected index fragment headed `# Long-Term Memory`.

L3 specifics:
- `defineMemory({ kind, scope, schema, identity? })` from `@dawn-ai/sdk`.
  - `kind`: `"semantic" | "episodic" | "procedural" | "reflection"` — only
    `semantic` is wired end-to-end; the other three are typed-but-deferred.
  - `scope`: subset of `["workspace","route","tenant","user","agent"]`.
  - `schema`: a zod schema; `identity?` defaults to `["subject","predicate"]`.
- Typegen emits typed `remember`/`recall` into `.dawn/dawn.generated.d.ts`;
  `remember.data` is derived from the route's `defineMemory()` zod schema.
- `recall({ query?, kind?, tags?, limit? })` → `store.search`; defaults
  `status="active"`, `limit=8`.
- `remember({ data, content?, tags?, confidence? })` → validates `data` against
  the zod schema; id is data-derived (`memory_` + sha1(namespace|JSON(data))).
- Injected index: up to `indexMaxEntries` (default 20) active in-scope memories,
  each truncated to 80 chars, heading `# Long-Term Memory`.
- Default store path: `<appRoot>/.dawn/memory.sqlite`.

Write governance (`memory.writes`, default `"candidate"`):
- `off` — no `remember` tool (recall-only).
- `candidate` (default) — writes land as `candidate`, hidden from recall until
  approved. **No reconciliation/supersession happens.** `dawn memory approve`
  only flips status to `active`.
- `auto` — writes land `active` immediately with inline reconciliation
  (idempotent UPDATE / SUPERSEDE / ADD via `classifyWrite`).

CLI (`dawn memory <sub> [--cwd]`): `list`, `search <q>` (substring filter over
candidates, NOT tokenized recall), `inspect <id>`, `approve <id>`,
`reject <id>` (hard delete), `forget <id>` (also hard delete; differs only in
message).

Config (`DawnConfig.memory`): `store`, `writes`, `indexMaxEntries`,
`resolveScope(ctx) => Record<string,string>` (supplies tenant/user/agent dims at
runtime). Note: `enabled` exists in the type but is not read by the runtime
(activation is presence-of-`memory.ts`).

Testing: `seedMemory(target, records)` from `@dawn-ai/testing`.

Deferred / not shipped: episodic/procedural/reflection kinds, vector/embedding
recall, FTS5/BM25, memory graph, dev-server Memory Inspector, Postgres/pgvector
adapters, schema-typed `remember.data`, and — importantly — the spec'd
permissions HITL gating for `auto` writes was NOT shipped (auto writes are not
gated through `@dawn-ai/permissions`).

## Changes

### A. `memory.mdx` — full restructure around the 3-layer model

Sections:
1. Intro + comparison table (AGENTS.md / `memory.md` / `memory.ts`: scope,
   format, who writes, persistence, when to use).
2. L1 Workspace profile (`AGENTS.md`).
3. L2 Route memory (`memory.md`), `# Route Memory`.
4. L3 Long-term collection: `defineMemory` config (full scope set), typegen'd
   tools, `remember`/`recall` inputs + defaults, data-derived id, injected
   `# Long-Term Memory` index (20 / 80-char), default `.dawn/memory.sqlite`,
   node:sqlite tokenized+recency.
5. Write governance table (off/candidate/auto). **Fix supersession claim**:
   reconciliation only in `auto`; candidate default = review-then-activate.
6. Reviewing candidates: `dawn memory` workflow; reject/forget both hard-delete;
   `search` is substring-over-candidates.
7. Configuration: `memory` block incl. `resolveScope` example (tenant/user).
8. Testing: `seedMemory`.
9. What's deferred — accurate list replacing the contradictory "what it's not"
   section; `<Callout type="warn">` that auto-mode permissions HITL gating is not
   shipped.

### B. Memory-adjacent reference fixes
- `configuration.mdx`: add the `memory` config key.
- `cli.mdx`: "nine" → "ten" commands; add `memory` to inline list.
- `api.mdx`: add reference entries for `defineMemory`, `DefinedMemory`,
  `MemoryScopeDimension`, `DawnToolContext`, `WorkspaceFs`, `inferProvider`,
  `SUPPORTED_AGENT_PROVIDERS`, `validateModelId`, `ModelIdValidation`, and the
  model-id constants.

### C. Broader audit fixes
- `migrating-from-langgraph.mdx`: graph route → named `export const graph`; fix
  tl;dr (line 13) and line 140 wording to agree (named export, not default).
- `tools.mdx`: document shared `src/tools/` discovery (route-local shadows
  shared).
- `workspace.mdx`: `create-dawn-app` → `create-dawn-ai-app`.
- `reasoning-effort.mdx`: `gpt-5.1` → curated `gpt-5-mini`.
- `observability.mdx`: `subagent()` → `task()`.
- `stream-output.mdx`: correct `plan_update` description (fires on `writeTodos`
  results, not on `plan.md` writes).
- Light dedup: `evals.mdx` links to `testing-agents.mdx` for shared
  aimock/fixture mechanics instead of restating; remove the repeated
  record-workflow block in `testing-agents.mdx`.

## Non-goals
- No package/source code changes.
- No nav restructure (memory page stays in Concepts).
- No new doc pages.
- Not fixing the underlying code divergences (e.g. shipping auto-mode HITL
  gating) — only documenting reality.

## Verification
- Re-grep each changed claim against `packages/*` source before marking done.
- `apps/web` typecheck/build so MDX still compiles.
- Confirm nav/search unaffected.
