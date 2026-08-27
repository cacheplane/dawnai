# Handoff — Agent Protocol stream-reattachment arc

**Snapshot date: 2026-08-27.** Point-in-time note. The PR states below go stale the moment someone merges; the *gotchas*, *decisions on record*, and *open follow-ups* sections do not.

---

## 1. State at a glance

Two PRs open, stacked. Both approved by the bot, both mergeable.

| PR | Branch | Contents | State |
|---|---|---|---|
| [#489](https://github.com/cacheplane/dawnai/pull/489) | `blove/agent-protocol-thread-auth-94c180` | **PR2** of the reattach arc (`LiveTurnHub` + `GET /threads/:id/runs/stream`) **plus** an AG-UI run-slot authorization fix | OPEN, MERGEABLE, base `main` |
| [#506](https://github.com/cacheplane/dawnai/pull/506) | `blove/ap-threads-tail` | **PR3** (`dawn threads tail`) | OPEN, MERGEABLE, base **`blove/agent-protocol-thread-auth-94c180`** (stacked) |

**Merge order is not optional.** #506 is based on #489's branch, not on `main`.

```bash
# 1. merge #489 first
# 2. then retarget #506 (it is a direct descendant, so this is clean):
gh pr edit 506 --base main
```

**Working copy:** `/Users/blove/repos/dawn/.claude/worktrees/thread-auth-pr2`, currently on `blove/ap-threads-tail`. Both branches are pushed and match their remotes. Kept alive deliberately for review fixes; `git worktree remove` it when the arc lands.

### The only red check on both PRs is `review`

It fails **repo-wide** on an exhausted Anthropic credit balance — identically on every recently merged PR (#502, #501, #499, #498). It is not a signal about this work. `validate` is the **only** required check on `main` and it passes on both:

```bash
gh api repos/cacheplane/dawnai/branches/main/protection --jq '.required_status_checks.contexts'  # => ["validate"]
```

---

## 2. Arc status

Design spec: `docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md`. Architecture chosen: **"Anchored Live-Turn Attach" — reattachment is resumable STATE, not a resumable stream.** (Event-replay with `Last-Event-ID` was designed and rejected; the spec records why. Do not revive it without a concrete third-party client demanding it.)

| Slice | Status |
|---|---|
| PR1 — durable HITL honesty (`PendingInterrupt.value`, `GET /pending_interrupts`, parked turns reporting `"interrupted"`) | **MERGED** (#443) |
| Thread authorization (`defineThreadAccess`) + PR A/PR B of the thread-access design | **MERGED** (#460, #468, #469, #474) |
| PR2 — `LiveTurnHub` + attach endpoint | **In review (#489)** |
| PR3 — `dawn threads tail` + docs | **In review (#506)** |

⚠️ **The task briefing that started this session was ~11 days stale** — it described the `/pending_interrupts` gating decision and thread-access PR B as still open when both had merged. Verify against `main` before trusting any description of this arc's state.

---

## 3. What is in each PR

### #489 — two logical units

**(a) Security fix.** `POST /agui/:routeId` called `runRegistry.begin` *before* rechecking the concrete thread row on the create-race path. Because the thread id is client-chosen there, a caller the recheck ultimately denies could hold a victim thread's run slot for the width of that recheck, bricking a concurrent authorized run with a transient `run_in_flight` 409. Row authorization now precedes the slot claim, mirroring the AP run handlers. Regression test: `packages/cli/test/thread-access-agui-slot-ordering.test.ts` (blocks a denied caller's recheck mid-flight via a controllable policy promise and a `hidingStore` that hides the victim row from its first `getThread` only).

Found by a three-thesis adversarial review (stamp forgery/prototype chain; gate ordering/TOCTOU; fail-open loader/manifest). The other two theses came back **clean** — see §6.

**(b) PR2 proper.** `packages/cli/src/lib/dev/live-turn-hub.ts` (bounded in-memory digest + pull-based SSE fan-out) and `handleApAttachRequest` in `runtime-fetch-core.ts`, plus producer hooks in both AP handlers and `agui-handler.ts`, and `liveTurnHub.closeAll()` on shutdown. Adds one additive `ThreadOperation` member, `thread.attach`.

### #506 — `dawn threads tail <thread-id>`

Five modules under `packages/cli/src/lib/threads/` behind a thin command:
`sse-frames` → `attach-state` → `tail-render` → `tail-stream` → `commands/threads.ts`.

Deliberately **structural**: it parses the documented wire defensively and never imports the server's frame types, so it is a genuine third-party consumer of the published contract. `renderSnapshot` renders `turn[]` through *the same* per-frame function the live tail uses, which makes "snapshot and tail concatenate cleanly" true by construction.

---

## 4. CI conditions you will hit

1. **`review` fails repo-wide** (credit balance). Top up to restore it — it caught two real bugs on #443 and has been silently valueless across ~90+ PRs.
2. **`sandbox-docker` fork-bomb flake.** Signature: `recycles a PID-exhausted keeper` → `Error: readFile failed: sh: 1: Cannot fork`, with 11/12 passing. It recurred once here and passed on re-run. Untracked as an issue; open PR #503 (lint/test-timeout coverage) is the natural home.
3. **Load-induced per-test timeouts under the full suite.** Seen on `render-route-types` (`@dawn-ai/core`, a TS-compile test) and `api-reference-inventory` (`web`, a `spawnSync` subprocess test). Both pass in isolation. Distinguish by the message: "Test timed out in Nms" is a flake; an `AssertionError` is not.
4. **Vercel** was failing on *every commit* repo-wide until #495 ("build workspace dependencies before the docs site"). If you see it red on a branch cut before 2026-08-26, merge `main`.

### The SEO lastmod gate — the one that will actually bite you

`apps/web/app/seo/generate-lastmod.test.ts` runs the generator with `--check` and expects exit 0. The generator derives each page's last-modified date **from git history**, so editing any `apps/web/content/docs/**.mdx` staleness the checked-in `apps/web/app/seo/lastmod.generated.ts` and reds the required `validate` check.

```bash
pnpm --dir apps/web seo:lastmod --as-of <YYYY-MM-DD>   # the failure message names the date
```

**Order matters, and this bit twice:**

1. Commit the docs change **first**.
2. *Then* regenerate.
3. Commit the manifest as **its own commit**.

Regenerating and then `--amend`ing the docs commit rewrites the very timestamp the manifest just captured, re-staling it (observed: `05:19:27` → `05:19:54`, a 27-second amend delta).

**Attribution trick:** regenerate and read the diff. One changed line naming your page means it is yours. Many lines means `main` was already stale.

⚠️ **A green pre-merge `validate` does not predict a green post-merge `validate`** when `main` has added a gate since your branch was cut. This gate landed on `main` after #489 was branched, so it only appeared after merging.

---

## 5. Repo gotchas baked into this work

- **Node 24 is mandatory.** `source ~/.nvm/nvm.sh && nvm use 24`. The shell default is v22 and makes ~20 unrelated CLI tests fail spuriously.
- **Never decide pass/fail through a pipe.** `<cmd> > /tmp/x.log 2>&1; echo "EXIT=$?"`. A `pnpm … | tail` reports the *pipe's* status and has produced a false green in this repo's history.
- **Never a bare `biome check --write`** — it mass-reformats. Scope it: `npx biome check --config-path ../config-biome/biome.json --write <paths>`.
- **Changesets: patch only** (the fixed 0.x group turns a minor into 1.0.0), and **commit the changeset before** running `scripts/check-changesets.mjs` — it diffs commits, not the working tree.
- **`check-docs.mjs` reads the BUILT `packages/cli/dist/index.js`.** Build before running it, or its CLI-surface check cannot see a new command. That check requires `cli.mdx` to contain the literal `dawn <name>` plus every declared **long** flag.
- **`check-docs.mjs` bans the phrase `byte-identical`** (rule: "overstates local/prod protocol or deployment parity", alongside "What works locally works in production" / "without translation"). It does *not* scan `docs/superpowers/`.
- **Widening the `ThreadOperation` union breaks a compile-time contract test** at `packages/sdk/test/thread-access.contract.ts` (an `Equal<ThreadOperation, …>` pinning every member). `pnpm --filter @dawn-ai/cli typecheck` does **not** catch it — only the SDK's own `tsc -p tsconfig.contracts.json` does.
- **Adding a new docs page costs five coordinated files**, including a hardcoded mirror list (`expectedNavDocEntries`) inside `scripts/check-docs.mjs`. Adding a section to an existing page costs one. PR3 deliberately chose the latter.
- **Adding a `DAWN_E` error code** requires a nav entry, a docs page, a `page.tsx` wrapper and a regenerated `errors.mdx`. PR3 deliberately avoided one.

### Shared-worktree hazard

This repo has many concurrent sessions. During this work another session **switched the shared worktree's HEAD between branches mid-session**, so commits landed on the wrong branch and one was `reset` away. Symptoms: foreign files appearing as modified in `git status`; `git log` showing commits you never made as ancestors of yours.

- Diagnose with the per-worktree reflog plus `git worktree list`.
- Recover with `git worktree add <path> <your-branch>` and `git cherry-pick` the strays. **A branch checked out in a dedicated worktree cannot be checked out elsewhere — the dedicated worktree locks it and the hijacking stops.**
- Never `git add -A` here. Stage explicit paths, always.

---

## 6. Decisions on record — do not relitigate without new information

- **Event-replay / `Last-Event-ID` reattachment was designed and rejected.** Reasons are in the spec's "Rejected approaches". Reconnect always re-snapshots; there are no cursors and no retention.
- **`/pending_interrupts` is gated on the thread-access axis AND the route that parked the interrupts** — they compose as AND. Decided 2026-08-13, shipped in #468.
- **The `LiveTurnHub` lives beside `runRegistry`** in the handler body, not beside `threadRouteMap` in `buildRouteTable`, because `handler.close()` must be able to drain it.
- **The attach endpoint is gated exactly as strictly as `/pending_interrupts`** — thread-access `read` with a `notFound` indistinguishable from a genuine miss, then route identity, then middleware with `method: "GET"`. Adversarial review confirmed no bypass; do not "simplify" that ordering.
- **`apAttachDigestMaxBytes` (2 MiB) and `apAttachMaxViewers` (16)** are internal handler-option defaults, **not** `DawnConfig` fields. The docs describe them as fixed defaults, which is accurate today.
- **PR3's client does not import server frame types.** That coupling is the point of the design; keep it.

### The recurring bug class in this area

**Prototype-chain reads.** Three separate places shipped the same hole before this session (a `[[Set]]` assignment that `__proto__` subverted; a policy-result reader honoring `Object.create({decision:"allow"})`). Use `Object.hasOwn` + `Object.defineProperty` on anything attacker-influenced. The re-audit confirmed these are currently closed end to end.

### Dawn's HTTP error envelope

`{error: {kind, message, details?: {code?}, code?}}`. `createRequestErrorBody(msg, {code})` passes the code as the **DETAILS** positional, so every thread endpoint's machine-readable code lands at **`error.details.code`**; `error.code` is populated only via the third `options` argument. **A client branching on a top-level `body.code` matches nothing and silently degrades to its generic branch** — exactly the bug PR3 shipped and fixed for `409 thread_route_unknown`.

---

## 7. Three bugs caught by reading code, not by green tests

Worth internalizing, because each passed its suite first.

1. **AG-UI run-slot ordering** (#489) — found by adversarial review, not by the existing thread-access suites.
2. **`retry:` arrives *after* `done`** on the durable path, so the stream driver must keep draining rather than break at the terminal frame — otherwise the reconnect hint is silently dropped.
3. **The error-code lookup** (§6). Its first test **passed against the broken code**: the asserted phrase ("has never run") also appears in the *server's* message, so the generic fallback satisfied it. Only asserting a phrase unique to the client's own branch ("there is nothing to tail") made it properly red.

**The lesson worth carrying:** when a test asserts a substring that could plausibly arrive by more than one path, it certifies nothing. Assert something only the intended path can produce — and verify a new test actually fails against the unfixed code.

Reviewers also caught non-vacuity gaps in PR2's own tests: a subscriber-isolation test that overflowed *both* subscribers (so it never proved isolation), a shutdown test that passed with `closeAll()` removed, and live-path tests that asserted no intermediate `publish()` frame. All were tightened and each was verified to fail without its fix.

---

## 8. Open follow-ups

**Blocking-ish**
- Get a **human review** on #489 — it touches an authorization gate and only the bot has approved.
- Merge #489, then `gh pr edit 506 --base main`.

**Arc**
- Promote `apAttachDigestMaxBytes` / `apAttachMaxViewers` to `DawnConfig` if operators ask; today they are fixed defaults.
- Live attach on workerd is **best-effort until proven**. The durable path is the documented guarantee. Proving it needs a deploy lane (deploy-anywhere PR3 territory).
- Multi-replica: any replica serves a correct durable snapshot; only the live tail requires the owning replica. Session affinity restores it. Owned by the future shared-backend sub-project.

**Repo hygiene (not this arc's fault)**
- **Top up Anthropic credits** to restore the `review` job repo-wide.
- File an issue for the `sandbox-docker` fork-bomb flake, or fold it into #503.

**Still-open perimeter items** (from the security work, tracked in memory)
- `interruptId` is `Date.now()` plus ~31 bits of `Math.random()` while being the only secret needed to answer a parked prompt.
- Ungated `GET /threads/{id}/state` still serves a parked prompt's tool name and arguments verbatim; the attach and `/pending_interrupts` gates protect the `interruptId`/`resumeKey` **addressing pair**, not the prompt's semantic content. Do not overclaim this.

---

## 9. Where the durable knowledge lives

- **Spec:** `docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md` (architecture + rejected approaches)
- **Spec:** `docs/superpowers/specs/2026-08-10-thread-access-design.md` (thread authorization)
- **Plans (re-drafted against real trees, not the stale provisional ones):**
  - `docs/superpowers/plans/2026-08-24-ap-reattach-pr2-live-turn-attach.md`
  - `docs/superpowers/plans/2026-08-26-ap-reattach-pr3-threads-tail.md`
  - The 2026-08-09 PR2/PR3 plans are marked **PROVISIONAL** and are superseded — do not execute them.
- **User-facing docs:** `apps/web/content/docs/dev-server/agent-protocol.mdx` ("Reattaching to a running turn") and `apps/web/content/docs/cli.mdx` (`dawn threads`).
- **Agent memory:** `project_ap_stream_reattach` (arc state, gates, error envelope), `project_shared_worktree_head_collision` (the worktree hazard), `project_dawn_worktree_bringup`, `dawn_node24_test_gotcha`.

> **Note for whoever picks this up:** the plans' value is their *pinned anchors and gotchas*, not their step lists. Both were re-drafted precisely because plans written before their predecessor landed are stale by construction. If you draft a PR4, re-verify against the tree you actually have.
