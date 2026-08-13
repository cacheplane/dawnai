# Thread Access PR B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the rest of the thread authorization surface — gate the four run endpoints and `GET /pending_interrupts` on `defineThreadAccess`, lift PR A's `hono` build failure by teaching the static-module pipeline about the policy, and ship the scaffold, conformance and docs that make the hook usable.

**Architecture:** PR A built the seam (`makeThreadGate`, the reserved metadata namespace, the loader, the enumeration test) and gated the five endpoints that ran no middleware at all. PR B reuses that seam unchanged: every task below is a gate call placed at a specific point in an existing handler, plus the build-target work that lets a policy survive `dawn build`. No new authorization concepts.

**Tech Stack:** TypeScript, Node 24 (`engines` requires it — 20 CLI tests fail under Node 22 on `main` too), vitest, pnpm workspaces, turbo, changesets, biome.

---

## Scope

The six items in the spec's **"PR B — the run surface, edge, and defaults"** slice, plus the resolved open question.

**The open question is decided: Option A.** `GET /threads/:id/pending_interrupts` moves onto the thread-access axis, *in addition to* #443's route-identity check, composing as AND. Decided by the repo owner on 2026-08-13, after PR A merged.

**That decision costs one thing the spec hoped to avoid.** The spec assumed the answer would land *before* PR A so the tenth `ThreadOperation` member would ship inside PR A's union and PR B would carry no published type change. PR A merged with **nine** members (`packages/sdk/src/thread-access.ts:38-47`), so Task 2 widens a published union. It is additive, but a consumer with an exhaustive `switch` over `ThreadOperation` will fail to compile. Call it out in the changeset.

## Base-branch reality — read this before Task 1

- Base is `origin/main` at or after `b3f44df0`. PR A (#460), the AG-UI parked-status fix (#462), the episode-park fix (#463), the middleware loader (#464), the vercel-native flake fix (#465) and the action-pin bump (#466) are all in.
- `main` moves fast — six merges on 2026-08-12 alone. Re-merge `origin/main` before pushing and expect conflicts in `runtime-fetch-core.ts`, which is the busiest file in the repo.
- Only `validate` is a required check. `review` fails repo-wide on an Anthropic credit balance; `vercel-native`, `chart-apply-smoke`, `chart-validate` and `sandbox-k8s` all flake intermittently on `main` itself. Do not treat those as your regression without checking the step list first.

## Repo gotchas baked into every task

- **Node 24 or the suite lies.** `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"` before any test command.
- **Capture exit codes explicitly.** `cmd > /tmp/x.log 2>&1; echo "EXIT=$?"` — piping to `grep`/`tail` reports the *pipe's* status and has already produced a false green in this repo's history.
- **Strip ANSI before grepping CI logs.** `perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g'` — `grep -c "FAIL"` silently returns 0 against coloured output.
- **`pnpm typecheck` on `@dawn-ai/sdk` is meaningless until you `pnpm build` first.** Found the hard way in Task 2. `packages/sdk/test/thread-access.contract.ts` imports from `"@dawn-ai/sdk"` — the package name — which resolves through `package.json`'s `types` to `dist/*.d.ts`, not `src/`. Edit a type in `src/`, run `typecheck` without rebuilding, and it silently checks the **old** types and reports success. It does not error; it lies. Build after every source edit, before every typecheck, or your green is stale. This is a different trap from the plan's other stale-`dist` warning: that one is about an unbuilt tree, this one is about ordering within an edit-test loop.
- **Changesets gate:** a changeset is required because `packages/*/src/` changes. `@dawn-ai/sdk`, `@dawn-ai/cli` and `@dawn-ai/testing` all move.
- **Patch versions only.** Never bump a minor.
- **`git worktree` + `perl -pi` with a glob:** quote or expand carefully. A collapsed glob has already produced a half-applied edit in this repo — always `git status` after a bulk rewrite.

## File Structure

**Modified — the gates:**
- `packages/cli/src/lib/dev/runtime-fetch-core.ts` — gates in `handleApStreamRequest` (:1669), `handleApWaitRequest` (:1953), `handleResumeRequest` (:2469), and the `/pending_interrupts` route handler (:1587-1603).
- `packages/cli/src/lib/dev/agui-handler.ts` — gate in the `POST /agui/:routeId` flow, after `runMiddleware` (:229) and before `tryClaim` (:235).

**Modified — the published surface:**
- `packages/sdk/src/thread-access.ts` — tenth `ThreadOperation` member.

**Modified — the build pipeline:**
- `packages/cli/src/lib/runtime/static-modules-core.ts` — `normalizeThreadAccessModule`.
- `packages/cli/src/runtime-exports.ts`, `packages/cli/src/fetch-exports.ts` — re-export it from **both** barrels; the generated manifest imports by literal specifier per target, so missing either breaks linking.
- `packages/cli/src/lib/build/modules-emitter.ts` — named-import line composed from a list, not the two-branch ternary at `:346-348`.
- `packages/cli/src/lib/build/targets/*` — node + hono probes; delete the `DAWN_E1005` hono refusal PR A added.

**Modified — templates, conformance, docs:**
- scaffold templates: new `src/thread-access.ts` + shared `src/auth.ts`.
- `runThreadsStoreConformance` — two cases from spec §4.
- `apps/web/content/docs/thread-access.mdx`, `middleware.mdx` (the "Where middleware runs" table + the ungated-endpoint sentence after it), `dev-server.mdx`.

**Tests (all new unless noted):**
- `packages/cli/test/thread-access-run-endpoints.test.ts` — the four run gates + ordering.
- `packages/cli/test/thread-access-pending-interrupts.test.ts` — the Option A gate.
- `packages/cli/test/thread-access-coverage.test.ts` — MODIFY: move five patterns to `GATED`.
- `packages/cli/test/pending-interrupts-endpoint.test.ts` — MODIFY: third premise rewrite.
- `packages/cli/test/static-middleware.test.ts`, `edge-modules-emitter.test.ts` — MODIFY: thread-access twins.

---

## Task 1: Prepare the worktree

**Files:** none (environment only)

- [ ] **Step 1: Confirm the worktree and base**

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/thread-access-pr-b
git log --oneline -1
git status --short
```

Expected: on `blove/thread-access-pr-b`, clean, at `b3f44df0` or later.

- [ ] **Step 2: Install and build**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm install --frozen-lockfile > /tmp/inst.log 2>&1; echo "EXIT=$?"
pnpm build > /tmp/build.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` both. A stale `dist` produces phantom `TS2305` errors on `@dawn-ai/sdk` exports that do not exist — build before believing any typecheck failure.

- [ ] **Step 3: Establish the green baseline**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts thread-access > /tmp/base.log 2>&1; echo "EXIT=$?"
grep -E "Test Files|Tests " /tmp/base.log
```

Expected: `EXIT=0`. Record the counts — every later task compares against them.

---

## Task 2: The tenth `ThreadOperation` member

**Files:**
- Modify: `packages/sdk/src/thread-access.ts:38-47`
- Test: `packages/sdk/test/thread-access.test.ts`

> **Corrected during execution.** The steps below originally put the guard in `packages/sdk/test/thread-access.test.ts` and expected `vitest` to report the type error. It does not: vitest transforms with esbuild and never type-checks, and `packages/sdk/tsconfig.json` includes only `src/**/*.ts`, so that file is type-checked by **nothing**. A `ThreadOperation[]` literal there is just strings at runtime — the test would keep passing if the union member were deleted, which makes it a guard that cannot fail.
>
> **The guard belongs in `packages/sdk/test/thread-access.contract.ts`**, which `tsconfig.contracts.json` does include and `pnpm --filter @dawn-ai/sdk run typecheck` does run. Follow that file's existing idiom. Prove it by deleting the member and watching `typecheck` fail.
>
> **This applies only to Task 2.** Tasks 3-7 assert HTTP status codes, which vitest checks at runtime — "run it and watch it fail" is a real red step there.

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/test/thread-access.test.ts`:

```ts
it("carries a pending-interrupts operation, so the read gate has a name", () => {
  // Option A: /pending_interrupts is authorized on the thread-access axis in
  // addition to the parking route's middleware. Without this member the gate in
  // runtime-fetch-core has no operation to declare.
  const operations: ThreadOperation[] = [
    "thread.create",
    "thread.get",
    "thread.state",
    "thread.delete",
    "thread.cancel",
    "thread.pending_interrupts",
    "run.stream",
    "run.wait",
    "run.resume",
    "run.agui",
  ]
  expect(new Set(operations).size).toBe(10)
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @dawn-ai/sdk exec vitest --run thread-access.test.ts > /tmp/t2.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=1`, a TypeScript error that `"thread.pending_interrupts"` is not assignable to `ThreadOperation`.

- [ ] **Step 3: Add the member**

In `packages/sdk/src/thread-access.ts`, between `"thread.cancel"` and `"run.stream"`:

```ts
export type ThreadOperation =
  | "thread.create"
  | "thread.get"
  | "thread.state"
  | "thread.delete"
  | "thread.cancel"
  /**
   * `GET /threads/:id/pending_interrupts`. Gated on this axis IN ADDITION to
   * the route that parked the interrupts — the two compose as AND. The parked
   * prompt's `interruptId`/`resumeKey` pair is the credential an attacker needs
   * to resume someone else's turn, so it answers to the same policy as every
   * other read of the thread.
   */
  | "thread.pending_interrupts"
  | "run.stream"
  | "run.wait"
  | "run.resume"
  | "run.agui"
```

- [ ] **Step 4: Verify green**

```bash
pnpm --filter @dawn-ai/sdk exec vitest --run thread-access.test.ts > /tmp/t2b.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/thread-access.ts packages/sdk/test/thread-access.test.ts
git commit -m "feat(sdk): name the pending-interrupts thread operation"
```

---

## Task 3: Gate `POST /threads/:id/runs/stream`

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` — `handleApStreamRequest` (:1669)
- Test: `packages/cli/test/thread-access-run-endpoints.test.ts` (create)

**Placement:** after `runMiddleware`, before `createThread` (:1749) and before `runRegistry.begin` (:1761). The default ordering — an existing 401 from a missing API key must not silently become a 403, and nothing observable happens in between.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/thread-access-run-endpoints.test.ts`.

**Use PR A's own endpoint-test pattern, not `createThreadAccessHarness`.** That harness is a *pure policy unit-tester* — its only method is `check(spec)`, it boots no server and has no `fetch`. Copy the `setup()` / `post()` / `get()` helpers from `packages/cli/test/thread-access-endpoints.test.ts:31-75`: a temp fixture app on disk, then `createRuntimeFetchHandler({ appRoot, threadAccess, threadsStore })` directly. The **injectable `threadsStore`** is how you assert no row was created — the HTTP response cannot answer that on its own.

```ts
import { describe, expect, it } from "vitest"
// setup(), post() and a recording in-memory ThreadsStore: copy from
// thread-access-endpoints.test.ts:31-75 and :77+ rather than re-inventing them.

describe("POST /threads/:id/runs/stream", () => {
  it("denies an unauthorized run without creating the row or taking a run slot", async () => {
    const seen: string[] = []
    const created: string[] = []
    const threadsStore = recordingStore({ onCreate: (id) => created.push(id) })
    const { handler } = await setup({
      threadsStore,
      threadAccess: {
        update: (request) => {
          seen.push(request.operation)
          return { allow: false }
        },
      },
    })

    const response = await handler.fetch(
      post("/threads/t-victim/runs/stream", { input: {}, route: "/hello" }),
    )

    expect(response.status).toBe(403)
    expect(seen).toEqual(["run.stream"])
    // The side effects that must NOT have happened on a deny.
    expect(created).toEqual([])
    expect(await threadsStore.getThread("t-victim")).toBeUndefined()
  })

  it("allows an authorized run", async () => {
    const { handler } = await setup({ threadAccess: { update: () => ({ allow: true }) } })
    const response = await handler.fetch(
      post("/threads/t-mine/runs/stream", { input: {}, route: "/hello" }),
    )
    expect(response.status).toBe(200)
  })
})
```

**The run-slot assertion needs a second request, not a registry accessor** — nothing exposes `RunRegistry` to a test. Assert it by issuing a second run on the same thread and expecting it to succeed rather than `409 run_in_flight`: if the denied request had taken the slot, the second would conflict.

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts thread-access-run-endpoints > /tmp/t3.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=1` — the deny case returns 200 because no gate exists yet.

- [ ] **Step 3: Insert the gate**

In `handleApStreamRequest`, immediately after the `runMiddleware` result is handled and **before** the `createThread` at `:1749`:

```ts
if (threadAccess) {
  const existing = await threadsStore.getThread(threadId)
  const gate = makeThreadGate(threadAccess, request)
  const g = gate({
    action: "update",  // fixed, per the SDK contract — see note below
    operation: "run.stream",
    threadId,
    ...(existing ? { thread: existing } : {}),
  })
  const settled = isThenable(g) ? await g : g
  if (!settled.ok) return settled.response
}
```

`threadAccess` must be threaded into this function's options exactly as `middleware` already is — add `readonly threadAccess: ThreadAccessPolicy | undefined` to the options interface at `:1669` and destructure it, then pass it from the route handler's `ctx`.

- [ ] **Step 4: Verify green**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts thread-access-run-endpoints > /tmp/t3b.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-run-endpoints.test.ts
git commit -m "feat(cli): gate the AP stream endpoint on thread access"
```

---

## Task 4: Gate `POST /threads/:id/runs/wait`

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` — `handleApWaitRequest` (:1953)
- Test: `packages/cli/test/thread-access-run-endpoints.test.ts`

**Placement:** identical shape to Task 3 — after `runMiddleware`, before `createThread` (:2031) and `runRegistry.begin` (:2038).

- [ ] **Step 1: Write the failing test**

Add to the same file, mirroring Task 3's pair but asserting `operation` is `"run.wait"` and driving `/threads/t-victim/runs/wait`. Repeat the assertions rather than looping — an engineer reading this task alone needs the whole case.

```ts
describe("POST /threads/:id/runs/wait", () => {
  it("denies an unauthorized run without creating the row or taking a run slot", async () => {
    const seen: string[] = []
    const created: string[] = []
    const threadsStore = recordingStore({ onCreate: (id) => created.push(id) })
    const { handler } = await setup({
      threadsStore,
      threadAccess: {
        update: (request) => {
          seen.push(request.operation)
          return { allow: false }
        },
      },
    })

    const response = await handler.fetch(
      post("/threads/t-victim/runs/wait", { input: {}, route: "/hello" }),
    )

    expect(response.status).toBe(403)
    expect(seen).toEqual(["run.wait"])
    expect(created).toEqual([])
    expect(await threadsStore.getThread("t-victim")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and watch it fail** — same command as Task 3, `EXIT=1`.

- [ ] **Step 3: Insert the gate** — the Task 3 block verbatim, with `operation: "run.wait"`.

- [ ] **Step 4: Verify green** — `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-run-endpoints.test.ts
git commit -m "feat(cli): gate the AP wait endpoint on thread access"
```

---

## Task 5: Gate `POST /threads/:id/resume` — the ordering exception

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` — `handleResumeRequest` (:2469)
- Test: `packages/cli/test/thread-access-run-endpoints.test.ts`

**This one is not a preference and must not be "tidied" to match the others.** The handler order is `tryClaim` (:2521) → `readPendingInterrupts` → `resolvePendingResume` (:2543) → `getThread` for the route key → `runMiddleware`. Gating after middleware would let a caller the policy denies still:

1. take and hold the victim's resume claim, so a concurrent legitimate resume gets `409 resume_in_progress` — a targeted DoS on a parked turn; and
2. learn from the pre-gate error codes whether the thread has pending interrupts and whether a guessed `interruptId`/`resumeKey` is valid — the exact pair Task 7 gates `/pending_interrupts` to protect.

So the gate goes **immediately after body parse and before `tryClaim` at :2521**, which is *before* `runMiddleware`.

**State the consequence plainly in a comment and in the docs (Task 13):** on `/resume`, and only there, a caller who would have received a middleware 401 receives a thread-access deny instead. Both rules cannot hold at once — `runMiddleware` needs `routeKey`, and `routeKey` is read from thread metadata, so "after middleware" and "before any side effect" are contradictory on this endpoint. The route identity middleware would authorize against is itself derived from the thread the caller has not yet been authorized to read.

- [ ] **Step 1: Write the failing test**

**A parked thread has to be produced, not stubbed.** Reuse the helpers already in `packages/cli/test/pending-interrupts-endpoint.test.ts`: `fixtureApp()` (:109), `withAimock()` (:131), `createHandler(appRoot, checkpointer)` (:151) and `waitForParkedWrite()` (:281), which blocks until the checkpoint durably holds the interrupt. Put this describe block in that file, or export those helpers to a shared test helper — do not re-implement parking.

**aimock fixture-ordering trap:** the `hasToolResult: true` entry MUST precede the plain `userMessage` entry, or the continuation re-matches the tool call and loops forever without finalizing.

```ts
describe("POST /threads/:id/resume — gated before it claims", () => {
  it("denies before taking the resume claim, so a legitimate resume is not DoSed", async () => {
    const appRoot = await fixtureApp()
    const handler = await createHandler(appRoot, checkpointer)  // deny-everything policy
    await driveUntilParked(handler, "t-victim")                 // per waitForParkedWrite
    const parked = await readPendingInterruptsBody(handler, "t-victim")

    const denied = await handler.fetch(
      post("/threads/t-victim/resume", { resume: { interruptId: "guess", resumeKey: "guess" } }),
    )
    expect(denied.status).toBe(403)

    // The claim must still be FREE. Asserted through the only observable there
    // is: a legitimate resume must now succeed rather than 409 resume_in_progress.
    const allowed = await allowingHandler.fetch(post("/threads/t-victim/resume", { resume: parked }))
    expect(allowed.status).not.toBe(409)
  })

  it("does not leak whether a guessed interruptId is valid", async () => {
    // Both requests are denied by the policy, so the 400/409 codes
    // resolvePendingResume derives from the victim's parked interrupts must
    // never be reachable — the two answers must be byte-identical.
    const wrong = await handler.fetch(
      post("/threads/t-victim/resume", { resume: { interruptId: "wrong", resumeKey: "wrong" } }),
    )
    const right = await handler.fetch(post("/threads/t-victim/resume", { resume: parked }))
    expect(wrong.status).toBe(right.status)
    expect(await wrong.text()).toBe(await right.text())
  })
})
```

- [ ] **Step 2: Run it and watch it fail** — expect `EXIT=1`, and specifically expect the second test to fail by returning *different* bodies, which is the leak.

- [ ] **Step 3: Insert the gate**

In `handleResumeRequest`, immediately after the body parse and **before** `const releaseResumeClaim = resumeClaims.tryClaim(threadId)` at `:2521`:

```ts
if (threadAccess) {
  // BEFORE tryClaim, and therefore before runMiddleware — deliberate, and not
  // the default ordering the other three use. Gating after middleware would let
  // a denied caller hold the victim's resume claim (a targeted DoS on a parked
  // turn) and read the 400/409 codes resolvePendingResume derives from the
  // victim's parked interrupts, which is the interruptId/resumeKey oracle
  // /pending_interrupts is gated to protect.
  //
  // The cost, stated rather than hidden: on this endpoint alone a caller who
  // would have received a middleware 401 receives a thread-access deny. Both
  // orders cannot hold — runMiddleware needs routeKey, and routeKey is read
  // from the thread metadata this caller is not yet authorized to read.
  const existing = await threadsStore.getThread(threadId)
  const gate = makeThreadGate(threadAccess, request)
  const g = gate({
    action: "update",
    operation: "run.resume",
    threadId,
    ...(existing ? { thread: existing } : {}),
  })
  const settled = isThenable(g) ? await g : g
  if (!settled.ok) return settled.response
}
```

- [ ] **Step 4: Verify green** — `EXIT=0`, both tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-run-endpoints.test.ts packages/testing/src
git commit -m "feat(cli): gate resume before it claims or answers about a parked turn"
```

---

## Task 6: Gate `POST /agui/:routeId`

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` — after `runMiddleware` (:229), before `tryClaim` (:235)
- Test: `packages/cli/test/thread-access-run-endpoints.test.ts`

**Placement:** middleware already runs first here, so the default costs nothing. The gate goes before `resumeClaims.tryClaim` (:235), `readPendingInterrupts` (:249), `runRegistry.begin` (:264) and `createThread` (:280).

**This route's pattern contains no `threads` segment**, which is exactly why the coverage test lists it — it still resolves a client-supplied thread id, creates the row and writes its metadata.

- [ ] **Step 1: Write the failing test** — the Task 3 shape, driving `POST /agui/echo` with a client-supplied `threadId` of `t-victim`, asserting `operation` is `"run.agui"`, status 403, no row created, no run slot taken, and the resume claim still free.

- [ ] **Step 2: Run it and watch it fail** — `EXIT=1`.

- [ ] **Step 3: Insert the gate**

```ts
if (threadAccess) {
  const existing = await threadsStore.getThread(input.threadId)
  const gate = makeThreadGate(threadAccess, request)
  const g = gate({
    action: "update",  // fixed, per the SDK contract — see note below
    operation: "run.agui",
    threadId: input.threadId,
    ...(existing ? { thread: existing } : {}),
  })
  const settled = isThenable(g) ? await g : g
  if (!settled.ok) return settled.response
}
```

`makeThreadGate`, `isThenable` and `GateSpec` live in `runtime-fetch-core.ts` and are not exported today.

> **Corrected during execution.** This step originally said to export them from `runtime-fetch-core.ts` and import them here. That creates a genuine module cycle — `runtime-fetch-core.ts` already imports `handleAgUiFetchRequest` from `agui-handler.ts`. It is safe at runtime (both symbols are referenced only inside function bodies) but it is the wrong shape, and it contradicts the very precedent the step cites: `terminal-status.ts` exists because #462 extracted a helper shared by **this exact file pair** rather than having one file import the other.
>
> **Extract to `packages/cli/src/lib/dev/thread-gate.ts`** and have both files import from it, leaving `runtime-fetch-core.ts`'s public surface unchanged. Move the gate's private helpers (`denyResponse`, `toThreadSubject`, `GATE_OK`, `warnedIgnoredStamp`) only if nothing else in `runtime-fetch-core.ts` uses them — check first. Model the new file on `terminal-status.ts`, and say in its module doc why it is separate.

- [ ] **Step 4: Verify green** — `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/agui-handler.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-run-endpoints.test.ts
git commit -m "feat(cli): gate the AG-UI route on thread access"
```

---

## Task 7: Gate `GET /pending_interrupts` — Option A

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` — the route handler at `:1587-1603`
- Test: `packages/cli/test/thread-access-pending-interrupts.test.ts` (create)
- Modify: `packages/cli/test/pending-interrupts-endpoint.test.ts` — third premise rewrite

**The two checks compose as AND**, and #443's route-identity check stays. A denied read must route through **this handler's own `404 thread_not_found` literal** so it stays byte-identical to a genuine miss — do not introduce a second 404 shape.

- [ ] **Step 1: Write the failing test**

Same helpers as Task 5 — a real parked thread via `fixtureApp` / `createHandler` / `waitForParkedWrite`.

```ts
it("denies a read the policy rejects, byte-identically to a genuine miss", async () => {
  const handler = await createHandler(appRoot, checkpointer)  // read: deny
  await driveUntilParked(handler, "t-victim")

  const denied = await handler.fetch(get("/threads/t-victim/pending_interrupts"))
  const missing = await handler.fetch(get("/threads/t-never-existed/pending_interrupts"))

  expect(denied.status).toBe(missing.status)
  expect(await denied.text()).toBe(await missing.text())
})

it("still enforces the parking route's middleware — the checks compose as AND", async () => {
  // A policy that allows everything must not make #443's route-identity check
  // vanish. This one should pass BEFORE the gate is added: it is a regression
  // guard on #443, not new behavior.
  const appRoot = await fixtureApp({
    "src/middleware.ts": "export default () => new Response(null, { status: 401 })\n",
  })
  const handler = await createHandler(appRoot, checkpointer)  // read: allow
  const response = await handler.fetch(get("/threads/t-mine/pending_interrupts"))
  expect(response.status).toBe(401)
})
```

- [ ] **Step 2: Run it and watch it fail** — `EXIT=1` on the first test; the second should already pass, which is the point (it is a regression guard on #443, not new behavior).

- [ ] **Step 3: Insert the gate**

In the `/pending_interrupts` handler, after the thread is loaded and before the parked-route identity resolution, reusing the handler's existing not-found literal:

```ts
if (threadAccess) {
  const gate = makeThreadGate(threadAccess, request)
  const g = gate({
    action: "read",
    notFound,                       // the handler's OWN literal — see above
    operation: "thread.pending_interrupts",
    threadId,
    ...(thread ? { thread } : {}),
  })
  const settled = isThenable(g) ? await g : g
  if (!settled.ok) return settled.response
}
```

- [ ] **Step 4: Rewrite the premise in `pending-interrupts-endpoint.test.ts`**

That file asserts this endpoint is gated on route identity *alone*. Find every comment and assertion stating so and correct it to "route identity AND thread access". Do not delete the route-identity coverage — Option A adds a check, it does not replace one.

- [ ] **Step 5: Verify green**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts pending-interrupts thread-access > /tmp/t7.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/thread-access-pending-interrupts.test.ts packages/cli/test/pending-interrupts-endpoint.test.ts
git commit -m "feat(cli): authorize pending-interrupt reads on the thread-access axis"
```

---

## Task 8: Move five patterns from deferred to gated

**Files:**
- Modify: `packages/cli/test/thread-access-coverage.test.ts`

This test is the reason PR B cannot quietly forget an endpoint. All five patterns currently on `DEFERRED` move to `GATED`, leaving `DEFERRED` empty.

- [ ] **Step 1: Move the entries**

Move all five `routeKey(...)` lines from `DEFERRED` into `GATED`, and replace the `DEFERRED` doc comment with:

```ts
/**
 * Empty since PR B. Every thread-scoped route is now gated on the thread-access
 * axis. A new thread endpoint belongs on GATED; putting it here again needs a
 * reason written down, because "deferred" was a slice boundary, not a category.
 */
const DEFERRED: readonly string[] = []
```

Update the `GATED` comment from "Gated in PR A: the five endpoints that ran no middleware at all" to name both slices.

- [ ] **Step 2: Verify green**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts thread-access-coverage > /tmp/t8.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, still asserting 14 entries.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/thread-access-coverage.test.ts
git commit -m "test(cli): every thread route is gated, so the deferred list is empty"
```

---

## Task 9: `normalizeThreadAccessModule` and the static-module pipeline

**Files:**
- Modify: `packages/cli/src/lib/runtime/static-modules-core.ts`
- Modify: `packages/cli/src/runtime-exports.ts` **and** `packages/cli/src/fetch-exports.ts`
- Modify: `packages/cli/src/lib/build/modules-emitter.ts:346-348`
- Test: `packages/cli/test/static-middleware.test.ts`, `packages/cli/test/edge-modules-emitter.test.ts`

**Both barrels or the manifest fails to link** — the generated manifest imports by literal specifier on each target.

**The emitter must compose its named-import line from a list**, not the current two-branch ternary, so a middleware-only app still emits the byte-identical string asserted at `static-middleware.test.ts:108-109` and `edge-modules-emitter.test.ts:248-249`. Place `threadAccess:` **after** `middleware:` and **before** `routes:` so the position assertions at `static-middleware.test.ts:112-116` stay green.

- [ ] **Step 1: Write the failing tests**

Add the thread-access twin of the existing no-middleware guard. `static-middleware.test.ts:141` and `:426` assert `not.toContain("normalizeMiddlewareModule")` for an app with no middleware file; add the same for `normalizeThreadAccessModule` and an app with no policy file — without it a no-policy app could start emitting a hook entry and nothing would notice.

- [ ] **Step 2: Run and watch fail** — `EXIT=1`.

- [ ] **Step 3: Implement** `normalizeThreadAccessModule` alongside `normalizeMiddlewareModule`, export from both barrels, and rewrite the emitter's import line as a list join.

- [ ] **Step 4: Verify green** — run both test files; `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(cli): carry a thread-access policy through the static module manifest"
```

---

## Task 10: The manifest-staleness guard

**Files:**
- Modify: the build target that records what the build saw + the boot path that checks it
- Test: `packages/cli/test/thread-access-build-targets.test.ts`

**The failure this closes actually happens:** a manifest generated before the app grew a policy, deployed to edge, silently ungated.

Record that the build saw a policy file, then fail the boot when that record is present and the manifest carries no `threadAccess` **key** — distinguished with `in`, so a bound-nothing entry and an absent entry are different things.

- [ ] **Step 1: Write the failing test** — a manifest with the record set and no `threadAccess` key must fail the boot with a named error; a manifest with `threadAccess: undefined` present must **not**.
- [ ] **Step 2: Run and watch fail** — `EXIT=1`.
- [ ] **Step 3: Implement**, using `"threadAccess" in manifest` rather than a truthiness check.
- [ ] **Step 4: Verify green** — `EXIT=0`.
- [ ] **Step 5: Commit**

```bash
git commit -am "fix(cli): fail the boot when a policy-built app deploys a policy-less manifest"
```

---

## Task 11: Lift PR A's `hono` build refusal

**Files:**
- Modify: `packages/cli/src/lib/build/targets/*` — remove the `DAWN_E1005` refusal for `hono`
- Test: `packages/cli/test/thread-access-build-targets.test.ts`

PR A made `dawn build --target hono|langsmith` fail with `DAWN_E1005` while a policy file exists, because the web runtime could not carry one. Task 9 removes that limitation for `hono`.

- [ ] **Step 1:** Flip the existing `hono` refusal test to assert a **successful** build that emits a `threadAccess` entry. Leave `langsmith` refusing and keep its test.
- [ ] **Step 2:** Run and watch fail — `EXIT=1`.
- [ ] **Step 3:** Remove the `hono` branch of the refusal.
- [ ] **Step 4:** Verify green — `EXIT=0`.
- [ ] **Step 5:** Commit.

```bash
git commit -am "feat(cli): hono builds carry a thread-access policy"
```

---

## Task 12: Scaffold and conformance

**Files:**
- Create: scaffold templates `src/thread-access.ts` (deny-by-default) and a shared `src/auth.ts`
- Modify: `runThreadsStoreConformance`

- [ ] **Step 1:** Add the two template files. The policy must be **deny-by-default** and must read its subject from the server stamp (`request.thread?.access`), never from `metadata`.
- [ ] **Step 2:** Add the two conformance cases spec §4 names.
- [ ] **Step 3:** Run the scaffold + conformance suites; `EXIT=0`.
- [ ] **Step 4:** Commit.

```bash
git commit -am "feat(cli): scaffold a deny-by-default thread-access policy"
```

---

## Task 13: Docs

**Files:**
- Modify: `apps/web/content/docs/thread-access.mdx` — the recipe, and the `/resume` ordering consequence from Task 5
- Modify: `apps/web/content/docs/middleware.mdx` — the "Where middleware runs" table and the ungated-endpoint sentence after it, both wrong the moment PR A shipped
- Modify: `apps/web/content/docs/dev-server.mdx`

- [ ] **Step 0: Fix the SDK doc comment PR B makes false.** `packages/sdk/src/thread-access.ts:16-37` documents each operation and the action it arrives under, then closes with: *"the four `run.*` members are not gated yet: a policy may match them today and simply will not be invoked for them until the run endpoints are wired."* PR B **is** that wiring. Delete that paragraph and add `thread.pending_interrupts` — `GET /threads/:id/pending_interrupts` — `read` to the list. That comment is also the authoritative statement that all four `run.*` operations arrive under **`update`**, which is what corrected this plan's own gate snippets mid-execution — do not weaken it.

- [ ] **Step 1:** Rewrite the middleware "Where middleware runs" table and the sentence after it. The claim that the run endpoints are gated by middleware alone is now false.
- [ ] **Step 2:** Document, in one clear sentence each: that `/pending_interrupts` composes both checks as AND and which one produced a given denial; and that `/resume` alone answers a thread-access deny where a middleware 401 would otherwise have been returned, with the reason.
- [ ] **Step 3:** Run the docs guards.

```bash
node scripts/check-docs.mjs > /tmp/docs.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`. If it fails with "did you run pnpm build?", that is a stale `dist`, not a docs error.

- [ ] **Step 4:** Commit.

```bash
git commit -am "docs: reconcile middleware and thread-access after PR B"
```

---

## Task 14: Changeset and full validation

- [ ] **Step 1: Write the changeset**

`@dawn-ai/sdk` patch, `@dawn-ai/cli` patch, `@dawn-ai/testing` patch. It must lead with the two consequences a reader needs:

1. `ThreadOperation` gains a tenth member — additive, but an exhaustive `switch` over it will stop compiling.
2. An app with a policy now has its run endpoints and `/pending_interrupts` authorized. Apps whose policy was written against PR A's five endpoints will see it invoked on five more.

- [ ] **Step 2: Full local validation**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm ci:validate > /tmp/validate.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`. This is long; do not interrupt it and do not read a truncated tail as success.

- [ ] **Step 3: Merge `origin/main` and re-validate**

`runtime-fetch-core.ts` is the busiest file in the repo; expect conflicts.

- [ ] **Step 4: Push and open the PR**

The body must state the Option A decision, the `/resume` ordering exception and its cost, and that `DEFERRED` is now empty.

---

## Self-review notes

**Spec coverage.** PR B item 1 → Tasks 3-8. Item 2 → Task 9. Item 3 → Task 10. Item 4 → Task 12. Item 5 → Task 12. Item 6 → Task 13. The resolved open question → Tasks 2 and 7. Item 2's hono lift → Task 11.

**Known thin spots**, flagged rather than papered over:

- Tasks 9-12 carry less literal code than Tasks 3-7. That is deliberate — the gates are the security-critical core and are specified to the line; the build-pipeline tasks depend on the exact shape of `normalizeMiddlewareModule`, which the implementer must read first and mirror. If that reading turns up a surprise, stop and re-plan rather than improvising a second pattern.
- **A first draft of this plan tested Tasks 3-7 through `createThreadAccessHarness`. That was wrong and is corrected above.** That harness is a pure policy unit-tester — one `check(spec)` method, no server, no `fetch`, no store — and its own doc comment says so. Endpoint tests use the `setup()` / `createRuntimeFetchHandler` pattern at `thread-access-endpoints.test.ts:31-75`, with an injected `threadsStore` for the "no row created" assertion. It is recorded here because the mistake is easy to repeat: the harness has the most inviting name in the package and is the wrong tool for every task in this plan.
- **There is no `RunRegistry` accessor for tests.** The "no run slot taken" assertion is made through a second request that must not receive `409 run_in_flight`, not through a registry read.
- Tasks 5 and 7 need a genuinely parked thread, which means driving a real turn through aimock until `waitForParkedWrite` returns. That is slower and fussier than the other tasks — budget for it, and mind the fixture-ordering trap noted in Task 5.
