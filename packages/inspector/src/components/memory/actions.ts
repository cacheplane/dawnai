/** The three mutations the Inspector can perform on a memory. */
export type MemoryVerb = "approve" | "reject" | "forget"

export interface MemoryActionResult {
  readonly id: string
  /** Absent when the action succeeded. */
  readonly error?: string
}

/**
 * POST one of the mutation routes and normalise the outcome. The routes answer
 * with `{ error }` on 409/500, so the useful message is in the body rather than
 * the status — callers surface `error` and treat its absence as success.
 */
export async function mutateMemory(id: string, verb: MemoryVerb): Promise<MemoryActionResult> {
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(id)}/${verb}`, { method: "POST" })
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
    if (!res.ok) return { id, error: body?.error ?? `HTTP ${res.status}` }
    return { id }
  } catch (cause) {
    return { id, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Apply `verb` to every id, one at a time. Sequential on purpose: approve
 * reconciles against the other actives in its namespace, so overlapping
 * approvals would race each other into avoidable 409s. These are local-store
 * writes over localhost, and the selection is whatever a human ticked.
 */
export async function mutateMemories(
  ids: readonly string[],
  verb: MemoryVerb,
): Promise<MemoryActionResult[]> {
  const results: MemoryActionResult[] = []
  for (const id of ids) {
    results.push(await mutateMemory(id, verb))
  }
  return results
}
