import type { MemoryStore } from "@dawn-ai/memory"
// The reconcile helper comes from the pure "./reconcile" subpath, never the
// barrel: the barrel re-exports sqliteMemoryStore and so reaches node:sqlite.
import { approveWithReconcile } from "@dawn-ai/memory/reconcile"
import { formatErrorMessage } from "../output.js"
import { createExecutionErrorBody, createRequestErrorBody } from "./server-errors.js"

/** The identity keys used when the route's `memory.ts` cannot be consulted. */
const DEFAULT_IDENTITY_KEYS = ["subject", "predicate"] as const

/**
 * GET /memory/candidates — list every candidate record across all namespaces
 * (empty prefix = all namespaces), for a web UI to review.
 */
export async function handleMemoryListRequest(options: {
  readonly memoryStore: MemoryStore
}): Promise<Response> {
  const { memoryStore } = options
  const candidates = await memoryStore.listCandidates("")
  return Response.json({ candidates }, { status: 200 })
}

/**
 * POST /memory/candidates/:id/approve — approve a candidate with the same
 * supersede-aware reconciliation as `runApprove` in `commands/memory.ts`:
 * 404 if the record is missing, 409 if it isn't currently a candidate, else
 * `approveWithReconcile` classifies it against active records with the same
 * identity key — a contradicting active row is superseded, an identical one
 * dedupes the candidate. The response keeps the original `{ record }` shape
 * and adds `action` ("activated" | "superseded" | "deduped") and the
 * `superseded` records.
 */
export async function handleMemoryApproveRequest(options: {
  readonly appRoot: string
  readonly memoryStore: MemoryStore
  readonly id: string
  /**
   * Injected because resolving a route's declared `identity` reads its
   * `memory.ts` from disk. Absent (edge runtimes, which have none), the
   * default semantic identity is used — the same keys `resolveIdentityKeys`
   * itself falls back to when the route cannot be resolved.
   */
  readonly resolveIdentityKeys?: (
    appRoot: string,
    namespace: string,
  ) => Promise<{ readonly keys: readonly string[]; readonly fallback: boolean }>
}): Promise<Response> {
  const { appRoot, memoryStore, id } = options
  const record = await memoryStore.get(id)
  if (!record) {
    return Response.json(createRequestErrorBody(`Record not found: ${id}`), { status: 404 })
  }
  if (record.status !== "candidate") {
    return Response.json(
      createRequestErrorBody(`Record "${id}" is not a candidate (status: ${record.status})`),
      { status: 409 },
    )
  }
  try {
    const identityKeys = options.resolveIdentityKeys
      ? (await options.resolveIdentityKeys(appRoot, record.namespace)).keys
      : DEFAULT_IDENTITY_KEYS
    const result = await approveWithReconcile(memoryStore, id, {
      identityKeys,
      now: new Date().toISOString(),
    })
    return Response.json(
      { record: result.approved, action: result.action, superseded: result.superseded },
      { status: 200 },
    )
  } catch (cause) {
    // Identity resolution (a broken route memory.ts) or reconciliation racing
    // a concurrent write — surface as JSON rather than a generic 500 page.
    return Response.json(createExecutionErrorBody(`Approve failed: ${formatErrorMessage(cause)}`), {
      status: 500,
    })
  }
}

/**
 * POST /memory/candidates/:id/reject — delete the record outright (mirrors
 * `runReject` in `commands/memory.ts`).
 */
export async function handleMemoryRejectRequest(options: {
  readonly memoryStore: MemoryStore
  readonly id: string
}): Promise<Response> {
  const { memoryStore, id } = options
  await memoryStore.delete(id)
  return Response.json({ ok: true }, { status: 200 })
}
