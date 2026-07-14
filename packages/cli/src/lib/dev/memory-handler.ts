import type { ServerResponse } from "node:http"
import type { MemoryStore } from "@dawn-ai/memory"
import { createRequestErrorBody } from "./server-errors.js"

// Local copy of runtime-server.ts's `sendJson` helper — kept private to each
// module (like agui-handler.ts does) to avoid a circular import between
// runtime-server.ts (which wires this handler into the route table) and this
// file.
function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}

/**
 * GET /memory/candidates — list every candidate record across all namespaces
 * (empty prefix = all namespaces), for a web UI to review.
 */
export async function handleMemoryListRequest(options: {
  readonly memoryStore: MemoryStore
  readonly response: ServerResponse
}): Promise<void> {
  const { memoryStore, response } = options
  const candidates = await memoryStore.listCandidates("")
  sendJson(response, 200, { candidates })
}

/**
 * POST /memory/candidates/:id/approve — flip a candidate to active.
 * Mirrors `runApprove` in `commands/memory.ts` exactly: 404 if the record is
 * missing, 409 if it isn't currently a candidate, else update + return the
 * refreshed record.
 */
export async function handleMemoryApproveRequest(options: {
  readonly memoryStore: MemoryStore
  readonly response: ServerResponse
  readonly id: string
}): Promise<void> {
  const { memoryStore, response, id } = options
  const record = await memoryStore.get(id)
  if (!record) {
    sendJson(response, 404, createRequestErrorBody(`Record not found: ${id}`))
    return
  }
  if (record.status !== "candidate") {
    sendJson(
      response,
      409,
      createRequestErrorBody(`Record "${id}" is not a candidate (status: ${record.status})`),
    )
    return
  }
  await memoryStore.update(id, { status: "active", updatedAt: new Date().toISOString() })
  const updated = await memoryStore.get(id)
  sendJson(response, 200, { record: updated })
}

/**
 * POST /memory/candidates/:id/reject — delete the record outright (mirrors
 * `runReject` in `commands/memory.ts`).
 */
export async function handleMemoryRejectRequest(options: {
  readonly memoryStore: MemoryStore
  readonly response: ServerResponse
  readonly id: string
}): Promise<void> {
  const { memoryStore, response, id } = options
  await memoryStore.delete(id)
  sendJson(response, 200, { ok: true })
}
