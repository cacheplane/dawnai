import type { MemoryStore } from "@dawn-ai/memory"
import { createRequestErrorBody } from "./server-errors.js"

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
 * POST /memory/candidates/:id/approve — flip a candidate to active.
 * Mirrors `runApprove` in `commands/memory.ts` exactly: 404 if the record is
 * missing, 409 if it isn't currently a candidate, else update + return the
 * refreshed record.
 */
export async function handleMemoryApproveRequest(options: {
  readonly memoryStore: MemoryStore
  readonly id: string
}): Promise<Response> {
  const { memoryStore, id } = options
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
  await memoryStore.update(id, { status: "active", updatedAt: new Date().toISOString() })
  const updated = await memoryStore.get(id)
  return Response.json({ record: updated }, { status: 200 })
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
