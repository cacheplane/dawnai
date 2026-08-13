# Thread Access PR C — stamp the implicit create

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three run endpoints that create a thread row when it is missing must stamp the creating caller into it, the same way `POST /threads` already does. One coherent change; no new authorization concepts.

**Base:** `origin/main` at `782568a9` (PR B merged).

---

## Why

PR A established that `POST /threads` stamps its caller into a reserved metadata key, so a policy can later authorize against `req.thread.access` — an unforgeable, server-issued owner record. PR B gated the run endpoints but left their own implicit create passing no metadata at all:

- `packages/cli/src/lib/dev/runtime-fetch-core.ts:1640` — `/runs/stream`
- `packages/cli/src/lib/dev/runtime-fetch-core.ts:1941` — `/runs/wait`
- `packages/cli/src/lib/dev/agui-handler.ts:307` — `/agui/:routeId`

all `createThread({ thread_id: threadId })`, on a **client-supplied** id. A thread born there has `access === undefined` forever, and that costs two things.

**The flow breaks on turn two.** The caller who created the thread is denied on their own thread, because the row records no owner. This is what makes the scaffolded policy refuse every AG-UI conversation on a browser-chosen `threadId`.

**The migration story is unsound — and this is the real reason for the PR.** An app adopting a policy is told to write a legacy branch: `access === undefined` means "this thread predates the policy", handled admin-only or backfilled. After PR B an attacker can manufacture an unstamped row on demand, by naming any thread id at `POST /threads/<id>/runs/stream`. `unstamped` stops meaning "pre-policy" and starts meaning "pre-policy, **or created by anyone just now**". A permissive legacy branch — the common shape mid-rollout — becomes an escalation path.

`POST /threads/:id/resume` is NOT in scope: it requires an already-parked thread and performs no implicit create.

## The design

Mirror `POST /threads` (`runtime-fetch-core.ts:1067-1110`), which is the reference implementation.

When a run endpoint finds the row absent **and a policy is installed**:

1. Gate under **`action: "create"`**, keeping the endpoint's own `operation` (`run.stream` / `run.wait` / `run.agui` — never rewritten to `thread.create`). No client metadata reaches these paths, so no `requestedMetadata`.
2. Apply the returned stamp to the create: `{ metadata: { [THREAD_ACCESS_METADATA_KEY]: stamp } }`, exactly as `POST /threads` builds `stored`.
3. **Recheck under `action: "update"` against the row that actually came back.** Security-critical and not optional. The id is client-chosen, so two callers can both see an absent row and both call `createThread`; an upsert backend hands the loser the winner's row. The recheck authorizes the ROW, not the intent. **Never a stamp comparison** — `POST /threads:1097-1100` explains why: with `permit()` and no stamp both sides are `undefined`, the comparison passes, and the loser proceeds on a stranger's row with no authorization at all.
4. Row already present: unchanged, the `action: "update"` gate PR B added.
5. **A hook-less app is untouched.** No extra gate call, no metadata, no extra store read — PR A's contract is "no policy file means today's behavior, exactly." All new work stays inside `if (threadAccess)`.

### What differs from `POST /threads`, and why no retry

`POST /threads` retries its create up to three times, because its id is server-generated and 32 bits wide: a collision there is a birthday problem, and a fresh draw is very likely to succeed. **A run endpoint cannot retry** — the caller named the id, so a second attempt collides identically, forever. Adoption of an existing row is therefore a permanent outcome on these paths and the `update` recheck is the *only* thing standing between the caller and a stranger's thread. `isRowWeJustWrote` has no role here.

A backend whose `createThread` throws on a duplicate id (sqlite's bare `INSERT`; the conformance kit deliberately admits both outcomes) surfaces exactly as it does today. That path never reaches the recheck because it never gets a row.

### The AG-UI window

On `/runs/stream` and `/runs/wait` the create is the statement after the gate. On `/agui/:routeId` it cannot be: it has always sat after `resumeClaims.tryClaim`, `runRegistry.begin` and a checkpointer read, and moving it would move side effects a denial must not take. So the `create` decision is carried down in two locals, and that handler additionally re-reads the row before creating: if one has appeared in the meantime, the turn is authorized under `update` against **that** row rather than proceeding on a decision made about a thread that did not exist. Same principle as the post-create recheck, applied to a window that is several statements wide instead of one.

## Published contract change

`packages/sdk/src/thread-access.ts`'s `ThreadOperation` doc says every `run.*` operation arrives under `update`, "without exception". That becomes false: `run.stream`, `run.wait` and `run.agui` now arrive under `create`, **then** `update`, when the row is absent — the same two-step shape `thread.create` already documents. Update those lines in the same style. Weaken nothing else in the comment.

## Tasks

- [ ] **Task 1 — plan.** This file, committed first.
- [ ] **Task 2 — failing tests.** `packages/cli/test/thread-access-run-endpoints.test.ts`, all three endpoints:
  - the creating caller takes a **second turn** on a thread the run endpoint created (the flow broken today — write it first and watch it fail);
  - an **intruder is denied** on a thread another caller's run endpoint created;
  - the **race**: a fake `ThreadsStore` whose `createThread` returns a foreign row, and the recheck denies;
  - a **hook-less app writes no metadata** on the implicit create.
  Observe every red step. A test that cannot fail is worse than no test.
- [ ] **Task 3 — implementation.** A shared create-and-recheck helper in `thread-gate.ts` (the module both `runtime-fetch-core.ts` and `agui-handler.ts` already import — the import back the other way would be a cycle), plus the `action: thread ? "update" : "create"` selection at the three gate sites. On `/agui` the gate is early (before `tryClaim` / `runRegistry.begin`) and the create is late, so the stamp is carried across in a local.
- [ ] **Task 4 — SDK doc.** `ThreadOperation`'s comment.
- [ ] **Task 5 — reconcile what is now false.** `apps/web/content/docs/thread-access.mdx` (the "denies a missing row denies every AG-UI turn" callout, and the "all four arrive under `update`" line), the three byte-for-byte copies of the scaffolded `thread-access.ts.example`, and the tests that string-match them (`packages/devkit/test/template-thread-access.test.ts`) or execute them (`packages/cli/test/thread-access-scaffold.test.ts`). The scaffold's behavior changes for the better and on its own — its `create` handler stamps an authenticated caller — so what changes here is prose that has stopped being true, plus the pinned expectations of it.
- [ ] **Task 6 — changeset.** `@dawn-ai/sdk` patch, `@dawn-ai/cli` patch. It must say plainly that a thread created implicitly by a run endpoint is now stamped, so a policy's legacy/unstamped branch again means only "created before the policy existed"; and that `run.*` operations can now arrive under `create`. PR B's own unreleased changeset states the opposite in two places and ships in the same release — amend it rather than contradict it.

## Verification

Node 24 (`export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`). Capture exit codes explicitly (`cmd > /tmp/x.log 2>&1; echo "EXIT=$?"`) — a pipe reports the pipe's status and has produced false greens here. **Build before typecheck**: cross-package types resolve through `dist/`, so an unbuilt edit does not error, it lies.

- `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts`
- `pnpm --filter @dawn-ai/devkit exec vitest --run`
- `node scripts/check-docs.mjs` (bans the literal phrase "byte-identical"; use "byte-for-byte")
- `pnpm typecheck`, `pnpm lint`
