# `dawn verify` environment preflight — design

**Date:** 2026-07-12
**Status:** approved (brainstorm)
**Topic:** Extend the existing `dawn verify` command with environment/runtime preflight checks (Node version, Docker daemon, provider-derived API keys) so "why won't it start" is answered in one place — **without adding a new CLI command**.

## Problem

`dawn check` validates config/descriptors; `dawn verify` validates *app integrity* (app root, routes, typegen, deps). Neither verifies the **environment** the app will actually run in:
- No **Node-version** assertion exists anywhere at runtime, yet the real floor is 22.13.0 (below it `node:sqlite` — used by `@dawn-ai/sqlite-storage`/`@dawn-ai/memory` — needs an experimental flag and breaks).
- **Docker daemon** reachability is only probed by `dawn check`, and only when a sandbox provider is configured — not part of `verify`.
- `dawn verify`'s deps check *does* flag missing env vars, but via a **hardcoded** `RECOMMENDED_ENV_VARS = ["OPENAI_API_KEY"]` (`check-dependencies.ts`) — it always nags about `OPENAI_API_KEY` regardless of which provider the app uses, and never checks the key the app *does* need (e.g. `ANTHROPIC_API_KEY`).

**Decision (locked):** do NOT add a `dawn doctor` command — keep the CLI surface minimal. Fold these checks into `dawn verify`.

## Goal

`dawn verify` gains environment readiness as part of its existing `checks[]` model: a new **`runtime`** check (Node + Docker) and a fixed, provider-aware **`deps` env-var** check. Same `--json` output, same counts, same exit semantics. A green `dawn verify` should mean "this app will boot in this environment."

## Non-goals

- No new command; no interactive UI; no separate colored output system (verify has its own line-based output + `--json`).
- Not re-validating config/descriptors (that's `dawn check`, which `verify` already shares its advisory model-id pass with).
- Not installing anything or mutating the environment.

## Architecture

Everything slots into `packages/cli/src/commands/verify.ts`'s existing check pipeline (`verifyApp` → `checks[]` → `counts` → success/failure result). New checks follow the established result-object shape (`{ name, status: "passed"|"warning"|"failed", … }`).

### 1. New `runtime` check — Node + Docker

New module `packages/cli/src/lib/verify/check-runtime.ts` returning:
```ts
interface RuntimeCheck {
  readonly name: "runtime"
  readonly node: { readonly version: string; readonly ok: boolean; readonly floor: "22.13.0" }
  readonly docker?: { readonly ok: boolean; readonly detail: string }   // present only if a sandbox provider is configured
  readonly status: "passed" | "warning" | "failed"
}
```
- **Node:** read `process.versions.node`, semver-compare to floor `22.13.0`. Below floor → `failed` (hard: `node:sqlite` genuinely breaks). This is new logic (no runtime version assert exists today).
- **Docker:** if `dawn.config.ts` configures a sandbox provider, call the provider's `preflight()` (the same `{ ok, detail, warnings? }` contract `dawn check` uses via `collect-sandbox-errors.ts`). Unreachable daemon → `failed` (the app can't run sandboxed). If no sandbox is configured, omit the docker sub-check entirely (don't nag about Docker an app doesn't use). Reuse the provider preflight; do not reimplement the `docker version` probe.

Distinction from `dawn check`: check runs the sandbox preflight only as config validation; verify frames Docker as an **environment-readiness** gate and reports it in the integrity result.

### 2. Fix the `deps` env-var check to be provider-aware

`packages/cli/src/lib/verify/check-dependencies.ts` currently hardcodes `RECOMMENDED_ENV_VARS = ["OPENAI_API_KEY"]`. Replace with a **provider → key-env-var table** and derive the required set from the providers the app's routes actually use:
- Add a `providerEnvVar(provider)` map (`openai→OPENAI_API_KEY`, `anthropic→ANTHROPIC_API_KEY`, `google→GOOGLE_API_KEY`/`GEMINI_API_KEY`, `mistral→MISTRAL_API_KEY`, `groq→GROQ_API_KEY`, `xai→XAI_API_KEY`, `openrouter→OPENROUTER_API_KEY`; `ollama` → none). Base it on `providerSpecs` in `chat-model-factory.ts:12-22` (single source; export or mirror it).
- Determine which providers the app uses by inferring the provider from each route's `model` id (the same `inferProvider`/discovery `dawn check` already does — `verify` already builds the route manifest). Union → required key env vars.
- Missing a required key → same `warning` the deps check already emits (keep it a warning, not a hard fail — a key may legitimately come from the runtime environment; matches current behavior). Keep the existing env-file resolution (`--env-file` > config env > `./.env`).
- Result: verify stops nagging about `OPENAI_API_KEY` for an Anthropic-only app, and correctly flags the key the app actually needs.

### 3. Wire into `verifyApp`

Add the `runtime` check to the `checks[]` produced by `verifyApp`, and update `VerifyCheckResult` union + the human-readable summary in `runVerifyCommand` (a `Runtime: Node <v> OK` / `Docker: reachable` line; warnings for missing keys as today). `--json` gains the new check objects automatically (they're in `checks[]`). Exit: a `failed` runtime check fails verify (non-zero), consistent with existing failed checks.

## Interaction with the error-code registry

Once the error-code registry (separate spec) lands, the runtime check's failure messages adopt codes (e.g. `DAWN_E5101 Node too old`, `DAWN_E2002 Docker unreachable`). This spec does not depend on the registry — if built first, add codes as a fast-follow; if the registry is built first, use codes from the start.

## Error handling / edge cases

- Node floor check must not itself require Node ≥22.13 to run (it runs on whatever Node invoked the CLI) — pure `process.versions.node` string compare, no `node:sqlite` import in the check.
- Docker preflight already handles "daemon not running" → `{ ok:false, detail }`; surface `detail` verbatim.
- An app with no routes / no models → no required keys (skip the provider-key derivation gracefully).
- `--json` consumers: new fields are additive; existing `checks[]` entries unchanged.

## Testing

- Unit (`check-runtime`): Node below/at/above floor → failed/passed; docker sub-check present only when a sandbox provider is configured (inject a fake provider with a stub `preflight()` returning ok/not-ok).
- Unit (`check-dependencies`): an Anthropic-only fixture app → requires `ANTHROPIC_API_KEY`, does NOT flag `OPENAI_API_KEY`; an OpenAI app → requires `OPENAI_API_KEY`; multi-provider → union; ollama-only → no key required. Env-file resolution still honored.
- Integration (`verify-command` test): `dawn verify --json` on a fixture includes the `runtime` check; a stale Node (mock `process.versions.node`) fails verify; the human summary prints the runtime line.
- Full `@dawn-ai/cli` suite stays green (additive checks; existing verify tests updated for the new check count).

## Rollout

One PR. Changeset: **patch** for `@dawn-ai/cli` (and `@dawn-ai/langchain` if `providerSpecs`/`providerEnvVar` is exported from there). Docs: update `cli.mdx`'s `verify` section + `configuration.mdx`/`getting-started` to mention `dawn verify` as the preflight. Build after the error-code registry (to emit codes) but independently shippable.
