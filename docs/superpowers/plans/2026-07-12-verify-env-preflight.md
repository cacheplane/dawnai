# `dawn verify` environment preflight — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Follow TDD.

**Goal:** Extend `dawn verify` (no new command) with a `runtime` check (Node ≥ 22.13.0 + Docker daemon when a sandbox is configured) and fix the hardcoded `OPENAI_API_KEY` deps check to be provider-derived.

**Architecture:** New checks slot into `verify.ts`'s existing `verifyApp → checks[] → counts` pipeline, sharing its `--json`/exit semantics.

**Spec:** `docs/superpowers/specs/2026-07-12-verify-env-preflight-design.md`

**Conventions:** `src`→`.js` / `test`→`.ts`; `exactOptionalPropertyTypes` → conditional-spread; `pnpm --filter @dawn-ai/cli lint`; changeset **patch**.

---

## Task 1: `runtime` check — Node version + Docker daemon

**Files:**
- Create: `packages/cli/src/lib/verify/check-runtime.ts`
- Test: `packages/cli/test/check-runtime.test.ts`

- [ ] **Step 1: Failing test** — `checkRuntime({ nodeVersion, sandboxProvider })`:
  - `nodeVersion: "22.12.5"` → `node.ok === false`, `status: "failed"`, `floor: "22.13.0"`.
  - `nodeVersion: "22.14.0"` → `node.ok === true`.
  - `sandboxProvider` with a stub `preflight()` → `{ ok: false, detail: "..." }` → `docker.ok === false`, `status: "failed"`; `{ ok: true }` → `docker.ok === true`.
  - No `sandboxProvider` → `docker` field absent, status driven by Node only.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `check-runtime.ts`:

```ts
import type { SandboxProvider } from "@dawn-ai/workspace"
const NODE_FLOOR = "22.13.0"
export interface RuntimeCheckResult {
  readonly name: "runtime"
  readonly node: { readonly version: string; readonly ok: boolean; readonly floor: string }
  readonly docker?: { readonly ok: boolean; readonly detail: string }
  readonly status: "passed" | "warning" | "failed"
}
function gte(a: string, b: string): boolean { /* pure numeric semver compare of MAJOR.MINOR.PATCH */ }
export async function checkRuntime(input: {
  readonly nodeVersion?: string
  readonly sandboxProvider?: Pick<SandboxProvider, "preflight" | "name">
}): Promise<RuntimeCheckResult> {
  const version = input.nodeVersion ?? process.versions.node
  const nodeOk = gte(version, NODE_FLOOR)
  const node = { version, ok: nodeOk, floor: NODE_FLOOR }
  let docker: RuntimeCheckResult["docker"]
  if (input.sandboxProvider?.preflight) {
    const r = await input.sandboxProvider.preflight()
    docker = { ok: r.ok, detail: r.detail ?? (r.ok ? "reachable" : "unreachable") }
  }
  const failed = !nodeOk || docker?.ok === false
  return { name: "runtime", node, ...(docker ? { docker } : {}), status: failed ? "failed" : "passed" }
}
```
   VERIFY the `SandboxProvider.preflight` return shape (`{ ok, detail?, warnings? }`) in `packages/workspace/src/sandbox-types.ts`. Write `gte` as a pure MAJOR.MINOR.PATCH compare (no deps); test it on `22.9.0`/`22.13.0`/`22.13.1`/`23.0.0`.
- [ ] **Step 4: Run → pass**; `pnpm --filter @dawn-ai/cli typecheck && lint`.
- [ ] **Step 5: Commit** `feat(cli): checkRuntime — Node floor + Docker daemon probe for verify`.

---

## Task 2: Provider-derived API-key check (fix the hardcoded OPENAI_API_KEY)

**Files:**
- Modify: `packages/cli/src/lib/verify/check-dependencies.ts`
- Possibly modify: `packages/langchain/src/chat-model-factory.ts` (export `providerSpecs`/a `providerEnvVar` map) — or add the map in cli
- Test: `packages/cli/test/check-dependencies.test.ts` (extend)

- [ ] **Step 1: Failing test** — `checkDependencies` on a fixture whose route model is an Anthropic id → `missingEnvVars` includes `ANTHROPIC_API_KEY` (when unset) and does NOT include `OPENAI_API_KEY`; an OpenAI app → `OPENAI_API_KEY`; a multi-provider app → the union; an ollama-only app → none. Env-file resolution still honored (set the key in a temp `.env` → not missing).
- [ ] **Step 2: Run → fail** (current code hardcodes `["OPENAI_API_KEY"]`).
- [ ] **Step 3: Implement:**
  - Define `PROVIDER_ENV_VAR: Record<string,string>` (`openai→OPENAI_API_KEY`, `anthropic→ANTHROPIC_API_KEY`, `google→GOOGLE_API_KEY`, `mistral→MISTRAL_API_KEY`, `groq→GROQ_API_KEY`, `xai→XAI_API_KEY`, `openrouter→OPENROUTER_API_KEY`; omit `ollama`). Source the provider list from `chat-model-factory.ts:providerSpecs` — export it if not already, else mirror with a comment pointing at the source of truth.
  - Replace `RECOMMENDED_ENV_VARS` with: infer each route's provider from its `model` id (reuse the SDK's `inferProvider` — grep for it; `dawn check`/the model-id validation already infer provider), union the providers, map to env vars, dedupe. Requires the route manifest — `checkDependencies` already receives app context; thread the manifest/providers in (mirror how `verify.ts` passes data to the deps check).
  - Keep it a `warning` (not failed) when a key is missing (matches current behavior); keep the env-file resolution.
- [ ] **Step 4: Run → pass**; existing `check-dependencies`/`verify` tests updated for the new behavior.
- [ ] **Step 5: Commit** `fix(cli): verify checks the API key the app actually needs (provider-derived, not hardcoded OPENAI_API_KEY)`.

---

## Task 3: Wire `runtime` into `verifyApp` + output

**Files:**
- Modify: `packages/cli/src/commands/verify.ts`
- Test: `packages/cli/test/verify-command.test.ts` (extend)

- [ ] **Step 1: Failing test** — `dawn verify --json` on a fixture includes a `checks[]` entry with `name: "runtime"`; a mocked stale `process.versions.node` makes verify exit non-zero; the human summary (non-json) prints a `Runtime: Node <v>` line.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — in `verifyApp`, call `checkRuntime({ sandboxProvider: <resolved from dawn.config sandbox, if any> })`, push its result into `checks[]`, and fold its status into `counts`/overall result (a `failed` runtime check fails verify). Add `RuntimeCheckResult` to the `VerifyCheckResult` union. In `runVerifyCommand`'s human path, print a runtime summary line. Resolve the configured sandbox provider the same way `collect-sandbox-errors.ts` does (reuse, don't duplicate).
- [ ] **Step 4: Run → pass**; full `@dawn-ai/cli` suite green (update the verify tests' expected check counts).
- [ ] **Step 5: Commit** `feat(cli): dawn verify runs the runtime/env preflight`.

---

## Task 4: Docs + changeset + PR

- [ ] **Step 1:** Update `apps/web/content/docs/cli.mdx` `verify` section (now checks env/runtime: Node floor, Docker, provider-derived keys); a one-liner in `getting-started.mdx`/`configuration.mdx` that `dawn verify` is the preflight before `dawn dev`/`dawn start`. No banned phrases; gpt-5 ids only. `node scripts/check-docs.mjs` → PASS.
- [ ] **Step 2:** `.changeset/verify-env-preflight.md` — **patch** for `@dawn-ai/cli` (+ `@dawn-ai/langchain` if `providerSpecs` was exported from it). Confirm the set via `git log … --name-only`.
- [ ] **Step 3:** Full local verify (`pnpm build && typecheck && lint && test && check-docs`); rebase, push, PR, watch `validate` + review.

**Notes:** Branch e.g. `feat/verify-env-preflight`; pin before subagent dispatch. Build after the error-code registry so runtime failures can carry `DAWN_E` codes (add them if the registry has landed; otherwise leave a follow-up note).
