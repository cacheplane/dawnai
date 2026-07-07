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
   *  candidate's updatedAt (data-derived — the library never reads a clock). */
  readonly now?: string
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
export interface MemoryStore {
  put(
    rec: MemoryRecord,
    opts?: { readonly embedding?: Float32Array; readonly embeddingModel?: string },
  ): Promise<void>
  get(id: string): Promise<MemoryRecord | null>
  search(q: MemoryQuery): Promise<readonly MemoryRecord[]>
  update(id: string, patch: Partial<MemoryRecord>): Promise<void>
  supersede(id: string, bySupersedingId: string): Promise<void>
  delete(id: string): Promise<void>
  listCandidates(namespacePrefix: string): Promise<readonly MemoryRecord[]>
}
