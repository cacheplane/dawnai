# Polished Flagship Research Demo — Design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Author:** Brian Love (with Claude)

## Summary

Build a polished, standalone `examples/research` demo app that is the flagship
expression of Dawn's strongest concepts. It mirrors the structure of the existing
`examples/chat` demo (a two-package pnpm monorepo: a Dawn `server/` plus a Next.js
`web/` UI) and dogfoods, in one coherent product, the research workflow, memory
candidates/approval, Docker sandbox isolation, workspace files, custom tools,
subagents, permissions/HITL, evals, and deterministic tests.

The default `app-research` scaffold template stays lighter and is aligned to the
flagship in a later slice. The demo is authored so its real files can be extracted
into a docs recipe (and, later, a blueprint) rather than remaining a hidden example.

## Motivation & Context

Findings from inspecting the current repo:

- **`examples/chat`** is the canonical demo *shape*: a pnpm monorepo with
  `server/` (`@dawn-example/chat-server`, a Dawn app with `appDir: src/app`) and
  `web/` (`@dawn-example/chat-web`, Next.js). The web app streams Server-Sent
  Events, renders an event log, offers a route picker, and implements a working
  HITL permission-resume flow (`web/app/api/permission-resume/route.ts`). It has
  its own vitest suite but is **not** wired into the `test/` harness.
- **`packages/devkit/templates/app-research`** is the **default scaffold**
  (`create-dawn-app` defaults to `research`, most recently improved in PR #302).
  It is already heavy: coordinator + `researcher` subagent, semantic memory with
  a candidate/approve flow, HITL allow/deny lists, a Docker sandbox gated behind
  `DAWN_DEMO_DOCKER_SANDBOX=1`, tool-output offloading, skills, evals with an LLM
  judge, a bundled 5-document corpus, and deterministic replay tests. It is
  **server-only — no UI.**
- **Blueprints** (`apps/web/content/blueprints/`) are markdown + frontmatter, but
  categories are **enforced** to `observability | retrieval | deploy`
  (`apps/web/lib/blueprints.ts:6`). There is **no research blueprint** and **no
  extraction tooling** — blueprints are hand-authored and served to `dawn add`.
- **Docs** (`apps/web/content/docs/`) are rich `.mdx` with `<CodeGroup>` blocks;
  `getting-started.mdx` already teaches research-as-default-scaffold.
- **Harness** (`test/generated`, `test/runtime`, `test/smoke`) achieves
  determinism through `aimock` fixtures (`packages/testing`). A new example gets
  coverage either as its own vitest suite (chat's approach) or a `test/runtime`
  fixture.

The core tension: the "scaffold" we want to keep light **is** the heavy default
template. So this work splits altitude — a polished flagship that goes deep, and
a slimmer default starter aligned to it.

## Decisions

Captured during brainstorming:

1. **Demo shape:** Server + web UI monorepo (like `examples/chat`).
2. **Scaffold treatment:** Slim/align the default `app-research` template in a
   **later slice**, not in the flagship's first PR.
3. **First implementation slice:** the `server/` app + deterministic tests.
4. **Extraction:** author a **docs recipe now**; design for a future
   `research-assistant` blueprint but do **not** add a new blueprint category yet.

## Goals

- A standalone `examples/research` app that is visibly the best demonstration of
  Dawn, runnable and green at every slice boundary.
- Deterministic by default; live/model paths explicitly gated.
- Docker sandbox dogfooding that is explicit but optional (works without Docker).
- Real local runtime verification plus a deterministic harness/test strategy.
- An end state that supports docs (and later blueprint) extraction from real files.

## Non-Goals

- Changing the default `app-research` scaffold in the first slice.
- Adding a new blueprint category or authoring a research blueprint now.
- Building any new framework abstraction. Prefer existing repo patterns.
- A production server (Dawn has none; `dawn dev` is localhost-only).

## Architecture

`examples/research/` is a two-package pnpm monorepo mirroring `examples/chat`:

- **`server/`** — `@dawn-example/research-server`, a Dawn app (`appDir: src/app`).
- **`web/`** — `@dawn-example/research-web`, a Next.js UI.

### Server package (Slice 1)

The `server/` package is the fullest expression of the research pattern, built by
**promoting** the current `app-research` template patterns into a polished,
non-`.template` form (concrete files, no mustache variables):

```
server/
  dawn.config.ts        # permissions allow/deny; sandbox gated by
                        #   DAWN_DEMO_DOCKER_SANDBOX=1; toolOutput offloading
  .env.example          # OPENAI_API_KEY
  vitest.config.ts      # fileParallelism: false (agents mutate OPENAI_BASE_URL)
  tsconfig.json         # extends @dawn-ai/config-typescript/node
  package.json          # @dawn-ai/{core,cli,langchain,sandbox,sdk}, zod
  workspace/
    AGENTS.md           # durable house rules injected into system prompt
    corpus/*.md         # bundled research corpus (seeded from template's 5 docs)
    scripts/fetch-source.mjs   # external-fetch seam (stub; not allowlisted)
  src/app/research/
    index.ts            # coordinator (gpt-5-mini): recall → plan → dispatch →
                        #   synthesize → remember
    state.ts            # z.object({ context: z.string().default("") })
    memory.ts           # defineMemory({ kind: "semantic", scope, schema })
    memory.md, plan.md
    skills/cite-sources/SKILL.md
    skills/synthesize-findings/SKILL.md
    subagents/researcher/index.ts   # gpt-5-mini; corpus search + cite
    evals/research-quality.eval.ts
  src/tools/searchCorpus.ts
  src/tools/readDoc.ts
  test/research.test.ts             # deterministic capability suite (fixtures)
  test/sandbox-docker.test.ts       # gated by DAWN_DEMO_DOCKER_SANDBOX=1
```

Model defaults follow the `gpt-5` family policy (canonical default `gpt-5-mini`).

### Web package (Slice 2)

Mirrors `examples/chat/web`:

```
web/
  app/layout.tsx
  app/page.tsx                       # topic input; live plan/todos; streaming
                                     #   report; HITL permission prompts; memory
                                     #   candidates panel
  app/api/research/route.ts          # SSE proxy to server /threads/{tid}/runs/stream
  app/api/permission-resume/route.ts # HITL resume
  next.config.mjs, package.json, tsconfig.json, .env.example
```

## Concepts Dogfooded

Coordinator + subagent dispatch (`task({ subagent, input })`); custom tools
(`searchCorpus`, `readDoc`) with tool-output offloading; semantic memory with
candidate → CLI-approve → recall; planning/todos (`plan.md`); skills; HITL
permissions (interrupt + resume); Docker sandbox (explicit but env-gated);
workspace path-jail; evals with an LLM judge; deterministic replay tests.

## Determinism & Live Gating

- **Slice 1:** deterministic means the vitest suite runs entirely on `aimock`
  fixtures with **no API key**, exactly like the template's tests. The app is
  also runnable live via `dawn run` / `dawn dev` with a key.
- **Slice 2:** a `pnpm dev` **demo mode** boots an `aimock`-backed fixture server
  (reusing `@dawn-ai/testing`'s `createAimock`, which returns a `baseUrl` set as
  `OPENAI_BASE_URL`) so the UI runs with **no API key** — a canned but believable
  research run. `pnpm dev:live` uses a real key. This makes the recorded-fixtures
  story a visible product feature. (Demo mode is designed here but implemented in
  Slice 2; Slice 1 does not depend on it.)

## Data Flow

1. User submits a topic (UI → `/api/research` → Dawn server `runs/stream`).
2. Coordinator recalls durable context, writes a plan (todos), and dispatches a
   `researcher` subagent per sub-question via `task()`.
3. Subagents call `searchCorpus` → `readDoc` (path-jailed to `corpus/`); large
   docs offload to `workspace/tool-outputs/`.
4. A non-allowlisted bash command (e.g. `node scripts/fetch-source.mjs`) raises a
   permission interrupt; the UI resumes it via `/api/permission-resume`.
5. Coordinator synthesizes a cited report to `workspace/reports/<slug>.md` and
   proposes a durable memory write (`remember()`), which lands as a **candidate**.
6. SSE events (`plan_update`, tool calls, `interrupt`, final message) stream to
   the UI throughout.

## Error Handling

- **No Docker:** the sandbox path is gated by `DAWN_DEMO_DOCKER_SANDBOX=1`; the
  default run and all non-sandbox tests work without Docker.
- **No API key:** deterministic tests (and Slice 2 demo mode) require no key.
- **Permission denials:** a denied interrupt returns control to the agent, which
  follows the `recover-from-failure`-style guidance rather than blindly retrying.
- **Path-jail violations:** `readDoc` asserts `corpus/` prefix and rejects `..`.

## Testing & Harness Strategy

- The `server/` package owns a deterministic vitest suite (chat's pattern) using
  `createAgentHarness` + `script()` fixtures, covering: corpus search + citation;
  subagent dispatch; memory candidate + CLI-approve → fresh-thread recall;
  planning todos; HITL interrupt + resume; tool-output offloading.
- A gated `test/sandbox-docker.test.ts` runs only under `DAWN_DEMO_DOCKER_SANDBOX=1`
  and verifies per-thread isolation (writes do not escape to host).
- **CI integration:** wire the research server's deterministic tests into the repo
  test run so the flagship stays green (note: `examples/chat` is currently *not*
  harnessed; this closes that gap for the flagship). The app must also pass
  `typecheck` and `build`.
- **Local verification:** `pnpm --filter research-server test`, `dawn run` on a
  canonical input, and the eval replay (`dawn eval`).

## Docs / Blueprint Extraction (Slice 4)

- Author a docs recipe under `apps/web/content/docs/recipes/` (e.g.
  `research-assistant.mdx`) whose `<CodeGroup>` blocks are drawn from the real
  flagship files, so docs stay honest to runnable code.
- Design the app so a future `research-assistant` blueprint is a small step:
  keep files self-contained and note the intended blueprint boundary. Do **not**
  add a new blueprint category (`agents`/`patterns`) in this work — that is a
  separate decision because categories are enforced in `apps/web/lib/blueprints.ts`.

## Implementation Slices

1. **Server app + deterministic tests** — the full research `server/` package,
   fixtures, evals, gated Docker test; green typecheck/build/test; runnable via
   `dawn run` / `dawn dev`. *(Begin here.)*
2. **Web UI + demo mode** — Next.js shell, SSE streaming, HITL resume, memory
   candidates panel; `aimock`-backed no-key demo mode.
3. **Scaffold slimming + alignment** — trim the default `app-research` template to
   a lighter starter aligned with the flagship's conventions.
4. **Docs recipe extraction** — author the recipe from real files; add a design
   note for a future research blueprint.

## Risks & Mitigations

- **Scope creep into the default scaffold.** Mitigated by deferring scaffold
  changes to Slice 3, after the flagship exists to align against.
- **UI hard to keep green.** Mitigated by building the server + tests first
  (Slice 1) so the UI has a stable, deterministic backend.
- **Fixture drift.** Deterministic tests replay recorded fixtures; use the
  harness `record` mode to refresh them when prompts change.

## Open Questions (deferred, not blocking)

- Whether Slice 3 slims the template by *removing* advanced features or by
  *cross-linking* to the flagship — decide when Slice 3 is planned.
- Exact blueprint category story — decide when/if a research blueprint is authored.
