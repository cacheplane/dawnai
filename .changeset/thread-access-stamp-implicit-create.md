---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
---

Threads created implicitly by a run endpoint are now stamped with the caller who
created them.

`POST /threads/:id/runs/stream`, `/runs/wait` and `POST /agui/{routeId}` create
the thread when the id they were given names no row. That create wrote no
metadata, so the row carried no access stamp — and two things followed from
that.

**A policy's legacy branch means only "created before the policy existed"
again.** `thread.access === undefined` is the branch an app writes when it
adopts a policy on an existing store, usually admin-only or backfilled. Because
an unstamped row could be manufactured on demand — by naming any thread id at a
run endpoint — that branch had quietly widened to "predates the policy, **or**
was created by anyone a moment ago", which turns a permissive legacy branch
(the common shape mid-rollout) into an escalation path. The implicit create now
carries the stamp your `create` handler returns, so the branch means what it
says.

**The caller who created a thread can take a second turn on it.** Previously the
row it had just made read back with no owner, so a policy that authorizes
against `thread.access` denied its own author from turn two onward. This is the
flow `POST /agui/{routeId}` drives, since CopilotKit picks its `threadId` in the
browser and never calls `POST /threads`.

**`run.*` operations can now arrive under `action: "create"`.** When the row is
absent, `run.stream`, `run.wait` and `run.agui` are asked under `create` — then
again as the `update` recheck that follows every create, the same two-step
`thread.create` already used. The `operation` is unchanged throughout; only the
`action` differs. `run.resume` is untouched: it requires an already-parked
thread and creates nothing.

Read your `create` handler before upgrading. It now decides runs on thread ids
the client picked, not just `POST /threads`, and the stamp it returns is what
every later turn on those threads authorizes against. A policy that denied
`create` outright — or that relied on `update` seeing `thread: undefined` for a
first turn — changes behavior here. Ownership of a client-chosen id is first
come, first served: whoever names an unused id is stamped as its owner and can
hold it against the caller who meant to use it. Mint ids with `POST /threads`
if that matters; those are server-generated and nobody can call them first.

The `update` recheck is not optional and is not a stamp comparison. Two callers
can both find the row absent, and a store that upserts on collision hands the
loser the winner's row; Dawn re-authorizes the row that actually came back
before the run proceeds. Comparing the minted stamp with the returned one would
not catch it — a `permit()` with no stamp leaves both sides `undefined`.

An app with no policy file is unaffected: the implicit create still passes the
thread id and nothing else, with no extra gate call and no extra store read.

The scaffolded `src/thread-access.ts` gains the AG-UI flow as a consequence: its
`create` handler stamps an authenticated caller, so a browser-chosen `threadId`
is served and stays served. Its commentary, and the thread-access docs, are
updated to match.
