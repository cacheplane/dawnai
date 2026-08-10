# Thread authorization — a `defineThreadAccess` hook over the thread endpoints

Status: approved (2026-08-10)
Author: Brian Love (with Claude)

## Problem

Route middleware gates *execution*: `/runs/stream`, `/runs/wait`, `/resume`, and the AG-UI
endpoint call `runMiddleware` before any route runs
(`packages/cli/src/lib/dev/runtime-fetch-core.ts:1295`, `:1523`, `:1803`,
`packages/cli/src/lib/dev/agui-handler.ts:205`). **Four sibling endpoints on the same thread
run no middleware at all**, and Dawn's own docs promise exactly that
(`apps/web/content/docs/dev-server.mdx:264` — "Thread create, read, delete, and state
endpoints do not invoke middleware"):

1. **`GET /threads/:id/state`** (`runtime-fetch-core.ts:1136-1157`) reads the checkpointer
   directly and returns `tuple.checkpoint.channel_values` — the full message history — plus
   `next` derived from `pendingWrites`. On a parked turn those pending writes are the
   interrupt, so an anonymous caller who can name a thread id reads the transcript *and*
   the parked prompt's tool name and arguments.

2. **`POST /threads/:id/cancel`** (`:968-1010`) aborts whatever run holds that thread's slot.
   Anyone can stop anyone's run.

3. **`DELETE /threads/:id`** (`:941-962`) deletes the row, then best-effort deletes the
   checkpoints, then destroys the sandbox, with no ownership check. On `origin/main` it also
   has no in-flight guard, and deleting mid-turn was therefore a gate bypass: every settle
   path ends in `updateMetadata`, a documented no-op for a missing row, so an attacker could
   delete the row while a turn parked and then recreate it pointing at a route of their own.
   PR #443 adds the `409 run_in_flight` guard; ownership is still unchecked.

4. **`GET /threads/:id`** (`:925-936`) echoes the stored `metadata` verbatim.

And one more endpoint belongs in scope even though it is not on that list, because it is where
the other four get the data they would be authorized against:

5. **`POST /threads`** (`:894-917`) stores caller-supplied `metadata` verbatim after only an
   `isRecord` check (`:912`). Nothing a server ever wrote into that object can be
   distinguished from something a client put there.

Thread ids are not a secret: `t-` plus four bytes of hex — eight lowercase hex digits —
(`packages/sqlite-storage/src/threads/store.ts:51-53`), a shape the conformance kit pins
(`packages/testing/src/threads-conformance.ts`, "generated ids are t- plus 8 lowercase hex
digits, and are unique").

PR #443 is the immediate reason this is now the sharpest edge on the surface. It gates
`GET /threads/:id/pending_interrupts` on the route that *parked* the interrupts, so the
`interruptId`/`resumeKey` pair is no longer readable by anyone who can name a thread. But it
protects only that pair, and only *because* its siblings are open: `parked-route.ts`'s own
header comment (on #443's branch; not on `origin/main`) says so plainly — "`GET /threads/:id`
is ungated and echoes metadata verbatim, so anyone who can name a thread id can read which
route parked it", and the same is true of the transcript through `/state`. #443 closed the
addressing leak while the payload leak stayed open one endpoint over. This spec closes the
class.

## Rejected approaches

- **Extend PR #443's route-identity gating to these four endpoints.** Wrong axis, and the
  prior art is decisive. LangGraph's `ThreadsRead` / `ThreadsUpdate` / `ThreadsDelete` auth
  payloads carry no `assistant_id` — only `RunsCreate` does — and `ThreadCreate` accepts
  none at all; a thread has no owning assistant *by construction*. OpenAI's Thread object
  likewise has no `assistant_id`. The Agent Protocol spec defines no security schemes
  whatsoever, so there is nothing to conform to. OWASP API1:2023 (Broken Object Level
  Authorization) argues for an object-level ownership check, not a capability check on the
  operation. Dawn's own code says the same thing: `parked-route.ts` exists precisely because
  the last-run route is *swappable* — "every endpoint that starts a turn overwrites `route`
  … so any caller allowed to run any route on a thread can move that identity onto a route
  of their choosing." Beyond the axis being wrong, `/state` has no route identity to gate on
  at all, so this approach would have to reproduce #443's resolution chain and invent a new
  `409 thread_route_unknown` exit on a plain read. And it is **documentably circular**:
  `apps/web/content/docs/dev-server.mdx:192` (on #443's branch; that paragraph is not yet on
  `origin/main`) instructs a reloaded client to recover its route by reading `metadata.route`
  from `GET /threads/:thread_id` — "A client that reloaded and no longer knows the route reads
  it from `GET /threads/:thread_id`" — so gating `GET /threads/:id` on route identity would
  require the caller to already know the thing that read exists to tell them.

- **A named `threadAccess` export on `src/middleware.ts`.** One file, one probe — but
  stamping degrades to a flat merge of the hook's metadata into the client's, with no
  reserved namespace, so any `permit()` branch that returns no stamp leaves a
  client-supplied `{ ownerId: "victim" }` intact and every later read matches it. Forgery
  becomes closed-by-convention rather than closed-by-mechanism. It also forces the
  fail-closed loader onto `src/middleware.ts`: a syntax error in an app's middleware, which
  today degrades to "no middleware", would become a hard boot failure for every app,
  including the ones that never adopt thread authorization. And `default` meaning route
  middleware while the policy must be named is a footgun that needs a brand check to patch.

- **A `ThreadsStore` facade (`scopeThreadsStore`).** Structurally the strongest coverage —
  every path that resolves a thread by client-supplied id goes through
  `getThreadsStore(request)` (`runtime-fetch-core.ts:540-541`), so a new endpoint would be
  gated because it *cannot* get a thread any other way — and it is the source of three of
  the improvements adopted below (`RunRegistry.claim()`, the per-action policy shape, the
  DELETE-oracle fix). Rejected on two grounds. First, **it inverts gate ordering on
  `/resume`**: there `threadsStore.getThread` is at `:1773` and `runMiddleware` is at `:1803`,
  the opposite of `/runs/stream` (middleware `:1295`, `getThread` `:1301`), so the thread
  gate would fire before route middleware on one endpoint and after it on another — turning
  what is today a middleware `401` into a thread-access `404`. Ordering is not something a
  data-access seam can control; worse, `resumeClaims.tryClaim(threadId)` runs at `:1734`,
  before both, so an unauthorized caller would still take and hold the thread's resume claim
  before being denied. Second, authorization denials would travel as exceptions *through*
  `ThreadsStore` into route and tool code, which is handed the store directly; `swallow the
  store error` is already the ambient style in that file (`updateStatus(…).catch(() =>
  undefined)` at `:1570`, `:1620`, `:1637`, `:1646`, `:1662`), which is exactly where a
  denial must not land. And `/state` — the hardest endpoint in the problem statement —
  touches only the checkpointer, so it needs a hand-written gate under the facade anyway.

## Design

Thread authorization is a **separate app module** answering a different question from route
middleware: *may this caller create, read, mutate, or destroy this thread?* Two concepts, two
files, two failure policies. Nothing in `packages/sdk/src/middleware.ts` changes —
`MiddlewareRequest` keeps its six fields, so the published middleware type is untouched.

Dawn stays unopinionated about the principal: the policy derives it from headers. Dawn's
contribution is the seam, the fail-closed loader, the deny shape, and one unforgeable
server-side stamp.

### 1. Public API — `packages/sdk/src/thread-access.ts`

```ts
/**
 * Thread authorization: who may create, read, mutate, or destroy a thread.
 *
 * Deliberately NOT route middleware. Middleware answers "may this caller run
 * this route", is keyed on route identity, and receives run input. A thread has
 * no owning route by construction (LangGraph's ThreadsRead/Update/Delete
 * payloads carry no assistant_id, and Dawn's own parked-route work documents
 * that last-run route is swappable), so gating thread endpoints on route
 * identity would be gating on the wrong axis. Two concepts, two files.
 */

/** LangGraph's `threads.*` split, minus `search` (Dawn serves no thread search). */
export type ThreadAction = "create" | "read" | "update" | "delete"

/** Which endpoint asked, for policies that need finer grain than `action`. */
export type ThreadOperation =
  | "thread.create"   // POST   /threads
  | "thread.get"      // GET    /threads/:id
  | "thread.state"    // GET    /threads/:id/state
  | "thread.delete"   // DELETE /threads/:id
  | "thread.cancel"   // POST   /threads/:id/cancel
  | "run.stream"      // POST   /threads/:id/runs/stream
  | "run.wait"        // POST   /threads/:id/runs/wait
  | "run.resume"      // POST   /threads/:id/resume
  | "run.agui"        // POST   /agui/:routeId

/** The persisted thread as the policy sees it: `Thread`, plus the server stamp. */
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
  /** `undefined` only on `thread.create` — that id is server-generated. */
  readonly threadId: string | undefined
  /** The persisted row. `undefined` on `create`, and when no row exists yet. */
  readonly thread: ThreadSubject | undefined
  /** Lowercase keys, repeated headers joined with ", " (same shape middleware sees). */
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  /** Path + query, e.g. `"/threads/t-1/state"`. */
  readonly url: string
  /** Client-supplied `metadata` on a create, already stripped of the reserved key. */
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
   * policy governs, but do not put secrets in it regardless.
   */
  readonly stamp?: Record<string, unknown>
}

export interface ThreadAccessDeny {
  readonly decision: "deny"
  /** Override the per-action default (404 for `read`, 403 otherwise). Nothing else is accepted. */
  readonly status?: 403 | 404
  /** JSON body. Omitted → Dawn's default for that status (see §5). */
  readonly body?: unknown
}

export type ThreadAccessResult = ThreadAccessAllow | ThreadAccessDeny

/**
 * One action's handler. Sync-or-async on purpose: a header-only policy that
 * returns a plain object introduces NO microtask boundary in the runtime — see
 * the gate contract in §3.
 */
export type DawnThreadAccess = (
  req: ThreadAccessRequest,
) => Promise<ThreadAccessResult> | ThreadAccessResult

/**
 * The policy object. Per-action handlers mirror LangGraph's `@auth.on.threads.*`
 * split; `fallback` is REQUIRED so "I forgot to handle delete" is a type error
 * rather than a silent allow or a silent 403 on every run.
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
  return {
    decision: "deny",
    ...(options?.status !== undefined ? { status: options.status } : {}),
    ...(options && "body" in options ? { body: options.body } : {}),
  }
}

/**
 * The reserved thread-metadata key Dawn owns. A colon makes it un-typable as a
 * JS identifier and effectively absent from real app metadata, so stripping it
 * unconditionally on every create path breaks nobody. Exported for store
 * migrations and for the `dawn memory`/inspector surfaces — apps read the stamp
 * through `ThreadSubject.access` and never need this constant.
 */
export const THREAD_ACCESS_METADATA_KEY = "dawn:access"
```

Barrel additions in `packages/sdk/src/index.ts` — all new names. Verified against the
current barrel: the middleware module exports only `allow`, `defineMiddleware`, `reject`
(`index.ts:39-46`), and no module in `packages/sdk/src` exports `permit`, `deny`,
`defineThreadAccess`, or `THREAD_ACCESS_METADATA_KEY`.

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

**What an app author writes — `<appRoot>/src/thread-access.ts`:**

```ts
import { defineThreadAccess, deny, permit, type ThreadAccessRequest } from "@dawn-ai/sdk"
import { principalOf } from "./auth.js"   // shared with src/middleware.ts

const owned = async (req: ThreadAccessRequest) => {
  const user = await principalOf(req.headers)
  if (!user) return deny()
  // `thread: undefined` reaches `delete` too — see §5. Denying it is what keeps
  // "not yours" and "does not exist" indistinguishable.
  const owner = req.thread?.access?.ownerId
  if (owner === undefined) return user.isAdmin ? permit() : deny()   // legacy or missing
  if (owner === user.id) return permit()
  if (req.action === "read" && user.isAdmin) return permit()
  return deny()
}

export default defineThreadAccess({
  create: async (req) => {
    const user = await principalOf(req.headers)
    return user ? permit({ ownerId: user.id, org: user.org }) : deny()
  },
  fallback: owned,
})
```

The full nine-member `ThreadOperation` union ships in this PR even though only the five
`thread.*` members are reachable until PR B. Shipping it whole means PR B adds no published
type change, and nobody writes an exhaustive `switch` that PR B breaks. A test pins exactly
which operations PR A can emit (§ Test strategy).

**Deliberate non-coupling.** The policy re-derives its principal from headers rather than
receiving `allow(context)` from middleware. Threading middleware context in would put a
`middlewareContext` field on `ThreadAccessRequest` that is present on `/runs/stream` (where
middleware runs) and absent on `GET /threads/:id` (where it does not) — an inconsistency
that reads as a bug the first time someone hits it. The documented pattern is a shared
`src/auth.ts` both files import; PR B scaffolds it, because convention alone is a
confused-deputy risk (§ Risks).

**Why `decision:` and not `action:` as the discriminant.** A copy-pasted middleware body
returning `{ action: "continue" }` becomes a compile error rather than a runtime coin-flip.

### 2. Loading — fail-closed, unlike `loadMiddleware`

Two modules, split on the `node:` boundary, so the pure half stays reachable from
`@dawn-ai/cli/fetch` and the disk half never is.

`packages/cli/src/lib/dev/thread-access.ts` — pure, no `node:` imports at all, not even
types:

```ts
import type { ThreadAccessPolicy, ThreadAccessResult } from "@dawn-ai/sdk"

/**
 * The ONE selection rule, shared by the dynamic loader and (in PR B) both build
 * probes — a built app can never bind differently than dev. `default` first
 * (nullish falls through), then a named `threadAccess` export.
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

/**
 * Shape validation, run on BOTH the dynamic path and (PR B) the manifest path.
 * Types are erased across a dynamic import, so `fallback` being required in
 * `ThreadAccessPolicy` is not enforcement — this is. Returns the reason, or
 * undefined when the value is a well-formed policy.
 */
export function validateThreadAccessPolicy(value: unknown): string | undefined

/**
 * Normalize a hook's return value. NOT the same as middleware's, on purpose:
 * `runMiddleware` compares `=== "reject"` and falls through to CONTINUE on any
 * other value, so a policy that returned `undefined` (forgot a return on one
 * branch) or a stale `{action:"continue"}` object would silently allow. Here,
 * anything that is not a well-formed allow is a DENY.
 */
export function normalizeThreadAccessResult(value: unknown): ThreadAccessResult
```

`normalizeThreadAccessResult` accepts `{decision:"allow"}` (keeping `stamp` only when it is a
non-array object), accepts `{decision:"deny"}` (keeping `status` only when it is exactly
`403` or `404`, and `body` only when the key is present), and returns `{decision:"deny"}` for
everything else. A malformed return therefore denies and logs one `console.warn` naming the
operation.

`packages/cli/src/lib/dev/thread-access-node.ts` — node-only:

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
 * This deliberately does NOT copy `loadMiddleware`
 * (packages/cli/src/lib/dev/middleware.ts:37-48), which wraps every dynamic
 * import in a bare `catch {}` (:42-44) and therefore cannot tell "no file" from
 * "file that threw". For middleware that is merely sloppy; for an authorization
 * policy it is a silent, total bypass — a syntax error, a missing dependency, or
 * a thrown env assertion in production would boot the app with every thread
 * world-writable and no log line. Existence is decided by `existsSync`, BEFORE
 * the import, so an import failure can only ever mean "the policy is broken".
 *
 *   • no candidate on disk                    → undefined (no gate; today's behavior)
 *   • first existing candidate fails to import → THROW (DAWN_E3003)
 *   • it imports but binds no valid policy     → THROW (DAWN_E3003)
 */
export async function loadThreadAccess(appRoot: string): Promise<ThreadAccessPolicy | undefined>
```

The "binds nothing" case also diverges from middleware, which ignores such a file. A
`thread-access.ts` on disk is an unambiguous statement of intent; binding nothing is never
what the author meant. `validateThreadAccessPolicy` produces the message, so the four
failures are distinguishable at a glance: not an object; no `default`/`threadAccess` export;
`fallback` missing or not a function; a per-action key present but not a function.

**Error registry.** `packages/sdk/src/errors.ts` gains:

```ts
  DAWN_E3003: {
    code: "DAWN_E3003",
    title: "Thread access policy failed to load",
    docsPath: "/docs/thread-access#load-failures",
  },
```

E3xxx is the permissions/authorization band (`DAWN_E3001` "Permission denied",
`DAWN_E3002` "Subagent dispatch denied", `errors.ts:66-75`), and `E3002` is the last member,
so `E3003` is free. `packages/sdk/test/errors.test.ts:33-37` checks only that `docsPath`
matches `/docs/<slug>#<anchor>`, not that the page exists — so nothing mechanically forces the
docs page into this PR. It ships anyway: `errorDocsUrl` renders that URL inside the boot
failure, and a 404 there is the worst possible first experience of an authorization feature.
PR A carries the one reference page with a `#load-failures` anchor (plus its `page.tsx`
wrapper and `nav.ts` entry under `apps/web/app/components/docs/`, without which the docs build
and the `docs-bundle` slug check fail); everything narrative is PR B.

**Boot resolution** mirrors middleware's three layers (`runtime-fetch-core.ts:271-276`):

```ts
  const threadAccess =
    options.threadAccess ??
    options.modules?.threadAccess ??
    (await fallbacks?.loadThreadAccess?.(options.appRoot))
```

All three layers ship in PR A, so the resolution never has to be rewritten. That includes the
additive optional `DawnStaticModules.threadAccess?: ThreadAccessPolicy`
(`packages/cli/src/lib/runtime/static-modules-core.ts:97` is where `middleware?` sits) and the
sibling clause in `loadStaticModules` (`static-modules.ts:36-41`), which runs the value
through `validateThreadAccessPolicy` and throws the re-run-`dawn build` message on anything
malformed. What PR A does **not** ship is the emitter that fills that channel — so `dawn build`
never writes the key, and a hand-rolled edge embed that constructs `DawnStaticModules` itself
is the only thing that can use it today. That is deliberate: the channel is honest from day
one, and PR B adds the generator, the build probes, and the staleness guard.

`StartRuntimeServerOptions` gains an optional `threadAccess?: ThreadAccessPolicy` beside the
existing `middleware?: DawnMiddleware` (`packages/cli/src/lib/dev/runtime-server.ts:87`).
`RuntimeBootFallbacks` gains `loadThreadAccess?` as **optional**, unlike the required
`loadMiddleware` (`packages/cli/src/lib/runtime/execute-route-core.ts:112-116`): that type is
exported, so an external embedder constructing the bag as an object literal would fail to
typecheck against a new required member. The cost is a silent-ungating vector on node, paid
for by a boot log line (§ Risks, risk 6).

**THROWS-vs-DEGRADES.** The doc block at `execute-route-core.ts:169-200` gets a third
category rather than an entry on either list, because the distinction is the whole security
property:

```
- `loadThreadAccess` → CONDITIONAL. Absent policy file: degrades to "no gate"
  (an app that never had one keeps today's behavior exactly). Present policy
  file that cannot be bound: THROWS DAWN_E3003 and fails the boot. There is no
  path on which a policy the author wrote resolves to "allow all".
```

**Request-time failure**: the gate does not catch. A hook that throws propagates to `fetch`'s
existing catch-all (`runtime-fetch-core.ts:632`) and becomes a 500, and the endpoint's real
work never runs. That is fail-closed already, and honest: a 403 would hide a broken policy
behind what looks like a working one.

**Build targets, in PR A.** `dawn build --target hono` and `--target langsmith` probe
`threadAccessCandidatePaths(appRoot)` and **fail the build** with `DAWN_E1005` ("Feature
unsupported by the build target or runtime", `errors.ts:51-55`) when a policy file exists,
naming the file. Neither target can carry the hook yet: hono's runtime has
`fallbacks === undefined` by construction, and langsmith materializes no middleware either
(`apps/web/content/docs/middleware.mdx` states it as a caveat). Middleware failing open there
is a feature regression; authorization failing open is a breach, so silence is not an option.
PR B lifts the hono failure by adding the manifest channel; langsmith's is permanent. The
`node` target needs nothing: its emitted `server.mjs` reaches the runtime through
`nodeBootFallbacks` like `dawn dev` and `dawn start` do, so the disk probe already applies.
An app with no policy file builds for every target exactly as before.

### 3. The gate — one helper, five call sites in PR A

Built once per request inside `buildRouteTable`, in `runtime-fetch-core.ts`:

```ts
type GateOk = { readonly ok: true; readonly stamp?: Record<string, unknown> }
type GateDenied = { readonly ok: false; readonly response: Response }
type Gate = GateOk | GateDenied

interface GateSpec {
  readonly action: ThreadAction
  readonly operation: ThreadOperation
  readonly threadId?: string
  readonly thread?: Thread
  readonly requestedMetadata?: Record<string, unknown>
  /** The response a denied READ must be byte-identical to. Required when action === "read". */
  readonly notFound?: () => Response
}

/**
 * Returns a no-op gate when the app has no policy — the ONLY thing a hook-less
 * app pays is this closure allocation. No store read, no reordering, nothing.
 *
 * `Gate | Promise<Gate>`, never `Promise<Gate>`: a policy handler that returns a
 * plain object (the header-only case) is resolved with ZERO microtask
 * boundaries. Callers do `const settled = isThenable(g) ? await g : g`.
 */
function makeThreadGate(
  policy: ThreadAccessPolicy | undefined,
  request: Request,
): (spec: GateSpec) => Gate | Promise<Gate>
```

Handler selection is `policy[spec.action] ?? policy.fallback`. `toThreadSubject(thread)`
splits the stored metadata: `access` is `metadata[THREAD_ACCESS_METADATA_KEY]` when it is a
record, `metadata` is the rest with that key removed — so a policy never sees the reserved
key inside `metadata` and is never tempted to authorize against the untrusted sibling.

| # | Endpoint | Action / operation | Position | What moves |
|---|---|---|---|---|
| 1 | `POST /threads` (`:894`) | `create` / `thread.create` | after body parse + the `isRecord(metadata)` 400, before `createThread` (`:912`) | new; also strips the reserved key from client metadata first (§4) |
| 2 | `GET /threads/:id` (`:925`) | `read` / `thread.get` | after `getThread` (`:926`), before **either** exit | nothing — the row is already loaded |
| 3 | `GET /threads/:id/state` (`:1136`) | `read` / `thread.state` | a new `getThreadsStore(request).getThread(threadId)` first (hook path only), then the gate, then `getTuple` | one extra store read, only when a policy is installed |
| 4 | `DELETE /threads/:id` (`:941`) | `delete` / `thread.delete` | **first in the handler**, before `deleteThread` (`:945`); needs a `getThread` the handler does not do today (hook path only) | see below |
| 5 | `POST /threads/:id/cancel` (`:968`) | `update` / `thread.cancel` | after `claim()`, before `claim.cancel()` | the claim replaces `cancel()`; see below |

`GET /healthz` and the memory-candidate endpoints are untouched. The four run endpoints and
AG-UI are PR B; the enumeration test (§7) is written in PR A with those five on the gated
list and the run endpoints on an explicit *deferred* list, so PR B has to move them rather
than being allowed to forget.

**`DELETE` gate placement.** On `origin/main` the handler's first act is
`deleteThread` (`:945`), so "first in the handler" is unambiguous. PR #443 adds a
`409 run_in_flight` guard ahead of it; after the rebase the gate goes ahead of *that*, so an
unauthorized caller cannot probe whether a run is live on someone else's thread.

**`POST /threads/:id/cancel` — the ordering hazard, closed rather than traded.** The
handler's comment (`:972-987`) says `cancel()` must be the first thing, with nothing awaited
before it, or the cancel lands on run N+1 instead of the run the caller observed. Authorizing
before a destructive act is non-negotiable, and authorizing after it is not an authorization
design — so `RunRegistry` gains a `claim()` sibling of the identity guard that `release()`
already carries (`run-registry.ts:95`):

```ts
export interface RunClaim {
  /** Aborts the exact run this claim bound to. False when a later run replaced it. */
  cancel(reason?: string): boolean
}

// on RunRegistry, beside cancel(threadId) (run-registry.ts:100):
claim(threadId: string): RunClaim | undefined
```

The handler becomes:

```ts
// Synchronous, FIRST statement, nothing awaited before it — the claim binds to
// the run the caller observed. Authorizing may now await freely.
const claim = getRunRegistry(request).claim(threadId)
const thread = threadAccess ? await getThreadsStore(request).getThread(threadId) : undefined
const g = gate({ action: "update", operation: "thread.cancel", threadId, thread })
const settled = isThenable(g) ? await g : g
if (!settled.ok) return settled.response
if (claim?.cancel()) return Response.json({ status: "interrupted", thread_id: threadId }, { status: 200 })
/* … existing 404 thread_not_found / 409 no_run_in_flight, unchanged … */
```

`cancel(threadId)` stays on `RunRegistry` and is untouched for its other callers. The
observable difference is a bug fix: a cancel can no longer land on a *later* run of the same
thread. When `claim.cancel()` returns false the handler falls through to the existing
`409 no_run_in_flight` — the honest answer for "the run you observed already finished", where
today the caller silently kills a run they never saw. No existing test asserts the old
behavior; the race is documented at `:972-987` as accepted, not as specified.

Note what graft A does and does not buy here. It removes the microtask the *policy call*
would add, so a header-only policy is resolved inline. It does not remove the `getThread`
await, because `ThreadAccessRequest.thread` is an eager field — a lazy accessor would buy the
read back at the cost of a shape the policy author has to remember to await. That await is
safe only because the claim was taken first; the two grafts are load-bearing together, not
separately.

### 4. Create stamping and the reserved namespace

Thread `metadata` is one flat, client-writable namespace, echoed verbatim by
`GET /threads/:id`, shallow-merged with no compare-and-set, and it already carries an
access-control input (`route`, and `parked_route` after #443). A "hook metadata merged last,
hook wins" scheme is forgery-proof only by ordering luck. The mechanism is a reserved
sub-namespace, stripped on the way in.

```ts
// packages/cli/src/lib/dev/thread-metadata.ts  (pure)
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"

/** Remove the key Dawn owns from anything a client supplied. Applied on EVERY create path. */
export function stripReservedThreadMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined

/** Guard for every `updateMetadata` patch the runtime builds. Throws — this is a Dawn bug if hit. */
export function assertNoReservedKey(patch: Record<string, unknown>): void
```

`stripReservedThreadMetadata` is applied at `POST /threads` **unconditionally, hook or no
hook**: the key contains a colon, cannot be written as a JS property identifier, and is
namespaced to Dawn, so stripping it always is safe — and it means an app that adopts a policy
in v2 cannot inherit forged stamps written in v1. It is the only unconditional behavior change
in this PR and it earns a changeset line.

`POST /threads` is the **only** client-writable metadata path in PR A, and that is verified,
not assumed: the handler never reads `thread_id` from the body (`:894-917`), so the id is
server-generated and there is no pre-existing row to collide with; and the three implicit
creates pass no metadata at all — `createThread({ thread_id: threadId })` at `:1303`, `:1531`,
and `agui-handler.ts:252`. `updateMetadata` has no HTTP endpoint. `assertNoReservedKey` wraps
the three runtime `updateMetadata` patch builders that write `route` (`:1331`, `:1551`,
`agui-handler.ts:254`) so a future refactor cannot clobber the stamp through the shallow
merge; it is an assertion, not a gate, and it does not gate those endpoints.

```ts
const clientMetadata = stripReservedThreadMetadata(metadata)
const g = gate({
  action: "create",
  operation: "thread.create",
  ...(clientMetadata ? { requestedMetadata: clientMetadata } : {}),
})
const settled = isThenable(g) ? await g : g
if (!settled.ok) return settled.response

const stored = settled.stamp
  ? { ...(clientMetadata ?? {}), [THREAD_ACCESS_METADATA_KEY]: settled.stamp }
  : clientMetadata
const thread = await getThreadsStore(request).createThread(
  stored !== undefined ? { metadata: stored } : {},
)
return Response.json(thread, { status: 200 })
```

**The client-supplied-id rule, stated now because PR B binds it.** On any create where the
caller chose the id, the runtime **re-authorizes as `update` against the row `createThread`
returned, unconditionally** — never conditional on comparing the returned stamp against the
one the policy just issued. The two backends disagree about what "create an existing id"
means: sqlite issues a bare `INSERT` and throws on a duplicate
(`packages/sqlite-storage/src/threads/store.ts:57-63`), while Postgres is
`ON CONFLICT (thread_id) DO NOTHING RETURNING …` with a `selectOne` fallback and a bounded
retry (`packages/postgres-storage/src/threads.ts:136-160`), so on a collision it **hands back
the existing row with the existing metadata and silently discards the caller's**. A
value-comparison recheck looks sufficient and is not: when the policy returns `permit()` with
no stamp, the issued stamp is `undefined`; if the row that came back also has none (a legacy
thread, or a winner who stamped nothing), both sides are `undefined`, the comparison passes,
and the racing loser proceeds on the winner's row with no re-authorization at all.
`JSON.stringify` equality is separately fragile on key ordering. So the recheck is
unconditional. Cost: one extra policy call on client-supplied-id creates, and no extra store
round-trip — the row is already in hand.

In PR A this rule is inert: the only gated create takes a server-generated id. It is
specified here because it is the reason PR B's three implicit-create sites are safe, and
because the `runThreadsStoreConformance` case that pins the divergence (`createThread` with an
already-present `thread_id` either rejects or returns the stored row **with its existing
metadata unchanged**, never applying the caller's) ships with PR B, alongside a companion
case pinning that `updateMetadata` is shallow and leaves an unrelated top-level key intact —
the property the stamp's survival depends on across every `route` write.

**Reading the stamp.** `GET /threads/:id` still returns the raw `Thread`, reserved key
included — deliberately: hiding it would break round-tripping and make the stamp
undebuggable, and that endpoint is now gated by the very policy the stamp feeds. The stamp
carries identifiers, never secrets (§ Risks, risk 7).

### 5. Deny semantics — 404 for reads, 403 for everything else

One function turns every deny into bytes:

```ts
function denyResponse(
  action: ThreadAction,
  result: ThreadAccessDeny,
  notFound: (() => Response) | undefined,
): Response {
  const status = result.status ?? (action === "read" ? 404 : 403)
  if (result.body !== undefined) return statusResponse(status, result.body)
  if (status === 404 && notFound) return notFound()   // byte-identical to the real 404
  if (status === 404) {
    return Response.json(createRequestErrorBody("Thread not found"), { status: 404 })
  }
  return Response.json(
    createRequestErrorBody("Forbidden", { code: "thread_access_denied" }),
    { status: 403 },
  )
}
```

`{ code: … }` is the **second positional** argument — `details`, not `options` — so it lands
at `error.details.code` with no `error.code`/`docsUrl`, matching `run_in_flight` and
`thread_not_found` exactly (`server-errors.ts:38-43`, asserted for the existing codes in
`packages/cli/test/run-cancellation.test.ts`). Deliberately **no registry code** on the deny
path: `DAWN_E3003` is reserved for load failures, and a `docsUrl` on a 403 is noise.

| Endpoint | Default deny | Body | Distinguishable from the pre-existing failure? |
|---|---|---|---|
| `POST /threads` | **403** | `{"error":{"details":{"code":"thread_access_denied"},"kind":"request_error","message":"Forbidden"}}` | n/a — nothing to hide |
| `GET /threads/:id` | **404** | `{"error":{"kind":"request_error","message":"Thread not found"}}` — the handler's own literal, via `notFound` | **No.** Byte-identical, and the row was already loaded before the gate ran, so the timing matches too |
| `GET /threads/:id/state` | **404** | `{"error":{"kind":"request_error","message":"No checkpoint found for thread"}}` — that handler's own literal | **No** for the body. The thread row is loaded before the gate and the checkpoint is not, so a deny is one `getTuple` faster than a genuine miss — a timing channel, not a content one |
| `DELETE /threads/:id` | **403** | `thread_access_denied` | **No** — see below |
| `POST /threads/:id/cancel` | **403** | `thread_access_denied` | **No.** A missing row is authorized with `thread: undefined` and denied the same way, so `/cancel`'s existing 404 vs 409 vs 200 split is only ever observable by a caller the policy already trusts with `update` on that thread |

A policy may override the status, but only within `403 | 404`.
`normalizeThreadAccessResult` drops any other value and falls back to the per-action default,
so a policy cannot mint a 200, a 500, or a redirect from a deny — and `statusResponse`'s
existing "outside 200-599 collapses to 500" path is unreachable from here. A supplied `body`
is JSON-encoded through `statusResponse` exactly as `reject(status, body)` is, including its
"no body ⇒ four bytes of `null`" behavior, which is why the defaults above always supply one.

**The read → 404 choice is what makes the pair work.** A read deny is indistinguishable from
a miss, so nobody can enumerate thread ids through `GET /threads/:id` or `/state`. The 403s
sit on endpoints whose caller has already named a specific thread and asked to change it,
where the marginal information is one bit and the diagnostic value of an honest 403 is high.

**The DELETE existence oracle, and why it does not open.** `DELETE /threads/:id` returns 204
unconditionally today, including for a thread that never existed — `deleteThread` is
`DELETE … WHERE thread_id = ?` in both stores and no-rows-affected is not an error. A 403
would ordinarily mean "this thread exists and is not yours", which is a bit DELETE does not
leak today. It does not leak it here either, because **the gate authorizes `delete` with
`thread: undefined` when the row is missing**, rather than short-circuiting to 204. Any
realistic ownership policy denies that (there is no `access.ownerId` to match), so
`DELETE /threads/<not-mine>` and `DELETE /threads/<never-existed>` both return 403 and the
oracle collapses. The rule the docs must state, and the scaffolded policy must obey (PR B):
*your `delete` handler denies when `thread` is `undefined`.* A policy that allows deleting
unknown threads reintroduces the oracle, and that is the app's informed choice.

**The policy is invoked on every gated request, including when the row is missing** —
`thread: undefined`, never a short-circuit to the endpoint's natural 404 or 204. That is what
collapses the DELETE oracle, and it is not only about DELETE:

- On `/state` the checkpointer is a **separate store** from `ThreadsStore` (the handler
  touches only `getTuple` today, `:1136-1157`), so a checkpoint can exist for a thread whose
  row is absent. Skipping the gate on a missing row would serve a transcript ungated. The
  gate runs with `thread: undefined`; a deny is that handler's own "No checkpoint found for
  thread" 404, byte-identical to the genuine miss.
- On `/cancel` a missing row would otherwise answer `404 thread_not_found` while a
  not-yours row answered 403 — the same oracle in a different wrapper.
- On `GET /threads/:id` the two outcomes are the identical 404 either way, so the call buys
  nothing observable. The policy is still invoked, because "invoked on every gated request"
  is one rule an implementer cannot get subtly wrong, and one policy call is cheap.

**Not a deny:** a hook that throws is a **500** through `fetch`'s catch-all (`:632`), and the
endpoint's work never runs. A hook that returns a malformed value is a **403** plus one
`console.warn` naming the operation. Both are fail-closed; neither is silently allowed, which
is the failure mode `runMiddleware`'s `=== "reject"` comparison has today.

### 6. Backward compatibility

An app with no `thread-access.ts` behaves exactly as today, and this is structural rather
than tested-into-existence. `loadThreadAccess` returns `undefined` when no candidate exists,
`makeThreadGate(undefined, …)` returns a closure that resolves `{ok:true}` synchronously with
no external await, and every handler guards its *new* work behind the same `if (!threadAccess)`.
Concretely, for a hook-less app:

- `GET /threads/:id/state` performs **no** `getThread` — the new read is inside the hook branch.
- `DELETE /threads/:id` performs **no** `getThread`.
- `POST /threads/:id/cancel` takes the claim synchronously as its first statement and awaits
  nothing before `claim.cancel()`.
- Every status code and every error body on all five endpoints is unchanged.

Type-level: `MiddlewareRequest`, `DawnMiddleware`, `MiddlewareResult`, `allow`, `reject`,
`defineMiddleware` are untouched. `@dawn-ai/sdk` gains nine types, three functions and one
constant, all additive. `StartRuntimeServerOptions` gains an optional `threadAccess`.
`RuntimeBootFallbacks` gains an optional `loadThreadAccess`. `ThreadsStore` and `Thread` are
unchanged — no new store, no new method, no migration, no schema change on either backend;
the stamp rides inside the existing `metadata` JSON/jsonb column. `DAWN_ERRORS` gains
`DAWN_E3003`; the registry is `as const satisfies Record<string, DawnErrorDescriptor>` and
`packages/sdk/test/errors.test.ts` iterates entries generically rather than asserting a count.

**Adopting** a policy is the breaking step, per app, and opt-in. Threads created before the
policy have `access === undefined`; the policy sees that and decides — Dawn does not guess.
The reference page makes this the first question a policy author answers, with the two sane
answers (admin-only, or a one-time backfill through `updateMetadata`).

### 7. Coverage is enumerated, so a test enumerates it

Five hand-placed call sites in one file, and `RouteMatcher` (`runtime-fetch-core.ts:152-156`)
has only `{method, pattern, handle}` — no metadata slot — so nothing structurally forces the
next endpoint someone adds to be gated. A test walks the built route table, collects every entry whose
`pattern.source` mentions `threads`, and fails if a pattern is on neither the **gated** list
nor the explicitly **deferred** list. Adding a thread endpoint without a decision is a red
test, not a quiet hole. This is not optional polish; it is the thing standing between an
enumerated design and a silently ungated endpoint next quarter.

## Non-goals

- **Route-scoped or assistant-scoped thread gating** — rejected on prior art above; #443's
  route-identity gating stays confined to `/pending_interrupts`, where the object being
  protected really is a route's own parked prompt.
- **An ACL store, a `thread_owners` table, or any `ThreadsStore` interface change** — the
  stamp rides in existing metadata. No migration, no new conformance kit.
- **Threading middleware's `allow(context)` into the policy** — it would be present on the
  run endpoints and absent on the thread endpoints. A shared `src/auth.ts` is the answer.
- **The policy seeing the request body** — `ThreadAccessRequest` is headers, method, url,
  and the row. Body-dependent authorization is a route concern and `src/middleware.ts`
  already has body-derived `params`.
- **Compare-and-set on `ThreadsStore`** — the create rule gets the same guarantee from the
  value `createThread` already returns.
- **Gating `dawn inspect`, `dawn memory`, or anything constructing a store directly** —
  local-operator tools with filesystem access to the database. Documented, not defended.
- **Making `createAgentHarness` run policies** — it drives `streamResolvedRoute` directly
  (`packages/testing/src/harness.ts:187`), takes no run slot and writes no threads-store row,
  so it runs no middleware today and will run no policy either. Policies are tested through
  the injector and the unit harness (§ Test strategy).
- **`dawn doctor` / `dawn check` warning on an app with open thread endpoints and no policy**
  — the right follow-up, filed, not in either slice.

## Delivery slices

**PR A — the seam and the originally-ungated endpoints. The disclosure closes here.**

1. `packages/sdk/src/thread-access.ts` + barrel + `DAWN_E3003`.
2. `dev/thread-access.ts` (pure: selection rule, candidate paths, policy validation, result
   normalization) and `dev/thread-access-node.ts` (`existsSync`-then-import, throws).
3. `RuntimeBootFallbacks.loadThreadAccess?`, `StartRuntimeServerOptions.threadAccess?`,
   `DawnStaticModules.threadAccess?` + its `loadStaticModules` validator clause, the
   three-layer boot resolution, and the one boot log line naming the resolution source.
4. `dev/thread-metadata.ts` + the unconditional strip at `POST /threads` +
   `assertNoReservedKey` on the three runtime `updateMetadata` patch builders.
5. `makeThreadGate` + `denyResponse` + the five call sites; `RunRegistry.claim()`.
6. The route-table enumeration test, with the run endpoints on the deferred list.
7. `dawn build --target hono|langsmith` fails with `DAWN_E1005` when a policy file exists.
8. The `thread-access` reference page (API, load failures, the legacy-thread question, the
   "identifiers not secrets" rule) + `page.tsx` + `nav.ts`. Changeset.

**PR B — the run surface, edge, and defaults.**

1. Gate `/runs/stream`, `/runs/wait`, `/resume`, and `/agui/:routeId`, each **after**
   `runMiddleware` so an existing 401 from a missing API key does not silently become a 403;
   the create-vs-update branch and the unconditional client-supplied-id recheck (§4). Move
   those four patterns from the deferred list to the gated list in the enumeration test.
2. `normalizeThreadAccessModule` in `static-modules-core.ts`, re-exported from **both**
   `packages/cli/src/runtime-exports.ts` and `packages/cli/src/fetch-exports.ts` (the
   generated manifest imports it by literal specifier on each target, so missing either
   barrel means the manifest fails to link), the shared emitter change in
   `modules-emitter.ts`, and the node + hono build probes — which lifts PR A's hono build
   failure. The emitter composes its named-import line from a list rather than the current
   two-branch ternary (`modules-emitter.ts:346-348`) so that a middleware-only app still emits
   the byte-identical string asserted at `packages/cli/test/static-middleware.test.ts:108-109`
   and `packages/cli/test/edge-modules-emitter.test.ts:248-249`, and `threadAccess:` is placed
   after `middleware:` and before `routes:` so the position assertions at
   `static-middleware.test.ts:112-116` stay green. `static-middleware.test.ts:141` and
   `:426` (`not.toContain("normalizeMiddlewareModule")` for an app with no middleware file)
   must gain the thread-access twin, or a no-policy app could start emitting a hook entry and
   nothing would notice.
3. The manifest-staleness guard: record that the build saw a policy file, then fail the boot
   when that record is present and the manifest carries no `threadAccess` **key**
   (distinguished with `in`, so a bound-nothing entry and an absent entry are different
   things). This is the failure that actually happens — a manifest generated before the app
   grew a policy, deployed to edge, silently ungated.
4. A scaffolded deny-by-default `src/thread-access.ts` and a shared `src/auth.ts` in the
   templates.
5. `runThreadsStoreConformance` gains the two cases §4 names.
6. Docs: the recipe, the `middleware.mdx` reconcile (its "Where middleware runs" table and
   the sentence after it become wrong the moment PR A ships — on `origin/main` that text is at
   `apps/web/content/docs/middleware.mdx:105-109`; after #443 it is the table at `:109-115` and
   the ungated-endpoint sentence at `:117`), and `dev-server.mdx:264`.

The slice boundary is defensible on its own terms: PR A closes the endpoints that run no
middleware at all, and PR B hardens endpoints that are *already* gated by route middleware.
It is not a fully sound authorization story until PR B lands —
`POST /threads/<chosen-id>/runs/stream` creates the thread when the row is missing and runs
against it when it is not, so an attacker who wins that race bypasses the create stamp, and
one who does not still runs an agent turn on a victim's thread. PR B is not optional and must
not be deferred past the release that carries PR A.

## Code delta

- `packages/sdk/src/thread-access.ts` — NEW (~150 lines, mostly types + three helpers).
- `packages/sdk/src/index.ts` — nine type exports, three value exports, one constant.
- `packages/sdk/src/errors.ts` — `DAWN_E3003`.
- `packages/cli/src/lib/dev/thread-access.ts` — NEW, pure.
- `packages/cli/src/lib/dev/thread-access-node.ts` — NEW, `node:fs` only.
- `packages/cli/src/lib/dev/thread-metadata.ts` — NEW, pure.
- `packages/cli/src/lib/dev/run-registry.ts` — `claim()` + `RunClaim`; `cancel()` untouched.
- `packages/cli/src/lib/dev/runtime-fetch-core.ts` — boot resolution, `makeThreadGate`,
  `denyResponse`, `toThreadSubject`, five gate insertions, the `/cancel` restructure, three
  `assertNoReservedKey` wraps.
- `packages/cli/src/lib/dev/runtime-server.ts` — `threadAccess?` option.
- `packages/cli/src/lib/runtime/static-modules-core.ts` — `DawnStaticModules.threadAccess?`.
- `packages/cli/src/lib/runtime/static-modules.ts` — the manifest-validator clause.
- `packages/cli/src/lib/runtime/execute-route-core.ts` — `loadThreadAccess?` on
  `RuntimeBootFallbacks`; the THROWS/DEGRADES third category.
- `packages/cli/src/lib/runtime/execute-route.ts` — wire `loadThreadAccess` into
  `nodeBootFallbacks`.
- `packages/cli/src/lib/build/targets/hono.ts`, `langsmith.ts` — the fail-the-build probe.
- `packages/testing/src/http-inject.ts` — `createAgentProtocolInjector({ appRoot, threadAccess? })`.
- `packages/testing/src/thread-access-harness.ts` — NEW; exported from `index.ts`.
- `apps/web/content/docs/thread-access.mdx` + `page.tsx` + `nav.ts` entry.
- **No changes** to `packages/sqlite-storage`, `packages/postgres-storage`, migrations,
  `ThreadsStore`, `Thread`, or `packages/sdk/src/middleware.ts`. No new packages.

## Test strategy

**Loader** — `packages/cli/test/thread-access-loader.test.ts`, the anti-`loadMiddleware`
suite and the most important new file: absent file → `undefined`; a file with a syntax error
→ rejects with `DAWN_E3003` (the case `loadMiddleware` gets wrong); a file exporting a
non-object → `DAWN_E3003`; a policy with no `fallback` → `DAWN_E3003` naming it; a policy
whose `read` is not a function → `DAWN_E3003`; a named `threadAccess` export binds; `default`
wins over a named export.

**Normalization** — pure unit tests: `undefined`, `null`, `{action:"continue"}`,
`{decision:"allowed"}`, a thrown-then-caught value — every one of them denies. A `stamp`
that is an array or a primitive is dropped. A `status` of `401`, `500`, or `200` is dropped
and the per-action default applies.

**Endpoints** — `packages/cli/test/thread-access-endpoints.test.ts` through
`createAgentProtocolInjector({ appRoot, threadAccess })`, one case per row of §5's table,
plus: a denied `GET /threads/:id` is **byte-identical** to a genuine 404; a denied `/state` is
byte-identical to a missing checkpoint; `DELETE` returns 403 for both an unauthorized *and* a
nonexistent thread (the oracle-collapse assertion); a create stamp is stored under the
reserved key and surfaces as `ThreadSubject.access` on the next request while
`ThreadSubject.metadata` does **not** contain it; a client-supplied `{"dawn:access":…}` at
`POST /threads` is dropped; a policy that throws yields 500 and the thread is not created; a
policy that returns `undefined` yields 403.

**Ordering** — a policy that records call order proves `claim()` precedes any await on
`/cancel`, and that a run started after the claim is *not* cancelled by it (the direct
sibling of `release()`'s identity-guard case). `packages/cli/test/run-cancellation.test.ts`
gains the `claim()` cases; its existing 404/409 assertions must stay green unchanged.

**Coverage** — the route-table enumeration test of §7, asserting both membership lists and
that every `ThreadOperation` PR A can emit is exactly the five `thread.*` members.

**Policy unit harness** — `packages/testing/src/thread-access-harness.ts` exporting
`createThreadAccessHarness({ policy })` with a `check(spec)` that builds a well-formed
`ThreadAccessRequest` from a partial (sane defaults for `headers`/`method`/`url`, `operation`
derived from `action`), routes it through the same `handler ?? fallback` selection the runtime
uses, and runs the result through the real `normalizeThreadAccessResult`. That lets an app
unit-test its policy — including the malformed-return-is-a-deny rule — without booting a
server. Route middleware never got one; this is the surface that makes policies testable at
all, given `createAgentHarness` is blind by construction.

**Purity** — `packages/cli/test/fetch-entry-purity.test.ts` and
`edge-bundle-purity.test.ts` go red immediately if `existsSync` lands in the pure module
instead of `thread-access-node.ts`. Getting them red once during implementation is the
expected way to discover a wrong import.

**Existing tests this work must update.** All three live on PR #443's branch, not on
`origin/main`, which is what this branch is cut from — PR A rebases onto #443 and updates
them there:

1. `packages/cli/test/run-cancellation.test.ts:688-703` — "409s when the thread exists but no
   run is in flight" creates a thread and cancels it, with no run ever started. It is at the
   same lines on `origin/main`, so it is the one tripwire verifiable today. Under `claim()`
   the assertions are unchanged (`claim()` returns `undefined`, the handler falls through to
   the same 409 `no_run_in_flight`), but the property under test moves from "nothing awaited
   before `cancel`" to "the claim is bound before any await", so the intent the test pins
   must be rewritten even though its expectations are not.
2. `packages/cli/test/pending-interrupts-endpoint.test.ts:756` — an unauthenticated
   `POST /cancel` against a `/park`-gated thread, asserted to return **200**, with a comment
   that says so explicitly: "Both of these are ungated today, which is what makes the window
   reachable without credentials. Gating them is tracked separately." That premise is what
   this spec retires. The test must be rewritten to run the app *with* a policy and assert
   403, keeping its real subject intact — that reaching the window wins the attacker nothing.
3. `packages/cli/test/pending-interrupts-endpoint.test.ts:840` — a `DELETE` mid-turn against
   the same `/park`-gated thread, asserting `409 run_in_flight`. Under §3 the delete gate runs
   *before* that 409, so an unauthenticated caller now gets 403 and never learns a run is in
   flight. Same treatment: rewrite the premise, keep the subject (the settle path cannot be
   raced by deleting the row).

Neither of those two exists in a fresh `origin/main` worktree — only the unit test
`packages/cli/test/pending-interrupts.test.ts` does.

**Existing test that pins a property the design must preserve.**
`packages/cli/test/agui-endpoint.test.ts:561-562` fetches `GET /threads/middleware-rejected`
unauthenticated and asserts 404 as proof that a middleware-rejected AG-UI run created no
thread. (Same lines in this worktree and on #443's branch.) That app installs no policy, so
the gate is a no-op and the assertion is untouched — but it pins the invariant: `GET
/threads/:id` must keep answering 404 for a row that does not exist. The design holds it by
placing the read gate **after** `getThread` and routing a denied read through that handler's
own 404 literal. A design that gated before the lookup and answered 403 would make this
test's premise ("404 means it was never created") false for any app with a policy.

**Also touched mechanically:** `packages/sdk/test/errors.test.ts` (new registry entry),
`packages/cli/test/check-error-codes.test.ts`, `packages/cli/test/error-code-render.test.ts`,
`packages/cli/test/build-targets.test.ts` and `hono-target.test.ts` (the new fail-the-build
probe), `packages/cli/test/static-middleware.test.ts:345` and `:354` (the manifest-validator
cases get thread-access twins — malformed entry throws, explicitly-undefined entry is
accepted), and `docs-bundle.test.ts` (the new page's slug).

Run everything on Node 24 (`nvm use 24`) — Node 22 makes roughly eight `dawn verify` tests
fail spuriously and look pre-existing.

## Risks

| Risk | Mitigation |
|---|---|
| **Enumerated coverage rots.** Five hand-placed call sites; `RouteMatcher` (`runtime-fetch-core.ts:152-156`) has no metadata slot, so nothing structurally forces the sixth endpoint to be gated. | The route-table enumeration test (§7) fails on any `/threads` pattern that is on neither the gated nor the deferred list. Not optional polish. |
| **Two files, two principals, nothing enforcing agreement.** `src/middleware.ts` and `src/thread-access.ts` each parse `Authorization` independently; the failure mode is a confused deputy — middleware admits the caller as org A, the policy derives org B. | Threading `allow(context)` in is worse (present on four endpoints, absent on five). The answer is a **scaffolded** shared `src/auth.ts` plus a worked example in the templates (PR B), not a docs line. Named as convention-not-enforcement. |
| **The stamp is echoed by `GET /threads/:id`**, so it is readable by anyone the `read` policy admits. | Deliberate — hiding it breaks round-tripping and makes it undebuggable. The docs say "identifiers, never secrets" in those words, the way `parked-route.ts` already words it for `parked_route` ("NOT SECRET … the key is an ACCESS-CONTROL INPUT, not a credential … do not build a check that relies on this being private"). |
| **Nothing scaffolds a policy**, so generated apps still start with fully open thread endpoints — this change makes authorization *possible*, not *default*. No template ships a `middleware.ts` either (verified: no `middleware*` file anywhere under `packages/create-dawn-app`). | The higher-leverage lever is the scaffold, not the mechanism: PR B ships a deny-by-default `src/thread-access.ts` in the templates. A `dawn doctor` warning for an app served with open thread endpoints and no policy is the filed follow-up. |
| **Create-on-a-client-supplied-id.** The obvious "compare the returned stamp against the issued one" recheck fails open when the policy returns `permit()` with no stamp: both sides are `undefined`, the comparison passes, and a racing loser proceeds on the winner's Postgres row. | Re-authorize as `update` against the returned row **unconditionally** (§4). Inert in PR A (server-generated id); binds in PR B, together with the conformance case pinning the sqlite-throws / Postgres-upserts divergence. |
| **Optional `loadThreadAccess` on `RuntimeBootFallbacks` reintroduces a silent ungating on node.** An external embedder building its own fallback bag gets `fallbacks` present, `loadThreadAccess` absent, no disk probe, no manifest, and no error. Requiring it would break their object literals (`loadMiddleware` is required today, `execute-route-core.ts:112-116`). | Keep it optional, and emit exactly one boot line naming the resolution source — `bound from src/thread-access.ts` / `bound from the build manifest` / `no thread access policy (all thread endpoints are open)`. "My policy vanished" is then one grep away. |
| **A stale edge manifest deploys ungated.** A `.dawn/build` produced before the app grew a policy carries no hook, and edge has no fallback to probe. | PR A refuses to build the hono target at all while a policy file exists. PR B replaces that with the manifest channel plus the `in`-distinguished staleness guard — record that the build saw a policy file, fail the boot when the record is present and the `threadAccess` **key** is absent. Guarding "key present but value undefined" instead would be near-dead code. |
| **The `/cancel` gate widens the documented run-N/N+1 window** (`runtime-fetch-core.ts:972-987`): an awaited policy call, or the row read it needs, before `cancel()` lets the cancel land on a later run. | `RunRegistry.claim()` taken synchronously as the first statement binds the abort to the run the caller observed, so the window is **closed**, not traded — and `Gate \| Promise<Gate>` keeps a header-only policy free of any microtask on top. Falling through to `409 no_run_in_flight` when the claim is stale is the honest answer, and is asserted. |
| **A malformed or throwing policy takes the whole endpoint down.** | By design and stated in the docs: malformed → 403 + one warn; throwing → 500 through `fetch`'s catch-all (`:632`), and the endpoint's work never runs. A 403 for a thrown policy would hide a broken policy behind what looks like a working one. |
