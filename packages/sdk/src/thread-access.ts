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

/**
 * Which endpoint asked, for policies that need finer grain than `action`.
 *
 * Each member, its endpoint, and the `action` it arrives under:
 *
 * - `thread.create` — `POST /threads` — `create`, then again as the `update`
 *   recheck that follows every create
 * - `thread.get` — `GET /threads/:id` — `read`
 * - `thread.state` — `GET /threads/:id/state` — `read`
 * - `thread.delete` — `DELETE /threads/:id` — `delete`
 * - `thread.cancel` — `POST /threads/:id/cancel` — `update`
 * - `thread.pending_interrupts` — `GET /threads/:id/pending_interrupts` — `read`
 * - `run.stream` — `POST /threads/:id/runs/stream` — `update`
 * - `run.wait` — `POST /threads/:id/runs/wait` — `update`
 * - `run.resume` — `POST /threads/:id/resume` — `update`
 * - `run.agui` — `POST /agui/:routeId` — `update`
 *
 * Every `run.*` operation arrives under `update`, without exception. Starting a
 * turn on a thread mutates it; none of them is a `create`, including the ones
 * whose endpoint will create the row when it is missing.
 */
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
   * thread can put anything here. Never contains the reserved key — Dawn lifts
   * it into `access` before building this object. Do not authorize against this
   * field.
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
 * One action's handler. Sync-or-async on purpose: a handler that returns a
 * plain object is resolved by the runtime with no microtask boundary, so a
 * header-only policy costs nothing on the hot path. An `async` handler is
 * equally correct — the runtime awaits it — and every gated endpoint is
 * ordered so that awaiting here is safe.
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
