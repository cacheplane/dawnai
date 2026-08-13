---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Thread access now authorizes the run endpoints and the pending-interrupts read.

Two things to check before upgrading.

**`ThreadOperation` gains a tenth member, `"thread.pending_interrupts"`.** The
addition is source-compatible everywhere except an exhaustive `switch` or
mapped type over the union, which stops compiling until it handles the new
member. It arrives under `action: "read"`.

**A policy written against the five endpoints of the previous release will now
be invoked on five more.** `POST /threads/:id/runs/stream`, `/runs/wait`,
`/resume`, `POST /agui/:routeId` and `GET /threads/:id/pending_interrupts` are
gated on the thread-access axis. The migration hazard is a policy whose
`fallback` returns a bare `{ allow: false }`, or denies any operation it does
not recognize: it will start denying traffic it permitted before, on endpoints
that previously answered to route middleware alone. Read your `fallback` before
upgrading. Every `run.*` operation arrives under `action: "update"` — including
on a thread id with no row yet, which those endpoints create — so a policy that
permits `update` for the thread's owner needs no change.

These gates compose with route middleware as AND rather than replacing it;
middleware still answers "may this caller run this route" and keeps doing the
per-caller work it does today. An app with no policy file is unaffected.

`POST /threads/:id/resume` and `GET /threads/:id/pending_interrupts` gate
**before** middleware rather than after it, so on those two a caller who would
have received a middleware `401` now receives a thread-access deny — a `403` on
`/resume`, a `404` on `/pending_interrupts`. That is forced: both resolve the
route identity middleware would authorize against out of the thread's own
metadata, so gating after middleware would mean reading a thread the caller is
not yet authorized to read. On `/resume` it also stops a denied caller taking
the thread's resume claim, which was a denial of service against a parked turn
that needed no credential, and reading the `400`/`409` codes as an oracle on a
guessed `interruptId`/`resumeKey`. A `/pending_interrupts` deny returns the
handler's own `404 thread_not_found`, indistinguishable from a genuine miss.

`dawn build --target hono` and `--target vercel` now build an app that has a
policy file, instead of refusing with `DAWN_E1005`. The policy is bundled into
the static module manifest and runs on those runtimes exactly as it does under
`dawn dev`. To close the gap that made the refusal necessary, a build that saw a
policy file stamps that fact into its entry point, and the boot now fails when
such an entry point is paired with a manifest carrying no thread-access entry —
a stale manifest would otherwise come up with every thread endpoint open and
nothing to say so. `--target langsmith` still refuses, permanently: it
materializes per-route graphs with no Dawn HTTP layer to run a policy in.

`create-dawn-app` templates now carry a deny-by-default `src/thread-access.ts`
and the shared `src/auth.ts` it imports, both as `.example` files that a rename
activates. They ship inert because a deny-by-default policy denies every request
from a caller the app cannot yet authenticate.

`@dawn-ai/testing`'s `runThreadsStoreConformance` gains two cases, both
properties the access stamp depends on: a `createThread` on an id that already
exists never applies the caller's metadata, and `updateMetadata` leaves a
top-level key its patch does not name intact. Custom `ThreadsStore`
implementations should re-run the kit.
