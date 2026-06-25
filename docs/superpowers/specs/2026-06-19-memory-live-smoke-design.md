# Long-Term Memory — Local Smoke + E2E Test Plan (Design)

**Status:** Approved (design phase) — 2026-06-19
**Subject:** Live/local verification of the long-term memory feature merged in PR #250.
**Branch:** `test/memory-live-smoke`.

## Goal

Verify the merged long-term memory feature against a **real model, locally**, covering the behaviors the existing aimock-deterministic tests cannot: whether a real model actually *calls* `remember`/`recall` and *heeds* injected memory, the human candidate→approve→recall loop through the real `dawn memory` CLI, and the full `dawn dev` / Agent-Protocol experience. Two deliverables: a **gated live-smoke vitest suite** (repeatable local regression) and a **manual session runbook** (hands-on eyeballing of the dev-server/CLI UX).

## Background & constraints

- Memory is **merged but unpublished** (ships in the unreleased `0.8.3`); a real `npm create dawn-ai-app@latest` pulls `0.8.2` (no memory). **All local vehicles use the local monorepo build** — the harness (live mode) for the suite, and `--mode internal` scaffolding for the manual session.
- `OPENAI_API_KEY` lives in `/Users/blove/repos/dawn/.env`, **authorized for LOCAL live smokes only — never CI, never printed.**
- The aimock-deterministic tests already prove the *logic* (store CRUD/tokenize/namespace/reconcile, capability wiring, typegen, the cross-thread e2e). This plan does **not** duplicate them; it adds real-model behavior + integration coverage.
- **`memory.writes` is app-wide** in `dawn.config.ts` (no per-route override). So auto-mode and candidate-mode scenarios require **separate fixture apps** (or the manual research app, which defaults to candidate).
- The probe app (`packages/testing/test/fixtures/probe-app`) has `memory: { writes: "auto" }` and a `/memory-chat` route with `memory.ts` (scope `["route"]`).

## Assertion strategy (decided)

Real-model output is non-deterministic, so the suite asserts on **deterministic surfaces**, using the model only as the driver:
- **Tool was called** — `expectToolCalled(run, "remember"|"recall")` (the model chooses to; we assert structurally).
- **Store / CLI state** — a row exists with the expected `status`/`namespace`/`data`; the `recall` tool's *output string* contains the stored fact.
- **Loose final-answer checks** — `finalMessage` contains the recalled value, tolerant of phrasing.
Determinism comes from the store, not the model's wording. Mild behavioral reliance ("model decides to call `remember` when asked") is accepted; richer behavioral judgment lives in the manual runbook.

## Deliverable 1 — Gated live-smoke suite

`packages/testing/test/memory-live.smoke.test.ts`, `it.skipIf(!process.env.OPENAI_API_KEY)`, never wired into any CI lane. Vehicle: `createAgentHarness({ live: true })` (proxies to real OpenAI) against probe fixture routes, plus `runMemoryCommand(...)` called programmatically for the CLI loop. Each test cleans its `.dawn/memory.sqlite` (and `-wal`/`-shm`) before/after, like the existing `memory-e2e` test.

**Scenarios (auto-mode, probe-app unless noted):**
1. **Remember round-trip** — prompt the agent to remember a fact; assert `remember` was called, a row exists in the store (active, correct namespace + `data`).
2. **Recall** — a fresh harness run (new thread) asks a question; assert `recall` was called, its output contains the stored fact, and `finalMessage` reflects it. (Cross-thread persistence + recall in one.)
3. **Supersession** — remember a contradicting value for the same `(subject,predicate)`; assert the prior row is `superseded` and the new one is `active` with the new value.
4. **Namespace isolation** — a second probe route `/memory-other` (auto) cannot `recall` a memory written under `/memory-chat` (different route-scoped namespace); assert recall output is empty / does not contain the other route's fact.
5. **Memory-index injection** — after a memory exists, assert `run.systemPrompt` contains the injected memory index (the `# Long-Term Memory` block listing the memory).
6. **Candidate → approve → recall (CLI loop)** — against a dedicated **candidate fixture app** (`writes: "candidate"`): agent `remember` writes a candidate (assert `status:"candidate"`, recall returns nothing); `runMemoryCommand(["approve", id], …)` flips it to active; a subsequent recall surfaces it. Also exercise `reject`/`forget` (a rejected candidate is gone).

**Fixtures to add:**
- `packages/testing/test/fixtures/probe-app/src/app/memory-other/{index.ts,memory.ts}` — second auto route for isolation.
- `packages/testing/test/fixtures/probe-app-memory-candidate/` — a minimal app (`package.json`, `dawn.config.ts` with `memory:{writes:"candidate"}`, `src/app/notes/{index.ts,memory.ts}`) for the candidate-governance scenario.

## Deliverable 2 — Manual session runbook

`docs/superpowers/runbooks/2026-06-19-memory-live-smoke-runbook.md` — a committed, copy-pasteable checklist:
1. Scaffold a research app from the local monorepo: `node packages/create-dawn-app/dist/bin.js /tmp/mem-smoke --mode internal --template research` (or the documented internal-scaffold path), `pnpm install`, `pnpm build`.
2. Load the key locally: `set -a; . /Users/blove/repos/dawn/.env; set +a` (never echo it). `dawn check`, then `dawn dev --port 2024`.
3. Drive `/research#agent` over the Agent Protocol (`POST /threads` → `POST /threads/:id/runs/wait` with `{"route":"/research#agent","input":{"messages":[…]}}`): prompt it to remember a vetted source/preference, then in a **new thread** ask it to recall.
4. Inspect with the real CLI: `dawn memory list` (see the candidate the research app produced — it defaults to `candidate`), `dawn memory inspect <id>`, `dawn memory approve <id>`; re-run a recall thread and confirm the approved memory surfaces. Try `reject`/`forget`.
5. Eyeball what the suite can't: open `.dawn/memory.sqlite` (or `dawn memory list`) to see namespaces; confirm the **system prompt** carries `workspace/AGENTS.md` + the route `memory.md` + the memory index together (via a debug print or the dev-server logs); confirm the agent *heeds* `memory.md` guidance.
6. Checklist of pass/fail observations per aspect.

## Coverage matrix

| Aspect | aimock-covered (not duplicated) | Live suite | Manual |
|---|---|---|---|
| Route `memory.md` injection | structure | — | model *heeds* it |
| `recall`/`remember` typed tools | typegen + capability | model *calls* them (1,2) | ✓ |
| Candidate→approve→recall (CLI) | candidate write | ✓ (6, candidate fixture app) | ✓ real CLI on research app |
| Auto supersession | reconcile + capability | ✓ (3) | — |
| Namespace isolation | store search | ✓ (4) | ✓ |
| Cross-thread persistence | memory-e2e | ✓ (2) | ✓ |
| Memory-index injection | fragment defined | ✓ (5, systemPrompt) | model uses it |
| AGENTS.md interplay | — | — | ✓ coexist in prompt |

## Safety rails

- Every suite test is `it.skipIf(!process.env.OPENAI_API_KEY)`; **not added to any CI workflow/lane** (CI has no key secret → all skip, but we also do not register the file in any harness lane that could force it).
- Key is sourced from `.env` for local runs only and **never echoed** to stdout/logs/commit.
- Each test cleans its `.dawn/memory.sqlite*` to avoid cross-run state.
- The runbook scaffolds into `/tmp` (or an ignored dir) and reminds the operator not to print the key.

## Out of scope

- Per-route `memory.writes` (a feature change) — candidate vs auto handled via separate fixture apps.
- Vector/semantic recall, episodic/procedural kinds, the dev Memory Inspector UI (all deferred features).
- Automating the manual dev-server/HTTP session (the suite uses the in-process harness, not a spawned `dawn dev`).
- Any change to CI.

## Implementation phasing

1. Probe fixtures: `/memory-other` route + the `probe-app-memory-candidate` app.
2. The gated live-smoke suite (scenarios 1–6), verified locally with the key, confirmed to **skip** cleanly without it.
3. The manual runbook doc.
4. A short note in the memory docs page pointing to the runbook for local verification.
