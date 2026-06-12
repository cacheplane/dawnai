# Docs Realignment for v0.7.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `apps/web/content/docs/*.mdx` back into alignment with the shipped v0.7.0 code — fix actively-misleading content, refresh stale examples, and fill the capability/reference gaps so a developer can follow the docs end-to-end against the published packages.

**Architecture:** Pure documentation work in `apps/web/content/docs/`. Two thrusts: (P1) **correctness fixes** to existing pages that currently break or mislead, and (P2) **new pages** for shipped-but-undocumented capabilities + a `dawn.config.ts` reference + observability. Every change is grounded in a cited code fact; the gate is `node scripts/check-docs.mjs` + `pnpm --filter @dawn-ai/web build` + a stale-term grep.

**Tech Stack:** MDX (fumadocs/Next.js docs site under `apps/web`), `scripts/check-docs.mjs` (docs gate).

**Source of truth (from the 2026-06-12 audit):** `docs/superpowers/specs/`… (no spec — the audit findings in this plan are the spec). Ground-truth code:
- Default scaffold: `packages/create-dawn-app/src/index.ts:79` (`let template = "research"`); research template at `packages/devkit/templates/app-research/` (model `gpt-5-mini`).
- Agent Protocol endpoints: `packages/cli/src/lib/dev/runtime-server.ts` (`POST /threads`, `GET/DELETE /threads/:id`, `POST /threads/:id/runs/stream`, `POST /threads/:id/runs/wait`, `GET /threads/:id/state`, `POST /threads/:id/resume`, `GET /healthz`). Run body = `{ "route": "<routeId>#<kind>", "input": { "messages": [...] } }` (validated by `validateApRunBody`; bare `route_id` without `#agent` → 400 "Unknown route").
- `dawn run` posts to `/threads/<t-cli-uuid>/runs/wait` with `{ route, input }` (`packages/cli/src/lib/runtime/execute-route-server.ts`).
- LangSmith auto-enable: `packages/cli/src/lib/dev/load-env.ts:38` (`applyLangsmithTracing` sets `LANGCHAIN_TRACING_V2=true` when `LANGSMITH_API_KEY` present).
- `DawnConfig`: `packages/core/src/types.ts` (`appDir`, `backends{filesystem,exec}`, `permissions{mode,allow,deny}`, `checkpointer`, `threadsStore`, `env`, `toolOutput{offloadThresholdChars,previewLines,maxBytes,ttlMs,gcThrottleMs,noOffloadTools}`, `summarization{enabled,maxTokens,keepRecentTurns,model,tokenCounter,summarize}`).
- Workspace: `packages/core/src/capabilities/built-in/workspace.ts` + `packages/workspace/src/local-filesystem.ts` (4 tools, path-jail, `writeFile` auto-creates parent dirs).
- Permissions: `packages/permissions/src/types.ts` (`mode: "interactive"|"non-interactive"|"bypass"`); resume body `{ interrupt_id, decision: "once"|"always"|"deny" }`.
- AGENTS.md memory prompt: `packages/core/src/capabilities/built-in/agents-md.ts:8` (agent uses `writeFile({path:"AGENTS.md",...})`; uses `context.appRoot`, not `process.cwd()`).
- Stream events: `packages/cli/src/lib/runtime/stream-types.ts` (`chunk`, `tool_call`, `tool_result`, `done`) + `agent-adapter.ts`/`subagent-dispatcher.ts` (`interrupt`, `plan_update`, `subagent.start|tool_call|tool_result|message|end`).
- `@dawn-ai/testing@5.0.0` exports: `packages/testing/src/index.ts`. Live mode is set at `createAgentHarness({ live: true })`, NOT on `run()`. `mode` other than `"in-process"` throws (`harness.ts:62`).
- `@dawn-ai/evals@3.0.0` exports: `packages/evals/src/index.ts` (incl. undocumented `runEval`, `resolveGate`, `resolveDataset`, `normalizeScore`).
- Tool discovery: `packages/cli/src/lib/runtime/tool-discovery.ts` — discovers BOTH `src/tools/` (shared) and `<route>/tools/` (route-local); tool name = `basename(file, ".ts")` (so `load-profile.ts` → `"load-profile"`, NOT `loadProfile`). The generic error at line 158 is `"... must default export a function"` (NO LangChain-specific message on main — see VERIFY-1).

**VERIFY-FIRST items (resolve before writing the affected doc):**
- **VERIFY-1 (LangChain `tool()` error):** the cli changelog claims "friendlier tool-discovery errors" for default-exported LangChain `tool()`, but `tool-discovery.ts:158` only throws the generic error. Before documenting any targeted error, `grep -rn "StructuredTool\|lc_serializable\|must default export" packages/cli/src` to find where (if anywhere) the targeted message lives. If it doesn't exist on main, do NOT document it (skip that bullet).
- **VERIFY-2 (`ctx.fs`):** `packages/sdk/src/runtime-context.ts` has no `fs` field on this branch — do NOT document `ctx.fs`. Re-grep before adding it to `tools.mdx`.

---

## Conventions for every task
- Work only in `apps/web/content/docs/`. After each task: run `node scripts/check-docs.mjs` (expect `Docs completeness check passed.`) and confirm no banned phrases (`byte-identical`, "What works locally works in production").
- Ground every claim in a cited code fact (use the source-of-truth list above; re-read the file if unsure). Prefer abstract routes (`/research` or `/my-route`) over the removed `/hello/[tenant]` in examples.
- Commit per task with `docs: …`.
- Nav: new pages must be added to the docs sidebar/nav. **First task in P2 locates the nav mechanism** (fumadocs `meta.json` or a `source.config`/sidebar file) — `grep -rn "getting-started\|mental-model" apps/web --include=*.json --include=*.ts --include=*.tsx -l`.

---

# PHASE 1 — Correctness fixes (existing pages)

## Task 1: Rewrite `getting-started.mdx` for the research default
**Files:** Modify `apps/web/content/docs/getting-started.mdx`

- [ ] **Step 1:** Read the page. The "What you'll have" intro + "What you got" section describe `/hello/[tenant]`, `state.ts`, `tools/greet.ts`, `model: "gpt-4o-mini"` — all from the removed greeter.
- [ ] **Step 2:** Rewrite so `npm create dawn-ai-app@latest my-app` is shown to produce the **research** app. Replace the "What you got" file tour with the actual research tree (verify by scaffolding: `node packages/create-dawn-app/dist/bin.js /tmp/gsX --mode internal && find /tmp/gsX -type f -not -path '*/node_modules/*'`): `src/app/research/{index.ts, plan.md, state.ts, tools/searchCorpus.ts, tools/readDoc.ts, subagents/researcher/index.ts, skills/*, evals/research-quality.eval.ts}`, `workspace/{AGENTS.md, corpus/*, scripts/fetch-source.mjs}`, `test/research.test.ts`, `dawn.config.ts`. Coordinator model is `gpt-5-mini`.
- [ ] **Step 3:** Fix the run example: not `dawn run '/hello/[tenant]'`. Show `npm run check` (→ "Dawn app is valid: 2 routes discovered"), `npm test`, `npm run eval` (offline), and a `dawn dev` + a correct Agent Protocol curl (see Task 3 for the exact body). Add a one-line note: "Want the minimal greeter instead? `npm create dawn-ai-app@latest my-app -- --template basic`."
- [ ] **Step 4:** `node scripts/check-docs.mjs` → passes. `grep -n "hello/\[tenant\]\|gpt-4o-mini\|greet" apps/web/content/docs/getting-started.mdx` → no matches.
- [ ] **Step 5:** Commit `docs: rewrite getting-started for the research default scaffold`.

## Task 2: Fix `mental-model.mdx` examples + persistence boundary
**Files:** Modify `apps/web/content/docs/mental-model.mdx`

- [ ] **Step 1:** Replace the `/hello/[tenant]` runtime diagram (`dawn run "/hello/[tenant]"`, `greet({tenant})`, `Hello, acme!`) with a `/research`-based or abstract `/my-route` example.
- [ ] **Step 2:** In "The runtime" section, add the thread/checkpointer layer (Dawn's `DawnSqliteSaver`, `.dawn/checkpoints.sqlite`). In the boundary table, correct "Persistence and resume" — Dawn now owns local SQLite checkpointing/threads (cite `packages/cli/src/lib/dev/runtime-server.ts` + `@dawn-ai/sqlite-storage`); clarify the "LangSmith deploy" row (LangSmith is the deploy/observability target, distinct from LangGraph).
- [ ] **Step 3:** check-docs passes; `grep -n "hello/\[tenant\]"` → none. Commit `docs: refresh mental-model examples + persistence boundary`.

## Task 3: Rewrite the `dev-server.mdx` protocol section (Agent Protocol)
**Files:** Modify `apps/web/content/docs/dev-server.mdx`

- [ ] **Step 1:** Read `packages/cli/src/lib/dev/runtime-server.ts` to enumerate the real endpoints + the `validateApRunBody` shape.
- [ ] **Step 2:** Replace the entire "three endpoints" section. Document the real set with a thread-lifecycle walkthrough: `POST /threads` → returns `{thread_id}`; `POST /threads/:thread_id/runs/wait` (and `…/runs/stream` for SSE) with body **`{ "route": "/research#agent", "input": { "messages": [{ "role": "user", "content": "…" }] } }`**; `GET /threads/:thread_id/state`; `POST /threads/:thread_id/resume` with `{ "interrupt_id": "…", "decision": "once" }`; `GET /threads/:thread_id`; `DELETE /threads/:thread_id`; `GET /healthz`. Remove the fabricated `assistant_id` / `metadata.dawn.*` / `on_completion: "delete"` fields. Note the route id MUST include the node suffix (`#agent`); a bare `/research` returns 400 "Unknown route".
- [ ] **Step 3:** Fix the `dawn run` description: it POSTs to `/threads/<t-cli-uuid>/runs/wait` with `{ route, input }` (cite `execute-route-server.ts`), auto-creating a CLI thread — not bare `/runs/wait`.
- [ ] **Step 4:** Add a short "Tracing" note (forward-ref to the new observability page, Task 14): `LANGSMITH_API_KEY` in `.env` auto-enables `LANGCHAIN_TRACING_V2`.
- [ ] **Step 5:** Verify each documented curl against a live server if practical (`dawn dev --port 2024` on a scaffolded app, then the documented calls). check-docs passes. Commit `docs: correct dev-server Agent Protocol endpoints + request bodies`.

## Task 4: Fix `cli.mdx` (protocol label, tracing, route example)
**Files:** Modify `apps/web/content/docs/cli.mdx`

- [ ] **Step 1:** Change the `dawn dev` description from "LangSmith protocol" to "Agent Protocol (AP) HTTP endpoints" (the `langgraph.json` deploy artifact is the LangSmith piece; the runtime is AP). Keep the verified-accurate nine-command list + `dawn check` output line as-is.
- [ ] **Step 2:** Add to the `dawn dev` entry: env loading (`.env` / `--env-file`) auto-enables LangSmith tracing when `LANGSMITH_API_KEY` is set (`load-env.ts:38`); mention `--port`.
- [ ] **Step 3:** Replace the `dawn run '/hello/[tenant]'` example with `/research` (or `/my-route`). check-docs passes; commit `docs: fix cli dev protocol label + tracing + route example`.

## Task 5: Fix `memory.mdx` "Updating memory" (Critical)
**Files:** Modify `apps/web/content/docs/memory.mdx`

- [ ] **Step 1:** Read `packages/core/src/capabilities/built-in/agents-md.ts`. The agent is instructed to update memory via the workspace `writeFile({ path: "AGENTS.md", content })` tool (available when `workspace/` exists), and the file resolves under `context.appRoot` (== cwd in `dawn dev`), NOT `process.cwd()` generically.
- [ ] **Step 2:** Replace the "Dawn does not currently add a generic writeFile" claim + the custom `node:fs/promises` `updateMemory.ts` example with: memory lives at `workspace/AGENTS.md`; the workspace capability's `writeFile` tool updates it (path-jailed); the agent already gets this instruction in its system prompt. Cross-link to the new workspace page (Task 11). Fix the `process.cwd()` wording → `context.appRoot`.
- [ ] **Step 3:** check-docs passes; commit `docs: correct memory update guidance to workspace writeFile`.

## Task 6: Fix `testing-agents.mdx` API errors + scaffold narrative
**Files:** Modify `apps/web/content/docs/testing-agents.mdx`

- [ ] **Step 1:** Fix the live-mode example: live is set at construction — `createAgentHarness({ appRoot, route, live: true })`, NOT `h.run({ live: true })` (cite `packages/testing/src/harness.ts`). 
- [ ] **Step 2:** The `"http-inject"` / `"subprocess"` mode descriptions: `harness.ts:62` throws `"mode … not yet implemented"` for non-`in-process`. Mark these "not yet implemented (planned)" or remove, and note the standalone `injectAgentProtocol` / `startSubprocessApp` exports exist but the `mode` option only supports `"in-process"` today.
- [ ] **Step 3:** Update the scaffold narrative: the default scaffold ships `test/research.test.ts` targeting `"/research#agent"` (not `test/agent.test.ts` / `hello/[tenant]`). Add a one-line mention of `AgentRunResult.toolResults` (+ `deriveToolResults`) since `expectNoToolErrors` reads it. (The two new matchers are already documented — leave them.)
- [ ] **Step 4:** check-docs passes; `grep -n "hello/\[tenant\]\|live: true" apps/web/content/docs/testing-agents.mdx` reviewed. Commit `docs: fix testing-agents live mode, harness modes, scaffold narrative`.

## Task 7: Fix `evals.mdx` scaffold reference + document `runEval`
**Files:** Modify `apps/web/content/docs/evals.mdx`

- [ ] **Step 1:** Replace the `evals/smoke.eval.ts` scaffold reference with `src/app/research/evals/research-quality.eval.ts` (the default scaffold's eval); `npm run eval` (the research `package.json` has `"eval": "dawn eval"`) runs it offline (replay). Update the `llmJudge` example model to `gpt-5-mini` to match the scaffold (still note any model id works).
- [ ] **Step 2:** Add a short "Programmatic API" subsection documenting `runEval(options)` (cite `packages/evals/src/index.ts` → `run-eval.js`) for driving an eval from a script. Optionally mention `gate`/`resolveGate` are exported.
- [ ] **Step 3:** check-docs passes; commit `docs: fix evals scaffold reference + document runEval`.

## Task 8: Global model + route + scaffold-narrative sweep
**Files:** Modify `agents.mdx`, `subagents.mdx`, `retry.mdx`, `api.mdx`, `recipes/retry-flaky-tools.mdx`, `faq.mdx`, `migrating-from-langgraph.mdx`

- [ ] **Step 1:** `grep -rn "gpt-4o-mini\|hello/\[tenant\]\|hello-dawn" apps/web/content/docs` to enumerate every remaining occurrence (excluding pages where `--template basic` is explicitly the subject).
- [ ] **Step 2:** Update canonical example models from `gpt-4o-mini` → `gpt-5-mini` (the default scaffold's model). Update `/hello/[tenant]` example routes to `/research` or an abstract `/my-route`. In `faq.mdx` + `migrating-from-langgraph.mdx`, fix any answer that implies the default scaffold is the greeter; add a `task({ subagent, input })` mention to the migration/FAQ where subagent dispatch comes up.
- [ ] **Step 3:** In `agents.mdx`, add the **workspace** capability to the "built-in features" list (it's currently missing) with a link to the new workspace page (Task 11).
- [ ] **Step 4:** check-docs passes; re-run the Step-1 grep → only intentional `--template basic` references remain. Commit `docs: sweep stale model ids + greeter route examples`.

## Task 9: Fix recipe bugs (auth-middleware, stream-output, dispatch-from-route, add-a-tool)
**Files:** Modify `recipes/auth-middleware.mdx`, `recipes/stream-output.mdx`, `recipes/dispatch-from-route.mdx`, `recipes/add-a-tool.mdx`

- [ ] **Step 1 (auth-middleware):** Tool name comes from `basename(file, ".ts")` (`tool-discovery.ts:131`). The recipe's `tools/load-profile.ts` would be `ctx.tools["load-profile"]`, but the recipe calls `ctx.tools.loadProfile(...)`. Fix: rename the file to `tools/loadProfile.ts` (recommended) so `ctx.tools.loadProfile` resolves, OR change the call to `ctx.tools["load-profile"]`. Pick the camelCase-file fix and note the basename→tool-name rule.
- [ ] **Step 2 (stream-output):** Document the SSE event taxonomy and parse the `event:` line, not only `data:`. Events (cite `stream-types.ts` + `agent-adapter.ts`/`subagent-dispatcher.ts`): `chunk` (streamed text — NOT `token` at the SSE layer), `tool_call` `{name,input}`, `tool_result` `{name,output}`, `plan_update`, `interrupt`, `subagent.start|tool_call|tool_result|message|end`, `done` `{output}`. Rewrite the consumer to branch on the parsed `event:` type.
- [ ] **Step 3 (dispatch-from-route):** Lead with the idiomatic `task({ subagent: "researcher", input: "…" })` pattern (cite `packages/langchain/src/subagent-tool-bridge.ts` + the research scaffold), and demote the raw-HTTP approach to an "advanced / cross-service" note. Fix the hardcoded `http://127.0.0.1:3001` fallback (dev server binds an ephemeral port unless `--port` is passed).
- [ ] **Step 4 (add-a-tool):** Add a note that tools are discovered from both `<route>/tools/` (route-local) and `src/tools/` (shared) — cite `tool-discovery.ts:32-37`. Mention `dawn check` also regenerates types (not only `dawn typegen`). Apply VERIFY-1 before adding any LangChain-`tool()` error note.
- [ ] **Step 5:** check-docs passes; commit `docs: fix recipe bugs (tool name, SSE events, task() dispatch, shared tools)`.

---

# PHASE 2 — New pages for shipped-but-undocumented capabilities

## Task 10: Locate nav + add a `configuration.mdx` reference page
**Files:** Create `apps/web/content/docs/configuration.mdx`; Modify the docs nav

- [ ] **Step 1:** Find the nav mechanism: `grep -rn "getting-started" apps/web --include=*.json --include=*.ts --include=*.tsx -l` (likely a fumadocs `meta.json` per folder or a `lib/source` config). Document where new pages register.
- [ ] **Step 2:** Create `configuration.mdx` — the full `dawn.config.ts` reference, every `DawnConfig` key from `packages/core/src/types.ts` with type, default, and a one-line purpose: `appDir`; `backends.{filesystem,exec}`; `permissions.{mode,allow,deny}`; `checkpointer`; `threadsStore`; `env`; `toolOutput.{offloadThresholdChars(40000),previewLines(10),maxBytes(256MB),ttlMs(3h),gcThrottleMs,noOffloadTools}`; `summarization.{enabled(false),maxTokens(12000),keepRecentTurns(6),model,tokenCounter,summarize}`. Include one complete annotated `export default { … }` example. Link out to the workspace/permissions/context-management pages for the deep dives.
- [ ] **Step 3:** Register the page in nav. `check-docs` passes (it may require a nav entry for a new page — satisfy whatever it asks). Commit `docs: add dawn.config.ts configuration reference`.

## Task 11: New `workspace.mdx`
**Files:** Create `apps/web/content/docs/workspace.mdx`; Modify nav

- [ ] **Step 1:** Source: `packages/core/src/capabilities/built-in/workspace.ts`, `packages/workspace/src/local-filesystem.ts`. Content: presence of a `workspace/` dir activates four tools `listDir` / `readFile` / `writeFile` / `runBash`, all path-jailed to `workspace/` (reject `..` / outside paths); `runBash` runs with cwd = `workspace/`; `writeFile` **auto-creates missing parent directories** (so `writeFile({path:"reports/x.md"})` works); large `readFile`/tool outputs interact with offloading (`workspace/tool-outputs/`); custom backends via `dawn.config.ts` `backends`. Note `runBash` is gated by the permissions capability (link Task 12).
- [ ] **Step 2:** Add a worked example (the research app's `searchCorpus`/`readDoc` reading `workspace/corpus/` + writing `reports/`). Link from `agents.mdx` (done in Task 8) and `memory.mdx` (Task 5). Register in nav.
- [ ] **Step 3:** check-docs passes; commit `docs: add workspace capability page`.

## Task 12: New `permissions.mdx` (HITL)
**Files:** Create `apps/web/content/docs/permissions.mdx`; Modify nav

- [ ] **Step 1:** Source: `packages/permissions/src/types.ts`, `packages/cli/src/lib/dev/runtime-server.ts` (resume), `packages/core/src/capabilities/built-in/workspace.ts` (gate). Content: `dawn.config.ts` `permissions: { mode?, allow: { bash: [...] }, deny: { bash: [...] } }`; the three modes (`interactive` default / `non-interactive` / `bypass`); how a non-allowlisted `runBash` raises a `command` permission interrupt; the SSE `interrupt` event shape (`{ interruptId, kind:"command", detail:{ command, suggestedPattern } }`); resume via `POST /threads/:id/resume` with `{ interrupt_id, decision: "once"|"always"|"deny" }`; `"always"` persists to `.dawn/permissions.json`. Include the create-thread → run → interrupt → resume curl sequence.
- [ ] **Step 2:** Register in nav; cross-link from workspace + dev-server pages. check-docs passes; commit `docs: add HITL permissions page`.

## Task 13: New `context-management.mdx` (offloading + summarization)
**Files:** Create `apps/web/content/docs/context-management.mdx`; Modify nav

- [ ] **Step 1:** Source: `packages/core/src/types.ts` (`toolOutput`, `summarization`) + the offload/summarization runtime. Content: **tool-output offloading** — large tool results spill to `workspace/tool-outputs/` and are replaced by a stub the model reads back; config keys + defaults; `readFile`/`listDir` are exempt. **Conversation summarization** — `enabled` (default off), `maxTokens`, `keepRecentTurns`, custom `model`/`tokenCounter`/`summarize`; how the two compose. Include `dawn.config.ts` snippets.
- [ ] **Step 2:** Register in nav; link from configuration.mdx. check-docs passes; commit `docs: add context-management (offloading + summarization) page`.

## Task 14: New `observability.mdx` (LangSmith tracing)
**Files:** Create `apps/web/content/docs/observability.mdx`; Modify nav

- [ ] **Step 1:** Source: `packages/cli/src/lib/dev/load-env.ts`. Content: setting `LANGSMITH_API_KEY` (in `.env` or shell) makes `dawn dev` auto-set `LANGCHAIN_TRACING_V2=true`; optional `LANGCHAIN_PROJECT` to name the project; this applies during `dawn dev` (env-loaded), how to opt out (set `LANGCHAIN_TRACING_V2=false`), and what a trace shows (LLM calls, tool calls, subagent child runs). Mention reading traces back via the LangSmith API for verification (brief). Cross-link from getting-started, cli, dev-server, deployment, faq, migration.
- [ ] **Step 2:** Register in nav; add the cross-links from the pages above. check-docs passes; commit `docs: add observability / LangSmith tracing page`.

## Task 15 (optional / lower priority): persistence note + threads
**Files:** Modify `mental-model.mdx` (or a short `persistence` section) + `dev-server.mdx`

- [ ] **Step 1:** Add a concise persistence explanation: SQLite checkpointer + threads store are on by default (`.dawn/checkpoints.sqlite`, `.dawn/threads.sqlite`); threads survive a `dawn dev` restart; override via `dawn.config.ts` `checkpointer`/`threadsStore`. This can live as a section in `configuration.mdx` (Task 10) + a pointer from `dev-server.mdx` rather than a whole page. Commit `docs: document default SQLite persistence + threads`.

---

# PHASE 3 — Wire-up & validation

## Task 16: Cross-links, nav coherence, full validation
**Files:** Various (nav + cross-links)

- [ ] **Step 1:** Ensure all new pages (configuration, workspace, permissions, context-management, observability) appear in the sidebar in a sensible order (e.g., under a "Capabilities" or "Configuration" group). Add cross-links: agents → workspace/permissions; getting-started → configuration/observability; dev-server → permissions/observability.
- [ ] **Step 2:** Stale-term sweep across ALL docs: `grep -rn "gpt-4o-mini\|/hello/\[tenant\]\|/runs/wait\b\|assistant_id\|on_completion\|smoke.eval.ts\|agent.test.ts" apps/web/content/docs` — every hit must be either corrected or an intentional `--template basic` / historical reference. 
- [ ] **Step 3:** `node scripts/check-docs.mjs` → passes. `pnpm --filter @dawn-ai/web build` → builds (catches broken MDX/links). 
- [ ] **Step 4:** Decide changeset: docs in `apps/web` are not a published package, but the CI "Require changeset for user-facing changes" check may apply — if the changesets check fails on the PR, add an empty changeset (`pnpm changeset --empty`) or a `apps/web`-scoped note. 
- [ ] **Step 5:** Commit `docs: nav + cross-links for new capability pages`; open PR.

---

## Self-Review

**1. Spec coverage (audit findings → tasks):**
- Stale default scaffold / model / routes → Tasks 1, 2, 4, 6, 7, 8 (+ sweep in 16).
- dev-server protocol wrong → Task 3. `dawn run` URL → Task 3.
- memory.mdx wrong update guidance → Task 5.
- testing-agents (live:true, modes, scaffold, toolResults) → Task 6. evals (smoke.eval.ts, runEval) → Task 7.
- recipe bugs (auth-middleware tool name, stream SSE events, dispatch task(), shared tools) → Task 9.
- GAPS → new pages: configuration (Task 10), workspace (11), permissions (12), context-management/offloading+summarization (13), observability (14), persistence (15).
- Cross-cutting nav/validation → Task 16.
- Undocumented testing/evals exports (toolResults, deriveToolResults, runEval) → Tasks 6/7 (the high-value ones; type-only exports left as YAGNI).

**2. Placeholder scan:** No "TBD". Two explicit VERIFY-FIRST items (LangChain `tool()` error; `ctx.fs`) are flagged with the exact grep to run before writing, and instructions to skip if absent — not placeholders, but guarded claims.

**3. Consistency:** Route examples standardize on `/research` or `/my-route`; model on `gpt-5-mini`; the AP run body `{route, input:{messages}}` and resume body `{interrupt_id, decision}` are stated once in the source-of-truth list and reused verbatim across Tasks 3/12. New-page set (configuration, workspace, permissions, context-management, observability) is consistent between Phase 2 and Task 16's nav/cross-link list.

**Scope note:** Phase 1 (Tasks 1–9) is the urgent, ship-first batch (correctness — these actively break/mislead). Phase 2 (Tasks 10–15) is the larger gap-filling effort and can be a separate PR if desired. Each phase is independently shippable.
