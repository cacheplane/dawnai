# `@dawn-ai/testing` API Consistency Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `@dawn-ai/testing`'s lifecycle surface — one factory verb (`create*`), one teardown (`close()` + `[Symbol.asyncDispose]`) on every handle.

**Architecture:** One PR off `feat/testing-api-dx` (spec: `docs/superpowers/specs/2026-06-17-testing-api-dx-design.md`). Mechanical renames + additive `[Symbol.asyncDispose]`, fully contained to `@dawn-ai/testing` (src + its own tests) and one docs file. No behavior change. Two tasks: X1 renames+dispose+tests (package green); X2 docs+changeset+PR.

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space, ESM `.js` specifiers), pnpm, Vitest, Biome, changesets.

**Conventions:** `pnpm -r build` once at start. Run `pnpm -r --if-present typecheck` before declaring done. `pyenv: cannot rehash` output is harmless noise. The renames break the package's own tests immediately, so src + tests are updated together in X1 to keep the package green.

**The rename map (apply consistently):**
| Old | New |
|---|---|
| `startAimock` | `createAimock` |
| `AimockHandle` (type) | `Aimock` |
| `AimockHandle.stop()` | `.close()` |
| `startSubprocessApp` | `createSubprocessApp` |
| `SubprocessApp.stop()` | `.close()` |
| `injectAgentProtocol` | `createAgentProtocolInjector` |

`SubprocessApp`, `AgentProtocolInjector`, `InjectResult`, `AgentHarness` type names unchanged. The `create*Harness` trio (workspace/tool/middleware) already conformant.

**asyncDispose insertion pattern:** each lifecycle return-object is an object literal. Add this method (it references the object's own `close`):
```ts
[Symbol.asyncDispose](): Promise<void> {
  return this.close()
}
```
Add the matching `[Symbol.asyncDispose](): Promise<void>` line to each handle's exported interface.

---

### Task X1: renames + unified teardown + asyncDispose (package green)

**Files (src):** `packages/testing/src/aimock-runner.ts`, `subprocess.ts`, `http-inject.ts`, `harness.ts`, `index.ts`
**Files (tests):** `packages/testing/test/aimock-runner.test.ts`, `subprocess.test.ts`, `http-inject.test.ts`, `restart-persistence.test.ts` (+ any harness test that wants an `await using` assertion)

- [ ] **Step 1 — `aimock-runner.ts`:**
  - Rename the interface `AimockHandle` → `Aimock`; rename `startAimock` → `createAimock`.
  - In the interface: rename `stop(): Promise<void>` → `close(): Promise<void>` and add `[Symbol.asyncDispose](): Promise<void>`.
  - In the returned object (line ~38): rename `async stop()` → `async close()`, and add `[Symbol.asyncDispose](): Promise<void> { return this.close() }`.
  - Internal note: the body that calls the underlying `mock.stop()` (the `@copilotkit/aimock` server's own stop) stays — only Dawn's wrapper method is renamed.

- [ ] **Step 2 — `subprocess.ts`:**
  - Rename `startSubprocessApp` → `createSubprocessApp`. Keep `SubprocessApp` type name.
  - Interface: `stop()` → `close()`; add `[Symbol.asyncDispose](): Promise<void>`.
  - Returned object (line ~97): `async stop()` → `async close()`; add the asyncDispose method.

- [ ] **Step 3 — `http-inject.ts`:**
  - Rename `injectAgentProtocol` → `createAgentProtocolInjector`. Keep `AgentProtocolInjector` / `InjectResult` type names.
  - `AgentProtocolInjector` already has `close()`. Add `[Symbol.asyncDispose](): Promise<void>` to the interface and `[Symbol.asyncDispose](): Promise<void> { return this.close() }` to the returned object (line ~42). (The inner `return {` at line ~50 is the per-inject `InjectResult` — do NOT add dispose there; only the injector handle.)

- [ ] **Step 4 — `harness.ts`:**
  - `createAgentHarness` / `AgentHarness` names unchanged. Add `[Symbol.asyncDispose](): Promise<void>` to the `AgentHarness` interface and `[Symbol.asyncDispose](): Promise<void> { return this.close() }` to the returned object (near the `async close()` at line ~182).
  - Update the two internal `aimock.stop()` calls (lines ~103, ~185) → `aimock.close()` (the wrapper method was renamed in Step 1).

- [ ] **Step 5 — `index.ts`:** update the re-exports: `startAimock`→`createAimock`, type `AimockHandle`→`Aimock`; `injectAgentProtocol`→`createAgentProtocolInjector`; `startSubprocessApp`→`createSubprocessApp`. Keep `AgentProtocolInjector`/`InjectResult`/`SubprocessApp` type exports.

- [ ] **Step 6 — update the package's own tests** to the new names + teardown:
  - `aimock-runner.test.ts`: `startAimock`→`createAimock`, `.stop()`→`.close()`.
  - `subprocess.test.ts`: `startSubprocessApp`→`createSubprocessApp`, `.stop()`→`.close()`.
  - `http-inject.test.ts`: `injectAgentProtocol`→`createAgentProtocolInjector`.
  - `restart-persistence.test.ts`: whichever of the above it uses.
  - Grep the test dir for any remaining `startAimock|startSubprocessApp|injectAgentProtocol|AimockHandle|\.stop()` on these handles and fix all.

- [ ] **Step 7 — add `await using` dispose coverage.** Add one assertion per newly-disposable handle proving `[Symbol.asyncDispose]` tears down (place in the most natural existing test file for each):
  - `createAimock`: `await using m = await createAimock({ fixtures: [] })` in a block; after the block, the server URL is no longer reachable (a `fetch` rejects) — or simpler, assert no throw and that a second explicit `close()` is idempotent. Prefer the reachability check if cheap; else the idempotency assertion.
  - `createSubprocessApp`: `await using` block; after exit, `app`'s process has exited (reuse whatever the existing stop test asserts).
  - `createAgentProtocolInjector`: `await using` block; no throw + idempotent close.
  - `createAgentHarness`: `await using h = await createAgentHarness({...})`; after the block, a follow-up `h.close()` (or aimock reachability) confirms closed. Mirror the existing `workspace-harness.test.ts` `await using` test.
  - Keep these minimal — the dispose just delegates to `close()`; the point is proving the delegation is wired.

- [ ] **Step 8 — verify:** `pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing test && pnpm --filter @dawn-ai/testing lint`. Then `pnpm -r build && pnpm -r --if-present typecheck` (no other package consumes the renamed symbols, but confirm). All green; the only failures during iteration should be the renamed-symbol references you then fix.

- [ ] **Step 9 — commit:**
```bash
git add packages/testing/src packages/testing/test
git commit -m "refactor(testing): unify on create* factories + close()/asyncDispose"
```

### Task X2: docs + changeset + verification + PR

**Files:** `apps/web/content/docs/testing-agents.mdx`, `apps/web/content/docs/testing.mdx` (conditional), `.changeset/testing-api-dx.md`

- [ ] **Step 1 — docs renames.** In `apps/web/content/docs/testing-agents.mdx` (lines ~154-157): `injectAgentProtocol` → `createAgentProtocolInjector`, `startSubprocessApp` → `createSubprocessApp`. Grep `testing.mdx` for `startAimock`/`startSubprocessApp`/`injectAgentProtocol`; rename any hits to the new names. Optionally add a one-line convention note in testing.mdx: "Every harness/handle is `create*` and tears down with `close()` (or `await using`)." Build docs: `pnpm --filter @dawn-ai/web build` (revert `apps/web/next-env.d.ts` churn).

- [ ] **Step 2 — changeset** `.changeset/testing-api-dx.md`:
```md
---
"@dawn-ai/testing": minor
---

Consistent lifecycle API. Every harness/handle is now created with a `create*` factory and torn down with `close()` (plus `[Symbol.asyncDispose]`, so `await using` works everywhere). **Breaking renames:** `startAimock` → `createAimock` (type `AimockHandle` → `Aimock`, `.stop()` → `.close()`); `startSubprocessApp` → `createSubprocessApp` (`.stop()` → `.close()`); `injectAgentProtocol` → `createAgentProtocolInjector`. The `create*Harness` helpers and pure fixture functions are unchanged.
```

- [ ] **Step 3 — full verification (report each):**
```
pnpm -r build
pnpm -r --if-present typecheck
pnpm --filter @dawn-ai/testing test
pnpm --filter @dawn-ai/testing lint
pnpm --filter @dawn-ai/web build
```
All green; testing lint exit 0 (2 pre-existing warnings only). Revert `next-env.d.ts` churn.

- [ ] **Step 4 — commit, push, PR:**
```bash
git add apps/web/content/docs/testing-agents.mdx apps/web/content/docs/testing.mdx .changeset/testing-api-dx.md
git commit -m "docs: rename testing helpers to the create*/close convention; changeset"
git push -u origin feat/testing-api-dx
gh pr create --base main --title "refactor(testing): unify lifecycle API on create* + close()/asyncDispose" \
  --body "DX-audit follow-up. Spec: docs/superpowers/specs/2026-06-17-testing-api-dx-design.md. One factory verb (create*), one teardown (close() + Symbol.asyncDispose) across @dawn-ai/testing. Renames: startAimock->createAimock (AimockHandle->Aimock, stop->close), startSubprocessApp->createSubprocessApp (stop->close), injectAgentProtocol->createAgentProtocolInjector. Contained to the testing package + docs; no external consumers."
```
Then enable auto-merge: `gh pr merge feat/testing-api-dx --auto --squash` (report outcome).
