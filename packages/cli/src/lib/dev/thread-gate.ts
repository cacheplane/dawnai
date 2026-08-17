import type {
  ThreadAccessDeny,
  ThreadAccessPolicy,
  ThreadAccessRequest,
  ThreadAction,
  ThreadOperation,
  ThreadSubject,
} from "@dawn-ai/sdk"
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import { headersToRecord } from "./middleware.js"
import { createRequestErrorBody } from "./server-errors.js"
import { statusResponse } from "./status-response.js"
import { normalizeThreadAccessResult } from "./thread-access.js"

/**
 * The thread-access gate: every gated endpoint builds one of these per
 * request and calls it to authorize against a `ThreadAccessPolicy`.
 *
 * Its own module rather than living in `runtime-fetch-core.ts` — the obvious
 * home, since every Agent Protocol handler already lives there. But
 * `runtime-fetch-core.ts` also imports the AG-UI handler, to wire
 * `POST /agui/:routeId` into the route table, and that endpoint's pattern
 * carries no `threads` segment — it gates itself inline rather than through
 * one of `runtime-fetch-core.ts`'s own handlers. Exporting the gate FROM
 * `runtime-fetch-core.ts` for the AG-UI handler to import back would have
 * made that import a cycle. This is the same shape of problem `terminal-
 * status.ts` was pulled out to solve in #462, after `terminalStatus` drifted
 * into two copies across this exact file pair: one shared module both
 * callers import, rather than either importing the other.
 */

export type GateOk = { readonly ok: true; readonly stamp?: Record<string, unknown> }
export type GateDenied = { readonly ok: false; readonly response: Response }
export type Gate = GateOk | GateDenied

export interface GateSpec {
  readonly action: ThreadAction
  readonly operation: ThreadOperation
  readonly threadId?: string
  readonly thread?: Thread
  readonly requestedMetadata?: Record<string, unknown>
  /**
   * Whether this request continues a parked turn — see
   * `ThreadAccessRequest.resuming`. Optional HERE so the many call sites that
   * can never be a resume say nothing; the gate defaults it to `false` and the
   * policy always receives a boolean.
   *
   * An endpoint that gates more than once for one request must pass the SAME
   * value at every site. Compute it once at the top of the handler.
   */
  readonly resuming?: boolean
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
 * Narrowing rather than a boolean, so the `await` branch typechecks. Nothing
 * in `packages/cli/src` had one before this.
 */
export function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
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
 *
 * Own properties only, both ways. The reserved key is read with `hasOwn` rather
 * than off the object, and each survivor is DEFINED rather than assigned: the
 * stored metadata is client-authored JSON, so it can carry `__proto__` as an
 * own data property, and `copy[key] = value` for that key runs the inherited
 * setter and swaps the copy's prototype instead of adding a property. Either
 * shortcut would let a forged stamp resolve through the chain on an object that
 * reports it stripped.
 */
function toThreadSubject(thread: Thread): ThreadSubject {
  const reserved = Object.hasOwn(thread.metadata, THREAD_ACCESS_METADATA_KEY)
    ? thread.metadata[THREAD_ACCESS_METADATA_KEY]
    : undefined
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(thread.metadata)) {
    if (key === THREAD_ACCESS_METADATA_KEY) continue
    Object.defineProperty(metadata, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
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
export function makeThreadGate(
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
      // Required on the published type, optional on the spec: an omitted spec
      // field is "this endpoint cannot resume", which is `false`.
      resuming: spec.resuming ?? false,
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

/**
 * The implicit thread create a run endpoint performs when the row is missing,
 * with the policy's stamp applied and the resulting ROW re-authorized.
 *
 * Called ONLY when a policy is installed — a hook-less app keeps its bare
 * `createThread({ thread_id })` at the call site and pays nothing for this.
 *
 * Mirrors `POST /threads` (`runtime-fetch-core.ts`), with two differences that
 * both come from the id being CLIENT-chosen here rather than server-generated:
 *
 * - **No retry.** `POST /threads` retries a create that collided, because it
 *   can draw a fresh 32-bit id and very likely win. A caller named this id, so
 *   every retry collides identically. Adoption of an existing row is permanent
 *   on this path.
 * - **The recheck is therefore the only boundary.** Unconditional, and never a
 *   stamp comparison: a `permit()` with no stamp leaves both sides `undefined`,
 *   the comparison passes, and the loser of a race proceeds on the winner's row
 *   with nothing having authorized it. Authorize the ROW.
 *
 * A store whose `createThread` throws on a duplicate id (sqlite's bare INSERT;
 * the conformance kit admits that and the upsert-and-return-the-existing-row
 * shape alike) propagates exactly as it does today — that path never obtains a
 * row, so there is nothing to re-authorize and nothing to hand back.
 */
export async function createGatedThreadForRun(args: {
  readonly gate: (spec: GateSpec) => Gate | Promise<Gate>
  readonly operation: ThreadOperation
  /**
   * The caller's own `resuming` — the recheck is the SAME request as the gate
   * that authorized the create, so it must report the same value. Defaults to
   * `false` for the endpoints that can never resume.
   */
  readonly resuming?: boolean
  readonly stamp: Record<string, unknown> | undefined
  readonly store: ThreadsStore
  readonly threadId: string
}): Promise<{ readonly ok: true; readonly thread: Thread } | GateDenied> {
  const { gate, operation, resuming, stamp, store, threadId } = args
  const thread = await store.createThread({
    thread_id: threadId,
    ...(stamp ? { metadata: { [THREAD_ACCESS_METADATA_KEY]: stamp } } : {}),
  })
  const recheck = gate({
    action: "update",
    operation,
    resuming: resuming ?? false,
    thread,
    threadId: thread.thread_id,
  })
  const settled = isThenable(recheck) ? await recheck : recheck
  if (!settled.ok) return settled
  return { ok: true, thread }
}
