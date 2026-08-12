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
   directly and returns `tuple.checkpoint.channel_values` — the full message history — so an
   anonymous caller who can name a thread id reads the transcript, including any tool calls
   and arguments recorded in it. `next` adds only the pending-write *channel names*
   (`next: tuple.pendingWrites?.map(([, channel]) => channel)`, `:1150`), i.e. the literal
   string `"__interrupt__"`; the interrupt payload itself is `write[2]`, which
   `readPendingInterrupts` reads (`pending-interrupts.ts:56-63`) and this endpoint discards.
   The transcript is the leak, and it is sufficient on its own — #443's own handler comment
   says the same thing about this endpoint ("ungated `GET /threads/:id/state` returns the
   messages carrying the tool call and its arguments verbatim").

2. **`POST /threads/:id/cancel`** (`:968-1010`) aborts whatever run holds that thread's slot.
   Anyone can stop anyone's run.

3. **`DELETE /threads/:id`** (`:941-962`) deletes the row, then best-effort deletes the
   checkpoints (a `typeof checkpointer.deleteThread === "function"` probe, `:947-955`), then
   destroys the sandbox, with no ownership check. #443 reverses the first two — checkpoints
   first, row last — which §4's orphan rule depends on; the `typeof` probe stays either way.
   On `origin/main` it also
   has no in-flight guard, and deleting mid-turn was therefore a gate bypass. The mechanism,
   stated exactly because it is easy to get wrong: *no* settle path writes `updateMetadata` on
   `origin/main` — `updateMetadata` is called at exactly three places, all at TURN START
   (`runtime-fetch-core.ts:1331`, `:1551`, `agui-handler.ts:254`, all writing `{route}`).
   Settle paths end in `updateStatus`: `:1394` and `:1408` (`/runs/stream`), `:1570`, `:1620`,
   `:1637`, `:1646`, `:1662` (`/runs/wait`), `:1865` and `:1879` (`/resume`), and
   `agui-handler.ts:305` (AG-UI). `updateStatus` is `UPDATE … WHERE thread_id = ?` in both
   stores, so it is a silent no-op for a missing row exactly as `updateMetadata` is (whose
   store-interface doc comment is where the "documented no-op" phrase actually lives —
   `packages/sqlite-storage/src/threads/store.ts:25-30`). On #443's branch the settle paths
   additionally write the parked-route gate key through `updateMetadata`
   (`settleParkedRoute` → `parked-route.ts:125`/`:135`), which is the specific gate a
   mid-turn delete defeated: the turn parks durably while its gate write silently writes
   nothing, and the attacker recreates the row pointing at a route of their own. Either way
   the writes no-op rather than fail, so the conclusion is the same on both branches.
   PR #443 adds the `409 run_in_flight` guard; ownership is still unchecked.

4. **`GET /threads/:id`** (`:925-936`) echoes the stored `metadata` verbatim.

And one more endpoint belongs in scope even though it is not on that list, because it is where
the other four get the data they would be authorized against:

5. **`POST /threads`** (`:894-917`) stores caller-supplied `metadata` verbatim after only an
   `isRecord` check (`:904`; the outer `isRecord(parsed.value)` body guard is at `:899`).
   Nothing a server ever wrote into that object can be distinguished from something a client
   put there.

Thread ids are neither a secret nor collision-proof: `t-` plus four random bytes — 32 bits,
eight lowercase hex digits — in **both** stores
(`packages/sqlite-storage/src/threads/store.ts:51-53`,
`packages/postgres-storage/src/threads.ts:81-85`), a shape the conformance kit pins
(`packages/testing/src/threads-conformance.ts:67`, "generated ids are t- plus 8 lowercase hex
digits, and are unique"). 32 bits is guessable at scale *and* birthday-collides at roughly
65k threads, which §4 has to design for rather than assume away.

PR #443 is the immediate reason this is now the sharpest edge on the surface. It gates
`GET /threads/:id/pending_interrupts` on the route that *parked* the interrupts, so the
`interruptId`/`resumeKey` pair is no longer readable by anyone who can name a thread. But it
protects only that pair, and only *because* its siblings are open: `parked-route.ts`'s own
header comment (on #443's branch; not on `origin/main`) says so plainly — "`GET /threads/:id`
is ungated and echoes metadata verbatim, so anyone who can name a thread id can read which
route parked it", and the same is true of the transcript through `/state`. #443 closed the
addressing leak while the payload leak stayed open one endpoint over. This spec closes the
class — with one endpoint deliberately left undecided, because #443 gates it on an axis this
spec argues against for thread objects: see § Open question for review.

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
  before being denied. The chosen design is not exempt from that hazard — it is *able to
  answer* it, which is the whole difference: a hand-placed gate can be put ahead of
  `tryClaim`, and PR B places it there explicitly, accepting the one consequence a data-access
  seam could not have chosen deliberately (on `/resume`, a middleware 401 becomes a
  thread-access deny). See Delivery slices, PR B item 1.
  Second, authorization denials would travel as exceptions *through*
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
  /**
   * `undefined` only when the runtime has no id yet: `action: "create"` on
   * `POST /threads`, whose id is server-generated. Present everywhere else,
   * INCLUDING the `action: "update"` recheck that follows every create (§4)
   * and, in PR B, the implicit creates that take a caller-chosen id.
   */
  readonly threadId: string | undefined
  /**
   * The persisted row. `undefined` on the first `create` call and whenever no
   * row exists — which reaches `delete`, `update` and `read` too, and is
   * deliberate: never a short-circuit (§5). Present on the create recheck,
   * where it is the row `createThread` actually returned.
   */
  readonly thread: ThreadSubject | undefined
  /**
   * Lowercase keys, repeated headers joined with ", " (same shape middleware
   * sees; `headersToRecord`, `middleware.ts:65-77`). Compare with STRICT
   * EQUALITY: `X-User-Id: victim` plus `X-User-Id: attacker` arrives as the one
   * string `"victim, attacker"`, which `includes`/`startsWith`/`split(",")`
   * comparisons get wrong and `===` gets right.
   */
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  /** Path + query, e.g. `"/threads/t-1/state"`. */
  readonly url: string
  /**
   * Client-supplied `metadata` on a create, already stripped of the reserved
   * key. `undefined` on every non-create — and on the create recheck, whose
   * metadata was already adjudicated by the create call (§4).
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
   * policy governs, but do not put secrets in it regardless.
   */
  readonly stamp?: Record<string, unknown>
}

export interface ThreadAccessDeny {
  readonly decision: "deny"
  /** Override the per-action default (404 for `read`, 403 otherwise). Nothing else is accepted. */
  readonly status?: 403 | 404
  /**
   * JSON body. Omitted OR `undefined` → Dawn's default for that status (§5).
   * There is deliberately no present-but-undefined distinction: `undefined`
   * cannot be serialized (`Response.json(undefined)` throws, §5), so the only
   * thing such a distinction could express is a 500.
   */
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
  return {
    decision: "deny",
    ...(options?.status !== undefined ? { status: options.status } : {}),
    // `!== undefined`, NOT `"body" in options`: see ThreadAccessDeny.body.
    ...(options?.body !== undefined ? { body: options.body } : {}),
  }
}

/**
 * The reserved thread-metadata key Dawn owns. A colon makes it un-typable as a
 * JS identifier and effectively absent from real app metadata, so stripping it
 * unconditionally on every create path breaks nobody. Exported for store
 * migrations, for the `dawn memory`/inspector surfaces, and for the operator
 * backfill script §6 documents — apps read the stamp through
 * `ThreadSubject.access` and never need this constant.
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
  // `thread: undefined` reaches `delete` too — see §5. Denying it FIRST, ahead
  // of the admin branch, is what keeps "not yours" and "does not exist"
  // indistinguishable; an admin allowed to delete a row that never existed
  // reopens the existence oracle §5 closes.
  if (req.thread === undefined) return deny()
  const owner = req.thread.access?.ownerId
  if (owner === undefined) return user.isAdmin ? permit() : deny()   // legacy thread
  if (owner === user.id) return permit()
  if (req.action === "read" && user.isAdmin) return permit()
  return deny()
}

export default defineThreadAccess({
  create: async (req) => {
    const user = await principalOf(req.headers)
    return user ? permit({ ownerId: user.id, org: user.org }) : deny()
  },
  // Also handles the post-create `update` recheck (§4): the row just stamped
  // has ownerId === user.id, so `owned` permits it; a row the store handed back
  // on a collision has someone else's, so `owned` denies and the caller never
  // receives a thread they do not own.
  fallback: owned,
})
```

The full nine-member `ThreadOperation` union ships in this PR even though only the five
`thread.*` members are reachable until PR B. Shipping it whole means PR B adds no published
type change, and nobody writes an exhaustive `switch` that PR B breaks. A test pins exactly
which operations PR A can emit (§ Test strategy). That same argument is why the
`/pending_interrupts` question below (§ Open question for review) has to be answered *before*
PR A merges rather than during PR B: one of its two options adds a tenth member, and adding it
later is exactly the published-type change this union shape exists to avoid.

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
import type { ThreadAccessPolicy, ThreadAccessResult, ThreadOperation } from "@dawn-ai/sdk"

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
 * Shape validation of a SELECTED POLICY VALUE — not of a module. Run on BOTH
 * the dynamic path (after `selectThreadAccessExport`) and (PR B) the manifest
 * path, where export selection never happened because the manifest already
 * holds a policy object. Types are erased across a dynamic import, so
 * `fallback` being required in `ThreadAccessPolicy` is not enforcement — this
 * is. Returns the reason, or undefined when the value is a well-formed policy.
 *
 * Three failures, all expressible against a value: not an object; `fallback`
 * missing or not a function; a per-action key present but not a function.
 */
export function validateThreadAccessPolicy(value: unknown): string | undefined

/**
 * Normalize a hook's return value. NOT the same as middleware's, on purpose:
 * `runMiddleware` compares `=== "reject"` and falls through to CONTINUE on any
 * other value, so a policy that returned `undefined` (forgot a return on one
 * branch) or a stale `{action:"continue"}` object would silently allow. Here,
 * anything that is not a well-formed allow is a DENY.
 *
 * Takes the operation so the warn on a malformed value can name it; the value
 * alone is not diagnosable.
 */
export function normalizeThreadAccessResult(
  value: unknown,
  operation: ThreadOperation,
): ThreadAccessResult
```

`normalizeThreadAccessResult` accepts `{decision:"allow"}` (keeping `stamp` only when it is a
non-array object), accepts `{decision:"deny"}` (keeping `status` only when it is exactly
`403` or `404`, and `body` only when it is not `undefined`), and returns a bare
`{decision:"deny"}` — no `status` — for everything else. A malformed return therefore denies
**at the per-action default**: 404 on `read`, 403 on `create`/`update`/`delete`. It is not
special-cased to 403, because special-casing it would make a broken `read` policy answer 403
where a working one answers 404 and hand back the enumeration oracle §5 exists to close.

That trade has a real cost — a broken read policy looks exactly like an empty database — so
the diagnosability is carried by the log rather than the status: one `console.warn` **per
denial** (not once per process; a malformed return is a bug that should be noisy), naming the
operation, the thread id, and the offending value.

The fourth loader message — "no `default`/`threadAccess` export" — is produced by
`loadThreadAccess`, not by `validateThreadAccessPolicy`: it is the case where
`selectThreadAccessExport` returned nullish, which cannot arise on the manifest path.

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
what the author meant. Four failures are distinguishable at a glance: no
`default`/`threadAccess` export (raised by `loadThreadAccess` itself, from a nullish
`selectThreadAccessExport`), and the three `validateThreadAccessPolicy` produces — not an
object; `fallback` missing or not a function; a per-action key present but not a function.

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
so `E3003` is free.

**The new code forces the docs page into PR A mechanically**, so PR A cannot defer it.
`packages/sdk/test/errors.test.ts:33-39` is indeed only a `/docs/<slug>#<anchor>` shape check
— but `scripts/check-docs.mjs`, which runs in CI (`.github/workflows/ci.yml:85`) and inside
`pnpm ci:validate`, carries an error-code↔docs drift guard that a new registry entry trips
twice:

- `:123-140` — every registry `docsPath`'s slug must be a `DOCS_NAV` entry, parsed out of
  `apps/web/app/components/docs/nav.ts` (`:85-88`); and `:90-103` requires each nav href to
  have **both** `apps/web/content/docs/<slug>.mdx` and `apps/web/app/docs/<slug>/page.tsx`.
- `:141-155` — `apps/web/content/docs/errors.mdx` must list *exactly* the registry's codes,
  with the failure message naming the fix: "run node scripts/generate-error-docs.mjs".

So `DAWN_E3003` hard-requires the nav entry, `thread-access.mdx`, its `page.tsx`, **and** a
regenerated `errors.mdx` (`pnpm docs:errors`, which reads the built SDK dist — run it after
`pnpm build`). PR A ships all four or lands with a red `Docs Check` lane. It would ship the
page regardless: `errorDocsUrl` renders that URL inside the boot failure, and a 404 there is
the worst possible first experience of an authorization feature. Everything narrative is
still PR B; PR A's page is the reference (API, load failures, the legacy-thread question, the
"identifiers not secrets" rule, and the two enumeration-oracle warnings of §5).

There is **no** `docs-bundle` slug check to satisfy — an earlier draft of this spec credited
one. `packages/cli/test/docs-bundle.test.ts` unit-tests `parseNav`/`parseNavOrder` against
inline fixture strings only (`:235-258`); it never reads the real nav. `check-docs.mjs` is the
whole guard.

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

**THROWS-vs-DEGRADES.** The doc block at `execute-route-core.ts:168-226` gets a third
category rather than an entry on either list, because the distinction is the whole security
property. The entry it is placed against is `` `loadMiddleware` → no middleware (fetch-core) ``
at `:214`, on the DEGRADES list:

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

### 3. The gate — one helper, five gated endpoints in PR A

Constructed **inside each handler invocation**, from the route table `buildRouteTable` builds
once at boot (`runtime-fetch-core.ts:557`). The distinction matters: `buildRouteTable` takes a
`ctx` object (`:827-857`) and runs before any request exists — only each `handle(request,
params)` closure has one. So the boot-resolved `threadAccess` is threaded in through that
`ctx` (a new `readonly threadAccess: ThreadAccessPolicy | undefined` member, destructured with
the rest at `:858-873`), and each handler that needs a gate does
`const gate = makeThreadGate(threadAccess, request)` as its own first step.

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

/**
 * New local helper — nothing in `packages/cli/src` has one today. Narrowing,
 * not just a boolean, so the `await` branch typechecks.
 */
function isThenable<T>(value: T | Promise<T>): value is Promise<T>
```

Handler selection is `policy[spec.action] ?? policy.fallback`. `toThreadSubject(thread)`
splits the stored metadata: `access` is `metadata[THREAD_ACCESS_METADATA_KEY]` when it is a
record, `metadata` is the rest with that key removed — so a policy never sees the reserved
key inside `metadata` and is never tempted to authorize against the untrusted sibling.

| # | Endpoint | Action / operation | Position | What moves |
|---|---|---|---|---|
| 1 | `POST /threads` (`:894`) | `create` / `thread.create`, then a second `update` / `thread.create` recheck | gate after body parse + the `isRecord(metadata)` 400 (`:904`), before `createThread` (`:912`); recheck after it returns | new; strips the reserved key from client metadata first, and adds the collision retry + unconditional recheck (§4), both inside the hook branch |
| 2 | `GET /threads/:id` (`:925`) | `read` / `thread.get` | after `getThread` (`:926`), before **either** exit | nothing — the row is already loaded |
| 3 | `GET /threads/:id/state` (`:1136`) | `read` / `thread.state` | a new `getThreadsStore(request).getThread(threadId)` first (hook path only), then the gate, then `getTuple` | one extra store read, only when a policy is installed |
| 4 | `DELETE /threads/:id` (`:941`) | `delete` / `thread.delete` | **first in the handler**, before `deleteThread` (`:945`); needs a `getThread` the handler does not do today (hook path only) | see below |
| 5 | `POST /threads/:id/cancel` (`:968`) | `update` / `thread.cancel` | after `claim()`, before `claim.cancel()` | the claim replaces `cancel()`; see below |

`GET /healthz` and the memory-candidate endpoints are untouched. The four run endpoints and
AG-UI are PR B; the enumeration test (§7) is written in PR A with those five on the gated
list, the run endpoints on an explicit *deferred* list, and `/healthz` plus the three
memory-candidate patterns on an *exempt* list, so PR B has to move them rather than being
allowed to forget. `GET /threads/:id/pending_interrupts`, which arrives with #443, is the one
endpoint this table deliberately does not place — see § Open question for review.

The memory-candidate endpoints are exempt rather than overlooked, and the reason is worth one
sentence rather than a list entry: a candidate is a *memory* record, addressed by candidate
id, with no thread id in its route and no `ThreadsStore` read on its path — there is no thread
subject to authorize against. That a candidate's content may have been *distilled from* a
thread's conversation is real, and it means memory needs its own authorization story; it does
not make it a thread-access one. Filed with the `dawn doctor` follow-up, not solved here.

**`DELETE` gate placement.** On `origin/main` the handler's first act is
`deleteThread` (`:945`), so "first in the handler" is unambiguous. PR #443 adds a
`409 run_in_flight` guard ahead of it *and* reverses the delete order (checkpoints first, row
last, with its own reasoning about which half may be left undone); after the rebase the gate
goes ahead of both, so an unauthorized caller cannot probe whether a run is live on someone
else's thread. §4's orphan rule depends on that reversal, so it is a rebase prerequisite, not
a detail.

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

// on RunRegistry, beside cancel(threadId) (run-registry.ts:100).
// REQUIRED, not optional — see the passthrough note below.
claim(threadId: string): RunClaim | undefined
```

**`claim` must be a required member, and the per-request wrapper must pass it through.**
`getRunRegistry(request)` does not hand back the shared registry on the normal path: when the
request has a lifetime entry (which `fetch` always populates, `:605`) it returns a per-request
object literal typed `RunRegistry` that hand-implements `activeCount`, `begin`, `cancel` and
`has` (`:506-535`). A required `claim` makes that literal fail typecheck until a passthrough is
added — which is the point. Declaring `claim?` instead would compile, and `/cancel` would then
silently fall back to today's behavior on **every real request** while the unit tests that use
the shared registry directly stayed green.

The handler becomes:

```ts
// Synchronous, FIRST statement, nothing awaited before it — the claim binds to
// the run the caller observed. Authorizing may now await freely.
const claim = getRunRegistry(request).claim(threadId)
// `threadAccess` is the boot-resolved policy, destructured from buildRouteTable's
// ctx; `gate` is this handler's own makeThreadGate(threadAccess, request).
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
server-generated; and the three implicit creates pass no metadata at all —
`createThread({ thread_id: threadId })` at `:1303`, `:1531`, and `agui-handler.ts:252`.
`updateMetadata` has no HTTP endpoint.

`assertNoReservedKey` wraps every runtime `updateMetadata` patch builder so a future refactor
cannot clobber the stamp through the shallow merge; it is an assertion, not a gate, and it
does not gate those endpoints. There are **three** on `origin/main` — the `{route}` writes at
`:1331`, `:1551` and `agui-handler.ts:254` — and **five after the #443 rebase**, which adds the
two parked-route writes at `parked-route.ts:125` (`{parked_route: routeKey}`) and `:135`
(`{parked_route: null}`). PR A wraps all five. It is deliberately **not** placed on
`ThreadsStore.updateMetadata` itself: that is the store contract, shared with operator tooling
that legitimately needs to write the key (see the backfill note in §6).

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
const input = stored !== undefined ? { metadata: stored } : {}

let thread = await getThreadsStore(request).createThread(input)

// Both of the following are inside the hook branch. A hook-less app makes the
// one createThread call above and returns, exactly as today (§6).
if (threadAccess) {
  // The id is server-generated and only 32 bits wide, so the row that came back
  // is not necessarily the row we wrote (Postgres upserts on a collision).
  // Retry rather than hand back a stranger's thread.
  for (let attempt = 1; attempt < 3 && !isRowWeJustWrote(thread, stored); attempt++) {
    thread = await getThreadsStore(request).createThread(input)
  }

  // Unconditional: authorize the ROW, not the intent. Never a stamp comparison —
  // see below for why that fails open on a stamp-less permit().
  const recheck = gate({
    action: "update",
    operation: "thread.create",
    threadId: thread.thread_id,
    thread,
  })
  const rechecked = isThenable(recheck) ? await recheck : recheck
  if (!rechecked.ok) return rechecked.response
}

return Response.json(thread, { status: 200 })
```

`isRowWeJustWrote(thread, stored)` is a local predicate in `runtime-fetch-core.ts`: the row's
`metadata` deep-equals `stored ?? {}` **and** `created_at === updated_at`. It is a
best-effort collision detector, not the security boundary — the recheck beside it is.

**The create rule: re-authorize against the row you got back, on EVERY create path.** A create
is the one gated operation whose subject does not exist when the policy runs, so the policy
authorizes an *intent* and the store returns a *row*. Those can differ, and nothing in
`createThread`'s contract says otherwise. So: after `createThread` returns, the runtime
**re-authorizes as `update` against the returned row, unconditionally** — never conditional on
comparing the returned stamp against the one the policy just issued.

An earlier draft scoped this rule to "any create where the caller chose the id", on the
premise that a server-generated id "cannot collide, so there is no pre-existing row to adopt".
That premise is false. `newThreadId()` is **four random bytes — 32 bits** in both stores
(`packages/sqlite-storage/src/threads/store.ts:51-53`,
`packages/postgres-storage/src/threads.ts:81-85`), and the two backends disagree about what
"create an existing id" means: sqlite issues a bare `INSERT` and throws on a duplicate
(`store.ts:57-63`), while Postgres is `ON CONFLICT (thread_id) DO NOTHING RETURNING …` with a
`selectOne` fallback and a bounded retry (`threads.ts:136-160`), so on a collision it **hands
back the existing row with its existing metadata and silently discards the caller's** —
including the stamp the policy just issued. Two consequences, and PR A owns both because
`POST /threads` is a PR A endpoint:

- *Without any attacker.* Ordinary birthday collisions arrive at roughly 65k threads. On
  Postgres, one tenant's `POST /threads` then returns **another tenant's row**, the caller's
  stamp is never persisted, and every later read of that thread authorizes against the other
  tenant's `access`.
- *With one.* Once PR B stamps the implicit creates, an attacker plants rows at ids of their
  choosing through `POST /threads/<chosen-id>/runs/stream` and owns them. A victim's
  `POST /threads` that draws a colliding id gets a 200 carrying the attacker's row, runs turns
  on it, and the attacker reads the transcript through `GET /threads/:id/state`.

A value-comparison recheck looks sufficient and is not: when the policy returns `permit()`
with no stamp, the issued stamp is `undefined`; if the row that came back also has none (a
legacy thread, or a winner who stamped nothing), both sides are `undefined`, the comparison
passes, and the loser proceeds on the winner's row with no re-authorization at all.
`JSON.stringify` equality is separately fragile on key ordering. So the recheck is
unconditional. Cost: one extra policy call per gated create, and no extra store round-trip —
the row is already in hand.

**And on the server-generated path, "did I actually insert?" is checked before returning.**
Re-authorizing alone turns a silent adoption into a deny, which is safe but is a 403 on a
create the caller was fully entitled to make. So `POST /threads` also compares the row it got
back against what it submitted — the returned `metadata` must deep-equal the object passed to
`createThread`, and `created_at` must equal `updated_at` — and on a mismatch **retries with a
fresh id**, bounded at three attempts, rather than handing back someone else's thread. This is
a runtime-side check in `runtime-fetch-core.ts`: no `ThreadsStore` change, no `created` flag on
the store contract, so §6's "no store interface change" promise holds.

Be honest about its reach: the check is decisive exactly when the policy stamped (an adopted
row carries a different stamp, or none), and indecisive in the one case where it does not
matter — a policy that returns `permit()` with no stamp on a create with no metadata has
nothing to distinguish and also nothing to authorize against later, i.e. it is not doing
per-thread ownership at all. The unconditional `update` re-authorization is what holds the line
in every case; the retry is what keeps the common case from being a spurious 403.

Widening the id to ≥128 bits is the real fix and is a deliberate **non-goal here** (see
Non-goals): it changes both stores and moves a `runThreadsStoreConformance` assertion
(`packages/testing/src/threads-conformance.ts:67`, "generated ids are t- plus 8 lowercase hex
digits"), which does not belong in an authorization PR and would make PR A's diff harder to
review, not easier.

**The recheck's request shape**, pinned because PR B is written against it: `action: "update"`,
`thread` = the row `createThread` returned, `threadId` = that row's `thread_id`, `operation`
and `url` and `method` = the same values the originating request carried (so a policy can tell
which endpoint it came from), `requestedMetadata: undefined` — the create's metadata was
already adjudicated by the create call, and repeating it would invite a policy to authorize
the same input twice under two different actions. `notFound` is whatever the originating
endpoint would use; on `POST /threads` there is none, so the deny is the `update` default 403.

One consequence the reference page must state: a policy whose `update` is stricter than its
`create` can deny its own successful create. That is the app's rule, not a Dawn bug — and the
example in §1 avoids it by routing both through the same `owned` helper, which is why that
example annotates the recheck rather than leaving it implicit.

**Orphaned checkpoint state: a create may never adopt it.** The stamp lives on the threads
row, but the payload `/state` protects lives in the checkpointer — two stores with no shared
transaction. So an id can exist in the checkpointer with no row, and a create on that id
silently inherits a stranger's transcript: the run resumes from it, and `GET /state` then
passes the read gate because the caller now owns the row. Where orphans come from, after the
#443 rebase:

- A checkpointer with no `deleteThread` method. Deletion is a `typeof … === "function"` probe
  (`:947-955`); a LangGraph saver or an app's own Mongo/Redis saver has no such method, so
  DELETE removes the row and leaves every checkpoint behind, permanently. (#443's reversal of
  the delete order fixes the *other* half — a throw mid-delete now strands the payload rather
  than the row — but it cannot help when the call never happens.)
- Deployments where the threads store and the checkpointer are different backends or have
  different lifetimes: the deploy-anywhere / serverless case, where an ephemeral threads store
  and a durable Postgres checkpointer are a normal configuration.

The rule: **on every create path, when the id is not one the runtime just generated, the
runtime probes the checkpointer for existing state at that id, and on a hit authorizes as
`update` with `thread: undefined` rather than as `create`.** `thread: undefined` is exactly
right and is not a placeholder — there is no row, so there is no `access` to match, and any
realistic policy denies (the same shape §5 relies on for the DELETE oracle). PR A's one gated
create takes a server-generated id and so never probes; the rule binds in PR B, where the three
implicit creates take a client-supplied id, and it is the reason those sites are safe. The cost
is one `getTuple` per implicit create on a missing row, on the hook path only.

The `runThreadsStoreConformance` case that pins the backend divergence (`createThread` with an
already-present `thread_id` either rejects or returns the stored row **with its existing
metadata unchanged**, never applying the caller's) ships with PR B, alongside a companion case
pinning that `updateMetadata` is shallow and leaves an unrelated top-level key intact — the
property the stamp's survival depends on across every `route` and `parked_route` write.

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
| `POST /threads` | **403** | `{"error":{"details":{"code":"thread_access_denied"},"kind":"request_error","message":"Forbidden"}}` | n/a — nothing to hide. Both denies on this endpoint answer identically: the `create` deny before the insert, and the §4 `update` recheck deny against the row that came back |
| *(PR B)* implicit create on a client-supplied id | **403** | same | The §4 checkpointer probe means an id with orphaned state is authorized as `update` with `thread: undefined`, so "adoptable orphan" and "not yours" answer the same |
| `GET /threads/:id` | **404** | `{"error":{"kind":"request_error","message":"Thread not found"}}` — the handler's own literal, via `notFound` | **No.** Byte-identical, and the row was already loaded before the gate ran, so the timing matches too |
| `GET /threads/:id/state` | **404** | `{"error":{"kind":"request_error","message":"No checkpoint found for thread"}}` — that handler's own literal | **No** for the body. The thread row is loaded before the gate and the checkpoint is not, so a deny is one `getTuple` faster than a genuine miss — a timing channel, not a content one |
| `DELETE /threads/:id` | **403** | `thread_access_denied` | **No** — see below |
| `POST /threads/:id/cancel` | **403** | `thread_access_denied` | **No.** A missing row is authorized with `thread: undefined` and denied the same way, so `/cancel`'s existing 404 vs 409 vs 200 split is only ever observable by a caller the policy already trusts with `update` on that thread |

A policy may override the status, but only within `403 | 404`.
`normalizeThreadAccessResult` drops any other value and falls back to the per-action default,
so a policy cannot mint a 200, a 500, or a redirect from a deny — and `statusResponse`'s
existing "outside 200-599 collapses to 500" path is unreachable from here.

A supplied `body` is JSON-encoded through `statusResponse` exactly as `reject(status, body)`
is. What that does with **no** body is worth stating correctly, because an earlier draft of
this spec had it wrong and the wrong version invites relaxing the rule below: `statusResponse`
calls `Response.json(body, {status})` (`status-response.ts:22-36`), and `Response.json(undefined)`
**throws** `TypeError: Value is not JSON serializable` (verified on Node 22.14 and Node 24),
which the `catch` at `:29-35` converts into a 500 `execution_error`. Only `Response.json(null)`
produces the four bytes `null`. That is exactly why `denyResponse` guards on
`result.body !== undefined` before ever calling `statusResponse`, and why every default above
supplies a literal body: a deny must never be able to 500. (Aside, out of scope here: a
middleware `reject(401)` with no body already 500s today for the same reason.)

**The read → 404 choice is what makes the pair work.** A read deny is indistinguishable from
a miss, so nobody can enumerate thread ids through `GET /threads/:id` or `/state`. The 403s
sit on endpoints whose caller has already named a specific thread and asked to change it,
where the marginal information is one bit and the diagnostic value of an honest 403 is high.

**The read → 403 an app may still choose.** `deny({ status: 403 })` on a `read` is legal, and
it reopens exactly the enumeration channel the 404 default closes: a 403 means "this thread
exists and is not yours", so `GET /threads/<guessed>` becomes an existence oracle over a
32-bit id space. This is the symmetric twin of the DELETE rule below and the reference page
carries the same explicit warning in the same words: *a `read` handler that returns 403 tells
the caller the thread exists.* Dawn does not forbid it — an app that authenticates every
caller and wants honest diagnostics is entitled to it — but it must be a choice, not a default
someone reaches by copying the `update` branch.

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
  thread" 404, byte-identical to the genuine miss. This is the same orphan §4 forbids a
  `create` from adopting: gating the read closes the front door, and the create probe stops
  an attacker walking in through the back one by claiming the row and then reading legally.
- On `/cancel` a missing row would otherwise answer `404 thread_not_found` while a
  not-yours row answered 403 — the same oracle in a different wrapper.
- On `GET /threads/:id` the two outcomes are the identical 404 either way, so the call buys
  nothing observable. The policy is still invoked, because "invoked on every gated request"
  is one rule an implementer cannot get subtly wrong, and one policy call is cheap.

**Not a deny:** a hook that throws is a **500** through `fetch`'s catch-all (`:632`), and the
endpoint's work never runs. A hook that returns a malformed value **denies at the per-action
default** — 404 on `read` (`thread.get`, `thread.state`), 403 on `create`/`update`/`delete` —
plus one `console.warn` per denial naming the operation, the thread id and the offending
value. It is deliberately *not* pinned to 403: `normalizeThreadAccessResult` returns a bare
`{decision:"deny"}` with no `status`, `denyResponse` applies the per-action default, and
forcing 403 on a read would make a broken policy answer differently from a working one and
hand back the enumeration oracle. The cost — a broken read policy looks like an empty database
— is paid by the warn, which is why the warn is per-denial rather than once per process. Both
failure modes are fail-closed; neither is silently allowed, which is the failure mode
`runMiddleware`'s `=== "reject"` comparison has today.

**Not covered by either:** a hook that *hangs*. Dawn imposes no timeout on a policy call, and
`/cancel` holds a bound `RunClaim` across that await, so a slow IdP degrades into a stuck
request rather than a denial. This is the same exposure any `await` in `src/middleware.ts`
already has, and Dawn has no timeout budget to inherit — so it is documented rather than
defended: the reference page tells policy authors to put their own timeout around any network
call and to fail closed on it. Named here so nobody reads the throw/malformed pair as the
complete failure taxonomy.

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
- `POST /threads` runs neither the recheck nor the collision retry: both are inside the hook
  branch, so a hook-less create is one `createThread` call exactly as today.
- Every status code and every error body on all five endpoints is unchanged.

The **one** unconditional behavior change is `stripReservedThreadMetadata` at `POST /threads`
(§4), which a hook-less app also pays: a client that posts `metadata: {"dawn:access": …}`
gets it dropped rather than stored. That is the line the changeset describes, and it is pinned
by a test that runs an app with **no policy file** (§ Test strategy) — testing it only through
the with-policy endpoints suite would leave the changeset's actual claim unverified.

Type-level: `MiddlewareRequest`, `DawnMiddleware`, `MiddlewareResult`, `allow`, `reject`,
`defineMiddleware` are untouched. `@dawn-ai/sdk` gains nine types, three functions and one
constant, all additive. `StartRuntimeServerOptions` gains an optional `threadAccess`.
`RuntimeBootFallbacks` gains an optional `loadThreadAccess`. **`@dawn-ai/testing` gains a
published export** — `createThreadAccessHarness` from the new
`packages/testing/src/thread-access-harness.ts`, re-exported from `index.ts` — plus an optional
`threadAccess?` on `createAgentProtocolInjector`'s options object (today: `{ appRoot }` only,
`http-inject.ts:21-23`). Both are additive, but they are *public API on a second package*, so
PR A's changeset covers `@dawn-ai/testing` as well as `@dawn-ai/sdk` and `@dawn-ai/cli`.
`ThreadsStore` and `Thread` are unchanged — no new store, no new method, no migration, no
schema change on either backend; the stamp rides inside the existing `metadata` JSON/jsonb
column. `DAWN_ERRORS` gains `DAWN_E3003`; the registry is
`as const satisfies Record<string, DawnErrorDescriptor>` and
`packages/sdk/test/errors.test.ts` iterates entries generically rather than asserting a count.

**Adopting** a policy is the breaking step, per app, and opt-in. Threads created before the
policy have `access === undefined`; the policy sees that and decides — Dawn does not guess.
The reference page makes this the first question a policy author answers, with the two sane
answers: admin-only (the `owned` example's legacy branch), or a one-time backfill.

The backfill needs a named surface, because every in-runtime path to it is deliberately shut:
`updateMetadata` has no HTTP endpoint, and `assertNoReservedKey` throws on any runtime patch
carrying the reserved key. The backfill is therefore an **operator script constructing the
threads store directly** and calling `ThreadsStore.updateMetadata(id, {[THREAD_ACCESS_METADATA_KEY]: …})`
— which is why that constant is exported, and why the assertion sits on the three (five after
#443) runtime patch builders rather than on the store method. This puts backfill in the same
class as the `dawn inspect` / `dawn memory` non-goal below: a local operator with filesystem
or database access, documented rather than defended. The reference page carries the script.

### 7. Coverage is enumerated, so a test enumerates it

Five hand-placed call sites in one file, and `RouteMatcher` (`runtime-fetch-core.ts:152-156`)
has only `{method, pattern, handle}` — no metadata slot — so nothing structurally forces the
next endpoint someone adds to be gated.

The test therefore walks the built route table and requires **every** entry to appear on
exactly one of three lists: **gated**, **deferred** (PR B owes it a gate), or **exempt** (not
thread-scoped). Two specifics, both of which an earlier draft got wrong and both of which
decide whether the test can do its job at all:

1. **The key is `` `${method} ${pattern.source}` ``, not `pattern.source`.**
   `GET /threads/:thread_id` (`:935`) and `DELETE /threads/:thread_id` (`:960`) have
   **byte-identical** pattern sources. Keyed on source alone the two are one row, the list
   cannot say that GET is gated as `read` and DELETE as `delete`, and a newly added ungated
   `PATCH` or `POST` on that same pattern passes silently — precisely the rot the test exists
   to catch.
2. **The filter is inverted: collect the whole table, not "entries mentioning `threads`".**
   `POST /agui/:routeId` is `/^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/` (`:1061`) and contains
   no "threads" — yet it resolves a client-supplied thread id, creates the row
   (`agui-handler.ts:252`) and writes its metadata (`:254`), and PR B is told to move it off
   the deferred list, which a name filter would make impossible. Any future thread-touching
   endpoint not spelled `/threads` is invisible to a name filter for the same reason. Walking
   the whole table and requiring classification makes a new route of *any* shape red until
   someone decides.

The three lists as PR A writes them (13 entries in today's table, 14 after the #443 rebase):

- **Gated** (5): `POST /threads`, `GET /threads/:id`, `DELETE /threads/:id`,
  `GET /threads/:id/state`, `POST /threads/:id/cancel`.
- **Deferred** (4): `POST /threads/:id/runs/stream`, `POST /threads/:id/runs/wait`,
  `POST /threads/:id/resume`, `POST /agui/:routeId`. PR B moves all four to gated.
- **Exempt** (4): `GET /healthz`, `GET /memory/candidates`,
  `POST /memory/candidates/:id/approve`, `POST /memory/candidates/:id/reject`.

`GET /threads/:id/pending_interrupts` arrives with the rebase as a 14th entry and is on none
of them until the question in § Open question for review is answered — which is the concrete
reason that question blocks PR A rather than PR B: the test is red the day it is written
otherwise, and whoever is holding the keyboard picks a bucket ad hoc.

This is not optional polish; it is the thing standing between an enumerated design and a
silently ungated endpoint next quarter.

## Open question for review

**Not decided here. The repo owner decides before PR A merges.**

**The tension.** PR #443 — the branch PR A rebases onto — adds a **sixth** thread endpoint,
`GET /threads/:thread_id/pending_interrupts` (`runtime-fetch-core.ts:1193-1206` on that
branch). It reads thread payload and it is gated on **route identity**: it resolves the route
that parked the interrupts (`metadata.parked_route`, else the last-run chain) and runs that
route's `runMiddleware`. Route identity is the axis this spec's "Rejected approaches" section
argues is the wrong one for thread objects — a thread has no owning route by construction, and
`parked-route.ts`'s own header comment documents that last-run route is attacker-swappable.
If both land as written, Dawn ships **two authorization models for reads of the same thread**:
`GET /threads/:id` and `/state` answer to `defineThreadAccess`, and `/pending_interrupts`
answers to `src/middleware.ts`.

The concrete failure that makes this more than an aesthetic objection: in an app whose
middleware **authenticates** rather than authorizes per-user — a shared API key, or
any-valid-user, which is the common shape — every caller satisfies the parked route's
middleware. A low-privilege user therefore reads another user's `interruptId`/`resumeKey` pair
and parked tool arguments, and can then resume that turn through `/resume` (ungated until PR
B). #443 reasons about this honestly for what it protects, and explicitly defers the rest
("Gating /state is tracked separately; this endpoint is not the place to compensate for it") —
which is precisely the seam this spec is supposed to close. PR A's claim "**the disclosure
closes here**" does not hold while that endpoint is on capability-only gating.

It also has to be answered *before* PR A merges, for two mechanical reasons: §7's enumeration
test requires every route-table entry to be classified, and this endpoint is the 14th entry
after the rebase; and Option A adds a member to `ThreadOperation`, a union PR A ships whole
specifically so PR B adds no published type change.

**Option A — bring `/pending_interrupts` onto the thread-access axis in PR B**, *in addition
to* #443's route-identity check, not instead of it. The endpoint would gain a `read` /
`thread.pending_interrupts` gate placed with the other reads, and a denied read would route
through that handler's own `404 thread_not_found` literal so it stays byte-identical to a
genuine miss.

- *Buys:* one authorization model for every read of a thread. The confused-deputy case above
  closes. The `/resume` gate PR B adds and this gate then agree on who may touch a parked turn,
  which is the pair an attacker actually needs.
- *Costs:* a tenth `ThreadOperation` member, decided in PR A and implemented in PR B, so PR A's
  union is written against a decision PR B has not yet shipped. #443's own tests
  (`pending-interrupts-endpoint.test.ts`) gain a third premise rewrite. The two checks compose
  as AND, which needs one clear sentence in the docs about which one produced a given denial —
  and a 404 that could be either middleware's or the policy's is harder to debug than either
  alone. It also grows PR B, which is already the larger slice.

**Option B — keep both axes and document why.** `/pending_interrupts` stays gated on the
parking route only; the docs state plainly that Dawn gates *the parked prompt's addressing
pair* on the route that parked it, and *the thread object* on `defineThreadAccess`, and that
an app relying on per-user isolation must make its middleware authorize per user rather than
merely authenticate.

- *Buys:* no change to #443, no tenth union member, PR B stays its stated size. It is also
  arguably the more honest model for the object in question — the parked prompt genuinely does
  belong to a route's turn, which is the one place in the thread surface where route identity
  is not a proxy for something else, and `parked-route.ts`'s own reasoning (a key written only
  by a turn that actually parked, so it cannot be repointed by starting a cheaper run) is a
  real ownership claim rather than a capability check wearing one's clothes.
- *Costs:* two authorization models for thread reads, permanently, and a shared-API-key app
  gets no isolation on the one endpoint that returns resume credentials — which most readers
  will assume `defineThreadAccess` covers, because it covers everything next to it. Every
  future thread-read endpoint has to be argued onto one axis or the other with no rule to
  appeal to.

**What is not in question either way:** `/pending_interrupts` must be classified on one of
§7's lists in PR A. Option A puts it on *deferred*; Option B puts it on *exempt* with the
reason inline. Leaving it unclassified is the only outcome this section rules out.

## Non-goals

- **Route-scoped or assistant-scoped thread gating for the five endpoints in §3** — rejected
  on prior art above. Whether #443's route-identity gating *also* stays the only gate on
  `/pending_interrupts` is deliberately **not** settled here; see § Open question for review.
- **An ACL store, a `thread_owners` table, or any `ThreadsStore` interface change** — the
  stamp rides in existing metadata. No migration, no new conformance kit.
- **Threading middleware's `allow(context)` into the policy** — it would be present on the
  run endpoints and absent on the thread endpoints. A shared `src/auth.ts` is the answer.
- **The policy seeing the request body** — `ThreadAccessRequest` is headers, method, url,
  and the row. Body-dependent authorization is a route concern and `src/middleware.ts`
  already has body-derived `params`.
- **Compare-and-set on `ThreadsStore`** — the create rule gets the same guarantee from the
  value `createThread` already returns.
- **Widening the thread id past 32 bits.** §4 establishes that `newThreadId()` is four random
  bytes in both stores, that this is guessable and birthday-collides at ~65k threads, and that
  the collision is what makes a create able to adopt a stranger's row. Raising it to ≥128 bits
  is the right fix and is **explicitly a follow-up, filed, not in either slice**: it touches
  both stores and moves a `runThreadsStoreConformance` assertion
  (`packages/testing/src/threads-conformance.ts:67`), which is a storage change wearing an
  authorization change's clothes. PR A defends against the collision instead — bounded retry
  plus unconditional re-authorization (§4) — and both of those stay correct and useful after
  the id is widened.
- **Gating `dawn inspect`, `dawn memory`, or anything constructing a store directly** —
  local-operator tools with filesystem access to the database. Documented, not defended.
- **Making `createAgentHarness` run policies** — it drives `streamResolvedRoute` directly
  (`packages/testing/src/harness.ts:187`), takes no run slot and writes no threads-store row,
  so it runs no middleware today and will run no policy either. Policies are tested through
  the injector and the unit harness (§ Test strategy).
- **`dawn doctor` / `dawn check` warning on an app with open thread endpoints and no policy**
  — the right follow-up, filed, not in either slice.

## Delivery slices

**PR A — the seam and the originally-ungated endpoints.** The disclosure on those five closes
here. It does **not** close the whole thread-read surface until the `/pending_interrupts`
question is answered (§ Open question for review) and PR B lands the run endpoints.

1. `packages/sdk/src/thread-access.ts` + barrel + `DAWN_E3003`.
2. `dev/thread-access.ts` (pure: selection rule, candidate paths, policy validation, result
   normalization) and `dev/thread-access-node.ts` (`existsSync`-then-import, throws).
3. `RuntimeBootFallbacks.loadThreadAccess?`, `StartRuntimeServerOptions.threadAccess?`,
   `DawnStaticModules.threadAccess?` + its `loadStaticModules` validator clause,
   `execute-route.ts` wiring `loadThreadAccess` into `nodeBootFallbacks` (without which the
   disk probe never runs on any node path), the three-layer boot resolution, and the one boot
   log line naming the resolution source.
4. `dev/thread-metadata.ts` + the unconditional strip at `POST /threads` +
   `assertNoReservedKey` on every runtime `updateMetadata` patch builder — three on
   `origin/main`, five after the #443 rebase (§4).
5. `makeThreadGate` + `denyResponse` + `isThenable` + the five gated endpoints; `RunRegistry.claim()`
   as a **required** member plus its passthrough in `getRunRegistry`'s per-request wrapper
   (`:506-535`); `threadAccess` threaded through `buildRouteTable`'s ctx.
6. `POST /threads`'s collision retry + the unconditional `update` recheck (§4).
7. **The `@dawn-ai/testing` surface**, which every endpoint test in this PR depends on:
   `createAgentProtocolInjector({ appRoot, threadAccess? })` in `http-inject.ts`, and the new
   `packages/testing/src/thread-access-harness.ts` exporting `createThreadAccessHarness`,
   re-exported from `packages/testing/src/index.ts`. This is a **published export on a second
   package** — the changeset covers `@dawn-ai/testing`, not only `@dawn-ai/sdk` and
   `@dawn-ai/cli` (§6).
8. The route-table enumeration test (§7), with the run endpoints deferred and `/healthz` +
   the memory-candidate endpoints exempt.
9. `dawn build --target hono|langsmith` fails with `DAWN_E1005` when a policy file exists.
10. The `thread-access` reference page (API, load failures, the legacy-thread question and the
    operator backfill script, the "identifiers not secrets" rule, and **both** enumeration-oracle
    warnings — `delete` denying on `thread: undefined`, and `read` returning 403) + `page.tsx`
    + `nav.ts` entry + a regenerated `apps/web/content/docs/errors.mdx` (§2 — CI enforces all
    four). Changeset.

**If #443 does not land first.** PR A is written against `origin/main` and rebases onto #443;
the spec assumes that order because #443 is the reason this is urgent. If #443 lands *after*
PR A, or not at all, four things move and nothing about the design does:

- The DELETE gate's "ahead of the `409 run_in_flight` guard" placement has no guard to sit
  ahead of; "first in the handler" is then literal, and the ordering becomes #443's problem to
  preserve when it rebases.
- `assertNoReservedKey` wraps three patch builders, not five; `parked-route.ts` does not exist.
- The two `pending-interrupts-endpoint.test.ts` rewrites (items 2 and 3 of "Existing tests
  this work must update") do not exist to rewrite. They become #443's own follow-up: that PR
  then owns updating its premise, because its comments assert those endpoints are ungated.
- §4's orphan rule gets *more* important, not less. On `origin/main` the row is deleted first
  (`:945`) and the checkpoints after, so a throw between them strands the **payload** behind a
  missing row — a third orphan source on top of the `typeof deleteThread === "function"` probe
  and split backends. #443's reversal is what removes it. Without #443, PR B's checkpointer
  probe on client-supplied-id creates is the only thing standing between an orphan and a
  caller who claims it.

The **`/pending_interrupts` question above is the exception** — it exists only because #443
exists, and if #443 is abandoned the question is moot.

**PR B — the run surface, edge, and defaults.**

1. Gate `/runs/stream`, `/runs/wait`, `/resume`, and `/agui/:routeId`, with the create-vs-update
   branch, the §4 checkpointer probe on a missing row, and the unconditional recheck against
   the returned row. Move those four patterns from the deferred list to the gated list in the
   enumeration test.

   **Ordering is per endpoint, not one global "after `runMiddleware`" rule.** The default —
   gate after middleware, so an existing 401 from a missing API key does not silently become a
   403 — holds on three of the four and is unsatisfiable on the fourth:

   | Endpoint | Gate position | Why |
   |---|---|---|
   | `POST /threads/:id/runs/stream` | after `runMiddleware` (`:1295`), before `createThread` (`:1303`) and `runRegistry.begin` (`:1315`) | the default; nothing observable happens in between |
   | `POST /threads/:id/runs/wait` | after `runMiddleware` (`:1523`), before `createThread` (`:1531`) and `runRegistry.begin` (`:1538`) | same shape |
   | `POST /agui/:routeId` | after `runMiddleware` (`agui-handler.ts:205`), before `resumeClaims.tryClaim` (`:211`), `readPendingInterrupts` (`:225`), `runRegistry.begin` (`:240`) and `createThread` (`:252`) | middleware already runs first here, so the default costs nothing |
   | `POST /threads/:id/resume` | **before** `resumeClaims.tryClaim` (`:1734`) — i.e. immediately after body parse — and therefore **before** `runMiddleware` (`:1803`) | see below |

   `/resume` is the exception and it is not a preference. Its handler order is `tryClaim`
   (`:1734`) → `readPendingInterrupts` (`:1746`) → `resolvePendingResume` (`:1756`, which
   returns distinct 400/409 codes derived from the victim's parked interrupts) → `getThread`
   for the route key (`:1773`) → `runMiddleware` (`:1803`). A caller the thread policy would
   deny, gated after middleware, would still have (a) taken and held the victim's resume claim,
   so a concurrent legitimate resume gets `409 resume_in_progress` — a targeted DoS on a parked
   turn — and (b) learned from the pre-gate error codes whether the thread has pending
   interrupts and whether a guessed `interruptId`/`resumeKey` is valid, which is the exact pair
   #443 gates `/pending_interrupts` to protect. This spec rejected the `scopeThreadsStore`
   alternative partly on this very ground; the chosen design must not inherit it.

   Nor can both rules hold at once here: `runMiddleware` needs `routeKey`, and `routeKey` is
   read from **thread metadata** at `:1773`, so "after middleware" and "before any side effect"
   are contradictory on this endpoint. State the consequence plainly rather than hiding it: on
   `/resume`, and only there, a caller who would have received a middleware 401 receives a
   thread-access deny instead (403, or the policy's chosen 404). The reason is that the route
   identity middleware would authorize against is itself derived from the thread the caller has
   not yet been authorized to read.

   Each of the four gets its own ordering test, in the style §7 applies to route coverage: a
   policy that records call order, asserted against the side effects that must not have
   happened on a deny (`/resume`: the resume claim is still free; `/agui` and the run
   endpoints: no row created, no run slot taken).
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
- `packages/cli/src/lib/dev/run-registry.ts` — `claim()` + `RunClaim` as **required** members;
  `cancel()` untouched.
- `packages/cli/src/lib/dev/runtime-fetch-core.ts` — boot resolution, `makeThreadGate`,
  `denyResponse`, `toThreadSubject`, `isThenable`, `isRowWeJustWrote`, `threadAccess` on
  `buildRouteTable`'s ctx (`:827-872`), a `claim` passthrough in `getRunRegistry`'s per-request
  wrapper (`:506-535`), five gate insertions, the `POST /threads` retry + recheck, the
  `/cancel` restructure, and **two** `assertNoReservedKey` wraps (`:1331`, `:1551`).
- `packages/cli/src/lib/dev/agui-handler.ts` — the third `assertNoReservedKey` wrap (`:254`).
  No gate here in PR A; PR B adds the `run.agui` gate.
- *(after the #443 rebase)* `packages/cli/src/lib/dev/parked-route.ts` — the fourth and fifth
  `assertNoReservedKey` wraps (`:125`, `:135`).
- `packages/cli/src/lib/dev/runtime-server.ts` — `threadAccess?` option.
- `packages/cli/src/lib/runtime/static-modules-core.ts` — `DawnStaticModules.threadAccess?`.
- `packages/cli/src/lib/runtime/static-modules.ts` — the manifest-validator clause.
- `packages/cli/src/lib/runtime/execute-route-core.ts` — `loadThreadAccess?` on
  `RuntimeBootFallbacks`; the THROWS/DEGRADES third category.
- `packages/cli/src/lib/runtime/execute-route.ts` — wire `loadThreadAccess` into
  `nodeBootFallbacks`.
- `packages/cli/src/lib/build/targets/hono.ts`, `langsmith.ts` — the fail-the-build probe.
- `packages/testing/src/http-inject.ts` — `createAgentProtocolInjector({ appRoot, threadAccess? })`
  (today `{ appRoot }` only, `:21-23`), forwarded to `createRuntimeFetchHandler`.
- `packages/testing/src/thread-access-harness.ts` — NEW; exported from
  `packages/testing/src/index.ts`. A published `@dawn-ai/testing` export — see §6 and the
  changeset note in PR A item 7.
- `apps/web/content/docs/thread-access.mdx` + `apps/web/app/docs/thread-access/page.tsx` +
  the `nav.ts` entry under `apps/web/app/components/docs/`.
- `apps/web/content/docs/errors.mdx` — regenerated by `pnpm docs:errors`
  (`scripts/generate-error-docs.mjs`) after `pnpm build`. Not optional: `scripts/check-docs.mjs`
  fails without it (§2).
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
`POST /threads` is dropped; a policy that throws yields 500 and the thread is not created.

Three more the malformed/stamp rules need, none of which the list above implies:

- **Malformed returns are asserted per action, not once.** A policy that returns `undefined`
  yields **403** on `DELETE /threads/:id` and a **byte-identical 404** on `GET /threads/:id`
  and `/state` — the per-action default (§5). A single "yields 403" assertion would pass
  against a wrong implementation that hard-codes 403 and silently reopens read enumeration.
- **The stamp is ignored on non-create.** An `update` allow (on `/cancel`) and a `read` allow
  (on `GET /threads/:id`) that each carry a `stamp` must leave the stored metadata **byte-for-byte
  unchanged**, and emit the once-per-process warn. Without this, "honored on `create` ONLY" is
  a doc comment with no enforcement, and a later refactor that merges the stamp on every allow
  would pass every other test in this suite.
- **A `read` policy that returns `deny({status: 403})` gets 403**, not the 404 default — the
  override is real and the enumeration consequence is the app's (§5). Pinned so nobody
  "fixes" the override away for safety.

**The unconditional strip, tested WITHOUT a policy** —
`packages/cli/test/thread-access-endpoints.test.ts` also runs an app with **no**
`thread-access.ts` and asserts that `POST /threads` with `metadata: {"dawn:access": {...},
"keep": 1}` stores `{"keep": 1}` and nothing else. This is the one behavior change a hook-less
app sees and the one the changeset describes; asserting it only through the with-policy suite
would leave the changeset's claim unverified.

**Boot log** — the three variants of the resolution line are asserted (`bound from
src/thread-access.ts` / `bound from the build manifest` / `no thread access policy (all thread
endpoints are open)`), including that the third is emitted for a hook-less app. It is the only
signal an operator has that a policy vanished (Risks, row 6), so it is a test, not a comment.
It is emitted **after** resolution succeeds, so the `DAWN_E3003` throw pre-empts it — a boot
that fails never claims to have bound anything.

**Ordering** — a policy that records call order proves `claim()` precedes any await on
`/cancel`, and that a run started after the claim is *not* cancelled by it (the direct
sibling of `release()`'s identity-guard case). `packages/cli/test/run-cancellation.test.ts`
gains the `claim()` cases; its existing 404/409 assertions must stay green unchanged.

**Create collision** — with a policy installed, a stubbed threads store whose `createThread`
returns a *foreign* row (the Postgres upsert shape) proves both halves of §4: `POST /threads`
retries with a fresh id, and if every attempt collides the unconditional `update` recheck
denies rather than returning the foreign row. Both are cheap to test at the store seam and
untestable through a real sqlite store, which throws instead.

**Coverage** — the route-table enumeration test of §7: every entry in the built table is on
exactly one of the gated / deferred / exempt lists, keyed on `` `${method} ${pattern.source}` ``;
and every `ThreadOperation` PR A can emit is exactly the five `thread.*` members (`thread.create`
appears twice per create — once as `action: "create"`, once as the `action: "update"` recheck).

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

**Existing tests this work must update.** Item 1 exists on `origin/main` at the same lines and
is the one tripwire verifiable **before** the rebase. Items 2 and 3 live only on PR #443's
branch — `packages/cli/test/pending-interrupts-endpoint.test.ts` does not exist in an
`origin/main` worktree, only the unit test `packages/cli/test/pending-interrupts.test.ts` does
— so PR A rebases onto #443 and updates those two there:

1. `packages/cli/test/run-cancellation.test.ts:688-703` — "409s when the thread exists but no
   run is in flight" creates a thread and cancels it, with no run ever started. Under `claim()`
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
   raced by deleting the row). Note that this test's comment states the settle mechanism the
   way the Problem section used to — "Every settle path ends in updateMetadata" — which is
   true on #443's branch (`settleParkedRoute`) and false on `origin/main` (`updateStatus`).
   Both are silent no-ops on a missing row, so the test's subject is unaffected; the rewrite
   should not "fix" the comment in the wrong direction.

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
accepted), and **`apps/web/content/docs/errors.mdx`**, regenerated via
`node scripts/generate-error-docs.mjs` (`pnpm docs:errors`) after `pnpm build` — the
`Docs Check` lane (`scripts/check-docs.mjs`) fails without it. **Not** `docs-bundle.test.ts`:
it unit-tests `parseNav` against inline fixtures and never sees the real nav (§2).

Run everything on Node 24 (`nvm use 24`) — Node 22 makes roughly eight `dawn verify` tests
fail spuriously and look pre-existing.

## Risks

| Risk | Mitigation |
|---|---|
| **Enumerated coverage rots.** Five hand-placed call sites; `RouteMatcher` (`runtime-fetch-core.ts:152-156`) has no metadata slot, so nothing structurally forces the next endpoint someone adds to be gated. | The route-table enumeration test (§7) requires **every** table entry, keyed on `` `${method} ${pattern.source}` ``, to be on the gated, deferred or exempt list. Whole-table and method-keyed, because a name filter cannot see `/agui` and a source-only key cannot separate `GET` from `DELETE` on `/threads/:id`. Not optional polish. |
| **Two files, two principals, nothing enforcing agreement.** `src/middleware.ts` and `src/thread-access.ts` each parse `Authorization` independently; the failure mode is a confused deputy — middleware admits the caller as org A, the policy derives org B. | Threading `allow(context)` in is worse (present on four endpoints, absent on five). The answer is a **scaffolded** shared `src/auth.ts` plus a worked example in the templates (PR B), not a docs line. Named as convention-not-enforcement. |
| **The stamp is echoed by `GET /threads/:id`**, so it is readable by anyone the `read` policy admits. | Deliberate — hiding it breaks round-tripping and makes it undebuggable. The docs say "identifiers, never secrets" in those words, the way `parked-route.ts` already words it for `parked_route` ("NOT SECRET … the key is an ACCESS-CONTROL INPUT, not a credential … do not build a check that relies on this being private"). |
| **Nothing scaffolds a policy**, so generated apps still start with fully open thread endpoints — this change makes authorization *possible*, not *default*. No template ships a `middleware.ts` either (verified: no `middleware*` file anywhere under `packages/create-dawn-app`). | The higher-leverage lever is the scaffold, not the mechanism: PR B ships a deny-by-default `src/thread-access.ts` in the templates. A `dawn doctor` warning for an app served with open thread endpoints and no policy is the filed follow-up. |
| **A create can return a row it did not write — on EVERY path, not only client-supplied ids.** `newThreadId()` is 32 bits in both stores, and Postgres `createThread` is `ON CONFLICT DO NOTHING` + `selectOne`, so a collision hands back a stranger's row and discards the caller's stamp. Birthday collisions arrive at ~65k threads with no attacker at all. The obvious "compare the returned stamp against the issued one" recheck fails open when the policy returns `permit()` with no stamp: both sides are `undefined` and the comparison passes. | Re-authorize as `update` against the returned row **unconditionally**, on every create path including `POST /threads` (§4), plus a bounded retry on the server-generated path when the returned row is not the one just written. Binds in PR A. Widening the id to ≥128 bits is the real fix and is a filed follow-up (Non-goals), not an authorization-PR change. |
| **A create can adopt orphaned checkpoint state.** The stamp lives on the threads row; the payload `/state` protects lives in the checkpointer, with no shared transaction. Checkpoint deletion is a `typeof checkpointer.deleteThread === "function"` probe (`:947-955`), so a LangGraph or app-supplied saver leaves every checkpoint behind when the row goes; split backends and lifetimes (deploy-anywhere/serverless) produce the same state. Claim the id, then read the victim's transcript legally. | On every create path taking a client-supplied id, probe the checkpointer and authorize as `update` with `thread: undefined` when state exists (§4). #443 already reverses DELETE's order (checkpoints first, row last), which removes the throw-mid-delete source; the `typeof` probe and split backends are what remains, and both are policy-visible rather than fixable here. |
| **Optional `loadThreadAccess` on `RuntimeBootFallbacks` reintroduces a silent ungating on node.** An external embedder building its own fallback bag gets `fallbacks` present, `loadThreadAccess` absent, no disk probe, no manifest, and no error. Requiring it would break their object literals (`loadMiddleware` is required today, `execute-route-core.ts:112-116`). | Keep it optional, and emit exactly one boot line naming the resolution source — `bound from src/thread-access.ts` / `bound from the build manifest` / `no thread access policy (all thread endpoints are open)`. "My policy vanished" is then one grep away. |
| **A stale edge manifest deploys ungated.** A `.dawn/build` produced before the app grew a policy carries no hook, and edge has no fallback to probe. | PR A refuses to build the hono target at all while a policy file exists. PR B replaces that with the manifest channel plus the `in`-distinguished staleness guard — record that the build saw a policy file, fail the boot when the record is present and the `threadAccess` **key** is absent. Guarding "key present but value undefined" instead would be near-dead code. |
| **The `/cancel` gate widens the documented run-N/N+1 window** (`runtime-fetch-core.ts:972-987`): an awaited policy call, or the row read it needs, before `cancel()` lets the cancel land on a later run. | `RunRegistry.claim()` taken synchronously as the first statement binds the abort to the run the caller observed, so the window is **closed**, not traded — and `Gate \| Promise<Gate>` keeps a header-only policy free of any microtask on top. Falling through to `409 no_run_in_flight` when the claim is stale is the honest answer, and is asserted. |
| **A malformed or throwing policy takes the whole endpoint down.** | By design and stated in the docs: malformed → deny at the **per-action default** (404 on `read`, 403 otherwise) plus one warn per denial naming the operation, thread id and value; throwing → 500 through `fetch`'s catch-all (`:632`), and the endpoint's work never runs. Not pinned to 403: forcing 403 on a read would make a broken policy answer differently from a working one and reopen enumeration. A 403 for a *thrown* policy would separately hide a broken policy behind what looks like a working one. |
| **A policy that hangs.** No timeout, no cap on concurrent in-flight policy calls; `/cancel` holds a bound `RunClaim` across the await. A slow IdP degrades into stuck requests rather than denials. | Documented, not defended (§5). It is the exposure any `await` in `src/middleware.ts` already has and Dawn has no timeout budget to inherit; the reference page tells policy authors to wrap network calls in their own timeout and fail closed. A Dawn-side budget is a follow-up worth having, and would have to cover middleware too. |
| **Denials are invisible to operators.** A read deny is byte-identical to a 404 by design, so a misconfigured policy denying every request looks exactly like an empty database, and there is no counter or structured log to say otherwise. | Partially covered: the malformed-return warn is per denial. A *legitimate* deny is deliberately silent, which is the cost of byte-identity. Named as a gap rather than solved — structured deny auditing wants a decision about log volume and PII in the same pass as the `dawn doctor` follow-up. |
| **Principal derivation from headers is the documented pattern, and header comparison is easy to get wrong.** Repeated headers arrive joined with `", "` (Fetch `Headers` iteration; `headersToRecord`, `middleware.ts:65-77`, additionally rejoins `set-cookie`). `X-User-Id: victim` + `X-User-Id: attacker` is one string. | Safe under strict equality, unsafe under any `includes`/`startsWith`/`split(",")` comparison — which is exactly what a hand-rolled parser reaches for. The reference page states this in those terms, with the strict-equality example, and says to prefer a signed token over a trusted header where the deployment allows it. |
| **Enumeration is cheap at scale even where the design is right.** DELETE's uniform 403 and PR B's create-vs-update branch are both probeable, and a *permitted* create on a guessed id still reveals the id was free. | Accepted. Byte-identity removes the content channel, not the cost channel; rate limiting is a deployment concern Dawn does not own. Widening the id (Non-goals follow-up) is what actually shrinks this, which is another reason to file it rather than forget it. |
