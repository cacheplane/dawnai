import type { MemoryRecord } from "@dawn-ai/memory"
import { tokenize } from "@dawn-ai/memory"

// ---------------------------------------------------------------------------
// Column selection
// ---------------------------------------------------------------------------

// The exact 14 columns rowToRecord reads — deliberately EXCLUDES `embedding`
// (1536/3072-dim) and `embedding_model`. rowToRecord never touches those, so a
// bare `SELECT *`/`SELECT m.*` would transfer + deserialize the full vector on
// every record read (candidate pools of 256, query-less lists, hybrid lookups)
// for nothing. Callers that need the embedding read it separately via
// getEmbeddingRow's `SELECT embedding::text`.
const RECORD_COLUMN_NAMES = [
  "id",
  "kind",
  "namespace",
  "content",
  "data",
  "source",
  "confidence",
  "tags",
  "status",
  "supersedes",
  "created_at",
  "updated_at",
  "effective_at",
  "expires_at",
] as const

/** Comma-separated record columns (unqualified), e.g. `SELECT ${RECORD_COLUMNS} FROM ...`. */
export const RECORD_COLUMNS = RECORD_COLUMN_NAMES.join(", ")

/** Record columns qualified with a table alias, e.g. `SELECT ${recordColumns("m")} FROM ... m`. */
export function recordColumns(alias: string): string {
  return RECORD_COLUMN_NAMES.map((c) => `${alias}.${c}`).join(", ")
}

// ---------------------------------------------------------------------------
// Row ↔ record conversion
// ---------------------------------------------------------------------------

// pg auto-parses `jsonb` columns to JS values, so `data`/`source`/`tags`/
// `supersedes` arrive already-deserialized — do NOT JSON.parse them again (the
// sqlite backend stores them as TEXT and must parse; here that would throw).
export function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    kind: row.kind as MemoryRecord["kind"],
    namespace: row.namespace as string,
    content: row.content as string,
    data: row.data as Record<string, unknown>,
    source: row.source as MemoryRecord["source"],
    confidence: row.confidence as number,
    tags: row.tags as string[],
    status: row.status as MemoryRecord["status"],
    ...(row.supersedes ? { supersedes: row.supersedes as string[] } : {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...(row.effective_at ? { effectiveAt: row.effective_at as string } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}),
  }
}

// Codepoint compare — matches the sqlite backend's BINARY-collation ordering,
// independent of Postgres's locale-sensitive collation (id ASC tiebreaks are
// applied in JS, so ordering is byte-identical across backends).
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function tokensFor(rec: MemoryRecord): string[] {
  const values = Object.values(rec.data).filter((v) => typeof v === "string") as string[]
  return tokenize([rec.content, rec.tags.join(" "), values.join(" ")].join(" "))
}

// Page (limit) then tag post-filter — mirrors the sqlite backend's ranked-path
// semantics exactly.
export function pageAndTagFilter(
  records: readonly MemoryRecord[],
  limit: number,
  tags: readonly string[] | undefined,
): MemoryRecord[] {
  let out = records.slice(0, limit)
  if (tags && tags.length > 0) {
    const want = new Set(tags)
    out = out.filter((r) => r.tags.some((t) => want.has(t)))
  }
  return out
}
