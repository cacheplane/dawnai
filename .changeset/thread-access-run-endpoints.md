---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Thread access now authorizes the run endpoints and the pending-interrupts read.

Two things to know about the shipped surface.

**`ThreadOperation` includes `"thread.pending_interrupts"`**, under
`action: "read"`. An exhaustive `switch` or mapped type over the union must
handle every member.

**Ten endpoints are gated on the thread-access axis**, including
`POST /threads/:id/runs/stream`, `/runs/wait`, `/resume`,
`POST /agui/:routeId` and `GET /threads/:id/pending_interrupts`. The hazard to
watch is a policy whose `fallback` returns a bare `{ allow: false }`, or denies
any operation it does not recognize: it denies these endpoints too, where route
middleware alone used to decide. Read your `fallback` before
upgrading. A `run.*` operation on a thread that exists arrives under
`action: "update"`; on a thread id with no row yet, `run.stream`, `run.wait` and
`run.agui` arrive under `action: "create"` — see the companion note on stamping
the implicit create, which lands in the same release. A policy that permits
`update` for the thread's owner therefore needs one more decision than it did
before: what its `create` handler should answer for a thread id the client
picked. `run.resume` never creates and is always an `update`.

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

`dawn build --target hono` and `--target vercel` bundle the policy into the
static module manifest and run it on those runtimes exactly as `dawn dev` does.
A build that saw a policy file stamps that fact into its entry point, and boot
fails when such an entry point is paired with a manifest carrying no
thread-access entry — a stale manifest would otherwise come up with every thread
endpoint open and nothing to say so. `--target langsmith` refuses with
`DAWN_E1005`, permanently: it materializes per-route graphs with no Dawn HTTP
layer to run a policy in.

`create-dawn-app` templates now carry a deny-by-default `src/thread-access.ts`
and the shared `src/auth.ts` it imports, both as `.example` files that a rename
activates. They ship inert because a deny-by-default policy denies every request
from a caller the app cannot yet authenticate.

`@dawn-ai/testing`'s `runThreadsStoreConformance` gains two cases, both
properties the access stamp depends on: a `createThread` on an id that already
exists never applies the caller's metadata, and `updateMetadata` leaves a
top-level key its patch does not name intact. Custom `ThreadsStore`
implementations should re-run the kit.
