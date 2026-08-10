export type MemoryKind = "semantic" | "episodic" | "procedural" | "reflection"
export type MemoryStatus = "candidate" | "active" | "superseded"
export interface MemorySource {
  readonly type: "run" | "user" | "tool" | "eval" | "human"
  readonly id: string
}
export interface MemoryRecord {
  readonly id: string
  readonly kind: MemoryKind
  readonly namespace: string
  readonly content: string
  readonly data: Record<string, unknown>
  readonly source: MemorySource
  readonly confidence: number
  readonly tags: readonly string[]
  readonly status: MemoryStatus
  readonly supersedes?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly effectiveAt?: string
  readonly expiresAt?: string
}
export interface MemoryQuery {
  readonly namespace: string
  readonly query?: string
  readonly kind?: MemoryKind
  readonly tags?: readonly string[]
  readonly status?: MemoryStatus
  readonly limit?: number
  /** ISO timestamp used as the recency reference for ranked (query) searches.
   *  Optional; when absent, recency is measured relative to the newest
   *  candidate's updatedAt (data-derived — the library never reads a clock).
   *  Also excludes rows with expiresAt <= now. */
  readonly now?: string
  /** ISO lower bound (inclusive) on COALESCE(effectiveAt, createdAt). */
  readonly since?: string
  /** ISO upper bound (exclusive) on COALESCE(effectiveAt, createdAt). */
  readonly until?: string
  /** When present, the store runs the hybrid path: keyword ∪ vector-nearest, RRF-fused. */
  readonly queryEmbedding?: Float32Array
  /** Only rows whose stored embedding_model equals this are vector-compared. */
  readonly embedderId?: string
  /** Hybrid tuning; all fields defaulted. */
  readonly vector?: VectorRankingOptions
}
export interface VectorRankingOptions {
  readonly weights?: { readonly keyword?: number; readonly vector?: number }
  readonly rrfK?: number
  readonly vectorK?: number
  readonly recencyWeight?: number
  readonly confidenceWeight?: number
  readonly recencyHalfLifeMs?: number
}
/** Sortable browse fields. A CLOSED whitelist: these are the only names that ever
 *  reach a SQL identifier position (see browse-order.ts). */
export type BrowseSortField =
  | "updatedAt"
  | "createdAt"
  | "confidence"
  | "namespace"
  | "kind"
  | "status"

export interface BrowseSortEntry {
  readonly field: BrowseSortField
  readonly dir: "asc" | "desc"
}

/** One normalized predicate. AND-combined with the other filters and with the
 *  top-level shorthand fields. At most ONE filter per `field` (mirrors the
 *  one-filter-per-column model of the grid that drives this API), rejected by
 *  `validateBrowseQuery` rather than last-one-wins; within-field multi-value exists
 *  only through `in`/`notIn`. */
export type BrowseFilter =
  // The enum arms are split PER FIELD, not shared as `field: "status" | "kind"` with
  // `values: readonly string[]` — a shared arm compiles
  // `{field: "status", op: "in", values: ["actve"]}`, losing the typo check the
  // `status` shorthand below already gives us for the identical query.
  | {
      readonly field: "status"
      readonly op: "in" | "notIn"
      readonly values: readonly MemoryStatus[]
    }
  | {
      readonly field: "kind"
      readonly op: "in" | "notIn"
      readonly values: readonly MemoryKind[]
    }
  | {
      readonly field: "content"
      readonly op: "contains" | "notContains" | "equals" | "notEquals" | "startsWith" | "endsWith"
      readonly value: string
    }
  | {
      readonly field: "namespace"
      readonly op: "equals" | "startsWith"
      readonly value: string
    }
  | {
      readonly field: "confidence"
      readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
      readonly value: number
    }
  | {
      readonly field: "confidence"
      readonly op: "between"
      readonly min: number
      readonly max: number
    }
  | {
      readonly field: "updatedAt"
      readonly op: "onDay" | "beforeDay" | "afterDay"
      /** "YYYY-MM-DD", interpreted as a UTC day. */
      readonly day: string
    }
  | {
      readonly field: "updatedAt"
      readonly op: "betweenDays"
      /** Inclusive of both UTC days. */
      readonly fromDay: string
      readonly untilDay: string
    }
export interface BrowseQuery {
  readonly namespacePrefix?: string
  /** EXACT namespace. Distinct from `namespacePrefix`: byte-exact, case-sensitive,
   *  no prefix semantics. ANDed with everything else, `namespacePrefix` included. */
  readonly namespace?: string
  /** One status, or a set matching any of them. An EMPTY set matches nothing —
   *  "any of none" is false, and reading it as "unfiltered" would show every
   *  row to a caller that had just narrowed to zero. */
  readonly status?: MemoryStatus | readonly MemoryStatus[]
  /** One kind, or a set matching any of them; empty matches nothing. */
  readonly kind?: MemoryKind | readonly MemoryKind[]
  readonly sourceType?: MemorySource["type"]
  readonly limit?: number
  readonly offset?: number
  /** ISO lower bound (inclusive) on COALESCE(effectiveAt, createdAt). */
  readonly since?: string
  /** ISO upper bound (exclusive) on COALESCE(effectiveAt, createdAt). */
  readonly until?: string
  /** When supplied, rows with expiresAt <= now are excluded (matches search's `now`). */
  readonly now?: string
  /** AND-combined normalized predicates: at most one per `field` and at most 8 in
   *  total, both enforced by `validateBrowseQuery`. Both in-repo stores evaluate
   *  every arm; a field with no clause is REJECTED as a `BrowseQueryError` rather
   *  than ignored. */
  readonly filters?: readonly BrowseFilter[]
  /** Applied in order, always terminated store-side by an `id ASC` tie-break so every
   *  window is deterministic. Absent or empty = `updatedAt DESC`. Both in-repo stores
   *  break that tie on BYTES, so they return the same sequence for tied rows whatever
   *  the database's default collation. */
  readonly orderBy?: readonly BrowseSortEntry[]
  /** Opaque continuation from a prior `BrowsePage`. It belongs to the query that
   *  produced it: the store recomputes the fingerprint and rejects a mismatch with a
   *  `BrowseQueryError` coded `continuation-invalid`. Applied as a keyset window, so
   *  a row inserted above the seam between pages cannot displace one out of the walk
   *  the way an `offset` would.
   *
   *  `now` is part of that fingerprint — it decides which rows are expired — so a
   *  caller walking pages must hold ONE `now` for the whole walk. Re-stamping it per
   *  request (`new Date().toISOString()`) rejects every continuation it is given. */
  readonly cursor?: string
}
export interface BrowsePage {
  readonly records: readonly MemoryRecord[]
  /** Exact count of the whole matching set — NOT of this window, and NOT reduced by
   *  a `cursor`. Rows and total are two separate statements, so a store must read them
   *  inside ONE transaction snapshot: both in-repo stores do, and a store that does not
   *  can hand back a `total` that no version of the table ever agreed with `records` on. */
  readonly total: number
  /** Opaque keyset continuation, or null when this window did not fill `limit`.
   *  Issued whenever the page FILLED rather than over-fetching `limit + 1` to learn
   *  whether a further row exists, so a walk over an exact multiple of `limit`
   *  legitimately ends in one empty window rather than an error. */
  readonly continuation: string | null
}
export interface MemoryStats {
  readonly total: number
  readonly byStatus: Readonly<Record<string, number>>
  readonly byKind: Readonly<Record<string, number>>
  readonly byNamespace: Readonly<Record<string, number>>
  readonly bySourceType: Readonly<Record<string, number>>
}
export interface MemoryStore {
  put(
    rec: MemoryRecord,
    opts?: { readonly embedding?: Float32Array; readonly embeddingModel?: string },
  ): Promise<void>
  get(id: string): Promise<MemoryRecord | null>
  search(q: MemoryQuery): Promise<readonly MemoryRecord[]>
  update(id: string, patch: Partial<MemoryRecord>): Promise<void>
  /** Marks `id` superseded and records the link on `bySupersedingId.supersedes`.
   *  `supersedes` is a SET: re-superseding the same pair is idempotent (no
   *  duplicate link, no error), which is what lets a retried consolidation pass
   *  re-link a batch it already partly linked. Asserted by
   *  `runMemoryStoreConformance`'s "supersede links and demotes episodic records". */
  supersede(id: string, bySupersedingId: string): Promise<void>
  delete(id: string): Promise<void>
  listCandidates(namespacePrefix: string): Promise<readonly MemoryRecord[]>
  /** Cross-namespace/status listing for inspection UIs. Ordered updated_at DESC, id ASC. */
  browse(q?: BrowseQuery): Promise<BrowsePage>
  /** Aggregate counts for facet UIs. */
  stats(opts?: { readonly namespacePrefix?: string }): Promise<MemoryStats>
  /** Delete (a) rows of any kind with expiresAt <= now, and (b) when cap is
   *  set, the oldest episodic rows beyond `cap` per namespace (ordered by
   *  COALESCE(effectiveAt, createdAt), id tiebreak). */
  prune(opts: {
    readonly now: string
    readonly namespacePrefix?: string
    readonly cap?: number
  }): Promise<{ readonly deletedExpired: number; readonly deletedOverCap: number }>
}
