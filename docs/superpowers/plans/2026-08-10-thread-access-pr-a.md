# Thread Access PR A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `defineThreadAccess` seam — SDK types and helpers, a fail-closed policy loader, create-stamping with a reserved metadata namespace, and gates on the five thread endpoints that run no middleware today (`POST /threads`, `GET /threads/:id`, `GET /threads/:id/state`, `POST /threads/:id/cancel`, `DELETE /threads/:id`).

**Architecture:** Thread authorization is a **separate app module** from route middleware, answering a different question (*may this caller create, read, mutate or destroy this thread?*) and keyed on the thread object rather than on route identity. The published surface (`packages/sdk/src/thread-access.ts`) is types plus three tiny helpers. The runtime half splits on the `node:` boundary: a pure module (`packages/cli/src/lib/dev/thread-access.ts`) holds export selection, candidate paths, policy validation and result normalization, so `@dawn-ai/cli/fetch` can reach it; a node-only module (`thread-access-node.ts`) does `existsSync`-then-import and **throws `DAWN_E3003`** rather than degrading, so a broken policy can never boot as "no gate". Each handler builds its own gate closure from the boot-resolved policy; a hook-less app pays one closure allocation and nothing else. A server-owned stamp rides in a reserved thread-metadata key (`dawn:access`) that is stripped from client input on every create path, so a stamp cannot be forged.

**Tech Stack:** TypeScript 7, pnpm workspaces + turbo, vitest 4, Biome 2 (100 cols, double quotes, no semicolons), changesets, Next.js MDX docs under `apps/web`.

---

## Scope

**In this PR (from the spec's "Delivery slices → PR A"):** items 1–10 — the SDK surface and `DAWN_E3003`; the pure loader helpers and the node loader; the boot wiring (`RuntimeBootFallbacks.loadThreadAccess?`, `StartRuntimeServerOptions.threadAccess?`, `DawnStaticModules.threadAccess?` plus its manifest validator, the three-layer resolution and the boot log line); `thread-metadata.ts` plus the unconditional strip and the `assertNoReservedKey` wraps; the gate and the five gated endpoints; `RunRegistry.claim()`; the `POST /threads` retry and recheck; the `@dawn-ai/testing` surface; the route-table enumeration test; the `hono`/`langsmith` build failure; and the `thread-access` reference page with its nav entry, `page.tsx` and regenerated `errors.mdx`. Plus a changeset.

**Not in this PR:** gates on `/runs/stream`, `/runs/wait`, `/resume`, `/agui/:routeId`; the static-manifest emitter and its staleness guard; scaffolded `src/thread-access.ts` / `src/auth.ts` templates; the `runThreadsStoreConformance` additions; narrative docs beyond the reference page (the `middleware.mdx` and `dev-server.mdx` reconciles are PR B).

## Base-branch reality — read this before Task 1

This worktree is cut from `origin/main`. **PR #443 is not merged here.** Concretely, in this tree:

- `packages/cli/src/lib/dev/parked-route.ts` **does not exist**, so `assertNoReservedKey` wraps **three** `updateMetadata` patch builders, not five (`runtime-fetch-core.ts:1331`, `:1551`, `agui-handler.ts:254` — verified by grep).
- `GET /threads/:thread_id/pending_interrupts` **does not exist**. The route table has exactly **13** entries. The enumeration test in Task 12 therefore cannot see a 14th entry, and the spec's **"Open question for review"** (whether `/pending_interrupts` is classified *deferred* under Option A or *exempt* under Option B) **does not block this PR as cut from main**. It becomes required at the rebase — see "Post-rebase tasks" at the end of this plan. Do not decide it here; reference the spec's § Open question for review.
- `DELETE /threads/:id` has **no** `409 run_in_flight` guard, so "first in the handler" is literal.
- `packages/cli/test/pending-interrupts-endpoint.test.ts` does not exist; only the unit test `packages/cli/test/pending-interrupts.test.ts` does.

## Repo gotchas baked into every task

1. **Node 24 is mandatory.** The shell default here is v22.14.0, which makes roughly eight `dawn verify` tests fail spuriously and look pre-existing. `nvm use 24` in Task 1 and in any new shell.
2. **A fresh worktree has no `node_modules`.** `pnpm install --frozen-lockfile` then `pnpm build` before any test.
3. **Never run a bare `biome check --write`** — it mass-reformats the repo. Use `pnpm --filter <pkg> lint` (and `pnpm --filter <pkg> lint -- --write` only if you need the fixer).
4. **`noUnusedVariables` and `noUnusedImports` are errors, and organize-imports is an error.** A helper or import written one task before its first use reds the lint. The task order below is chosen so every symbol is consumed in the commit that introduces it (module-level `export`s are exempt — they are never "unused").
5. **Do not pipe pnpm output through `tail`** — it masks the exit status.
6. **The default vitest reporter swallows `console.warn` in a non-TTY shell.** Where a test needs to see stderr, add `--reporter=verbose`. (Tests here assert through `vi.spyOn` instead, which does not need it.)
7. **`check-docs.mjs` scans `.changeset/`, `packages/**`, `apps/web/**` and `docs/**` for banned phrases**, and `byte-identical` is one of them (`scripts/check-docs.mjs:355`). The spec uses that phrase freely; **your source comments, docs page and changeset must not.** Use "byte-for-byte" (already used across the repo) or "the identical bytes". `docs/superpowers/` is excluded, so this plan file itself is fine.
8. **Adding an error code requires four things at once** — the registry entry, a `DOCS_NAV` entry, `apps/web/content/docs/<slug>.mdx` **and** `apps/web/app/docs/<slug>/page.tsx`, plus a regenerated `apps/web/content/docs/errors.mdx`. The regeneration command is `pnpm docs:errors` (= `node scripts/generate-error-docs.mjs`), and it reads `packages/sdk/dist/index.js`, so **run `pnpm build` first**. All of that lands in one commit (Task 3) so no commit is left red.
9. **Changesets: patch only.** The fixed 0.x group turns a `minor` into a 1.0.0 bump for every package. **Commit the changeset before running `node scripts/check-changesets.mjs`** — that script diffs `origin/main...HEAD` and cannot see an uncommitted file.
10. **`packages/cli` cannot import `@dawn-ai/testing`.** It is not a dependency of `@dawn-ai/cli`, `.npmrc` sets `package-manager-strict=true`, and `@dawn-ai/testing` depends on `@dawn-ai/cli` (adding the reverse edge would be a build cycle). The spec's "endpoint tests through `createAgentProtocolInjector`" is therefore **not implementable from `packages/cli/test`**: those tests call `createRuntimeFetchHandler` directly (the pattern `run-cancellation.test.ts` already uses) and pass `threadAccess` through `StartRuntimeServerOptions`. The injector's new `threadAccess?` option is exercised from `packages/testing/test` instead (Task 14).

## File Structure

| File | Created / Modified | Single responsibility |
|---|---|---|
| `packages/sdk/src/thread-access.ts` | Create | The published thread-authorization contract: `ThreadAction`, `ThreadOperation`, `ThreadSubject`, `ThreadAccessRequest`, the allow/deny result union, `ThreadAccessPolicy`, and the `defineThreadAccess` / `permit` / `deny` helpers plus `THREAD_ACCESS_METADATA_KEY`. |
| `packages/sdk/src/index.ts` | Modify | Re-export the new type and value surface from the package barrel. |
| `packages/sdk/src/errors.ts` | Modify | Register `DAWN_E3003` in the E3xxx permissions band. |
| `packages/sdk/test/thread-access.test.ts` | Create | Unit-pins the helper return shapes (bare allow, bare deny, dropped `undefined` body) and the barrel re-exports. |
| `packages/sdk/test/errors.test.ts` | Modify | Pins the `DAWN_E3003` descriptor and its rendered docs URL. |
| `packages/cli/src/lib/dev/thread-access.ts` | Create | **Pure** (no `node:` imports): the one export-selection rule, the four candidate paths, policy shape validation, hook-result normalization, and the boot log line. |
| `packages/cli/src/lib/dev/thread-access-node.ts` | Create | Node-only fail-closed loader: `existsSync` decides existence, an import failure or an unusable binding throws `DAWN_E3003`. |
| `packages/cli/src/lib/dev/thread-metadata.ts` | Create | **Pure**: strip Dawn's reserved metadata key off client input; assert no runtime `updateMetadata` patch carries it. |
| `packages/cli/src/lib/dev/run-registry.ts` | Modify | Add `RunClaim` and the required `claim(threadId)` member so a cancel can bind to the run the caller observed before anything is awaited. |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | Modify | Boot resolution + boot log; the gate helpers (`isThenable`, `toThreadSubject`, `denyResponse`, `makeThreadGate`, `jsonDeepEqual`, `isRowWeJustWrote`); `threadAccess` on `buildRouteTable`'s ctx; the `claim` passthrough; the five gate insertions; the `POST /threads` strip, stamp, retry and recheck; two `assertNoReservedKey` wraps; `buildRouteTable`/`RouteMatcher` exported as the coverage-test seam. |
| `packages/cli/src/lib/dev/agui-handler.ts` | Modify | The third `assertNoReservedKey` wrap. No gate here in PR A. |
| `packages/cli/src/lib/dev/runtime-server.ts` | Modify | `StartRuntimeServerOptions.threadAccess?`. |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | Modify | `RuntimeBootFallbacks.loadThreadAccess?` (optional, unlike `loadMiddleware`) and the THROWS-vs-DEGRADES third category. |
| `packages/cli/src/lib/runtime/execute-route.ts` | Modify | Wire `loadThreadAccess` into `nodeBootFallbacks`, without which the disk probe never runs on any node path. |
| `packages/cli/src/lib/runtime/static-modules-core.ts` | Modify | `DawnStaticModules.threadAccess?` — the manifest channel, honest from day one (PR B fills it). |
| `packages/cli/src/lib/runtime/static-modules.ts` | Modify | Validate a manifest `threadAccess` entry with the re-run-`dawn build` message. |
| `packages/cli/src/lib/build/targets/thread-access-probe.ts` | Create | The shared "this target cannot carry a policy" build failure (`DAWN_E1005`). |
| `packages/cli/src/lib/build/targets/hono.ts` | Modify | Fail the build when a policy file exists. |
| `packages/cli/src/lib/build/targets/langsmith.ts` | Modify | Same, permanently. |
| `packages/cli/src/runtime-exports.ts` | Modify | Publish `normalizeThreadAccessResult` on `@dawn-ai/cli/runtime` for the testing harness. |
| `packages/cli/test/thread-access-pure.test.ts` | Create | Unit tests for the pure module: selection, candidate order, validation reasons, normalization (every malformed shape denies), boot line. |
| `packages/cli/test/thread-access-loader.test.ts` | Create | The anti-`loadMiddleware` suite: absent → `undefined`; broken/unbound → `DAWN_E3003`. |
| `packages/cli/test/thread-metadata.test.ts` | Create | Unit tests for the strip and the assertion. |
| `packages/cli/test/thread-access-boot.test.ts` | Create | Three-layer resolution, the boot log's four variants, and the manifest validator clause. |
| `packages/cli/test/thread-access-endpoints.test.ts` | Create | End-to-end endpoint behavior: the hook-less strip, every row of the deny table, the oracle-collapse assertions, stamp storage and non-create stamp rejection, malformed-per-action, throw → 500, and the create collision. |
| `packages/cli/test/thread-access-coverage.test.ts` | Create | The route-table enumeration test and the emitted-`ThreadOperation` test. |
| `packages/cli/test/thread-access-build-targets.test.ts` | Create | `dawn build --target hono|langsmith` fails with `DAWN_E1005` when a policy file exists, and is unaffected when none does. |
| `packages/cli/test/run-cancellation.test.ts` | Modify | Add the `claim()` identity cases; keep the existing 404/409 expectations unchanged. |
| `packages/testing/src/thread-access-harness.ts` | Create | `createThreadAccessHarness({ policy })` — unit-test a policy without booting a server. |
| `packages/testing/src/http-inject.ts` | Modify | `createAgentProtocolInjector({ appRoot, threadAccess? })`. |
| `packages/testing/src/index.ts` | Modify | Publish the harness. |
| `packages/testing/test/thread-access-harness.test.ts` | Create | Harness defaults, handler selection, and normalization through the real runtime function; the injector option end-to-end. |
| `apps/web/content/docs/thread-access.mdx` | Create | The reference page: API, load failures (the `DAWN_E3003` anchor), deny semantics, both enumeration-oracle warnings, the legacy-thread question and backfill script, the header-comparison rule, and the timeout warning. |
| `apps/web/app/docs/thread-access/page.tsx` | Create | The Next.js wrapper `check-docs.mjs` requires for every nav entry. |
| `apps/web/app/components/docs/nav.ts` | Modify | The `Thread Access` nav entry (`check-docs.mjs` resolves `DAWN_E3003`'s `docsPath` slug through it). |
| `apps/web/content/docs/errors.mdx` | Modify (generated) | Regenerated by `pnpm docs:errors` so the registry and the page cannot drift. |
| `.changeset/thread-access-hook.md` | Create | Patch bump for `@dawn-ai/sdk`, `@dawn-ai/cli`, `@dawn-ai/testing`, describing the one unconditional behavior change. |

---

## Task 1: Prepare the worktree

**Files:**
- None (environment only)

- [ ] **Step 1: Select Node 24**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
nvm use 24
node -v
```

Expected: `v24.x.x`. If `nvm` is not on `PATH`, run `source "$NVM_DIR/nvm.sh"` first. Do not continue on v22 — roughly eight `dawn verify` tests fail spuriously on it and look pre-existing.

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm install --frozen-lockfile
```

Expected: install completes. A fresh worktree has no `node_modules`, so this is not optional.

- [ ] **Step 3: Build every package**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm build
```

Expected: turbo reports success for all packages. Several suites resolve `@dawn-ai/*` through each package's `dist/`, so a stale or missing build produces failures that have nothing to do with your change.

- [ ] **Step 4: Record a green baseline for the two suites this PR touches**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/sdk exec vitest --run --config vitest.config.ts
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts
```

Expected: both pass. If something is already red, note it now — otherwise you will attribute it to your change later.

- [ ] **Step 5: Confirm the base-branch assumptions**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
ls packages/cli/src/lib/dev/parked-route.ts
grep -rn "pending_interrupts" packages/cli/src/
grep -n "updateMetadata" packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/src/lib/dev/agui-handler.ts
```

Expected: `parked-route.ts` reports "No such file or directory"; the `pending_interrupts` grep prints nothing; the `updateMetadata` grep prints exactly three lines (`runtime-fetch-core.ts:1331`, `runtime-fetch-core.ts:1551`, `agui-handler.ts:254`). If any of that differs, #443 has landed underneath you — stop and re-read "Post-rebase tasks" at the end of this plan before continuing.

---

## Task 2: The published SDK surface

**Files:**
- Create: `packages/sdk/src/thread-access.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/thread-access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/thread-access.test.ts`:

```ts
import { describe, expect, it } from "vitest"

import * as barrel from "../src/index.js"
import {
  defineThreadAccess,
  deny,
  permit,
  THREAD_ACCESS_METADATA_KEY,
  type ThreadAccessPolicy,
} from "../src/thread-access.js"

describe("permit", () => {
  it("returns a bare allow when no stamp is supplied", () => {
    const result = permit()
    expect(result).toEqual({ decision: "allow" })
    expect("stamp" in result).toBe(false)
  })

  it("carries the stamp when one is supplied", () => {
    expect(permit({ org: "acme", ownerId: "u-1" })).toEqual({
      decision: "allow",
      stamp: { org: "acme", ownerId: "u-1" },
    })
  })
})

describe("deny", () => {
  it("returns a bare deny with neither status nor body", () => {
    const result = deny()
    expect(result).toEqual({ decision: "deny" })
    expect("status" in result).toBe(false)
    expect("body" in result).toBe(false)
  })

  it("keeps an explicit status and body", () => {
    expect(deny({ body: { error: "nope" }, status: 403 })).toEqual({
      body: { error: "nope" },
      decision: "deny",
      status: 403,
    })
  })

  it("drops an explicitly-undefined body rather than carrying it", () => {
    // `Response.json(undefined)` throws, so a present-but-undefined body could
    // only ever express a 500. There is deliberately no such distinction.
    const result = deny({ body: undefined, status: 404 })
    expect(result).toEqual({ decision: "deny", status: 404 })
    expect("body" in result).toBe(false)
  })
})

describe("defineThreadAccess", () => {
  it("returns the policy object unchanged (identity helper, runtime no-op)", () => {
    const policy: ThreadAccessPolicy = { fallback: () => permit() }
    expect(defineThreadAccess(policy)).toBe(policy)
  })
})

describe("THREAD_ACCESS_METADATA_KEY", () => {
  it("is the reserved `dawn:access` key", () => {
    expect(THREAD_ACCESS_METADATA_KEY).toBe("dawn:access")
  })

  it("cannot be written as a JS property identifier, which is why stripping it is safe", () => {
    expect(THREAD_ACCESS_METADATA_KEY).toContain(":")
  })
})

describe("package barrel", () => {
  it("re-exports the thread-access value surface", () => {
    expect(barrel.defineThreadAccess).toBe(defineThreadAccess)
    expect(barrel.permit).toBe(permit)
    expect(barrel.deny).toBe(deny)
    expect(barrel.THREAD_ACCESS_METADATA_KEY).toBe(THREAD_ACCESS_METADATA_KEY)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/sdk exec vitest --run --config vitest.config.ts test/thread-access.test.ts
```

Expected: FAIL — the whole file fails to load with `Failed to resolve import "../src/thread-access.js"`.

- [ ] **Step 3: Write the module**

Create `packages/sdk/src/thread-access.ts`:

```ts
/**
 * Thread authorization: who may create, read, mutate, or destroy a thread.
 *
 * Deliberately NOT route middleware. Middleware answers "may this caller run
 * this route", is keyed on route identity, and receives run input. A thread has
 * no owning route by construction (LangGraph's ThreadsRead/Update/Delete
 * payloads carry no assistant_id, and Dawn's own last-run `route` metadata key
 * is swappable by anyone allowed to start any run on the thread), so gating
 * thread endpoints on route identity would be gating on the wrong axis. Two
 * concepts, two files.
 */

/** LangGraph's `threads.*` split, minus `search` (Dawn serves no thread search). */
export type ThreadAction = "create" | "read" | "update" | "delete"

/** Which endpoint asked, for policies that need finer grain than `action`. */
export type ThreadOperation =
  | "thread.create" // POST   /threads
  | "thread.get" // GET    /threads/:id
  | "thread.state" // GET    /threads/:id/state
  | "thread.delete" // DELETE /threads/:id
  | "thread.cancel" // POST   /threads/:id/cancel
  | "run.stream" // POST   /threads/:id/runs/stream
  | "run.wait" // POST   /threads/:id/runs/wait
  | "run.resume" // POST   /threads/:id/resume
  | "run.agui" // POST   /agui/:routeId

/**
 * The persisted thread as the policy sees it: the stored row, plus the server
 * stamp lifted out of the reserved metadata key.
 */
export interface ThreadSubject {
  readonly thread_id: string
  readonly created_at: string
  readonly updated_at: string
  readonly status: "idle" | "busy" | "interrupted"
  /**
   * Client-supplied metadata, verbatim and UNTRUSTED — anyone who can create a
   * thread can put anything here. Never contains the reserved key: Dawn strips
   * it on every create path. Do not authorize against this field.
   */
  readonly metadata: Readonly<Record<string, unknown>>
  /**
   * The stamp this thread's own `create` decision returned. Unforgeable.
   * `undefined` for a thread created before the policy existed, or by a
   * `permit()` with no stamp. Authorize against THIS.
   */
  readonly access: Readonly<Record<string, unknown>> | undefined
}

export interface ThreadAccessRequest {
  readonly action: ThreadAction
  readonly operation: ThreadOperation
  /**
   * `undefined` only when the runtime has no id yet: `action: "create"` on
   * `POST /threads`, whose id is server-generated. Present everywhere else,
   * INCLUDING the `action: "update"` recheck that follows every create.
   */
  readonly threadId: string | undefined
  /**
   * The persisted row. `undefined` on the first `create` call and whenever no
   * row exists — which reaches `delete`, `update` and `read` too, and is
   * deliberate: the policy is invoked on every gated request, never
   * short-circuited to the endpoint's natural 404 or 204. That is what keeps
   * "not yours" and "never existed" from being distinguishable.
   */
  readonly thread: ThreadSubject | undefined
  /**
   * Lowercase keys, repeated headers joined with ", " — the same shape route
   * middleware sees. Compare with STRICT EQUALITY: `X-User-Id: victim` plus
   * `X-User-Id: attacker` arrives as the one string `"victim, attacker"`, which
   * `includes`/`startsWith`/`split(",")` comparisons get wrong and `===` gets
   * right.
   */
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  /** Path + query, e.g. `"/threads/t-1/state"`. */
  readonly url: string
  /**
   * Client-supplied `metadata` on a create, already stripped of the reserved
   * key. `undefined` on every non-create — and on the create recheck, whose
   * metadata was already adjudicated by the create call.
   */
  readonly requestedMetadata: Readonly<Record<string, unknown>> | undefined
}

export interface ThreadAccessAllow {
  readonly decision: "allow"
  /**
   * Server-side stamp, honored on `create` ONLY (ignored elsewhere; the runtime
   * logs once per process when a non-create allow carries one). Stored under a
   * reserved metadata key the client cannot write, surfaced as
   * `ThreadSubject.access` on every later request. Must be JSON-serializable.
   *
   * It is part of the body `GET /threads/:id` returns — which your own `read`
   * policy governs, but put identifiers in it, never secrets.
   */
  readonly stamp?: Record<string, unknown>
}

export interface ThreadAccessDeny {
  readonly decision: "deny"
  /** Override the per-action default (404 for `read`, 403 otherwise). Nothing else is accepted. */
  readonly status?: 403 | 404
  /**
   * JSON body. Omitted OR `undefined` gives Dawn's default for that status.
   * There is deliberately no present-but-undefined distinction: `undefined`
   * cannot be serialized (`Response.json(undefined)` throws), so the only thing
   * such a distinction could express is a 500.
   */
  readonly body?: unknown
}

export type ThreadAccessResult = ThreadAccessAllow | ThreadAccessDeny

/**
 * One action's handler. Sync-or-async on purpose: a header-only policy that
 * returns a plain object introduces NO microtask boundary in the runtime, which
 * is what lets the `/cancel` gate run after the run claim is already bound.
 */
export type DawnThreadAccess = (
  req: ThreadAccessRequest,
) => Promise<ThreadAccessResult> | ThreadAccessResult

/**
 * The policy object. Per-action handlers mirror LangGraph's `@auth.on.threads.*`
 * split; `fallback` is REQUIRED so "I forgot to handle delete" is a type error
 * rather than a silent allow or a silent deny on every request of that action.
 */
export interface ThreadAccessPolicy {
  readonly create?: DawnThreadAccess
  readonly read?: DawnThreadAccess
  readonly update?: DawnThreadAccess
  readonly delete?: DawnThreadAccess
  /** Covers every action with no handler of its own. Required. */
  readonly fallback: DawnThreadAccess
}

/** Identity helper — runtime no-op, exists for inference. Mirrors `defineMiddleware`. */
export function defineThreadAccess(policy: ThreadAccessPolicy): ThreadAccessPolicy {
  return policy
}

export function permit(stamp?: Record<string, unknown>): ThreadAccessAllow {
  return stamp ? { decision: "allow", stamp } : { decision: "allow" }
}

export function deny(options?: {
  readonly status?: 403 | 404
  readonly body?: unknown
}): ThreadAccessDeny {
  const status = options?.status
  const body = options?.body
  return {
    decision: "deny",
    ...(status !== undefined ? { status } : {}),
    // `!== undefined`, NOT `"body" in options`: see ThreadAccessDeny.body.
    ...(body !== undefined ? { body } : {}),
  }
}

/**
 * The reserved thread-metadata key Dawn owns. A colon makes it un-typable as a
 * JS identifier and effectively absent from real app metadata, so stripping it
 * unconditionally on every create path breaks nobody. Exported for store
 * migrations, for the `dawn memory` / inspector surfaces, and for the operator
 * backfill script the docs carry — apps read the stamp through
 * `ThreadSubject.access` and never need this constant.
 */
export const THREAD_ACCESS_METADATA_KEY = "dawn:access"
```

- [ ] **Step 4: Add the barrel exports**

In `packages/sdk/src/index.ts`, insert these two statements between the `./route-types.js` block and the `./runtime-context.js` block (Biome sorts barrel exports by module specifier, and `./thread-access.js` sorts after `./runtime-context.js` — put it immediately before the `./types.js` line):

```ts
export type {
  DawnThreadAccess,
  ThreadAccessAllow,
  ThreadAccessDeny,
  ThreadAccessPolicy,
  ThreadAccessRequest,
  ThreadAccessResult,
  ThreadAction,
  ThreadOperation,
  ThreadSubject,
} from "./thread-access.js"
export { defineThreadAccess, deny, permit, THREAD_ACCESS_METADATA_KEY } from "./thread-access.js"
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/sdk exec vitest --run --config vitest.config.ts test/thread-access.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Lint and typecheck**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/sdk lint
pnpm --filter @dawn-ai/sdk typecheck
```

Expected: both clean. If Biome reports an import-order error on `index.ts`, run `pnpm --filter @dawn-ai/sdk lint -- --write` (never a bare `biome check --write`).

- [ ] **Step 7: Commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
git add packages/sdk/src/thread-access.ts packages/sdk/src/index.ts packages/sdk/test/thread-access.test.ts
git commit -m "feat(sdk): add the defineThreadAccess policy contract"
```

---

## Task 3: `DAWN_E3003` and the reference page it forces

The new registry entry trips `scripts/check-docs.mjs` twice — its `docsPath` slug must be a `DOCS_NAV` entry with **both** an `.mdx` and a `page.tsx`, and `errors.mdx` must list exactly the registry's codes. All four land here so no commit is left red.

**Files:**
- Modify: `packages/sdk/src/errors.ts`
- Modify: `packages/sdk/test/errors.test.ts`
- Create: `apps/web/content/docs/thread-access.mdx`
- Create: `apps/web/app/docs/thread-access/page.tsx`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify (generated): `apps/web/content/docs/errors.mdx`

- [ ] **Step 1: Write the failing test**

In `packages/sdk/test/errors.test.ts`, add this `it` block inside the existing `describe("DAWN_ERRORS registry", ...)`, immediately after the `"registers delegation policy, denial, and dispatch failure errors"` block:

```ts
  it("registers the thread access load failure in the permissions band", () => {
    expect(DAWN_ERRORS.DAWN_E3003).toEqual({
      code: "DAWN_E3003",
      title: "Thread access policy failed to load",
      docsPath: "/docs/thread-access#load-failures",
    })
    expect(errorDocsUrl("DAWN_E3003")).toBe("https://dawnai.org/docs/thread-access#load-failures")
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/sdk exec vitest --run --config vitest.config.ts test/errors.test.ts
```

Expected: FAIL. TypeScript reports `Property 'DAWN_E3003' does not exist`, and the assertion fails with `expected undefined to deeply equal { code: 'DAWN_E3003', … }`.

- [ ] **Step 3: Add the registry entry**

In `packages/sdk/src/errors.ts`, insert immediately after the `DAWN_E3002` entry (which currently ends the E3xxx band) and before `DAWN_E4001`:

```ts
  DAWN_E3003: {
    code: "DAWN_E3003",
    title: "Thread access policy failed to load",
    docsPath: "/docs/thread-access#load-failures",
  },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/sdk exec vitest --run --config vitest.config.ts test/errors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the nav entry**

In `apps/web/app/components/docs/nav.ts`, inside the `Concepts` section, insert immediately after the `Access Control` item:

```ts
      { label: "Thread Access", href: "/docs/thread-access" },
```

- [ ] **Step 6: Add the Next.js page wrapper**

Create `apps/web/app/docs/thread-access/page.tsx`:

```tsx
import type { Metadata } from "next"
import Content from "../../../content/docs/thread-access.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Thread Access" }

export default function Page() {
  return <DocsPage href="/docs/thread-access" Content={Content} />
}
```

- [ ] **Step 7: Write the reference page**

Create `apps/web/content/docs/thread-access.mdx`. The `## Load failures` heading is load-bearing — it is the `#load-failures` anchor `DAWN_E3003` renders. Do not use the phrase "byte-identical" anywhere; `scripts/check-docs.mjs` bans it.

````mdx
# Thread Access

`src/thread-access.ts` answers one question: **may this caller create, read, mutate, or destroy this thread?**

That is a different question from the one [middleware](/docs/middleware) answers ("may this caller run this route"), and it is keyed on a different thing. A thread has no owning route: every endpoint that starts a turn overwrites the thread's `route` metadata, so any caller allowed to run any route on a thread can move that identity onto a route of their choosing. Thread authorization is therefore keyed on the thread object, and lives in its own file with its own failure policy.

Without a policy file, every thread endpoint is open to anyone who can name a thread id — and ids are neither secret nor collision-proof (`t-` plus four random bytes). This page is how you close that.

## The shape

```ts title="src/thread-access.ts"
import { defineThreadAccess, deny, permit, type ThreadAccessRequest } from "@dawn-ai/sdk"
import { principalOf } from "./auth.js" // shared with src/middleware.ts

const owned = async (req: ThreadAccessRequest) => {
  const user = await principalOf(req.headers)
  if (!user) return deny()
  // `thread: undefined` reaches `delete` too. Denying it FIRST, ahead of the
  // admin branch, is what keeps "not yours" and "does not exist" the same
  // answer; an admin allowed to delete a row that never existed reopens the
  // existence oracle this default closes.
  if (req.thread === undefined) return deny()
  const owner = req.thread.access?.ownerId
  if (owner === undefined) return user.isAdmin ? permit() : deny() // legacy thread
  if (owner === user.id) return permit()
  if (req.action === "read" && user.isAdmin) return permit()
  return deny()
}

export default defineThreadAccess({
  create: async (req) => {
    const user = await principalOf(req.headers)
    return user ? permit({ ownerId: user.id, org: user.org }) : deny()
  },
  // Also handles the post-create `update` recheck: the row just stamped has
  // `ownerId === user.id`, so `owned` permits it; a row the store handed back on
  // an id collision carries someone else's, so `owned` denies and the caller
  // never receives a thread they do not own.
  fallback: owned,
})
```

Dawn probes four paths, in order: `src/thread-access.ts`, `src/thread-access.js`, `thread-access.ts`, `thread-access.js`. The `default` export wins; a named `threadAccess` export is the fallback.

`fallback` is required. "I forgot to handle delete" is a compile error rather than a silent allow — or a silent deny — on every request of that action.

## What the policy receives

| Field | Notes |
|---|---|
| `action` | `"create"`, `"read"`, `"update"` or `"delete"` — which handler was selected. |
| `operation` | The specific endpoint, e.g. `"thread.state"`, for policies that need finer grain than `action`. |
| `threadId` | `undefined` only on `POST /threads`, whose id is server-generated. |
| `thread` | The stored row, or `undefined` when no row exists. |
| `headers` | Lowercase keys, repeated headers joined with `", "`. |
| `method`, `url` | The originating request's method, and its path plus query. |
| `requestedMetadata` | Client-supplied metadata on a create, already stripped of Dawn's reserved key. `undefined` everywhere else. |

`thread.metadata` is client-supplied and untrusted — anyone who can create a thread can write anything into it. **Authorize against `thread.access`**, which is the stamp your own `create` decision returned. Dawn stores it under a reserved key (`dawn:access`) that it strips from client input on every create path, so a client cannot forge one, and it is lifted out of `metadata` before your policy sees the row.

`thread.access` is `undefined` for a thread created before you adopted a policy. Dawn does not guess what that should mean — decide it explicitly. The two sane answers are admin-only (the `owned` example above) or a one-time backfill (below).

### Comparing headers

Repeated headers arrive joined. `X-User-Id: victim` plus `X-User-Id: attacker` is the single string `"victim, attacker"`. That is safe under `===` and unsafe under `includes`, `startsWith` or `split(",")` — which is exactly what a hand-rolled parser reaches for. Compare with strict equality, and prefer a signed token over a trusted header wherever the deployment allows it.

## Denials

`deny()` produces **404 for a `read`, 403 for everything else**.

| Endpoint | Default deny |
|---|---|
| `POST /threads` | 403 `thread_access_denied` |
| `GET /threads/:thread_id` | 404, the same body a genuine miss returns |
| `GET /threads/:thread_id/state` | 404, the same body a missing checkpoint returns |
| `DELETE /threads/:thread_id` | 403 `thread_access_denied` |
| `POST /threads/:thread_id/cancel` | 403 `thread_access_denied` |

The read default is 404 so a denial cannot be told apart from a miss, which is what stops anyone enumerating thread ids. The 403s sit on endpoints where the caller has already named a specific thread and asked to change it.

`deny({ status, body })` overrides both. `status` accepts only `403` or `404` — a policy cannot mint a 200, a 500 or a redirect — and anything else falls back to the per-action default.

<Callout type="warning">
**A `read` handler that returns 403 tells the caller the thread exists.** `deny({ status: 403 })` on a read is legal, and it reopens the enumeration channel the 404 default closes: `GET /threads/<guessed>` becomes an existence oracle over a 32-bit id space. Dawn does not forbid it — an app that authenticates every caller and wants honest diagnostics is entitled to it — but make it a choice, not something you reach by copying the `update` branch.
</Callout>

<Callout type="warning">
**Your `delete` handler must deny when `thread` is `undefined`.** `DELETE /threads/:thread_id` returns 204 today even for a thread that never existed, so a 403 would ordinarily mean "this exists and is not yours" — a bit DELETE does not leak. Dawn keeps it that way by invoking the policy with `thread: undefined` instead of short-circuiting, so an ownership policy denies both cases identically. A policy that allows deleting unknown threads puts the oracle back.
</Callout>

The policy runs on **every** gated request, including when the row is missing. On `/state` that matters for a second reason: the checkpointer is a separate store from the threads store, so a transcript can exist for a thread whose row is gone, and skipping the gate would serve it ungated.

## Failure modes

A policy that **throws** becomes a 500 and the endpoint's real work never runs. That is fail-closed and honest — a 403 would hide a broken policy behind what looks like a working one.

A policy that returns something that is neither a well-formed allow nor a well-formed deny (a missing `return` on one branch, a copy-pasted `{ action: "continue" }`) **denies at the per-action default** and logs a warning naming the operation, the thread id and the value. It is deliberately not pinned to 403: forcing 403 on a read would make a broken policy answer differently from a working one and hand back the enumeration oracle.

A policy that **hangs** is not defended. Dawn imposes no timeout on a policy call, so a slow identity provider degrades into stuck requests. Put your own timeout around any network call in a policy and fail closed on it.

## Load failures

Route middleware that fails to import degrades to "no middleware". An authorization policy must not: a syntax error, a missing dependency or a thrown environment assertion would boot the app with every thread world-writable and no log line. So the loader decides existence with a filesystem check **before** the import, and an import failure can then only mean "the policy is broken".

- No policy file on disk — no gate, exactly today's behavior.
- A policy file that fails to import — the boot fails with `DAWN_E3003`.
- A policy file that imports but binds no usable policy — the boot fails with `DAWN_E3003`.

Four cases are distinguishable at a glance in the message: no `default` or `threadAccess` export; the bound value is not an object; `fallback` is missing or is not a function; a per-action key is present but is not a function.

There is no path on which a policy you wrote resolves to "allow everything". See [Error codes](/docs/errors).

Every boot logs which layer the policy came from, or that there is none — it is the one signal that says a policy vanished:

```
Dawn: thread access policy bound from src/thread-access.ts
Dawn: no thread access policy (all thread endpoints are open)
```

## Build targets

`dawn build --target hono` and `--target langsmith` **fail** with `DAWN_E1005` while a policy file exists. Neither runtime can carry the hook today, and a build that silently dropped it would deploy every thread endpoint ungated. The `node` target needs nothing special — its emitted server reaches the same disk probe `dawn dev` does. An app with no policy file builds for every target exactly as before. See [Deployment](/docs/deployment).

## Adopting a policy on an existing app

Threads created before the policy have `access === undefined`. Either handle that branch (admin-only is the usual answer) or backfill.

Backfill is an **operator script** that constructs the threads store directly. Every in-runtime path to the reserved key is deliberately shut: there is no HTTP endpoint for metadata updates, and the runtime asserts that none of its own metadata patches carry the key.

```ts title="scripts/backfill-thread-access.ts"
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import { createThreadsStore } from "@dawn-ai/sqlite-storage"

const store = createThreadsStore({ path: ".dawn/threads.sqlite" })
for (const thread of await store.listThreads()) {
  if (thread.metadata[THREAD_ACCESS_METADATA_KEY] !== undefined) continue
  await store.updateMetadata(thread.thread_id, {
    [THREAD_ACCESS_METADATA_KEY]: { ownerId: "operator-assigned-owner" },
  })
}
```

This is in the same class as `dawn inspect` and `dawn memory`: a local operator with filesystem or database access, documented rather than defended.

## Identifiers, never secrets

`GET /threads/:thread_id` returns the raw thread, reserved key included. That is deliberate — hiding it would break round-tripping and make the stamp undebuggable, and that endpoint is gated by the very policy the stamp feeds. Put identifiers in a stamp. Do not put anything in it whose disclosure to a caller your `read` policy admits would matter.

## What this does not cover yet

The run endpoints — `POST /threads/:thread_id/runs/stream`, `/runs/wait`, `/resume` and `POST /agui/{routeId}` — are gated by [route middleware](/docs/middleware) only. They are not yet on this policy, and a caller who can run a route on a thread can still create the row for an id of their choosing. Keep middleware doing real per-caller authorization until they are.
````

- [ ] **Step 8: Rebuild the SDK and regenerate `errors.mdx`**

`scripts/generate-error-docs.mjs` reads `packages/sdk/dist/index.js`, so the build must run first.

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm build
pnpm docs:errors
```

Expected: `[generate-error-docs] wrote 18 code(s) to …/apps/web/content/docs/errors.mdx`, and `git diff --stat apps/web/content/docs/errors.mdx` shows a one-row addition for `DAWN_E3003`.

- [ ] **Step 9: Run the docs guard**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
node scripts/check-docs.mjs
```

Expected: exits 0. A `DAWN_ERRORS.DAWN_E3003 docsPath … is not a known docs page` failure means the nav entry is missing or misspelled; a `DOCS_NAV references /docs/thread-access, but … is missing` failure means the `.mdx` or the `page.tsx` is missing; a `uses …` failure means a banned phrase reached the page.

- [ ] **Step 10: Commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
git add packages/sdk/src/errors.ts packages/sdk/test/errors.test.ts apps/web/content/docs/thread-access.mdx apps/web/app/docs/thread-access/page.tsx apps/web/app/components/docs/nav.ts apps/web/content/docs/errors.mdx
git commit -m "docs: add the thread-access reference page and register DAWN_E3003"
```

---

## Task 4: The pure loader half

Pure means **no `node:` imports at all, not even types** — `packages/cli/test/fetch-entry-purity.test.ts` and `edge-bundle-purity.test.ts` go red immediately if `existsSync` lands here instead of in `thread-access-node.ts`.

**Files:**
- Create: `packages/cli/src/lib/dev/thread-access.ts`
- Test: `packages/cli/test/thread-access-pure.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-access-pure.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"

import {
  normalizeThreadAccessResult,
  selectThreadAccessExport,
  threadAccessBootLine,
  threadAccessCandidatePaths,
  validateThreadAccessPolicy,
} from "../src/lib/dev/thread-access.js"

const noop = () => ({ decision: "allow" }) as const

describe("selectThreadAccessExport", () => {
  it("prefers a default export", () => {
    const chosen = { fallback: noop }
    expect(selectThreadAccessExport({ default: chosen, threadAccess: { fallback: noop } })).toBe(
      chosen,
    )
  })

  it("falls through a nullish default to the named threadAccess export", () => {
    const chosen = { fallback: noop }
    expect(selectThreadAccessExport({ threadAccess: chosen })).toBe(chosen)
    expect(selectThreadAccessExport({ default: undefined, threadAccess: chosen })).toBe(chosen)
    expect(selectThreadAccessExport({ default: null, threadAccess: chosen })).toBe(chosen)
  })

  it("returns undefined for a module that binds neither", () => {
    expect(selectThreadAccessExport({})).toBeUndefined()
    expect(selectThreadAccessExport(null)).toBeUndefined()
    expect(selectThreadAccessExport(undefined)).toBeUndefined()
    expect(selectThreadAccessExport("nope")).toBeUndefined()
  })

  it("returns a non-object default rather than swallowing it, so the validator can report it", () => {
    expect(selectThreadAccessExport({ default: "nope" })).toBe("nope")
  })
})

describe("threadAccessCandidatePaths", () => {
  it("lists the four candidates in probe precedence order", () => {
    expect(threadAccessCandidatePaths("/app")).toEqual([
      "/app/src/thread-access.ts",
      "/app/src/thread-access.js",
      "/app/thread-access.ts",
      "/app/thread-access.js",
    ])
  })
})

describe("validateThreadAccessPolicy", () => {
  it("accepts a policy with only a fallback", () => {
    expect(validateThreadAccessPolicy({ fallback: noop })).toBeUndefined()
  })

  it("accepts a policy with every per-action handler", () => {
    expect(
      validateThreadAccessPolicy({
        create: noop,
        delete: noop,
        fallback: noop,
        read: noop,
        update: noop,
      }),
    ).toBeUndefined()
  })

  it("reports a value that is not an object", () => {
    expect(validateThreadAccessPolicy("nope")).toBe("the bound value is not an object")
    expect(validateThreadAccessPolicy(null)).toBe("the bound value is not an object")
    expect(validateThreadAccessPolicy(noop)).toBe("the bound value is not an object")
  })

  it("reports a missing or non-function fallback by name", () => {
    expect(validateThreadAccessPolicy({})).toContain("`fallback`")
    expect(validateThreadAccessPolicy({ fallback: "nope" })).toContain("`fallback`")
  })

  it("reports a per-action key that is present but is not a function", () => {
    expect(validateThreadAccessPolicy({ fallback: noop, read: "nope" })).toBe(
      "`read` is present but is not a function",
    )
  })
})

describe("normalizeThreadAccessResult", () => {
  it("keeps a well-formed allow", () => {
    expect(normalizeThreadAccessResult({ decision: "allow" }, "thread.get")).toEqual({
      decision: "allow",
    })
  })

  it("keeps a record stamp and drops a non-record one", () => {
    expect(
      normalizeThreadAccessResult({ decision: "allow", stamp: { ownerId: "u-1" } }, "thread.create"),
    ).toEqual({ decision: "allow", stamp: { ownerId: "u-1" } })
    expect(normalizeThreadAccessResult({ decision: "allow", stamp: [1] }, "thread.create")).toEqual({
      decision: "allow",
    })
    expect(normalizeThreadAccessResult({ decision: "allow", stamp: 7 }, "thread.create")).toEqual({
      decision: "allow",
    })
  })

  it("keeps a deny's 403 or 404 and drops any other status", () => {
    expect(normalizeThreadAccessResult({ decision: "deny", status: 403 }, "thread.get")).toEqual({
      decision: "deny",
      status: 403,
    })
    expect(normalizeThreadAccessResult({ decision: "deny", status: 404 }, "thread.get")).toEqual({
      decision: "deny",
      status: 404,
    })
    for (const status of [200, 401, 500]) {
      expect(normalizeThreadAccessResult({ decision: "deny", status }, "thread.get")).toEqual({
        decision: "deny",
      })
    }
  })

  it("keeps a deny body and drops an explicitly-undefined one", () => {
    expect(
      normalizeThreadAccessResult({ body: { error: "x" }, decision: "deny" }, "thread.delete"),
    ).toEqual({ body: { error: "x" }, decision: "deny" })
    const undefinedBody = normalizeThreadAccessResult(
      { body: undefined, decision: "deny" },
      "thread.delete",
    )
    expect("body" in undefinedBody).toBe(false)
  })

  it("denies with no status for every malformed return, and warns once per denial", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      for (const value of [undefined, null, "allow", 1, [], { action: "continue" }, { decision: "allowed" }]) {
        expect(normalizeThreadAccessResult(value, "thread.state", "t-1")).toEqual({
          decision: "deny",
        })
      }
      expect(warn).toHaveBeenCalledTimes(7)
      expect(warn.mock.calls[0]?.[0]).toContain("thread.state")
      expect(warn.mock.calls[0]?.[0]).toContain("t-1")
    } finally {
      warn.mockRestore()
    }
  })

  it("does not warn for a well-formed result", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      normalizeThreadAccessResult({ decision: "allow" }, "thread.get")
      normalizeThreadAccessResult({ decision: "deny" }, "thread.get")
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("threadAccessBootLine", () => {
  it("names each resolution source, and says so when there is none", () => {
    expect(
      threadAccessBootLine({ fromManifest: false, fromOptions: true, resolved: true }),
    ).toBe("Dawn: thread access policy bound from the runtime options")
    expect(
      threadAccessBootLine({ fromManifest: true, fromOptions: false, resolved: true }),
    ).toBe("Dawn: thread access policy bound from the build manifest")
    expect(
      threadAccessBootLine({ fromManifest: false, fromOptions: false, resolved: true }),
    ).toBe("Dawn: thread access policy bound from src/thread-access.ts")
    expect(
      threadAccessBootLine({ fromManifest: false, fromOptions: false, resolved: false }),
    ).toBe("Dawn: no thread access policy (all thread endpoints are open)")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-pure.test.ts
```

Expected: FAIL — the file fails to load with `Failed to resolve import "../src/lib/dev/thread-access.js"`.

- [ ] **Step 3: Write the module**

Create `packages/cli/src/lib/dev/thread-access.ts`:

```ts
/**
 * The pure half of thread-access loading: everything an edge bundle may reach.
 *
 * No `node:` imports, not even types — `test/fetch-entry-purity.test.ts` and
 * `test/edge-bundle-purity.test.ts` gate this module's graph. The disk probe
 * lives in `thread-access-node.ts`.
 */

import type { ThreadAccessResult, ThreadOperation } from "@dawn-ai/sdk"

/**
 * The ONE selection rule, shared by the dynamic loader and (in a later slice)
 * the build probes — a built app can never bind differently than dev.
 * `default` first (nullish falls through), then a named `threadAccess` export.
 *
 * Returns the raw value rather than narrowing it: a non-object default must
 * reach `validateThreadAccessPolicy` so the operator is told what is wrong,
 * not silently treated as "no policy" the way `loadMiddleware` treats it.
 */
export function selectThreadAccessExport(mod: unknown): unknown {
  if (!mod || typeof mod !== "object") return undefined
  const candidate = mod as { readonly default?: unknown; readonly threadAccess?: unknown }
  return candidate.default ?? candidate.threadAccess
}

/** The four candidate paths, in probe precedence order. String concat, not `path.join`. */
export function threadAccessCandidatePaths(appRoot: string): readonly string[] {
  return [
    `${appRoot}/src/thread-access.ts`,
    `${appRoot}/src/thread-access.js`,
    `${appRoot}/thread-access.ts`,
    `${appRoot}/thread-access.js`,
  ]
}

const THREAD_ACCESS_ACTION_KEYS = ["create", "read", "update", "delete"] as const

/**
 * Shape validation of a SELECTED POLICY VALUE — not of a module. Run on both
 * the dynamic path (after `selectThreadAccessExport`) and the manifest path,
 * where export selection never happened because the manifest already holds a
 * policy object. Types are erased across a dynamic import, so `fallback` being
 * required in `ThreadAccessPolicy` is not enforcement — this is.
 *
 * Returns the reason, or undefined when the value is a well-formed policy.
 */
export function validateThreadAccessPolicy(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return "the bound value is not an object"
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.fallback !== "function") {
    return "`fallback` is missing or is not a function (it is required so an unhandled action cannot silently allow or silently deny)"
  }
  for (const key of THREAD_ACCESS_ACTION_KEYS) {
    const handler = candidate[key]
    if (handler !== undefined && typeof handler !== "function") {
      return `\`${key}\` is present but is not a function`
    }
  }
  return undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function renderValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Normalize a hook's return value. NOT the same as middleware's, on purpose:
 * `runMiddleware` compares `=== "reject"` and falls through to CONTINUE on any
 * other value, so a policy that returned `undefined` (a missing return on one
 * branch) or a stale `{ action: "continue" }` object would silently allow.
 * Here, anything that is not a well-formed allow is a DENY.
 *
 * The deny it returns carries NO status, so `denyResponse` applies the
 * per-action default — 404 on a read, 403 otherwise. Pinning it to 403 would
 * make a broken read policy answer differently from a working one and hand back
 * the enumeration oracle the 404 default closes. The cost — a broken read
 * policy looks like an empty database — is paid by the warn, which is why the
 * warn is per denial rather than once per process.
 *
 * `operation` and `threadId` exist so the warn can name what failed; the value
 * alone is not diagnosable. `threadId` is optional because the policy unit
 * harness has no request to take one from.
 */
export function normalizeThreadAccessResult(
  value: unknown,
  operation: ThreadOperation,
  threadId?: string,
): ThreadAccessResult {
  if (isPlainRecord(value)) {
    if (value.decision === "allow") {
      const stamp = value.stamp
      return isPlainRecord(stamp) ? { decision: "allow", stamp } : { decision: "allow" }
    }
    if (value.decision === "deny") {
      const status = value.status === 403 || value.status === 404 ? value.status : undefined
      return {
        decision: "deny",
        ...(status !== undefined ? { status } : {}),
        ...(value.body !== undefined ? { body: value.body } : {}),
      }
    }
  }
  console.warn(
    `Dawn thread access: the policy for ${operation} on ${threadId ?? "(no thread id)"} returned ` +
      `a value that is neither an allow nor a deny, so the request was denied. Received: ${renderValue(value)}`,
  )
  return { decision: "deny" }
}

/**
 * The one boot line naming where the policy came from — the only signal an
 * operator has that a policy vanished (a stale manifest, or an embedder-built
 * fallback bag with no `loadThreadAccess`).
 *
 * The disk variant names the conventional path rather than the resolved
 * candidate: the runtime core has no filesystem, and the loader hands back only
 * the policy. All four candidate paths therefore report this same line.
 */
export function threadAccessBootLine(source: {
  readonly fromOptions: boolean
  readonly fromManifest: boolean
  readonly resolved: boolean
}): string {
  if (!source.resolved) return "Dawn: no thread access policy (all thread endpoints are open)"
  if (source.fromOptions) return "Dawn: thread access policy bound from the runtime options"
  if (source.fromManifest) return "Dawn: thread access policy bound from the build manifest"
  return "Dawn: thread access policy bound from src/thread-access.ts"
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-pure.test.ts
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Lint and typecheck**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
git add packages/cli/src/lib/dev/thread-access.ts packages/cli/test/thread-access-pure.test.ts
git commit -m "feat(cli): add the pure thread-access selection, validation and normalization helpers"
```

---

## Task 5: The fail-closed node loader

**Files:**
- Create: `packages/cli/src/lib/dev/thread-access-node.ts`
- Test: `packages/cli/test/thread-access-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-access-loader.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadThreadAccess } from "../src/lib/dev/thread-access-node.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function fixtureApp(files: Readonly<Record<string, string>>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-loader-"))
  tempDirs.push(appRoot)
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

const VALID_POLICY = `export default {
  fallback: () => ({ decision: "allow" }),
}
`

describe("loadThreadAccess", () => {
  it("returns undefined when no candidate exists (today's behavior, unchanged)", async () => {
    const appRoot = await fixtureApp({ "package.json": '{"type":"module"}\n' })
    await expect(loadThreadAccess(appRoot)).resolves.toBeUndefined()
  })

  it("binds a default export", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY })
    const policy = await loadThreadAccess(appRoot)
    expect(typeof policy?.fallback).toBe("function")
  })

  it("binds a named threadAccess export", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": `export const threadAccess = {
  fallback: () => ({ decision: "allow" }),
}
`,
    })
    const policy = await loadThreadAccess(appRoot)
    expect(typeof policy?.fallback).toBe("function")
  })

  it("prefers the default export over a named one", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": `export const threadAccess = { fallback: () => ({ decision: "deny" }), tag: "named" }
export default { fallback: () => ({ decision: "allow" }), tag: "default" }
`,
    })
    const policy = await loadThreadAccess(appRoot)
    expect((policy as unknown as { tag: string }).tag).toBe("default")
  })

  it("rejects with DAWN_E3003 when the file cannot be imported", async () => {
    // The case `loadMiddleware` gets wrong: its bare `catch {}` cannot tell
    // "no file" from "file that threw", so a broken policy would boot ungated.
    const appRoot = await fixtureApp({
      "src/thread-access.ts": "export default { fallback: () => ({ decision: 'allow' })\n",
    })
    await expect(loadThreadAccess(appRoot)).rejects.toMatchObject({ code: "DAWN_E3003" })
  })

  it("rejects with DAWN_E3003 when the module binds nothing", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": "export const helper = 1\n" })
    await expect(loadThreadAccess(appRoot)).rejects.toMatchObject({ code: "DAWN_E3003" })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(/default.*threadAccess/s)
  })

  it("rejects with DAWN_E3003 when the export is not an object", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": 'export default "nope"\n' })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(/not an object/)
  })

  it("rejects with DAWN_E3003, naming fallback, when fallback is missing", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": "export default { read: () => ({ decision: 'allow' }) }\n",
    })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(/`fallback`/)
  })

  it("rejects with DAWN_E3003 when a per-action key is not a function", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": `export default {
  fallback: () => ({ decision: "allow" }),
  read: "nope",
}
`,
    })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(/`read` is present but is not a function/)
  })

  it("probes the root-level candidate when src/ has none", async () => {
    const appRoot = await fixtureApp({ "thread-access.ts": VALID_POLICY })
    const policy = await loadThreadAccess(appRoot)
    expect(typeof policy?.fallback).toBe("function")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-loader.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/lib/dev/thread-access-node.js"`.

- [ ] **Step 3: Write the module**

Create `packages/cli/src/lib/dev/thread-access-node.ts`:

```ts
import { existsSync } from "node:fs"
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"

import { diagnose } from "../diagnostics.js"
import { CliError } from "../output.js"
import {
  selectThreadAccessExport,
  threadAccessCandidatePaths,
  validateThreadAccessPolicy,
} from "./thread-access.js"

/**
 * Load the app's thread-access policy.
 *
 * This deliberately does NOT copy `loadMiddleware` (`./middleware.ts`), which
 * wraps every dynamic import in a bare `catch {}` and therefore cannot tell "no
 * file" from "file that threw". For middleware that is merely sloppy; for an
 * authorization policy it is a silent, total bypass — a syntax error, a missing
 * dependency, or a thrown env assertion in production would boot the app with
 * every thread world-writable and no log line.
 *
 * Existence is decided by `existsSync`, BEFORE the import, so an import failure
 * can only ever mean "the policy is broken":
 *
 *   • no candidate on disk                     -> undefined (no gate; today's behavior)
 *   • first existing candidate fails to import -> THROW (DAWN_E3003)
 *   • it imports but binds no valid policy     -> THROW (DAWN_E3003)
 *
 * The "binds nothing" case also diverges from middleware, which ignores such a
 * file. A `thread-access.ts` on disk is an unambiguous statement of intent;
 * binding nothing is never what the author meant.
 */
export async function loadThreadAccess(appRoot: string): Promise<ThreadAccessPolicy | undefined> {
  const path = threadAccessCandidatePaths(appRoot).find((candidate) => existsSync(candidate))
  if (!path) return undefined

  let mod: unknown
  try {
    mod = await import(path)
  } catch (error) {
    const diag = diagnose(error, { appRoot })
    const detail = diag ? `${diag.summary}\n\n${diag.hint}` : String(error)
    throw new CliError(
      `Thread access policy at ${path} failed to import, so every thread endpoint would be ungated. ` +
        `Fix the file or delete it.\n\n${detail}`,
      1,
      { cause: error, code: "DAWN_E3003" },
    )
  }

  const selected = selectThreadAccessExport(mod)
  if (selected === undefined || selected === null) {
    throw new CliError(
      `Thread access policy at ${path} has no \`default\` or \`threadAccess\` export. ` +
        "Export the policy with `export default defineThreadAccess({ … })`.",
      1,
      { code: "DAWN_E3003" },
    )
  }

  const reason = validateThreadAccessPolicy(selected)
  if (reason) {
    throw new CliError(`Thread access policy at ${path} is not a valid policy: ${reason}.`, 1, {
      code: "DAWN_E3003",
    })
  }

  return selected as ThreadAccessPolicy
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-loader.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the purity gate still holds**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/fetch-entry-purity.test.ts test/edge-bundle-purity.test.ts
```

Expected: PASS. A failure here means `node:fs` reached the pure module — move the import back into `thread-access-node.ts`.

- [ ] **Step 6: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/dev/thread-access-node.ts packages/cli/test/thread-access-loader.test.ts
git commit -m "feat(cli): load the thread-access policy fail-closed with DAWN_E3003"
```

---

## Task 6: Boot wiring — three layers, one log line

All three resolution layers ship now, so the resolution never has to be rewritten. The manifest channel is honest from day one even though nothing emits into it yet (that is PR B).

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/src/lib/runtime/static-modules-core.ts`
- Modify: `packages/cli/src/lib/runtime/static-modules.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Test: `packages/cli/test/thread-access-boot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-access-boot.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"

const VALID_POLICY_FILE = `export default {
  fallback: () => ({ decision: "allow" }),
}
`

async function fixtureApp(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-boot-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const appFiles: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-boot-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
    ...files,
  }
  for (const [relativePath, source] of Object.entries(appFiles)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

const allowAll: ThreadAccessPolicy = { fallback: () => ({ decision: "allow" }) }

async function bootWithLog(
  options: Parameters<typeof createRuntimeFetchHandler>[0],
): Promise<string[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  try {
    const handler = await createRuntimeFetchHandler(options)
    cleanup.push(() => handler.close())
    return log.mock.calls.map((call) => String(call[0]))
  } finally {
    log.mockRestore()
  }
}

describe("thread-access boot resolution", () => {
  it("logs that there is no policy for an app with no policy file", async () => {
    const appRoot = await fixtureApp()
    const lines = await bootWithLog({ appRoot })
    expect(lines).toContain("Dawn: no thread access policy (all thread endpoints are open)")
  })

  it("binds the app's policy file from disk and says so", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY_FILE })
    const lines = await bootWithLog({ appRoot })
    expect(lines).toContain("Dawn: thread access policy bound from src/thread-access.ts")
  })

  it("prefers an injected policy over the disk probe", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY_FILE })
    const lines = await bootWithLog({ appRoot, threadAccess: allowAll })
    expect(lines).toContain("Dawn: thread access policy bound from the runtime options")
  })

  it("fails the boot with DAWN_E3003 when the policy file cannot be bound", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": "export default { read: 1 }\n" })
    await expect(createRuntimeFetchHandler({ appRoot })).rejects.toMatchObject({
      code: "DAWN_E3003",
    })
  })
})

describe("loadStaticModules — threadAccess validation", () => {
  async function writeManifest(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "dawn-thread-access-manifest-"))
    cleanup.push(() => rm(dir, { force: true, recursive: true }))
    const manifestPath = join(dir, "modules.mjs")
    await writeFile(manifestPath, body, "utf8")
    return manifestPath
  }

  it("throws the re-run-dawn-build error on a malformed threadAccess entry", async () => {
    const manifestPath = await writeManifest(
      'export default { threadAccess: { read: 1 }, routes: [] }\n',
    )
    await expect(loadStaticModules(pathToFileURL(manifestPath))).rejects.toThrow(
      /threadAccess.*re-run `dawn build`/s,
    )
  })

  it("accepts an explicitly-undefined threadAccess entry", async () => {
    const manifestPath = await writeManifest(
      "export default { threadAccess: undefined, routes: [] }\n",
    )
    const modules = await loadStaticModules(pathToFileURL(manifestPath))
    expect(modules.threadAccess).toBeUndefined()
  })

  it("accepts a well-formed threadAccess entry", async () => {
    const manifestPath = await writeManifest(
      'export default { threadAccess: { fallback: () => ({ decision: "allow" }) }, routes: [] }\n',
    )
    const modules = await loadStaticModules(pathToFileURL(manifestPath))
    expect(typeof modules.threadAccess?.fallback).toBe("function")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-boot.test.ts
```

Expected: FAIL. TypeScript reports `Object literal may only specify known properties, and 'threadAccess' does not exist in type …` on the injected-policy case, and the log assertions fail with `expected [] to contain 'Dawn: no thread access policy …'`.

- [ ] **Step 3: Add the optional fallback and the THROWS/DEGRADES entry**

In `packages/cli/src/lib/runtime/execute-route-core.ts`, extend the existing `@dawn-ai/sdk` type import:

```ts
import type { DawnMiddleware, ThreadAccessPolicy } from "@dawn-ai/sdk"
```

Add this member to `RuntimeBootFallbacks`, immediately after the `loadMiddleware` member:

```ts
  /**
   * The `src/thread-access.ts` probe.
   *
   * OPTIONAL, unlike `loadMiddleware`, because this interface is exported: an
   * external embedder constructing the bag as an object literal would fail to
   * typecheck against a new required member. The cost is a silent-ungating
   * vector — `fallbacks` present, this absent, no disk probe, no manifest and
   * no error — which is paid for by the one boot line naming the resolution
   * source.
   */
  readonly loadThreadAccess?: (appRoot: string) => Promise<ThreadAccessPolicy | undefined>
```

In the same file, in the doc block above `requireFallbacks`, add a **third category** after the DEGRADES list (the distinction is the whole security property, so it is neither a THROWS entry nor a DEGRADES one):

```
 * CONDITIONAL — one input, two answers, because the difference is the security
 * property rather than a preference:
 *   - `loadThreadAccess`      → absent policy file: degrades to "no gate", so an
 *                               app that never had one keeps today's behavior
 *                               exactly. Present policy file that cannot be
 *                               bound: THROWS DAWN_E3003 and fails the boot.
 *                               There is no path on which a policy the author
 *                               wrote resolves to "allow all".
```

- [ ] **Step 4: Wire the probe into `nodeBootFallbacks`**

In `packages/cli/src/lib/runtime/execute-route.ts`, add the import beside the existing middleware one:

```ts
import { loadThreadAccess } from "../dev/thread-access-node.js"
```

and add the member to the `nodeBootFallbacks` object literal, immediately after `loadSubagentDescription`:

```ts
  loadThreadAccess,
```

Without this the disk probe never runs on any node path — `dawn dev`, `dawn start` and every test go through here.

- [ ] **Step 5: Add the runtime option**

In `packages/cli/src/lib/dev/runtime-server.ts`, add to `StartRuntimeServerOptions` immediately after the `middleware?` member:

```ts
  /**
   * Pre-loaded thread access policy. Absent: the build manifest's entry, then
   * the dynamic src/thread-access.ts probe.
   */
  readonly threadAccess?: ThreadAccessPolicy
```

and extend that file's `@dawn-ai/sdk` type import to include `ThreadAccessPolicy`.

- [ ] **Step 6: Add the manifest channel**

In `packages/cli/src/lib/runtime/static-modules-core.ts`, extend the `@dawn-ai/sdk` type import to include `ThreadAccessPolicy`, and add this member to `DawnStaticModules`, immediately after `middleware`:

```ts
  /**
   * App-level thread access policy bound from the manifest's static import,
   * when the app has a policy file.
   *
   * The channel is declared now so the boot resolution never has to be
   * rewritten; nothing emits into it yet, so today only a hand-rolled edge
   * embed that constructs `DawnStaticModules` itself can use it.
   */
  readonly threadAccess?: ThreadAccessPolicy
```

- [ ] **Step 7: Validate the manifest entry**

In `packages/cli/src/lib/runtime/static-modules.ts`, add the import:

```ts
import { validateThreadAccessPolicy } from "../dev/thread-access.js"
```

and insert this block in `loadStaticModules`, immediately after the existing middleware validation and before the `routes` loop:

```ts
  // Thread access is optional, and `undefined` is legitimate (an app with no
  // policy file emits no entry) — but anything present must be a well-formed
  // policy. Validated with the same function the dynamic loader uses, because
  // types are erased across the manifest import.
  const threadAccess = (manifest as { readonly threadAccess?: unknown }).threadAccess
  if (threadAccess !== undefined) {
    const reason = validateThreadAccessPolicy(threadAccess)
    if (reason) {
      throw new Error(
        `Static module manifest at ${href} has an invalid threadAccess entry (${reason}) — re-run \`dawn build\`.`,
      )
    }
  }
```

- [ ] **Step 8: Resolve it at boot and log the source**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, extend the `@dawn-ai/sdk` type import:

```ts
import type { DawnMiddleware, MiddlewareRequest, ThreadAccessPolicy } from "@dawn-ai/sdk"
```

add the pure-module import beside the existing `./middleware.js` one:

```ts
import { threadAccessBootLine } from "./thread-access.js"
```

and insert this immediately after the existing `const middleware = …` resolution:

```ts
  // Authorization, unlike middleware, must never resolve to "allow all" by
  // accident: `loadThreadAccess` throws DAWN_E3003 rather than degrading when a
  // policy file exists but cannot be bound. An absent file resolves to
  // undefined — an app that never had a policy keeps today's behavior exactly.
  const threadAccess =
    options.threadAccess ??
    options.modules?.threadAccess ??
    (await fallbacks?.loadThreadAccess?.(options.appRoot))
  // One line per boot, and the only signal an operator has that a policy
  // vanished. Emitted AFTER resolution, so a DAWN_E3003 throw pre-empts it: a
  // boot that failed never claims to have bound anything.
  console.log(
    threadAccessBootLine({
      fromManifest: options.modules?.threadAccess !== undefined,
      fromOptions: options.threadAccess !== undefined,
      resolved: threadAccess !== undefined,
    }),
  )
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-boot.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 10: Run the whole CLI suite — this commit adds a line to every boot**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts
```

Expected: PASS. The new `console.log` goes to the vitest process's stdout, not to the `CommandIo` callbacks that `hono-target.test.ts` and `dev-command.test.ts` capture, so no existing stdout assertion should see it. If one does, that test is capturing `console` globally — fix that test's capture rather than dropping the boot line, which is spec-required and asserted.

- [ ] **Step 11: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/runtime/execute-route-core.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/runtime/static-modules-core.ts packages/cli/src/lib/runtime/static-modules.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-boot.test.ts
git commit -m "feat(cli): resolve the thread-access policy at boot from options, manifest or disk"
```

---

## Task 7: The reserved metadata namespace

**Files:**
- Create: `packages/cli/src/lib/dev/thread-metadata.ts`
- Test: `packages/cli/test/thread-metadata.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-metadata.test.ts`:

```ts
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import {
  assertNoReservedKey,
  stripReservedThreadMetadata,
} from "../src/lib/dev/thread-metadata.js"

describe("stripReservedThreadMetadata", () => {
  it("passes undefined through", () => {
    expect(stripReservedThreadMetadata(undefined)).toBeUndefined()
  })

  it("returns the same object when the reserved key is absent", () => {
    const metadata = { keep: 1 }
    expect(stripReservedThreadMetadata(metadata)).toBe(metadata)
  })

  it("removes the reserved key and keeps every sibling", () => {
    const stripped = stripReservedThreadMetadata({
      [THREAD_ACCESS_METADATA_KEY]: { ownerId: "attacker" },
      keep: 1,
      route: "/chat#agent",
    })
    expect(stripped).toEqual({ keep: 1, route: "/chat#agent" })
  })

  it("returns an empty object when the reserved key was the only entry", () => {
    expect(stripReservedThreadMetadata({ [THREAD_ACCESS_METADATA_KEY]: { ownerId: "x" } })).toEqual(
      {},
    )
  })
})

describe("assertNoReservedKey", () => {
  it("accepts a patch that does not carry the reserved key", () => {
    expect(() => assertNoReservedKey({ route: "/chat#agent" })).not.toThrow()
  })

  it("throws on a patch that would clobber the stamp through the shallow merge", () => {
    expect(() => assertNoReservedKey({ [THREAD_ACCESS_METADATA_KEY]: { ownerId: "x" } })).toThrow(
      /dawn:access/,
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-metadata.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/lib/dev/thread-metadata.js"`.

- [ ] **Step 3: Write the module**

Create `packages/cli/src/lib/dev/thread-metadata.ts`:

```ts
/**
 * Thread metadata is one flat, client-writable namespace, echoed verbatim by
 * `GET /threads/:thread_id` and shallow-merged with no compare-and-set — and it
 * already carries an access-control input (`route`). A "hook metadata merged
 * last, hook wins" scheme would be forgery-proof only by ordering luck. The
 * mechanism instead is a reserved sub-namespace, stripped on the way in.
 *
 * Pure: no `node:` imports.
 */

import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"

/**
 * Remove the key Dawn owns from anything a client supplied. Applied on EVERY
 * create path, hook or no hook: the key contains a colon, cannot be written as
 * a JS property identifier, and is namespaced to Dawn, so stripping it always
 * is safe — and it means an app that adopts a policy later cannot inherit
 * forged stamps written before it did.
 *
 * Returns the input object unchanged when there is nothing to strip, so the
 * common path allocates nothing.
 */
export function stripReservedThreadMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined
  if (!Object.hasOwn(metadata, THREAD_ACCESS_METADATA_KEY)) return metadata
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== THREAD_ACCESS_METADATA_KEY) rest[key] = value
  }
  return rest
}

/**
 * Guard for every `updateMetadata` patch the runtime builds, so a future
 * refactor cannot clobber the stamp through the store's shallow merge. Throws —
 * reaching it is a Dawn bug, not a caller error.
 *
 * Deliberately NOT placed on `ThreadsStore.updateMetadata` itself: that is the
 * store contract, shared with operator tooling that legitimately needs to write
 * the key (the documented backfill script).
 */
export function assertNoReservedKey(patch: Record<string, unknown>): void {
  if (Object.hasOwn(patch, THREAD_ACCESS_METADATA_KEY)) {
    throw new Error(
      `Dawn bug: a runtime thread-metadata patch carried the reserved key "${THREAD_ACCESS_METADATA_KEY}". ` +
        "That key is the server-issued access stamp and may only be written by the create path or by an operator backfill.",
    )
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-metadata.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/dev/thread-metadata.ts packages/cli/test/thread-metadata.test.ts
git commit -m "feat(cli): reserve the dawn:access thread-metadata namespace"
```

---

## Task 8: Strip the reserved key at `POST /threads`, and guard every runtime metadata patch

This is the **one unconditional behavior change** in the PR — a hook-less app pays it too — so it is tested through an app with **no** policy file, which is exactly what the changeset claims.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Test: `packages/cli/test/thread-access-endpoints.test.ts` (created here; Tasks 10 and 11 append to it)

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-access-endpoints.test.ts`. The `setup` helper defined here is reused by every later task in this file, so write it exactly as given:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"

/**
 * A handler over a scratch app. `threadAccess` is injected through
 * `StartRuntimeServerOptions` rather than written to disk: `packages/cli`
 * cannot import `@dawn-ai/testing` (not a dependency, and the reverse edge
 * would be a build cycle), so the injector's own option is exercised from
 * `packages/testing/test/thread-access-harness.test.ts` instead.
 */
async function setup(
  options: {
    readonly threadAccess?: ThreadAccessPolicy
    readonly threadsStore?: ThreadsStore
  } = {},
): Promise<{ readonly handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>> }> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-endpoints-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-endpoints-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    ...(options.threadAccess ? { threadAccess: options.threadAccess } : {}),
    ...(options.threadsStore ? { threadsStore: options.threadsStore } : {}),
  })
  cleanup.push(() => handler.close())
  return { handler }
}

function post(path: string, payload?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), {
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), { headers, method: "GET" })
}

function del(path: string, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), { headers, method: "DELETE" })
}

describe("POST /threads with no policy installed", () => {
  it("drops a client-supplied dawn:access and keeps every sibling", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      post("/threads", { metadata: { "dawn:access": { ownerId: "attacker" }, keep: 1 } }),
    )
    expect(response.status).toBe(200)
    const thread = (await response.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({ keep: 1 })
  })

  it("does not create an empty metadata object for a body that had none", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(post("/threads"))
    expect(response.status).toBe(200)
    const thread = (await response.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({})
  })

  it("stores ordinary metadata unchanged", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    const thread = (await response.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({ tenant: "acme" })
  })

  it("still 400s on a non-object metadata", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(post("/threads", { metadata: "nope" }))
    expect(response.status).toBe(400)
  })

  it("still round-trips the stored metadata through GET /threads/:thread_id", async () => {
    const { handler } = await setup()
    const created = await handler.fetch(
      post("/threads", { metadata: { "dawn:access": { ownerId: "attacker" }, keep: 1 } }),
    )
    const { thread_id } = (await created.json()) as { thread_id: string }
    const fetched = await handler.fetch(get(`/threads/${thread_id}`))
    const thread = (await fetched.json()) as { metadata: Record<string, unknown> }
    expect(thread.metadata).toEqual({ keep: 1 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-endpoints.test.ts
```

Expected: FAIL on the first and last cases with `expected { 'dawn:access': { ownerId: 'attacker' }, keep: 1 } to deeply equal { keep: 1 }`. The other three pass — they pin behavior that must not change.

- [ ] **Step 3: Apply the strip at `POST /threads`**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, add the import beside the other `./` imports:

```ts
import { assertNoReservedKey, stripReservedThreadMetadata } from "./thread-metadata.js"
```

In the `POST /threads` handler, replace the `createThread` call:

```ts
        const thread = await getThreadsStore(request).createThread(
          metadata !== undefined ? { metadata } : {},
        )
        return Response.json(thread, { status: 200 })
```

with:

```ts
        // Unconditional, hook or no hook: the reserved key is Dawn's, contains
        // a colon (so it cannot be written as a JS property identifier), and
        // stripping it always means an app that adopts a policy later can never
        // inherit a stamp a client forged before it did.
        const clientMetadata = stripReservedThreadMetadata(metadata)
        const thread = await getThreadsStore(request).createThread(
          clientMetadata !== undefined ? { metadata: clientMetadata } : {},
        )
        return Response.json(thread, { status: 200 })
```

- [ ] **Step 4: Guard the two `updateMetadata` patch builders in this file**

There are exactly two on this branch, and they are textually identical, so edit each by its surrounding context.

In `handleApStreamRequest`, under the comment that ends `…so resume survives a server restart.`, replace:

```ts
    await threadsStore.updateMetadata(threadId, { route: routeKey })
```

with:

```ts
    const routePatch = { route: routeKey }
    // The stamp lives in the same flat metadata object and this merge is
    // shallow, so a future patch that carried the reserved key would silently
    // overwrite it. Assertion, not a gate: reaching it is a Dawn bug.
    assertNoReservedKey(routePatch)
    await threadsStore.updateMetadata(threadId, routePatch)
```

In `handleApWaitRequest`, under the comment `// Record route for potential resume (in-memory fast-path + durable metadata)`, apply the identical replacement.

- [ ] **Step 5: Guard the AG-UI patch builder**

In `packages/cli/src/lib/dev/agui-handler.ts`, add the import:

```ts
import { assertNoReservedKey } from "./thread-metadata.js"
```

and replace:

```ts
    await threadsStore.updateMetadata(threadId, { route: routeKey })
```

with:

```ts
    const routePatch = { route: routeKey }
    // See the same guard in runtime-fetch-core.ts: the metadata merge is
    // shallow, so nothing the runtime writes may carry the access stamp's key.
    assertNoReservedKey(routePatch)
    await threadsStore.updateMetadata(threadId, routePatch)
```

There is **no** thread-access gate in this file in PR A; the `run.agui` gate is PR B.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-endpoints.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Prove the three metadata writers still work end to end**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/agui-endpoint.test.ts test/resume-endpoint.test.ts test/run-cancellation.test.ts
```

Expected: PASS. These are the suites that exercise `{ route: routeKey }` on all three paths.

- [ ] **Step 8: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/thread-access-endpoints.test.ts
git commit -m "feat(cli): strip the reserved access key from client thread metadata"
```

---

## Task 9: `RunRegistry.claim()` — bind the cancel before anything is awaited

`POST /threads/:thread_id/cancel` cannot authorize before it cancels while `cancel()` must be the first statement. `claim()` closes that rather than trading it: the claim binds synchronously to the run the caller observed, and authorizing may then await freely. `claim` is a **required** interface member on purpose — `getRunRegistry`'s per-request wrapper is a hand-written object literal, and a required member makes it fail typecheck until the passthrough is added. Declaring it optional would compile and `/cancel` would silently fall back to today's behavior on every real request while unit tests using the shared registry stayed green.

**Files:**
- Modify: `packages/cli/src/lib/dev/run-registry.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Test: `packages/cli/test/run-registry.test.ts`
- Test: `packages/cli/test/run-cancellation.test.ts`

- [ ] **Step 1: Write the failing unit test**

Append to `packages/cli/test/run-registry.test.ts`:

```ts
describe("RunRegistry.claim", () => {
  it("returns undefined when no run is in flight", () => {
    const registry = createRunRegistry()
    expect(registry.claim("t1")).toBeUndefined()
  })

  it("aborts the exact run it bound to", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    const claim = registry.claim("t1")
    expect(claim?.cancel()).toBe(true)
    expect(run?.cancelled).toBe(true)
    expect(run?.signal.aborted).toBe(true)
  })

  it("refuses to abort a later run that replaced the one it bound to", () => {
    // The direct sibling of release()'s identity guard: a cancel issued against
    // run N must never land on run N+1.
    const registry = createRunRegistry()
    const first = registry.begin("t1", shutdown())
    const claim = registry.claim("t1")
    first?.release()
    const second = registry.begin("t1", shutdown())
    expect(claim?.cancel()).toBe(false)
    expect(second?.cancelled).toBe(false)
    expect(second?.signal.aborted).toBe(false)
    second?.release()
  })

  it("leaves cancel(threadId) untouched for its other callers", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    expect(registry.cancel("t1")).toBe(true)
    expect(run?.cancelled).toBe(true)
    expect(registry.cancel("t-absent")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-registry.test.ts
```

Expected: FAIL — `registry.claim is not a function`, and TypeScript reports `Property 'claim' does not exist on type 'RunRegistry'`.

- [ ] **Step 3: Add `RunClaim` and `claim` to the registry**

In `packages/cli/src/lib/dev/run-registry.ts`, add this interface immediately after `RunHandle`:

```ts
export interface RunClaim {
  /** Aborts the exact run this claim bound to. False when a later run replaced it. */
  cancel(reason?: string): boolean
}
```

add this member to `RunRegistry`, immediately after `cancel`:

```ts
  /**
   * Bind to whatever run holds this thread's slot right now, synchronously.
   *
   * `cancel(threadId)` resolves the entry at CALL time, so a caller that awaits
   * anything between observing a run and cancelling it can abort a later run of
   * the same thread. A claim resolves the entry up front and carries an
   * identity guard, which is what lets `POST /threads/:id/cancel` authorize —
   * and therefore await — before it aborts.
   *
   * REQUIRED, not optional: `getRunRegistry`'s per-request wrapper is a
   * hand-written object literal, and a required member makes that literal fail
   * typecheck until a passthrough is added.
   */
  claim(threadId: string): RunClaim | undefined
```

and add this to the object `createRunRegistry` returns, immediately after `begin`'s closing brace and before `cancel`:

```ts
    claim(threadId) {
      const entry = entries.get(threadId)
      if (!entry) return undefined
      return {
        cancel(reason = "Run cancelled") {
          // Identity guard, the direct sibling of release()'s: never abort a
          // run that replaced the one this claim bound to.
          if (entries.get(threadId) !== entry) return false
          entry.cancel(reason)
          return true
        },
      }
    },
```

- [ ] **Step 4: Add the per-request passthrough**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, inside the object literal `getRunRegistry` returns, add immediately after the `begin` member and before `cancel`:

```ts
      claim: (threadId) => runRegistry.claim(threadId),
```

Without this the typecheck fails, which is the point.

- [ ] **Step 5: Bind the claim first in the `/cancel` handler**

Replace the `POST /threads/:thread_id/cancel` handler's opening — the comment block ending `…which is not worth the complexity.` plus the `if (getRunRegistry(request).cancel(threadId))` block — with:

```ts
        const threadId = params.thread_id ?? ""
        // Synchronous, FIRST statement, nothing awaited before it: the claim
        // binds to the run the caller observed, so anything that runs after it
        // (in a later slice, an awaited authorization check) can no longer make
        // the cancel land on run N+1. `cancel(threadId)` resolved the entry at
        // call time, which is why that ordering used to be load-bearing.
        //
        // Known, accepted race: a cancel arriving between the route finishing
        // and its idle-status write completing still finds the slot and reports
        // "interrupted" for a run that actually completed. The window is a
        // single DB write wide and corrupts nothing — the streaming client has
        // already received the real output.
        const claim = getRunRegistry(request).claim(threadId)
        // A stale claim falls through to the existing 409: "the run you
        // observed already finished" is the honest answer, where cancelling
        // through the registry by thread id would silently kill a run the
        // caller never saw.
        if (claim?.cancel()) {
          return Response.json({ status: "interrupted", thread_id: threadId }, { status: 200 })
        }
```

Leave the rest of the handler — the `getThread`, the `404 thread_not_found` and the `409 no_run_in_flight` — exactly as it is.

- [ ] **Step 6: Rewrite the intent of the existing 409 test**

In `packages/cli/test/run-cancellation.test.ts`, the case titled `"409s when the thread exists but no run is in flight"` keeps every expectation unchanged (`claim()` returns `undefined`, the handler falls through to the same 409 `no_run_in_flight`), but the property it pins has moved. Rename it and add the comment:

```ts
  it("409s when the thread exists but no run is in flight (the claim is unbound)", async () => {
    // The property under test moved from "nothing is awaited before cancel" to
    // "the claim is bound before any await". The expectations are unchanged:
    // with no run in flight there is nothing to claim, so the handler falls
    // through to the same 409.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-registry.test.ts test/run-cancellation.test.ts
```

Expected: PASS. The existing 404 / 409 / interrupted assertions in `run-cancellation.test.ts` must be green **unchanged** — if any of them moved, the `/cancel` rewrite changed more than it should.

- [ ] **Step 8: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/dev/run-registry.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/run-registry.test.ts packages/cli/test/run-cancellation.test.ts
git commit -m "fix(cli): bind POST /threads/:id/cancel to the run the caller observed"
```

---

## Task 10: The gate, and the four read/update/delete endpoints

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Test: `packages/cli/test/thread-access-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/thread-access-endpoints.test.ts`. First update that file's two imports at the top — `noUnusedImports` is an error, which is why they were not added in Task 8:

```ts
import type { ThreadAccessPolicy, ThreadAccessRequest, ThreadAccessResult } from "@dawn-ai/sdk"
```

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
```

```ts
const allowAll: ThreadAccessPolicy = { fallback: () => ({ decision: "allow" }) }
const denyAll: ThreadAccessPolicy = { fallback: () => ({ decision: "deny" }) }

/** Records every request the runtime made, in order. */
function recording(result: ThreadAccessResult = { decision: "allow" }): {
  readonly policy: ThreadAccessPolicy
  readonly seen: ThreadAccessRequest[]
} {
  const seen: ThreadAccessRequest[] = []
  return {
    policy: {
      fallback: (req) => {
        seen.push(req)
        return result
      },
    },
    seen,
  }
}

describe("GET /threads/:thread_id", () => {
  it("answers a denied read with the same bytes a genuine miss returns", async () => {
    const open = await setup()
    const created = await open.handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    const genuineMiss = await open.handler.fetch(get("/threads/t-does-not-exist"))
    const genuineBody = await genuineMiss.text()

    const gated = await setup({ threadAccess: denyAll })
    const gatedCreated = await gated.handler.fetch(post("/threads"))
    expect(gatedCreated.status).toBe(403)

    const denied = await gated.handler.fetch(get(`/threads/${thread_id}`))
    expect(denied.status).toBe(genuineMiss.status)
    expect(await denied.text()).toBe(genuineBody)
  })

  it("still answers 404 for a row that does not exist, with a permissive policy", async () => {
    // agui-endpoint.test.ts relies on this: a 404 there proves a
    // middleware-rejected run created no thread.
    const { handler } = await setup({ threadAccess: allowAll })
    const response = await handler.fetch(get("/threads/never-created"))
    expect(response.status).toBe(404)
  })

  it("invokes the policy with the row loaded, the operation, the method and the url", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    const created = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    const { thread_id } = (await created.json()) as { thread_id: string }
    seen.length = 0
    await handler.fetch(get(`/threads/${thread_id}?x=1`, { "x-user-id": "u-1" }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      action: "read",
      headers: { "x-user-id": "u-1" },
      method: "GET",
      operation: "thread.get",
      threadId: thread_id,
      url: `/threads/${thread_id}?x=1`,
    })
    expect(seen[0]?.thread?.metadata).toEqual({ tenant: "acme" })
    expect(seen[0]?.requestedMetadata).toBeUndefined()
  })

  it("invokes the policy with thread undefined when the row is missing", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(get("/threads/t-missing"))
    expect(seen.at(-1)?.thread).toBeUndefined()
    expect(seen.at(-1)?.threadId).toBe("t-missing")
  })

  it("honors a read handler that overrides the status to 403", async () => {
    const { handler } = await setup({
      threadAccess: { fallback: () => ({ decision: "deny", status: 403 }) },
    })
    const response = await handler.fetch(get("/threads/t-anything"))
    expect(response.status).toBe(403)
  })

  it("honors a supplied deny body", async () => {
    const { handler } = await setup({
      threadAccess: { fallback: () => ({ body: { why: "nope" }, decision: "deny", status: 403 }) },
    })
    const response = await handler.fetch(get("/threads/t-anything"))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ why: "nope" })
  })
})

describe("GET /threads/:thread_id/state", () => {
  it("answers a denied read with the same bytes a missing checkpoint returns", async () => {
    const open = await setup()
    const genuineMiss = await open.handler.fetch(get("/threads/t-nothing/state"))
    expect(genuineMiss.status).toBe(404)
    const genuineBody = await genuineMiss.text()

    const gated = await setup({ threadAccess: denyAll })
    const denied = await gated.handler.fetch(get("/threads/t-nothing/state"))
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(genuineBody)
  })

  it("uses the thread.state operation", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(get("/threads/t-x/state"))
    expect(seen.at(-1)?.operation).toBe("thread.state")
    expect(seen.at(-1)?.action).toBe("read")
  })
})

describe("DELETE /threads/:thread_id", () => {
  it("returns 403 for an unauthorized thread AND for one that never existed", async () => {
    // The oracle collapse: 204-for-everything today means a 403 would otherwise
    // announce "this exists and is not yours".
    const gated = await setup({ threadAccess: denyAll })
    const missing = await gated.handler.fetch(del("/threads/t-never-existed"))
    expect(missing.status).toBe(403)
    const missingBody = await missing.text()

    const open = await setup()
    const created = await open.handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    const existing = await gated.handler.fetch(del(`/threads/${thread_id}`))
    expect(existing.status).toBe(403)
    expect(await existing.text()).toBe(missingBody)
  })

  it("carries the thread_access_denied code in error.details", async () => {
    const { handler } = await setup({ threadAccess: denyAll })
    const response = await handler.fetch(del("/threads/t-x"))
    expect(await response.json()).toEqual({
      error: {
        details: { code: "thread_access_denied" },
        kind: "request_error",
        message: "Forbidden",
      },
    })
  })

  it("does not delete the row when the policy denies", async () => {
    const open = await setup()
    const created = await open.handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    const gated = await setup({ threadAccess: denyAll })
    await gated.handler.fetch(del(`/threads/${thread_id}`))
    expect((await open.handler.fetch(get(`/threads/${thread_id}`))).status).toBe(200)
  })

  it("still returns 204 when the policy allows", async () => {
    const { handler } = await setup({ threadAccess: allowAll })
    const created = await handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    expect((await handler.fetch(del(`/threads/${thread_id}`))).status).toBe(204)
  })
})

describe("POST /threads/:thread_id/cancel", () => {
  it("returns 403 for a missing row rather than the handler's 404", async () => {
    const { handler } = await setup({ threadAccess: denyAll })
    const response = await handler.fetch(post(`/threads/t-missing/cancel`))
    expect(response.status).toBe(403)
  })

  it("uses the update action and the thread.cancel operation", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(post("/threads/t-x/cancel"))
    expect(seen.at(-1)?.action).toBe("update")
    expect(seen.at(-1)?.operation).toBe("thread.cancel")
  })

  it("ignores a stamp on a non-create allow, leaving the stored metadata alone", async () => {
    // Without this, "honored on create ONLY" is a doc comment with no
    // enforcement, and a refactor that merged the stamp on every allow would
    // pass every other case in this suite.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const { handler } = await setup({
        threadAccess: {
          create: () => ({ decision: "allow" }),
          fallback: () => ({ decision: "allow", stamp: { ownerId: "smuggled" } }),
        },
      })
      const created = await handler.fetch(post("/threads", { metadata: { keep: 1 } }))
      const { thread_id } = (await created.json()) as { thread_id: string }
      const before = await (await handler.fetch(get(`/threads/${thread_id}`))).text()
      await handler.fetch(post(`/threads/${thread_id}/cancel`))
      await handler.fetch(get(`/threads/${thread_id}`))
      const after = await (await handler.fetch(get(`/threads/${thread_id}`))).text()
      expect(after).toBe(before)
      // Once per process, not once per request: this is a policy-authoring
      // mistake, not a per-request failure. Several requests carried a stamp
      // above; exactly one warning came out.
      expect(warn.mock.calls.filter((call) => String(call[0]).includes("create only"))).toHaveLength(
        1,
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe("malformed and throwing policies", () => {
  const malformed: ThreadAccessPolicy = { fallback: () => undefined as never }

  it("denies at the per-action default: 403 on DELETE, 404 on both reads", async () => {
    // A single "yields 403" assertion would pass against an implementation that
    // hard-codes 403 and silently reopens read enumeration.
    const { handler } = await setup({ threadAccess: malformed })
    expect((await handler.fetch(del("/threads/t-x"))).status).toBe(403)
    expect((await handler.fetch(post("/threads/t-x/cancel"))).status).toBe(403)
    expect((await handler.fetch(post("/threads"))).status).toBe(403)
    expect((await handler.fetch(get("/threads/t-x"))).status).toBe(404)
    expect((await handler.fetch(get("/threads/t-x/state"))).status).toBe(404)
  })

  it("keeps a malformed read denial matching a genuine miss byte for byte", async () => {
    const open = await setup()
    const genuine = await open.handler.fetch(get("/threads/t-x"))
    const { handler } = await setup({ threadAccess: malformed })
    const denied = await handler.fetch(get("/threads/t-x"))
    expect(await denied.text()).toBe(await genuine.text())
  })

  it("turns a throwing policy into a 500 and never reaches createThread", async () => {
    // The endpoint's real work must not run. A throw is not caught by the gate:
    // it propagates to fetch's catch-all, which is fail-closed and honest,
    // where a 403 would hide a broken policy behind a working-looking one.
    let creates = 0
    const store: ThreadsStore = {
      async createThread() {
        creates += 1
        return {
          created_at: "2026-01-01T00:00:00.000Z",
          metadata: {},
          status: "idle",
          thread_id: "t-should-not-happen",
          updated_at: "2026-01-01T00:00:00.000Z",
        }
      },
      async deleteThread() {},
      async getThread() {
        return undefined
      },
      async listThreads() {
        return []
      },
      async updateMetadata() {},
      async updateStatus() {},
    }
    const { handler } = await setup({
      threadAccess: {
        fallback: () => {
          throw new Error("policy exploded")
        },
      },
      threadsStore: store,
    })
    const response = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    expect(response.status).toBe(500)
    expect(creates).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-endpoints.test.ts
```

Expected: FAIL — every new case fails because no gate runs yet, e.g. `expected 200 to be 404` on the denied read and `expected 204 to be 403` on DELETE.

- [ ] **Step 3: Add the gate helpers**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, extend the `@dawn-ai/sdk` type import to:

```ts
import type {
  DawnMiddleware,
  MiddlewareRequest,
  ThreadAccessDeny,
  ThreadAccessPolicy,
  ThreadAccessRequest,
  ThreadAction,
  ThreadOperation,
  ThreadSubject,
} from "@dawn-ai/sdk"
```

add the value import immediately after it (matching the two-import-from-one-module style `execute-route-core.ts` already uses):

```ts
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
```

and extend the pure-module import:

```ts
import { normalizeThreadAccessResult, threadAccessBootLine } from "./thread-access.js"
```

Then add this block immediately above the `// Route table builder` banner comment:

```ts
// ---------------------------------------------------------------------------
// Thread access gate
// ---------------------------------------------------------------------------

type GateOk = { readonly ok: true; readonly stamp?: Record<string, unknown> }
type GateDenied = { readonly ok: false; readonly response: Response }
type Gate = GateOk | GateDenied

interface GateSpec {
  readonly action: ThreadAction
  readonly operation: ThreadOperation
  readonly threadId?: string
  readonly thread?: Thread
  readonly requestedMetadata?: Record<string, unknown>
  /** The response a denied READ must be indistinguishable from. Supply it whenever action is "read". */
  readonly notFound?: () => Response
}

/** Allocated once: every no-op gate and every stamp-less allow returns this. */
const GATE_OK: Gate = { ok: true }

/**
 * A stamp is honored on `create` ONLY. Carrying one on any other allow is a
 * policy-authoring mistake rather than a request failure, so it is reported
 * once per process rather than once per request — unlike the malformed-return
 * warn, which is a bug that should stay noisy.
 */
let warnedIgnoredStamp = false

/**
 * Narrowing rather than a boolean, so the `await` branch typechecks. Nothing in
 * `packages/cli/src` had one before this.
 */
function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Split the stored metadata: `access` is the server stamp, `metadata` is
 * everything else. A policy therefore never sees the reserved key inside
 * `metadata` and is never tempted to authorize against the untrusted sibling.
 */
function toThreadSubject(thread: Thread): ThreadSubject {
  const reserved = thread.metadata[THREAD_ACCESS_METADATA_KEY]
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(thread.metadata)) {
    if (key !== THREAD_ACCESS_METADATA_KEY) metadata[key] = value
  }
  return {
    access: isPlainRecord(reserved) ? reserved : undefined,
    created_at: thread.created_at,
    metadata,
    status: thread.status,
    thread_id: thread.thread_id,
    updated_at: thread.updated_at,
  }
}

/**
 * Every deny becomes bytes here.
 *
 * `{ code: … }` is the SECOND positional argument — `details`, not `options` —
 * so it lands at `error.details.code` with no `error.code` / `docsUrl`, exactly
 * as `run_in_flight` and `thread_not_found` do. Deliberately no registry code
 * on the deny path: `DAWN_E3003` is for load failures, and a docs URL on a 403
 * is noise.
 *
 * Every branch supplies a literal body, and the guard is on
 * `result.body !== undefined` rather than on key presence, because
 * `Response.json(undefined)` throws and `statusResponse` would turn that into a
 * 500. A deny must never be able to 500.
 */
function denyResponse(
  action: ThreadAction,
  result: ThreadAccessDeny,
  notFound: (() => Response) | undefined,
): Response {
  const status = result.status ?? (action === "read" ? 404 : 403)
  if (result.body !== undefined) return statusResponse(status, result.body)
  if (status === 404 && notFound) return notFound()
  if (status === 404) {
    return Response.json(createRequestErrorBody("Thread not found"), { status: 404 })
  }
  return Response.json(createRequestErrorBody("Forbidden", { code: "thread_access_denied" }), {
    status: 403,
  })
}

/**
 * Build this request's gate.
 *
 * Returns a no-op gate when the app has no policy — the ONLY thing a hook-less
 * app pays is this closure allocation. No store read, no reordering, nothing.
 *
 * `Gate | Promise<Gate>`, never `Promise<Gate>`: a policy handler that returns a
 * plain object (the header-only case) is resolved with ZERO microtask
 * boundaries, which is what keeps the `/cancel` claim binding meaningful.
 * Callers do `const settled = isThenable(g) ? await g : g`.
 */
function makeThreadGate(
  policy: ThreadAccessPolicy | undefined,
  request: Request,
): (spec: GateSpec) => Gate | Promise<Gate> {
  if (!policy) return () => GATE_OK
  const headers = headersToRecord(request.headers)
  const method = request.method
  const parsed = new URL(request.url)
  const url = `${parsed.pathname}${parsed.search}`
  return (spec) => {
    const handler = policy[spec.action] ?? policy.fallback
    const accessRequest: ThreadAccessRequest = {
      action: spec.action,
      headers,
      method,
      operation: spec.operation,
      requestedMetadata: spec.requestedMetadata,
      thread: spec.thread ? toThreadSubject(spec.thread) : undefined,
      threadId: spec.threadId,
      url,
    }
    const settle = (value: unknown): Gate => {
      const result = normalizeThreadAccessResult(value, spec.operation, spec.threadId)
      if (result.decision === "allow") {
        if (!result.stamp) return GATE_OK
        if (spec.action === "create") return { ok: true, stamp: result.stamp }
        // Dropped, not merged: the stamp is the server's answer to "who created
        // this thread", and honoring it here would let any later allow rewrite
        // it through the store's shallow merge.
        if (!warnedIgnoredStamp) {
          warnedIgnoredStamp = true
          console.warn(
            `Dawn thread access: the policy returned a stamp on a ${spec.action} allow ` +
              `(${spec.operation}). Stamps are honored on create only, so it was ignored. ` +
              "This warning is emitted once per process.",
          )
        }
        return GATE_OK
      }
      return { ok: false, response: denyResponse(spec.action, result, spec.notFound) }
    }
    const returned = handler(accessRequest) as unknown
    return isThenable(returned) ? returned.then(settle) : settle(returned)
  }
}
```

A hook that throws is deliberately **not** caught here: it propagates to `fetch`'s existing catch-all and becomes a 500, and the endpoint's real work never runs. A 403 would hide a broken policy behind what looks like a working one.

- [ ] **Step 4: Thread the policy through the route table**

In `buildRouteTable`'s `ctx` parameter type, add immediately after `readonly registry: RuntimeRegistry`:

```ts
  /**
   * The boot-resolved policy. `buildRouteTable` runs before any request exists,
   * so the gate itself is built per handler invocation from this.
   */
  readonly threadAccess: ThreadAccessPolicy | undefined
```

add `threadAccess,` to the destructuring block below it, and add `threadAccess,` to the `buildRouteTable({ … })` call in `createRuntimeFetchHandler` (right after `resumeClaims,`).

- [ ] **Step 5: Gate `GET /threads/:thread_id`**

Replace that handler body with:

```ts
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        // The gate runs AFTER the lookup and a denial routes through this same
        // literal, so "404 means the row does not exist" stays true for a
        // policied app — agui-endpoint.test.ts pins that invariant.
        const thread = await getThreadsStore(request).getThread(threadId)
        const notFound = () =>
          Response.json(createRequestErrorBody("Thread not found"), { status: 404 })
        const gate = makeThreadGate(threadAccess, request)
        const g = gate({
          action: "read",
          notFound,
          operation: "thread.get",
          threadId,
          ...(thread ? { thread } : {}),
        })
        const settled = isThenable(g) ? await g : g
        if (!settled.ok) return settled.response
        if (!thread) return notFound()
        return Response.json(thread, { status: 200 })
      },
```

- [ ] **Step 6: Gate `GET /threads/:thread_id/state`**

Replace that handler body with:

```ts
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        const notFound = () =>
          Response.json(createRequestErrorBody("No checkpoint found for thread"), { status: 404 })
        if (threadAccess) {
          // The one extra store read this endpoint pays, and only with a policy
          // installed. The checkpointer is a SEPARATE store from ThreadsStore,
          // so a transcript can exist for a thread whose row is gone — the gate
          // therefore runs with `thread: undefined` rather than skipping.
          const thread = await getThreadsStore(request).getThread(threadId)
          const gate = makeThreadGate(threadAccess, request)
          const g = gate({
            action: "read",
            notFound,
            operation: "thread.state",
            threadId,
            ...(thread ? { thread } : {}),
          })
          const settled = isThenable(g) ? await g : g
          if (!settled.ok) return settled.response
        }
        const tuple = await getCheckpointer(request).getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: "" },
        })
        if (!tuple) return notFound()
        const apState = {
          config: tuple.config,
          created_at: new Date().toISOString(),
          metadata: tuple.metadata,
          next: tuple.pendingWrites?.map(([, channel]) => channel) ?? [],
          parent_config: tuple.parentConfig ?? null,
          values: tuple.checkpoint.channel_values ?? {},
        }
        return Response.json(apState, { status: 200 })
      },
```

- [ ] **Step 7: Gate `DELETE /threads/:thread_id`**

Insert the gate as the handler's **first** work, ahead of `deleteThread`:

```ts
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        if (threadAccess) {
          // First in the handler, and a `getThread` this endpoint does not do
          // today — hook path only. The gate authorizes with `thread:
          // undefined` when the row is missing rather than short-circuiting to
          // 204, so "not yours" and "never existed" answer identically and the
          // existence oracle a 403 would otherwise open stays shut.
          const thread = await getThreadsStore(request).getThread(threadId)
          const gate = makeThreadGate(threadAccess, request)
          const g = gate({
            action: "delete",
            operation: "thread.delete",
            threadId,
            ...(thread ? { thread } : {}),
          })
          const settled = isThenable(g) ? await g : g
          if (!settled.ok) return settled.response
        }
        const checkpointer = getCheckpointer(request)
        await getThreadsStore(request).deleteThread(threadId)
```

Leave the rest of the handler — the `typeof … deleteThread === "function"` probe, the sandbox destroy and the 204 — unchanged.

- [ ] **Step 8: Gate `POST /threads/:thread_id/cancel`**

Insert the gate between the claim and `claim?.cancel()`:

```ts
        const claim = getRunRegistry(request).claim(threadId)
        if (threadAccess) {
          // Safe to await only because the claim is already bound. The two are
          // load-bearing together: without the claim this read would let the
          // cancel land on run N+1.
          const thread = await getThreadsStore(request).getThread(threadId)
          const gate = makeThreadGate(threadAccess, request)
          const g = gate({
            action: "update",
            operation: "thread.cancel",
            threadId,
            ...(thread ? { thread } : {}),
          })
          const settled = isThenable(g) ? await g : g
          if (!settled.ok) return settled.response
        }
        if (claim?.cancel()) {
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-endpoints.test.ts
```

Expected: PASS, 23 tests (Task 8's 5 plus the 18 added here).

- [ ] **Step 10: Prove the invariant existing tests pin still holds**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/agui-endpoint.test.ts test/run-cancellation.test.ts test/memory-endpoints.test.ts test/resume-endpoint.test.ts
```

Expected: PASS. `agui-endpoint.test.ts`'s `GET /threads/middleware-rejected → 404` case is the one that pins "404 means it was never created"; that app installs no policy, so the gate is a no-op there.

- [ ] **Step 11: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-endpoints.test.ts
git commit -m "feat(cli): gate the four previously-ungated thread endpoints"
```

---

## Task 11: `POST /threads` — gate, stamp, retry, recheck

A create is the one gated operation whose subject does not exist when the policy runs: the policy authorizes an *intent* and the store returns a *row*, and those can differ. `newThreadId()` is four random bytes — 32 bits — in both stores, and Postgres `createThread` is `ON CONFLICT DO NOTHING` plus a `selectOne` fallback, so a collision hands back a stranger's row and silently discards the caller's metadata **including the stamp the policy just issued**. Birthday collisions arrive at roughly 65k threads with no attacker at all.

Two mechanisms, and only the second is the security boundary. The retry keeps the common case from being a spurious 403. The **unconditional** `update` recheck against the returned row is what holds the line — never a stamp comparison, which fails open when the policy returns `permit()` with no stamp and both sides are `undefined`.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Test: `packages/cli/test/thread-access-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/thread-access-endpoints.test.ts`:

```ts
/**
 * A store whose `createThread` always hands back a row it did not just write —
 * the Postgres upsert shape. Untestable through real sqlite, which throws on a
 * duplicate instead.
 */
function collidingStore(foreign: {
  readonly thread_id: string
  readonly metadata: Record<string, unknown>
}): { readonly store: ThreadsStore; readonly attempts: () => number } {
  let attempts = 0
  const store: ThreadsStore = {
    async createThread() {
      attempts += 1
      return {
        created_at: "2026-01-01T00:00:00.000Z",
        metadata: foreign.metadata,
        status: "idle",
        thread_id: foreign.thread_id,
        updated_at: "2026-01-02T00:00:00.000Z",
      }
    },
    async deleteThread() {},
    async getThread() {
      return undefined
    },
    async listThreads() {
      return []
    },
    async updateMetadata() {},
    async updateStatus() {},
  }
  return { attempts: () => attempts, store }
}

describe("POST /threads with a policy installed", () => {
  it("denies before the row is written", async () => {
    const { handler } = await setup({ threadAccess: denyAll })
    const response = await handler.fetch(post("/threads"))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        details: { code: "thread_access_denied" },
        kind: "request_error",
        message: "Forbidden",
      },
    })
  })

  it("passes the stripped client metadata as requestedMetadata on the create call", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    await handler.fetch(
      post("/threads", { metadata: { "dawn:access": { ownerId: "attacker" }, tenant: "acme" } }),
    )
    expect(seen[0]).toMatchObject({
      action: "create",
      operation: "thread.create",
      requestedMetadata: { tenant: "acme" },
    })
    expect(seen[0]?.threadId).toBeUndefined()
    expect(seen[0]?.thread).toBeUndefined()
  })

  it("stores the stamp under the reserved key and surfaces it as thread.access later", async () => {
    const seen: ThreadAccessRequest[] = []
    const policy: ThreadAccessPolicy = {
      create: () => ({ decision: "allow", stamp: { ownerId: "u-1" } }),
      fallback: (req) => {
        seen.push(req)
        return { decision: "allow" }
      },
    }
    const { handler } = await setup({ threadAccess: policy })
    const created = await handler.fetch(post("/threads", { metadata: { tenant: "acme" } }))
    expect(created.status).toBe(200)
    const body = (await created.json()) as { metadata: Record<string, unknown>; thread_id: string }
    // The raw row still carries the key: hiding it would break round-tripping
    // and make the stamp undebuggable.
    expect(body.metadata).toEqual({ "dawn:access": { ownerId: "u-1" }, tenant: "acme" })

    seen.length = 0
    await handler.fetch(get(`/threads/${body.thread_id}`))
    expect(seen.at(-1)?.thread?.access).toEqual({ ownerId: "u-1" })
    expect(seen.at(-1)?.thread?.metadata).toEqual({ tenant: "acme" })
  })

  it("re-authorizes the returned row as an update, on the same operation", async () => {
    const { policy, seen } = recording()
    const { handler } = await setup({ threadAccess: policy })
    const created = await handler.fetch(post("/threads"))
    const { thread_id } = (await created.json()) as { thread_id: string }
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
      action: "update",
      operation: "thread.create",
      threadId: thread_id,
    })
    expect(seen[1]?.thread?.thread_id).toBe(thread_id)
    // The create's metadata was already adjudicated by the create call;
    // repeating it would invite authorizing the same input twice.
    expect(seen[1]?.requestedMetadata).toBeUndefined()
  })

  it("lets a stricter update handler deny its own successful create, at the 403 update default", async () => {
    const { handler } = await setup({
      threadAccess: {
        create: () => ({ decision: "allow" }),
        fallback: () => ({ decision: "deny" }),
      },
    })
    const response = await handler.fetch(post("/threads"))
    expect(response.status).toBe(403)
  })

  it("runs neither the retry nor the recheck for a hook-less app", async () => {
    const { attempts, store } = collidingStore({ metadata: { owner: "stranger" }, thread_id: "t-foreign" })
    const { handler } = await setup({ threadsStore: store })
    const response = await handler.fetch(post("/threads"))
    expect(response.status).toBe(200)
    expect(attempts()).toBe(1)
  })

  it("retries with a fresh id when the store hands back a row it did not write", async () => {
    const { attempts, store } = collidingStore({ metadata: { owner: "stranger" }, thread_id: "t-foreign" })
    const { handler } = await setup({ threadAccess: allowAll, threadsStore: store })
    await handler.fetch(post("/threads"))
    expect(attempts()).toBe(3)
  })

  it("denies rather than returning the foreign row when every attempt collides", async () => {
    const { store } = collidingStore({ metadata: { owner: "stranger" }, thread_id: "t-foreign" })
    const { handler } = await setup({
      threadAccess: {
        create: () => ({ decision: "allow", stamp: { ownerId: "u-1" } }),
        // An ownership policy: the foreign row carries no matching stamp.
        fallback: (req) => (req.thread?.access?.ownerId === "u-1" ? { decision: "allow" } : { decision: "deny" }),
      },
      threadsStore: store,
    })
    const response = await handler.fetch(post("/threads"))
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain("t-foreign")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-endpoints.test.ts
```

Expected: FAIL — the create is not gated, so `denies before the row is written` reports `expected 200 to be 403`, `re-authorizes the returned row` reports `expected 0 to be 2` (no policy call at all), and the retry case reports `expected 1 to be 3`.

- [ ] **Step 3: Add the collision predicate**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, add these two functions immediately below `toThreadSubject`:

```ts
/** Structural equality over JSON-shaped values (no Dates, no Maps, no cycles). */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonDeepEqual(item, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && jsonDeepEqual(left[key], right[key]))
}

/**
 * Did `createThread` actually insert, or did it hand back a row that was
 * already there? Best-effort collision detection, NOT the security boundary —
 * the unconditional `update` recheck beside it is. It is decisive exactly when
 * the policy stamped (an adopted row carries a different stamp, or none) and
 * indecisive in the one case where it does not matter: a `permit()` with no
 * stamp on a create with no metadata has nothing to distinguish and also
 * nothing to authorize against later.
 */
function isRowWeJustWrote(thread: Thread, stored: Record<string, unknown> | undefined): boolean {
  return thread.created_at === thread.updated_at && jsonDeepEqual(thread.metadata, stored ?? {})
}
```

- [ ] **Step 4: Rewrite the `POST /threads` tail**

Replace everything from `const clientMetadata = …` to the closing `return Response.json(thread, { status: 200 })` with:

```ts
        // Unconditional, hook or no hook: the reserved key is Dawn's, contains
        // a colon (so it cannot be written as a JS property identifier), and
        // stripping it always means an app that adopts a policy later can never
        // inherit a stamp a client forged before it did.
        const clientMetadata = stripReservedThreadMetadata(metadata)
        const gate = makeThreadGate(threadAccess, request)
        const created = gate({
          action: "create",
          operation: "thread.create",
          ...(clientMetadata !== undefined ? { requestedMetadata: clientMetadata } : {}),
        })
        const settled = isThenable(created) ? await created : created
        if (!settled.ok) return settled.response

        const stored = settled.stamp
          ? { ...(clientMetadata ?? {}), [THREAD_ACCESS_METADATA_KEY]: settled.stamp }
          : clientMetadata
        const input = stored !== undefined ? { metadata: stored } : {}

        let thread = await getThreadsStore(request).createThread(input)

        // Both of the following are inside the hook branch. A hook-less app
        // makes the one createThread call above and returns, exactly as today.
        if (threadAccess) {
          // The id is server-generated and only 32 bits wide, so the row that
          // came back is not necessarily the row we wrote: Postgres upserts on a
          // collision and returns the existing row with its existing metadata,
          // discarding the caller's. Retry rather than hand back a stranger's
          // thread — a bare re-authorization would be safe but would 403 a
          // create the caller was fully entitled to make.
          for (let attempt = 1; attempt < 3 && !isRowWeJustWrote(thread, stored); attempt++) {
            thread = await getThreadsStore(request).createThread(input)
          }

          // Unconditional: authorize the ROW, not the intent. Never a stamp
          // comparison — when the policy returns permit() with no stamp both
          // sides are undefined, the comparison passes, and the loser proceeds
          // on the winner's row with no re-authorization at all.
          const recheck = gate({
            action: "update",
            operation: "thread.create",
            thread,
            threadId: thread.thread_id,
          })
          const rechecked = isThenable(recheck) ? await recheck : recheck
          if (!rechecked.ok) return rechecked.response
        }

        return Response.json(thread, { status: 200 })
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-endpoints.test.ts
```

Expected: PASS, 31 tests. In particular the hook-less case must still report exactly **one** `createThread` attempt.

- [ ] **Step 6: Run the whole CLI suite**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts
```

Expected: PASS.

- [ ] **Step 7: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-endpoints.test.ts
git commit -m "feat(cli): stamp thread creates and re-authorize the row the store returned"
```

---

## Task 12: Enumerated coverage, enumerated by a test

Five hand-placed call sites in one file, and `RouteMatcher` has only `{ method, pattern, handle }` — no metadata slot — so nothing structurally forces the next endpoint someone adds to be gated. This test is what stands between an enumerated design and a silently ungated endpoint next quarter.

Two specifics decide whether it can do its job at all. The key is `` `${method} ${pattern.source}` ``, not the source alone: `GET /threads/:thread_id` and `DELETE /threads/:thread_id` have identical pattern sources, so a source-only key would collapse them into one row and let a newly added ungated `PATCH` on that pattern pass silently. And the filter is inverted — collect the **whole** table rather than the entries mentioning `threads`: `POST /agui/:routeId` contains no "threads" yet resolves a client-supplied thread id, creates the row and writes its metadata.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (export the seam)
- Test: `packages/cli/test/thread-access-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-access-coverage.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadAccessPolicy, ThreadOperation } from "@dawn-ai/sdk"
import { afterEach, describe, expect, it } from "vitest"

import { buildRouteTable } from "../src/lib/dev/runtime-fetch-core.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function routeKey(method: string, pattern: RegExp): string {
  return `${method} ${pattern.source}`
}

/** Gated in PR A: the five endpoints that ran no middleware at all. */
const GATED: readonly string[] = [
  routeKey("POST", /^\/threads(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/),
  routeKey("DELETE", /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)\/state(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/cancel(?:\?.*)?$/),
]

/**
 * Thread-scoped and NOT yet gated. PR B moves all four onto GATED; until then
 * they are gated by route middleware only. `POST /agui/:routeId` is on this
 * list precisely because its pattern contains no "threads" — it still resolves
 * a client-supplied thread id, creates the row and writes its metadata.
 */
const DEFERRED: readonly string[] = [
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/wait(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/resume(?:\?.*)?$/),
  routeKey("POST", /^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/),
]

/**
 * Not thread-scoped, so there is no thread subject to authorize against. A
 * memory candidate is addressed by candidate id, with no thread id in its route
 * and no ThreadsStore read on its path. That a candidate may have been
 * distilled FROM a thread's conversation is real, and it means memory needs its
 * own authorization story — it does not make it a thread-access one.
 */
const EXEMPT: readonly string[] = [
  routeKey("GET", /^\/healthz(?:\?.*)?$/),
  routeKey("GET", /^\/memory\/candidates(?:\?.*)?$/),
  routeKey("POST", /^\/memory\/candidates\/(?<id>[^/?#]+)\/approve(?:\?.*)?$/),
  routeKey("POST", /^\/memory\/candidates\/(?<id>[^/?#]+)\/reject(?:\?.*)?$/),
]

// The ctx is never read: buildRouteTable only destructures it and closes over
// the values, and this test invokes no handler.
const routes = buildRouteTable({} as unknown as Parameters<typeof buildRouteTable>[0])
const actual = routes.map((route) => `${route.method} ${route.pattern.source}`)

describe("route-table coverage", () => {
  it("has 13 entries on this branch", () => {
    // PR #443 adds `GET /threads/:thread_id/pending_interrupts` as a 14th. It
    // does not exist here, so it is on none of the lists below. Classifying it
    // becomes required at the rebase — see the spec's "Open question for
    // review" (docs/superpowers/specs/2026-08-10-thread-access-design.md).
    expect(actual).toHaveLength(13)
  })

  it("classifies every route as gated, deferred or exempt", () => {
    const classified = new Set([...GATED, ...DEFERRED, ...EXEMPT])
    expect(actual.filter((key) => !classified.has(key))).toEqual([])
  })

  it("lists no route that the table does not serve", () => {
    const served = new Set(actual)
    expect([...GATED, ...DEFERRED, ...EXEMPT].filter((key) => !served.has(key))).toEqual([])
  })

  it("keys on method AND pattern, so GET and DELETE on one pattern stay distinct", () => {
    expect(new Set(actual).size).toBe(actual.length)
    const sharedPattern = /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/.source
    expect(actual.filter((key) => key.endsWith(sharedPattern))).toHaveLength(2)
  })
})

describe("emitted thread operations", () => {
  it("emits exactly the five thread.* members in PR A", async () => {
    const emitted: ThreadOperation[] = []
    const policy: ThreadAccessPolicy = {
      fallback: (req) => {
        emitted.push(req.operation)
        return { decision: "allow" }
      },
    }
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-coverage-"))
    cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
    for (const [relativePath, source] of Object.entries({
      "dawn.config.ts": "export default {}\n",
      "package.json": '{ "name": "coverage-fixture", "type": "module" }\n',
      "src/app/hello/index.ts": "export const graph = async () => ({ ok: true })\n",
    })) {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }
    const handler = await createRuntimeFetchHandler({ appRoot, threadAccess: policy })
    cleanup.push(() => handler.close())

    const created = await handler.fetch(
      new Request("http://localhost/threads", { method: "POST" }),
    )
    const { thread_id } = (await created.json()) as { thread_id: string }
    await handler.fetch(new Request(`http://localhost/threads/${thread_id}`))
    await handler.fetch(new Request(`http://localhost/threads/${thread_id}/state`))
    await handler.fetch(
      new Request(`http://localhost/threads/${thread_id}/cancel`, { method: "POST" }),
    )
    await handler.fetch(
      new Request(`http://localhost/threads/${thread_id}`, { method: "DELETE" }),
    )

    // thread.create appears twice per create — once as action "create", once as
    // the action "update" recheck against the row the store returned.
    expect(emitted).toEqual([
      "thread.create",
      "thread.create",
      "thread.get",
      "thread.state",
      "thread.cancel",
      "thread.delete",
    ])
    expect(new Set(emitted)).toEqual(
      new Set(["thread.create", "thread.get", "thread.state", "thread.cancel", "thread.delete"]),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-coverage.test.ts
```

Expected: FAIL — `"buildRouteTable" is not exported by "src/lib/dev/runtime-fetch-core.ts"`.

- [ ] **Step 3: Export the seam**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, three local types become part of an exported signature once `buildRouteTable` is exported, and `tsc`'s declaration emit refuses to name a private one. Change all three declarations to `export`:

```ts
export type RouteHandler = (request: Request, params: Record<string, string>) => Promise<Response>
```

```ts
export type RouteBoot = Pick<BootResolvedInstances, "bootFallbacks" | "config">
```

```ts
export interface RouteMatcher {
```

(Keep each one's existing doc comment.) Then change `function buildRouteTable(ctx: {` to:

```ts
/**
 * Exported for `test/thread-access-coverage.test.ts`, which walks every entry
 * and requires each to be classified as gated, deferred or exempt. Not part of
 * any package barrel — `fetch-exports.ts` and `runtime-exports.ts` re-export
 * only `createRuntimeFetchHandler`.
 */
export function buildRouteTable(ctx: {
```

(Keep the existing doc comment about request-aware accessors immediately above this one.)

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-coverage.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/cli build
```

Expected: all three clean. `build` is the one that runs declaration emit — if it reports `has or is using private name 'X'`, export that local type as well (the same reason `RouteHandler` and `RouteBoot` were exported in Step 3) and re-run.

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-coverage.test.ts
git commit -m "test(cli): require every route-table entry to be classified for thread access"
```

---

## Task 13: `hono` and `langsmith` builds fail while a policy file exists

Neither target can carry the hook. The hono runtime has `fallbacks === undefined` by construction, so the disk probe never runs; langsmith materializes no middleware either. Middleware failing open there is a feature regression; authorization failing open is a breach, so silence is not an option. PR B lifts the hono failure by adding the manifest channel; langsmith's is permanent. The `node` target needs nothing — its emitted `server.mjs` reaches the runtime through `nodeBootFallbacks` exactly as `dawn dev` does.

**Files:**
- Create: `packages/cli/src/lib/build/targets/thread-access-probe.ts`
- Modify: `packages/cli/src/lib/build/targets/hono.ts`
- Modify: `packages/cli/src/lib/build/targets/langsmith.ts`
- Test: `packages/cli/test/thread-access-build-targets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-access-build-targets.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RouteManifest } from "@dawn-ai/core"
import { afterEach, describe, expect, it } from "vitest"

import { assertNoThreadAccessPolicy } from "../src/lib/build/targets/thread-access-probe.js"
import { buildTargets } from "../src/lib/build/targets/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

const POLICY_FILE = 'export default { fallback: () => ({ decision: "allow" }) }\n'

async function fixtureApp(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-build-"))
  tempDirs.push(appRoot)
  const appFiles: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "build-probe-fixture", "type": "module" }\n',
    ...files,
  }
  for (const [relativePath, source] of Object.entries(appFiles)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

function emitContext(appRoot: string) {
  return {
    appRoot,
    buildDir: join(appRoot, ".dawn/build"),
    manifest: { appRoot, routes: [] } as unknown as RouteManifest,
  }
}

describe("assertNoThreadAccessPolicy", () => {
  it("does nothing when the app has no policy file", async () => {
    const appRoot = await fixtureApp()
    expect(() => assertNoThreadAccessPolicy(appRoot, "hono")).not.toThrow()
  })

  it("throws DAWN_E1005 naming the target and the file", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    expect(() => assertNoThreadAccessPolicy(appRoot, "hono")).toThrow(/src\/thread-access\.ts/)
    try {
      assertNoThreadAccessPolicy(appRoot, "hono")
      expect.unreachable("expected a CliError")
    } catch (error) {
      expect(error).toMatchObject({ code: "DAWN_E1005" })
      expect(String(error)).toContain("hono")
    }
  })

  it("probes every candidate path, not just src/", async () => {
    const appRoot = await fixtureApp({ "thread-access.js": POLICY_FILE })
    expect(() => assertNoThreadAccessPolicy(appRoot, "langsmith")).toThrow(/thread-access\.js/)
  })
})

describe("build targets that cannot carry a policy", () => {
  it("fails the hono build", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.hono?.emit(emitContext(appRoot))).rejects.toMatchObject({
      code: "DAWN_E1005",
    })
  })

  it("fails the langsmith build", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.langsmith?.emit(emitContext(appRoot))).rejects.toMatchObject({
      code: "DAWN_E1005",
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-build-targets.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/lib/build/targets/thread-access-probe.js"`.

- [ ] **Step 3: Write the probe**

Create `packages/cli/src/lib/build/targets/thread-access-probe.ts`:

```ts
import { existsSync } from "node:fs"

import { threadAccessCandidatePaths } from "../../dev/thread-access.js"
import { CliError } from "../../output.js"

/**
 * Fail a build for a target that cannot carry the app's thread access policy.
 *
 * Middleware failing open on these targets is a feature regression; an
 * authorization policy failing open is a breach, so the build refuses rather
 * than emitting artifacts that would deploy every thread endpoint ungated.
 *
 * Same candidate list as the dynamic probe, so the build can never disagree
 * with dev about whether a policy exists.
 */
export function assertNoThreadAccessPolicy(appRoot: string, target: string): void {
  const found = threadAccessCandidatePaths(appRoot).find((candidate) => existsSync(candidate))
  if (!found) return
  throw new CliError(
    `The "${target}" build target cannot carry a thread access policy, and ${found} exists. ` +
      "Building it anyway would deploy every thread endpoint ungated. Remove the policy file, " +
      'or build for the "node" target, which probes it at boot.',
    1,
    { code: "DAWN_E1005" },
  )
}
```

- [ ] **Step 4: Call it from the hono target**

In `packages/cli/src/lib/build/targets/hono.ts`, add the import beside the existing `middlewareCandidatePaths` one:

```ts
import { assertNoThreadAccessPolicy } from "./thread-access-probe.js"
```

and insert as the **first** statement of `emit`, before `const artifacts` and before `loadBuildConfig`:

```ts
    // Before anything is read or written: a build that emitted artifacts and
    // then threw would leave a .dawn/build that looks deployable.
    assertNoThreadAccessPolicy(ctx.appRoot, "hono")
```

- [ ] **Step 5: Call it from the langsmith target**

In `packages/cli/src/lib/build/targets/langsmith.ts`, add:

```ts
import { assertNoThreadAccessPolicy } from "./thread-access-probe.js"
```

and insert as the first statement of `emit`, before `const artifacts: string[] = []`:

```ts
    // Permanent for this target: LangSmith materializes no app middleware
    // either, so there is nowhere for the policy to run.
    assertNoThreadAccessPolicy(appRoot, "langsmith")
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/thread-access-build-targets.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Prove an app with no policy file still builds for every target**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/build-targets.test.ts test/hono-target.test.ts test/hono-node-roundtrip.test.ts
```

Expected: PASS, unchanged. None of those fixtures ship a policy file.

- [ ] **Step 8: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
git add packages/cli/src/lib/build/targets/thread-access-probe.ts packages/cli/src/lib/build/targets/hono.ts packages/cli/src/lib/build/targets/langsmith.ts packages/cli/test/thread-access-build-targets.test.ts
git commit -m "feat(cli): refuse hono and langsmith builds while a thread-access policy exists"
```

---

## Task 14: The `@dawn-ai/testing` surface

Route middleware never got a unit harness, and `createAgentHarness` is blind by construction — it drives `streamResolvedRoute` directly, takes no run slot and writes no threads-store row, so it runs no middleware today and will run no policy either. This is the surface that makes policies testable at all.

`@dawn-ai/testing` resolves `@dawn-ai/cli/runtime` through `packages/cli/dist`, so **rebuild the CLI before running these tests**.

**Files:**
- Modify: `packages/cli/src/runtime-exports.ts`
- Create: `packages/testing/src/thread-access-harness.ts`
- Modify: `packages/testing/src/http-inject.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/thread-access-harness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/testing/test/thread-access-harness.test.ts`:

```ts
import { fileURLToPath } from "node:url"
import { defineThreadAccess, deny, permit, type ThreadAccessRequest } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import { createAgentProtocolInjector } from "../src/http-inject.js"
import { createThreadAccessHarness } from "../src/thread-access-harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

describe("createThreadAccessHarness", () => {
  it("routes an action to its own handler when the policy has one", async () => {
    const seen: string[] = []
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({
        delete: () => {
          seen.push("delete")
          return deny()
        },
        fallback: () => {
          seen.push("fallback")
          return permit()
        },
      }),
    })
    expect(await harness.check({ action: "delete", threadId: "t-1" })).toEqual({
      decision: "deny",
    })
    expect(await harness.check({ action: "read", threadId: "t-1" })).toEqual({ decision: "allow" })
    expect(seen).toEqual(["delete", "fallback"])
  })

  it("fills in sane defaults for headers, method, url and operation", async () => {
    let received: ThreadAccessRequest | undefined
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({
        fallback: (req) => {
          received = req
          return permit()
        },
      }),
    })
    await harness.check({ action: "read", threadId: "t-9" })
    expect(received).toMatchObject({
      action: "read",
      headers: {},
      method: "GET",
      operation: "thread.get",
      threadId: "t-9",
      url: "/threads/t-9",
    })
    expect(received?.thread).toBeUndefined()
    expect(received?.requestedMetadata).toBeUndefined()
  })

  it("passes an explicit operation, headers, thread and requestedMetadata through", async () => {
    let received: ThreadAccessRequest | undefined
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({
        fallback: (req) => {
          received = req
          return permit()
        },
      }),
    })
    await harness.check({
      action: "read",
      headers: { "x-user-id": "u-1" },
      operation: "thread.state",
      requestedMetadata: { tenant: "acme" },
      thread: {
        access: { ownerId: "u-1" },
        created_at: "2026-01-01T00:00:00.000Z",
        metadata: { tenant: "acme" },
        status: "idle",
        thread_id: "t-9",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      threadId: "t-9",
    })
    expect(received?.operation).toBe("thread.state")
    expect(received?.headers).toEqual({ "x-user-id": "u-1" })
    expect(received?.thread?.access).toEqual({ ownerId: "u-1" })
    expect(received?.requestedMetadata).toEqual({ tenant: "acme" })
  })

  it("runs the result through the runtime's own normalization, so a malformed return denies", async () => {
    const harness = createThreadAccessHarness({
      policy: { fallback: () => undefined as never },
    })
    expect(await harness.check({ action: "read", threadId: "t-1" })).toEqual({ decision: "deny" })
  })

  it("drops a deny status the runtime would drop", async () => {
    const harness = createThreadAccessHarness({
      policy: { fallback: () => ({ decision: "deny", status: 401 }) as never },
    })
    expect(await harness.check({ action: "delete", threadId: "t-1" })).toEqual({
      decision: "deny",
    })
  })

  it("awaits an async handler", async () => {
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({ fallback: async () => permit({ ownerId: "u-1" }) }),
    })
    expect(await harness.check({ action: "create" })).toEqual({
      decision: "allow",
      stamp: { ownerId: "u-1" },
    })
  })
})

describe("createAgentProtocolInjector({ threadAccess })", () => {
  it("gates the injected app's thread endpoints", async () => {
    const ap = await createAgentProtocolInjector({
      appRoot,
      threadAccess: defineThreadAccess({
        fallback: (req) => (req.headers["x-api-key"] === "secret" ? permit() : deny()),
      }),
    })
    try {
      const denied = await ap.inject({ method: "POST", payload: {}, url: "/threads" })
      expect(denied.statusCode).toBe(403)

      const allowed = await ap.inject({
        headers: { "x-api-key": "secret" },
        method: "POST",
        payload: {},
        url: "/threads",
      })
      expect(allowed.statusCode).toBe(200)
    } finally {
      await ap.close()
    }
  }, 60_000)

  it("leaves an injector with no policy open, exactly as before", async () => {
    const ap = await createAgentProtocolInjector({ appRoot })
    try {
      const created = await ap.inject({ method: "POST", payload: {}, url: "/threads" })
      expect(created.statusCode).toBe(200)
    } finally {
      await ap.close()
    }
  }, 60_000)
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/thread-access-harness.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/thread-access-harness.js"`.

- [ ] **Step 3: Publish the normalizer on `@dawn-ai/cli/runtime`**

In `packages/cli/src/runtime-exports.ts`, add:

```ts
export { normalizeThreadAccessResult } from "./lib/dev/thread-access.js"
```

immediately after the `./lib/dev/runtime-registry.js` export block. (PR B adds the `fetch-exports.ts` twin along with `normalizeThreadAccessModule`; nothing needs it there yet.)

- [ ] **Step 4: Write the harness**

Create `packages/testing/src/thread-access-harness.ts`:

```ts
import { normalizeThreadAccessResult } from "@dawn-ai/cli/runtime"
import type {
  ThreadAccessPolicy,
  ThreadAccessRequest,
  ThreadAccessResult,
  ThreadAction,
  ThreadOperation,
  ThreadSubject,
} from "@dawn-ai/sdk"

/** A partial `ThreadAccessRequest`: only `action` is required. */
export interface ThreadAccessCheckSpec {
  readonly action: ThreadAction
  /** Defaults to the canonical operation for the action. */
  readonly operation?: ThreadOperation
  readonly threadId?: string
  readonly thread?: ThreadSubject
  readonly headers?: Readonly<Record<string, string>>
  readonly method?: string
  readonly url?: string
  readonly requestedMetadata?: Readonly<Record<string, unknown>>
}

export interface ThreadAccessHarness {
  /**
   * Run one request through the policy exactly as the runtime would: the same
   * `handler ?? fallback` selection, and the same result normalization — so a
   * handler that returns nothing on some branch denies here too.
   */
  check(spec: ThreadAccessCheckSpec): Promise<ThreadAccessResult>
}

const DEFAULT_OPERATION: Readonly<Record<ThreadAction, ThreadOperation>> = {
  create: "thread.create",
  delete: "thread.delete",
  read: "thread.get",
  update: "thread.cancel",
}

function defaultMethod(action: ThreadAction): string {
  if (action === "read") return "GET"
  if (action === "delete") return "DELETE"
  return "POST"
}

/**
 * Unit-test a thread access policy without booting a server.
 *
 * `createAgentHarness` is blind to policies by construction — it drives
 * `streamResolvedRoute` directly, takes no run slot and writes no threads-store
 * row — so this and `createAgentProtocolInjector({ threadAccess })` are the two
 * surfaces that make a policy testable.
 */
export function createThreadAccessHarness(options: {
  readonly policy: ThreadAccessPolicy
}): ThreadAccessHarness {
  return {
    async check(spec) {
      const operation = spec.operation ?? DEFAULT_OPERATION[spec.action]
      const request: ThreadAccessRequest = {
        action: spec.action,
        headers: spec.headers ?? {},
        method: spec.method ?? defaultMethod(spec.action),
        operation,
        requestedMetadata: spec.requestedMetadata,
        thread: spec.thread,
        threadId: spec.threadId,
        url: spec.url ?? (spec.threadId ? `/threads/${spec.threadId}` : "/threads"),
      }
      const handler = options.policy[spec.action] ?? options.policy.fallback
      return normalizeThreadAccessResult(await handler(request), operation, spec.threadId)
    },
  }
}
```

- [ ] **Step 5: Add the injector option**

In `packages/testing/src/http-inject.ts`, add the type import:

```ts
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"
```

and change the factory signature and its handler construction to:

```ts
export async function createAgentProtocolInjector(options: {
  appRoot: string
  /** Injected rather than probed from disk, so a test needs no policy file. */
  threadAccess?: ThreadAccessPolicy
}): Promise<AgentProtocolInjector> {
  const core = await createRuntimeFetchHandler({
    appRoot: options.appRoot,
    ...(options.threadAccess ? { threadAccess: options.threadAccess } : {}),
  })
```

Leave the rest of the file unchanged.

- [ ] **Step 6: Publish the harness**

In `packages/testing/src/index.ts`, add — Biome sorts these blocks by module specifier, so place it between the `./tool-harness.js` block and the `./workspace-harness.js` block:

```ts
export {
  createThreadAccessHarness,
  type ThreadAccessCheckSpec,
  type ThreadAccessHarness,
} from "./thread-access-harness.js"
```

- [ ] **Step 7: Rebuild the CLI, then run the test**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/thread-access-harness.test.ts
```

Expected: PASS, 8 tests. A `normalizeThreadAccessResult is not a function` failure means the CLI `dist` is stale — rebuild.

- [ ] **Step 8: Prove the existing injector suite is unaffected**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/http-inject.test.ts
```

Expected: PASS, unchanged.

- [ ] **Step 9: Lint, typecheck and commit**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/testing lint
pnpm --filter @dawn-ai/testing typecheck
git add packages/cli/src/runtime-exports.ts packages/testing/src/thread-access-harness.ts packages/testing/src/http-inject.ts packages/testing/src/index.ts packages/testing/test/thread-access-harness.test.ts
git commit -m "feat(testing): add createThreadAccessHarness and the injector's threadAccess option"
```

---

## Task 15: The changeset

`scripts/check-docs.mjs` scans `.changeset/` for banned phrases and the prose becomes CHANGELOG text verbatim, so keep it plain and do not write "byte-identical". The fixed 0.x group turns a `minor` into a 1.0.0 bump for every package — **patch only**.

**Files:**
- Create: `.changeset/thread-access-hook.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/thread-access-hook.md`:

```markdown
---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Thread endpoints can now be authorized with a `src/thread-access.ts` policy.

`defineThreadAccess` answers a different question from route middleware — may
this caller create, read, mutate or destroy this thread — and is keyed on the
thread object rather than on route identity, because a thread has no owning
route. Five endpoints that previously ran no middleware at all are gated by it:
`POST /threads`, `GET /threads/:thread_id`, `GET /threads/:thread_id/state`,
`POST /threads/:thread_id/cancel` and `DELETE /threads/:thread_id`. A read
denial answers the same 404 a genuine miss answers, so a policy cannot be used
to enumerate thread ids, and a `delete` is authorized even when the row is
missing so a 403 cannot confirm that a thread exists.

The policy loader is fail-closed, unlike the middleware probe: a
`thread-access.ts` that exists but cannot be imported or binds no usable policy
fails the boot with `DAWN_E3003` rather than degrading to "no gate". An app with
no policy file behaves exactly as before, and every boot logs which layer the
policy came from, or that there is none.

`dawn build --target hono` and `--target langsmith` now fail with `DAWN_E1005`
while a policy file exists, because neither runtime can carry the hook yet.

One behavior change applies with or without a policy: `POST /threads` drops the
reserved `dawn:access` key from client-supplied `metadata`. That key holds the
server-issued access stamp, so a client can never write one — including in an
app that adopts a policy later.

`POST /threads/:thread_id/cancel` now binds its cancel to the run the caller
observed, so a cancel can no longer land on a later run of the same thread; when
the observed run has already finished it answers the existing
`409 no_run_in_flight`.

`@dawn-ai/testing` gains `createThreadAccessHarness` for unit-testing a policy
without booting a server, and `createAgentProtocolInjector` accepts a
`threadAccess` policy.

The run endpoints — `/runs/stream`, `/runs/wait`, `/resume` and `/agui` — are
not on this policy yet and remain gated by route middleware only.
```

- [ ] **Step 2: Commit it BEFORE running the guard**

`scripts/check-changesets.mjs` diffs `origin/main...HEAD`, so it cannot see an uncommitted file.

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
git add .changeset/thread-access-hook.md
git commit -m "chore: add the thread-access changeset"
```

- [ ] **Step 3: Run both guards**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
git fetch origin main
BASE_REF=origin/main node scripts/check-changesets.mjs
node scripts/check-docs.mjs
```

Expected: both exit 0. A `.changeset/thread-access-hook.md overstates local/prod protocol or deployment parity` failure means a banned phrase reached the prose — rewrite it, amend the commit, re-run.

---

## Verification

Run the full local gate on Node 24, from the worktree root, in this order. Do not pipe any of it through `tail`.

- [ ] **Step 1: Confirm the toolchain**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
nvm use 24
node -v
```

Expected: `v24.x.x`.

- [ ] **Step 2: Lint and build**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm lint
pnpm build
```

Expected: both clean. `pnpm build` must run before the docs guard, which imports `packages/sdk/dist/index.js` and `packages/cli/dist/lib/docs-bundle.js`.

- [ ] **Step 3: Typecheck and test everything**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm typecheck
pnpm test
```

Expected: green. `pnpm test` runs the whole vitest workspace.

- [ ] **Step 4: Confirm the generated error docs are in sync**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm docs:errors
git diff --exit-code apps/web/content/docs/errors.mdx
```

Expected: no diff. A diff means Task 3's regeneration was stale — commit the regenerated file.

- [ ] **Step 5: Docs and changeset guards**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
node scripts/check-docs.mjs
git fetch origin main
BASE_REF=origin/main node scripts/check-changesets.mjs
```

Expected: both exit 0.

- [ ] **Step 6: The full CI gate**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm ci:validate
```

Expected: green. This is what CI runs; it includes the lint, build, typecheck, test, docs check, pack check and harness verification steps above plus the release-script tests.

- [ ] **Step 7: Spot-check the security properties by hand**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-hook
pnpm --filter @dawn-ai/cli exec vitest --run --reporter=verbose --config vitest.config.ts test/thread-access-endpoints.test.ts test/thread-access-coverage.test.ts test/thread-access-loader.test.ts
```

Expected: every case named. Read the list and confirm by eye that these five are present and green: the denied read matching a genuine miss; the denied `/state` matching a missing checkpoint; DELETE answering 403 for both an unauthorized and a nonexistent thread; the malformed policy answering 403 on DELETE and 404 on both reads; and the route table classifying all 13 entries.

## PR notes

**Title:** `feat: authorize thread endpoints with a defineThreadAccess policy`

**The description must call out:**

1. **What closes and what does not.** The disclosure on the five endpoints that ran no middleware at all closes here. It is not a complete authorization story until PR B lands the run endpoints: `POST /threads/<chosen-id>/runs/stream` still creates the thread when the row is missing and runs against it when it is not, so an attacker who wins that race bypasses the create stamp, and one who does not still runs an agent turn on a victim's thread. PR B must not be deferred past the release that carries this.
2. **The one unconditional behavior change.** `POST /threads` drops a client-supplied `dawn:access` key from `metadata`, with or without a policy installed. It is pinned by a test that runs an app with no policy file.
3. **The `/cancel` behavior change.** A cancel now binds to the run the caller observed. The observable difference is a bug fix — a cancel can no longer land on run N+1 — and a stale claim falls through to the existing `409 no_run_in_flight` rather than silently killing a run the caller never saw. No existing test asserted the old behavior; the race was documented as accepted, not as specified.
4. **The new boot log line.** Every boot now prints one line naming where the policy came from, or that there is none. It is the only signal an operator has that a policy vanished (a stale manifest, or an external embedder whose fallback bag omits the optional `loadThreadAccess`).
5. **The build gate.** `dawn build --target hono|langsmith` fails with `DAWN_E1005` while a policy file exists. PR B lifts the hono half; langsmith's is permanent. An app with no policy file is unaffected.
6. **The published surface, on three packages.** `@dawn-ai/sdk` gains nine types, three functions and one constant; `@dawn-ai/cli` gains `StartRuntimeServerOptions.threadAccess?`, the optional `RuntimeBootFallbacks.loadThreadAccess?`, `DawnStaticModules.threadAccess?` and a `normalizeThreadAccessResult` export on `@dawn-ai/cli/runtime`; `@dawn-ai/testing` gains `createThreadAccessHarness` and the injector's `threadAccess?` option. `RunRegistry.claim` is a **required** member on purpose. Nothing in `packages/sdk/src/middleware.ts` changed, and `ThreadsStore` / `Thread` are untouched — no migration, no schema change, the stamp rides in the existing metadata column.
7. **Two deliberate divergences from the spec**, both explained in the review thread:
   - `normalizeThreadAccessResult` takes an optional third `threadId` argument. The spec's prose requires the malformed-return warn to name the thread id, but the signature it printed took only `(value, operation)`. The extra argument is optional so the unit harness can call it with two.
   - The endpoint suite lives in `packages/cli/test` and drives `createRuntimeFetchHandler` directly rather than `createAgentProtocolInjector`. `packages/cli` cannot depend on `@dawn-ai/testing` (strict pnpm, and the reverse edge is a build cycle). The injector's new option is covered from `packages/testing/test` instead.
8. **The open question is not answered here, and does not need to be.** `GET /threads/:thread_id/pending_interrupts` does not exist on this base, so the enumeration test cannot see it. Its classification — *deferred* under Option A, *exempt* under Option B — becomes required at the rebase onto #443. See the spec's "Open question for review".

**The changeset** covers `@dawn-ai/sdk`, `@dawn-ai/cli` **and** `@dawn-ai/testing`, all **patch** (the fixed 0.x group turns a minor into a 1.0.0 bump for every package), and describes the metadata strip, the fail-closed loader, the `/cancel` fix, the build gate and the run endpoints still being open.

## Post-rebase tasks (only after PR #443 merges)

Do not attempt these before #443 is in the base — none of the files exist yet. Each is a follow-up commit on the rebased branch.

- [ ] **Answer the spec's open question, then classify `/pending_interrupts`.** The repo owner decides between Option A (bring it onto the thread-access axis in PR B; it goes on the enumeration test's **deferred** list and `ThreadOperation` gains a tenth member, `thread.pending_interrupts`, **in this PR** so PR B adds no published type change) and Option B (keep it on route-identity gating permanently; it goes on the **exempt** list with the reason inline). Leaving it unclassified is the only outcome ruled out — the enumeration test is red the day it is written otherwise. See the spec's "Open question for review".

- [ ] **Update the coverage test's entry count.** `expect(actual).toHaveLength(13)` becomes `14`, and the new key `` routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)\/pending_interrupts(?:\?.*)?$/) `` goes on whichever list the decision picked. Confirm the pattern source against `runtime-fetch-core.ts` on the rebased branch rather than trusting this line.

- [ ] **Wrap the two `parked-route.ts` metadata patch builders.** `settleParkedRoute` writes `{ parked_route: routeKey }` and `{ parked_route: null }`. Both need the same `assertNoReservedKey(patch)` treatment the three `{ route: routeKey }` writers got in Task 8 — five patch builders total after the rebase.

- [ ] **Move the DELETE gate ahead of #443's `409 run_in_flight` guard.** On this base "first in the handler" is literal. After the rebase the gate must sit ahead of both the 409 guard and the reversed delete order (checkpoints first, row last), so an unauthorized caller cannot probe whether a run is live on someone else's thread.

- [ ] **Rewrite the premise of `pending-interrupts-endpoint.test.ts:756`.** An unauthenticated `POST /cancel` against a `/park`-gated thread is asserted to return 200, with a comment saying those endpoints are ungated. Run that app **with** a policy and assert 403, keeping the test's real subject intact: reaching the window wins the attacker nothing.

- [ ] **Rewrite the premise of `pending-interrupts-endpoint.test.ts:840`.** A mid-turn `DELETE` against the same thread asserts `409 run_in_flight`; under the new gate ordering an unauthenticated caller gets 403 and never learns a run is in flight. Same treatment — rewrite the premise, keep the subject (the settle path cannot be raced by deleting the row). That test's comment states the settle mechanism as "every settle path ends in `updateMetadata`", which is true on #443's branch and false on `origin/main`; do not "fix" it in the wrong direction.

- [ ] **Re-run the full gate.** `nvm use 24 && pnpm ci:validate`.

