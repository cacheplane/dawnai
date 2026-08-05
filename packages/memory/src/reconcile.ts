import type { MemoryKind, MemoryRecord, MemoryStore } from "./types.js"

export type WritePolicy = { readonly mode: "reconcile" } | { readonly mode: "append" }

/** Per-kind write discipline. Semantic facts reconcile (identity match →
 *  update/supersede); episodic events append (a later episode never
 *  contradicts an earlier one). Procedural/reflection are typed but not yet
 *  wired — throwing beats baking in accidental semantics.
 *  Mirrored inline in packages/core/src/capabilities/built-in/memory.ts
 *  remember (core can't import this package) — keep in sync. */
export function writePolicyFor(kind: MemoryKind): WritePolicy {
  switch (kind) {
    case "semantic":
      return { mode: "reconcile" }
    case "episodic":
      return { mode: "append" }
    default:
      throw new Error(`memory kind '${kind}' is not yet wired (semantic and episodic are)`)
  }
}

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

/** Upper bound on active rows scanned for an identity match during approval.
 *  Namespaces beyond this size would silently skip reconciliation for the
 *  overflow rows — accepted trade-off: real namespaces are orders of magnitude
 *  smaller, and an unbounded scan risks pathological reads. */
const ACTIVE_SCAN_LIMIT = 10_000

export interface ApproveResult {
  readonly approved: MemoryRecord
  readonly action: "activated" | "superseded" | "deduped"
  readonly superseded: readonly MemoryRecord[]
  readonly identityKeys: readonly string[]
}

/**
 * Approve a candidate WITH supersede reconciliation (fixes the two-actives bug):
 * same identity + different data → the old active row is superseded; same
 * identity + identical data → the candidate is dropped (dedupe); no identity
 * match → plain activation. Used by `dawn memory approve` and the inspector —
 * the capability's auto-write path keeps its own inline logic by design.
 * Append-kind candidates (per writePolicyFor, e.g. episodic) bypass
 * reconciliation entirely — approval is a plain activation, no identity scan.
 *
 * NOT transactional: MemoryStore has no CAS primitive, so the read-classify-
 * write sequence can race a concurrent same-identity auto-write. Worst case is
 * the pre-existing two-actives state, which self-heals on the next auto-write
 * or approval of that identity.
 */
export async function approveWithReconcile(
  store: MemoryStore,
  id: string,
  opts: { readonly identityKeys: readonly string[]; readonly now: string },
): Promise<ApproveResult> {
  const candidate = await store.get(id)
  if (!candidate) throw new Error(`memory ${id} not found`)
  if (candidate.status !== "candidate")
    throw new Error(`memory ${id} is '${candidate.status}', not a candidate`)
  if (writePolicyFor(candidate.kind).mode === "append") {
    // Append-only kinds: approval is a plain activation — no identity scan.
    await store.update(id, { status: "active", updatedAt: opts.now })
    const approved = await store.get(id)
    if (!approved) throw new Error(`approved memory ${id} vanished`)
    return { approved, action: "activated", superseded: [], identityKeys: opts.identityKeys }
  }
  const actives = await store.search({
    namespace: candidate.namespace,
    status: "active",
    kind: candidate.kind,
    limit: ACTIVE_SCAN_LIMIT,
  })
  const op = classifyWrite(candidate, actives, opts.identityKeys)
  if (op.op === "update") {
    const existing = actives.find((r) => r.id === op.targetId)
    if (!existing) throw new Error(`reconcile target ${op.targetId} vanished`)
    // Deliberately does NOT refresh the surviving record (unlike the auto
    // path's idempotent-update): approving a duplicate shouldn't reorder recency.
    await store.delete(id)
    return {
      approved: existing,
      action: "deduped",
      superseded: [],
      identityKeys: opts.identityKeys,
    }
  }
  if (op.op === "supersede") {
    const target = actives.find((r) => r.id === op.targetId)
    if (!target) throw new Error(`reconcile target ${op.targetId} vanished`)
    // Activate first, then demote — same order as the capability's auto path
    // (put active record → store.supersede). store.supersede also appends the
    // demoted id to this record's `supersedes` via a Set (both sqlite and
    // pgvector), so the explicit link here cannot double-append.
    await store.update(id, {
      status: "active",
      updatedAt: opts.now,
      supersedes: [...(candidate.supersedes ?? []), target.id],
    })
    await store.supersede(target.id, id)
    const approved = await store.get(id)
    if (!approved) throw new Error(`approved memory ${id} vanished`)
    return { approved, action: "superseded", superseded: [target], identityKeys: opts.identityKeys }
  }
  await store.update(id, { status: "active", updatedAt: opts.now })
  const approved = await store.get(id)
  if (!approved) throw new Error(`approved memory ${id} vanished`)
  return { approved, action: "activated", superseded: [], identityKeys: opts.identityKeys }
}
