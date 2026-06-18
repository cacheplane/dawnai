# `@dawn-ai/testing` API consistency pass (Design)

**Status:** Approved for planning
**Date:** 2026-06-17
**Roadmap:** DX-audit follow-up phase requested during backlog #6 (testing unit harnesses, PR #230). With three new `create*Harness` helpers landed, the testing surface mixed two factory verbs and two teardown methods and had `[Symbol.asyncDispose]` on only the newest handles. This unifies the surface so every lifecycle object is created and disposed the same way.

## Problem

Audit of `@dawn-ai/testing`'s public surface:

| Export | Handle | Teardown | `asyncDispose` |
|---|---|---|---|
| `createAgentHarness` | `AgentHarness` | `close()` | ❌ |
| `createWorkspaceHarness` / `createToolHarness` / `createMiddlewareHarness` | `*Harness` | `close()` | ✅ |
| `injectAgentProtocol` | `AgentProtocolInjector` | `close()` | ❌ |
| `startAimock` | `AimockHandle` | `stop()` | ❌ |
| `startSubprocessApp` | `SubprocessApp` | `stop()` | ❌ |
| `script` / `record` / `loadFixtures` / `writeFixtures` / `expect*` | — (pure fns) | — | — |

Three inconsistencies: two factory verbs (`create*` vs `start*` vs `inject*`), two teardown methods (`close()` vs `stop()`), and `[Symbol.asyncDispose]` on only 3 of 5 disposable handles (so `await using` works unevenly).

## Decisions (from brainstorming)

- **Full rename pass** for a single uniform scheme (user choice; no back-compat constraint — pre-1.0, fixed versioning).
- **One factory verb: `create*`.** One teardown: **`close()` + `[Symbol.asyncDispose]`** on every lifecycle handle.
- **Type names stay descriptive** (not forced to a uniform `*Harness` suffix): `Aimock`, `SubprocessApp`, `AgentProtocolInjector`, and the `*Harness` types each name a genuinely different thing.
- Pure fixture functions (`script`, `record`, `loadFixtures`, `writeFixtures`) and matchers keep their verbs — no lifecycle to unify.
- **Accepted tradeoff:** `start*`/`stop()` signaled "spawns an external process"; collapsing to `create*`/`close()` loses that call-site cue, but the descriptive type names (`Aimock`, `SubprocessApp`) still carry it.

## Verified facts (against main @ `1241d21`)

- Renamed exports are consumed ONLY within `@dawn-ai/testing` (src + its own tests) and one docs file. No `examples/chat` / eval-fixture / other-package consumers. The `.stop()` in `packages/cli/test/dev-command.test.ts` is the unrelated `DevProcessHandle` — leave it.
- `harness.ts` internally calls `aimock.stop()` at lines 103 and 185 — these must become `aimock.close()` after the AimockHandle rename.
- `apps/web/content/docs/testing-agents.mdx` references `injectAgentProtocol` and `startSubprocessApp` (lines 154-157) — must update to the new names.
- `apps/web/content/docs/testing.mdx`'s unit-harness section already uses `create*` + `await using`/`close()` — no rename needed there.
- Index exports (`packages/testing/src/index.ts`): `startAimock`/`AimockHandle`, `injectAgentProtocol`/`AgentProtocolInjector`/`InjectResult`, `startSubprocessApp`/`SubprocessApp` — update to the renamed symbols.

## Design — the renames

### 1. `aimock-runner.ts`
- `startAimock` → **`createAimock`**.
- `AimockHandle` → **`Aimock`**.
- `stop()` → **`close()`**; add `[Symbol.asyncDispose]` delegating to `close()`.

### 2. `subprocess.ts`
- `startSubprocessApp` → **`createSubprocessApp`**.
- `SubprocessApp` keeps its name (it is a spawned app).
- `stop()` → **`close()`**; add `[Symbol.asyncDispose]`.

### 3. `http-inject.ts`
- `injectAgentProtocol` → **`createAgentProtocolInjector`**.
- `AgentProtocolInjector` / `InjectResult` keep names; `close()` already present; add `[Symbol.asyncDispose]`.

### 4. `harness.ts`
- `createAgentHarness` / `AgentHarness` keep names; `close()` keeps; add `[Symbol.asyncDispose]`.
- Update the two internal `aimock.stop()` calls → `aimock.close()`.

### 5. `index.ts`
- Re-export the renamed symbols (`createAimock`/`Aimock`, `createSubprocessApp`, `createAgentProtocolInjector`).

The new trio (`createWorkspaceHarness`/`createToolHarness`/`createMiddlewareHarness`) is already conformant — no change.

### Net public surface after this pass
Every lifecycle object: `create<Noun>(…): Promise<Noun>` + `noun.close()` + `await using`. Disposable handles: `AgentHarness`, `WorkspaceHarness`, `ToolHarness`, `MiddlewareHarness`, `AgentProtocolInjector`, `Aimock`, `SubprocessApp`.

## Testing

- Update the package's own tests to the new names/teardown: `aimock-runner.test.ts` (`createAimock`, `.close()`), `subprocess.test.ts` (`createSubprocessApp`, `.close()`), `http-inject.test.ts` (`createAgentProtocolInjector`), `restart-persistence.test.ts` (whichever it uses).
- Add a focused `[Symbol.asyncDispose]` assertion for each newly-disposable handle (`createAgentHarness`, `createAimock`, `createSubprocessApp`, `createAgentProtocolInjector`) — an `await using` scope leaves the resource closed (e.g. aimock server no longer reachable / subprocess exited). Mirror the workspace-harness `await using` test.
- Full `@dawn-ai/testing` suite green after renames; no behavior change beyond method/symbol names + the additive dispose.

## Docs

- `apps/web/content/docs/testing-agents.mdx`: rename `injectAgentProtocol` → `createAgentProtocolInjector` and `startSubprocessApp` → `createSubprocessApp` (lines ~154-157).
- `apps/web/content/docs/testing.mdx`: if it references `startAimock` anywhere, rename to `createAimock`; otherwise no change. Consider a one-line note stating the convention: "every harness/handle is `create*` + `close()` (or `await using`)."

## Changeset

`@dawn-ai/testing` minor (fixed versioning bumps all). The changeset MUST flag the breaking renames explicitly: `startAimock`→`createAimock` (+ `AimockHandle`→`Aimock`, `.stop()`→`.close()`), `startSubprocessApp`→`createSubprocessApp` (`.stop()`→`.close()`), `injectAgentProtocol`→`createAgentProtocolInjector`; plus `[Symbol.asyncDispose]` added to all lifecycle handles.

## Out of scope

- Renaming the pure fixture functions/matchers (no lifecycle).
- Forcing a uniform `*Harness` type suffix (rejected — descriptive names chosen).
- Any runtime/behavior change — this is naming + additive dispose only.
