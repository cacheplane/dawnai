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
export interface BrowseQuery {
  readonly namespacePrefix?: string
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
}
export interface BrowsePage {
  readonly records: readonly MemoryRecord[]
  readonly total: number
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
