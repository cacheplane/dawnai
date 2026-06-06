# `@dawn-ai/testing` fixture files + live mode + scaffold (Design)

**Status:** Approved for planning
**Date:** 2026-06-06
**Roadmap:** Testing Track 2 (productization). Follows the capability-coverage increment ([PR #194](https://github.com/cacheplane/dawnai/pull/194)). Moves `@dawn-ai/testing` toward a productized, fixture-based e2e suite users can build for their own agents. **Drift detection is explicitly deferred to a future phase** (per the user decision recorded in `project_phase_status.md`).

## Problem

`@dawn-ai/testing` ships a strong mocked harness (in-process / http-inject / subprocess, `script()` builder, capability matchers, capability coverage). But three gaps block a fully productized, fixture-based e2e story:

1. **The record→commit→replay loop is open.** `record()` *writes* a `*.fixture.json` from a real model, but nothing *loads* one back into the harness, and `script()` only produces in-memory fixtures. Users can't durably commit fixtures and replay them.
2. **No live-model validation.** Every harness mode mocks the model. Teams occasionally want to run a scenario against the *real* model (does it still call the right tool / produce a sane answer) — without exact-arg assertions.
3. **No scaffold adoption.** A new Dawn app (`create-dawn-app`) ships no example test, so users don't start with a working suite.

This increment closes all three. It is package + scaffold work only — **no framework changes** (the runtime, capability activation, and aimock journal already provide everything needed).

## Verified facts (against the current code + aimock 1.28)

- **`record()`** (`packages/testing/src/record.ts`) shells the aimock recorder (`llmock --record --provider-openai <url> --out <file>`), writing a committed fixture JSON. Local-only.
- **No fixture-file loader exists.** `startAimock`/`addFixtures` consume an in-memory `AimockFixture[]`; `createAgentHarness({ fixtures })` and `h.run({ fixtures })` accept a `FixtureSet | ScriptBuilder`. The deleted (#193 T17) repo-level runner read committed files as `JSON.parse(...).fixtures`.
- **aimock proxy/record mode:** `LLMock` (`MockServerOptions`/`RecordConfig`) supports proxying unmatched requests to a real upstream provider (the types include a "proxy unmatched requests" option and a `RecordConfig` with `provider`). In proxy mode aimock still records each request in its journal (`getRequests()`), so `systemPrompt` capture continues to work. (Exact option names confirmed during implementation against the installed `@copilotkit/aimock` `.d.ts`.)
- **systemPrompt capture** (harness): the harness reads the per-turn `system`/`developer`-role text from `AimockHandle.getRequests()`. This works for any mode where the app's model traffic flows through aimock — including proxy mode.
- **`create-dawn-app`** scaffolds via `@dawn-ai/devkit`'s `resolveTemplateDir`/`writeTemplate` from `packages/devkit/templates/app-basic/` (template files use `.template` suffix for package.json/tsconfig/etc). The basic template has a `src/app/(public)/hello/[tenant]/` route with a `greet` tool and no test.
- **No committed fixture files anywhere** in the repo; Dawn's own dogfood uses inline `script()`. This increment does NOT change that — fixture files are a shipped capability for users.
- CI has no `OPENAI_API_KEY` secret and no nightly cron; the existing real-LLM test (`run-agent-protocol.test.ts`) is `skipIf(!process.env.OPENAI_API_KEY)`.

## Architecture

All additions are in `@dawn-ai/testing` + the scaffold template. Backward-compatible.

### 1. Fixture-file loop — `loadFixtures` / `writeFixtures`

New module `packages/testing/src/fixture-file.ts`:

- **`loadFixtures(path: string): FixtureSet`** — reads a committed fixture JSON and returns a `FixtureSet` (i.e. `AimockFixture[]`) that plugs straight into `createAgentHarness({ fixtures })` or `h.run({ fixtures })`. Accepts both shapes: `{ fixtures: [...] }` (the wrapper `record()` and the old runner used) and a bare `[...]` array. Throws a clear error if the file is missing or not valid fixture JSON.
- **`writeFixtures(path: string, fixtures: FixtureSet | ScriptBuilder): void`** — serializes inline fixtures to a committed file as `{ fixtures: [...] }` (pretty-printed, stable key order for reviewable diffs). Complements `record()`'s real-model→file path with an author-inline→file path.

Together with the existing `record()`, this is: **author (`script()`) or record (`record()`) → `writeFixtures`/recorder → commit → `loadFixtures` → replay**. CI policy unchanged: replay is read-only; `record()` is local-only.

### 2. Live mode — aimock proxy-record

`createAgentHarness({ live: true })` runs the agent against the **real** model while keeping aimock in the path as a recording proxy, so `systemPrompt` is retained.

- The harness starts aimock in **proxy mode** (forward unmatched requests to the real OpenAI upstream), sets `OPENAI_BASE_URL` → aimock (as today), and **keeps the real `OPENAI_API_KEY`** intact (not dummied) so aimock's proxy can authenticate upstream (header passthrough). Any `fixtures` passed are ignored in live mode (the real model responds); a debug-gated warning notes they're ignored.
- **Real responses + journal:** because traffic still flows through aimock, `getRequests()` is populated → `run.systemPrompt` works live, and `run.toolCalls`/`finalMessage`/`state` reflect the real model.
- **Guard:** `createAgentHarness({ live: true })` throws a clear error if `OPENAI_API_KEY` is absent (so a misconfigured live test fails loudly, not silently against a dead proxy).
- **Assertion guidance (docs, not enforced):** real models are nondeterministic — assert loosely (`expectToolCalled`, `expectFinalMessage().toContain/.toMatch`, `expectSystemPrompt`, `expectNoInterrupt`), not exact tool args.
- **Gated, never in CI:** the live smoke test is `it.skipIf(!process.env.OPENAI_API_KEY)(...)`. CI has no key secret, so it skips there. Local/manual only; the seed for a future nightly phase.

Implementation note: `startAimock` gains a `proxy?: { upstream: string }` (or `live: true`) option that configures `LLMock`'s proxy/record passthrough. The harness's existing per-turn journal-slice + `systemPromptFromRequests` logic is reused unchanged.

### 3. Scaffold sample test

In `packages/devkit/templates/app-basic/`:
- Add `test/agent.test.ts.template` — a sample using `createAgentHarness` + `script()` + a matcher against the template's `hello/[tenant]` route (confirm the route key + how a `[tenant]` param is supplied via the harness during implementation; if a parameterized route is awkward, the sample targets it with a concrete tenant value or the template gains a trivial non-parameterized agent route for the sample).
- Add `@dawn-ai/testing` to `package.json.template` devDependencies and a `"test": "vitest run"` script.

Result: `create-dawn-app` produces an app with a **passing example agent test** out of the box.

### 4. Docs

Extend the testing guide (`apps/web/content/docs/testing-agents.mdx`):
- **Fixtures workflow:** author with `script()` or record with `record()` → `writeFixtures` → commit → `loadFixtures` → replay. CI replays read-only.
- **Live mode:** `createAgentHarness({ live: true })`, what it does (proxy-record), the real-model assertion caveats, and that it's gated/local-only.
- **Scaffold:** "your new app already has `test/agent.test.ts` — here's how to grow it."

## Public API additions (all from the barrel)

```ts
loadFixtures(path: string): FixtureSet
writeFixtures(path: string, fixtures: FixtureSet | ScriptBuilder): void
// createAgentHarness options gains: live?: boolean
```

## Error handling / edge cases

- **`loadFixtures` on a missing/invalid file** → throws naming the path + reason.
- **`writeFixtures`** creates parent dirs as needed; pretty-prints for reviewable diffs.
- **`live: true` without `OPENAI_API_KEY`** → throws at construction (loud, not a silent dead proxy).
- **`live: true` with `fixtures`** → fixtures ignored; debug-gated warning.
- **Live-mode determinism** → not enforced in code; docs steer to loose assertions. The live smoke uses loose matchers only.
- **Backward compatibility** → `loadFixtures`/`writeFixtures` are new; `live` is an optional harness flag defaulting to the existing mocked behavior. No existing test changes.

## Testing

- **Unit (`@dawn-ai/testing`):** `loadFixtures` parses both `{fixtures:[...]}` and bare-array shapes + errors on bad input; `writeFixtures` round-trips (`loadFixtures(writeFixtures(x)) === x`) and accepts a `ScriptBuilder`; `createAgentHarness({ live: true })` throws without a key (mock `process.env`). The proxy wiring of `startAimock({ proxy })` is unit-tested by asserting the `LLMock` proxy config is set (no real upstream call).
- **Integration (mocked, CI):** a fixture round-trip e2e — `writeFixtures(script()…)` to a temp file → `loadFixtures` → run through the harness → assert (proves committed fixtures replay).
- **Live smoke (gated, NOT in CI):** `it.skipIf(!process.env.OPENAI_API_KEY)` runs one scenario via `createAgentHarness({ live: true })` against the real model and asserts loosely (`expectToolCalled`, `expectFinalMessage`, `expectSystemPrompt` non-empty). Confirmed locally with the repo `.env` key during implementation; documented as local/manual.
- **Scaffold:** the `create-dawn-app` test (or a devkit template test) verifies the generated app includes `test/agent.test.ts` + the `@dawn-ai/testing` devDep; ideally generate the app and run its sample test once to prove it passes.

## Out of scope (explicit, deferred)

- **Drift detection** (scheduled re-record vs live API + diff) — future phase.
- **Real-model calls in CI** — the live smoke is gated and CI gets no key secret.
- **Rewriting Dawn's own dogfood to committed fixtures** — Dawn keeps inline `script()`; fixture files are a user capability.
- **A `dawn test --record` CLI** — `record()` (programmatic) is sufficient for now; a CLI wrapper is a later ergonomic.
