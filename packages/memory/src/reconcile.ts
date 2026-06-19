import type { MemoryRecord } from "./types.js"
export type WriteOp =
  | { op: "add" }
  | { op: "update"; targetId: string }
  | { op: "supersede"; targetId: string }
function identityOf(data: Record<string, unknown>, keys: readonly string[]): string {
  return keys.map((k) => JSON.stringify(data[k] ?? null)).join(" ")
}
/** Deterministic write classification (no LLM): ADD if no identity match; UPDATE if identity+data equal; SUPERSEDE if identity matches but data differs. */
export function classifyWrite(
  incoming: MemoryRecord,
  candidates: readonly MemoryRecord[],
  identityKeys: readonly string[],
): WriteOp {
  const incomingId = identityOf(incoming.data, identityKeys)
  const match = candidates.find((c) => identityOf(c.data, identityKeys) === incomingId)
  if (!match) return { op: "add" }
  const same = JSON.stringify(match.data) === JSON.stringify(incoming.data)
  return same ? { op: "update", targetId: match.id } : { op: "supersede", targetId: match.id }
}
