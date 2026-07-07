import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { SQLInputValue } from "node:sqlite"
import { DatabaseSync } from "node:sqlite"
import { fuseHybrid, rankKeywordCandidates } from "./hybrid.js"
import { DEFAULT_CANDIDATE_POOL, type RecallRankingOptions, type RecallWeights } from "./score.js"
import { tokenize } from "./tokenize.js"
import type { MemoryQuery, MemoryRecord, MemoryStore, VectorRankingOptions } from "./types.js"
import { cosineSimilarity, DEFAULT_VECTOR_K } from "./vector.js"

// ---------------------------------------------------------------------------
// Inline DB helpers (mirrors packages/sqlite-storage/src/internal — not
// re-exported from that package's public API, so we replicate the tiny shim).
// ---------------------------------------------------------------------------

function openDb(path: string): DatabaseSync {
  const isMemory = path === ":memory:"
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL")
  }
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA synchronous = NORMAL")
  return db
}

interface Migration {
  readonly version: number
  readonly up: string
}

function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")
  const row = db.prepare("SELECT max(version) AS v FROM schema_version").get() as {
    v: number | null
  }
  const current = row?.v ?? 0
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  for (const m of sorted) {
    if (m.version <= current) continue
    db.exec("BEGIN")
    try {
      db.exec(m.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(m.version)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, namespace TEXT NOT NULL,
        content TEXT NOT NULL, data TEXT NOT NULL, source TEXT NOT NULL,
        confidence REAL NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL,
        supersedes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        effective_at TEXT, expires_at TEXT
      );
      CREATE INDEX idx_mem_ns_status_updated ON memories(namespace, status, updated_at DESC);
      CREATE TABLE memory_tokens (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, token TEXT NOT NULL
      );
      CREATE INDEX idx_memtok_token ON memory_tokens(token);
      CREATE INDEX idx_memtok_mem ON memory_tokens(memory_id);
    `,
  },
  {
    version: 2,
    up: `
      ALTER TABLE memories ADD COLUMN embedding BLOB;
      ALTER TABLE memories ADD COLUMN embedding_model TEXT;
    `,
  },
]

// ---------------------------------------------------------------------------
// Row ↔ record conversion
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    kind: row.kind as MemoryRecord["kind"],
    namespace: row.namespace as string,
    content: row.content as string,
    data: JSON.parse(row.data as string) as Record<string, unknown>,
    source: JSON.parse(row.source as string) as MemoryRecord["source"],
    confidence: row.confidence as number,
    tags: JSON.parse(row.tags as string) as string[],
    status: row.status as MemoryRecord["status"],
    ...(row.supersedes ? { supersedes: JSON.parse(row.supersedes as string) as string[] } : {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...(row.effective_at ? { effectiveAt: row.effective_at as string } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}),
  }
}

// Codepoint compare — matches SQLite BINARY collation, no ICU dependence.
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function tokensFor(rec: MemoryRecord): string[] {
  const values = Object.values(rec.data).filter((v) => typeof v === "string") as string[]
  return tokenize([rec.content, rec.tags.join(" "), values.join(" ")].join(" "))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function sqliteMemoryStore(opts: {
  path: string
  /** Recall ranking tuning; all fields defaulted. See score.ts. */
  recall?: RecallRankingOptions
  /** Store-level hybrid tuning; used when a query omits `vector`. All fields defaulted. */
  vector?: VectorRankingOptions
}): MemoryStore {
  const db = openDb(opts.path)
  runMigrations(db, MIGRATIONS)

  function reindex(rec: MemoryRecord): void {
    db.prepare("DELETE FROM memory_tokens WHERE memory_id = ?").run(rec.id)
    const ins = db.prepare("INSERT INTO memory_tokens(memory_id, token) VALUES (?, ?)")
    for (const t of tokensFor(rec)) ins.run(rec.id, t)
  }

  function getById(id: string): MemoryRecord | null {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : null
  }

  function putRecord(
    rec: MemoryRecord,
    embed?: { embedding?: Float32Array; embeddingModel?: string },
  ): void {
    const blob =
      embed?.embedding && embed.embeddingModel
        ? Buffer.from(
            embed.embedding.buffer.slice(
              embed.embedding.byteOffset,
              embed.embedding.byteOffset + embed.embedding.byteLength,
            ),
          )
        : null
    const model = embed?.embedding && embed.embeddingModel ? embed.embeddingModel : null
    db.prepare(
      `INSERT OR REPLACE INTO memories
       (id,kind,namespace,content,data,source,confidence,tags,status,supersedes,created_at,updated_at,effective_at,expires_at,embedding,embedding_model)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      rec.id,
      rec.kind,
      rec.namespace,
      rec.content,
      JSON.stringify(rec.data),
      JSON.stringify(rec.source),
      rec.confidence,
      JSON.stringify(rec.tags),
      rec.status,
      rec.supersedes ? JSON.stringify(rec.supersedes) : null,
      rec.createdAt,
      rec.updatedAt,
      rec.effectiveAt ?? null,
      rec.expiresAt ?? null,
      blob,
      model,
    )
    reindex(rec)
  }

  // Re-read a row's persisted embedding so update() does not drop it (putRecord
  // rewrites the full row; without this the embedding columns would go null).
  function getEmbeddingRow(id: string): { embedding?: Float32Array; embeddingModel?: string } {
    const row = db
      .prepare("SELECT embedding, embedding_model FROM memories WHERE id = ?")
      .get(id) as { embedding?: Uint8Array; embedding_model?: string } | undefined
    if (row?.embedding && row.embedding_model) {
      return {
        embedding: new Float32Array(
          row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.embedding.byteLength,
          ),
        ),
        embeddingModel: row.embedding_model,
      }
    }
    return {}
  }

  // Keyword-ranked list: candidate pool → live corpus stats → scoreMemory →
  // stable sort (score DESC, updated_at DESC, id ASC). Returns the FULL sorted
  // list (caller pages + tag-filters). `weightsOverride` lets the hybrid path
  // rank by relevance ONLY; when absent the default recall weights apply — this
  // is the exact behavior the shipped smarter-recall path exercises.
  function rankKeyword(
    q: MemoryQuery,
    baseSql: string,
    baseParams: SQLInputValue[],
    terms: string[],
    weightsOverride?: RecallWeights,
  ): MemoryRecord[] {
    const rawPool = opts.recall?.candidatePool
    const pool =
      typeof rawPool === "number" && Number.isFinite(rawPool) && rawPool > 0
        ? Math.floor(rawPool)
        : DEFAULT_CANDIDATE_POOL
    const placeholders = terms.map(() => "?").join(",")

    // 1) Candidate pool: rows matching ≥1 query token, newest first (pool
    //    truncation by recency is deterministic).
    const candidateRows = db
      .prepare(
        `SELECT m.* FROM memories m WHERE ${baseSql}
         AND m.id IN (SELECT memory_id FROM memory_tokens WHERE token IN (${placeholders}))
         ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
      )
      .all(...baseParams, ...terms, pool) as Record<string, unknown>[]
    const candidates = candidateRows.map(rowToRecord)
    if (candidates.length === 0) return []

    // 2) Corpus stats, computed live (nothing cached → nothing to go stale).
    const corpusSize = (
      db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${baseSql}`).get(...baseParams) as {
        n: number
      }
    ).n
    const dfRows = db
      .prepare(
        `SELECT t.token AS token, COUNT(DISTINCT t.memory_id) AS df
         FROM memory_tokens t JOIN memories m ON m.id = t.memory_id
         WHERE ${baseSql} AND t.token IN (${placeholders}) GROUP BY t.token`,
      )
      .all(...baseParams, ...terms) as { token: string; df: number }[]
    const dfByToken = new Map(dfRows.map((r) => [r.token, r.df]))

    // 3) Score + sort via the shared pure ranking core. Candidate token sets are
    //    recomputed via the same `tokenize` reindex() uses, so they are
    //    guaranteed consistent with the table.
    const options: RecallRankingOptions | undefined =
      weightsOverride || opts.recall
        ? { ...opts.recall, ...(weightsOverride ? { weights: weightsOverride } : {}) }
        : undefined
    return rankKeywordCandidates(candidates, dfByToken, corpusSize, terms, q.now, options, tokenize)
  }

  // Page (limit) then tag post-filter — today's ranked-path semantics, unchanged.
  function pageAndTagFilter(
    records: MemoryRecord[],
    limit: number,
    q: MemoryQuery,
  ): MemoryRecord[] {
    let out = records.slice(0, limit)
    if (q.tags && q.tags.length > 0) {
      const want = new Set(q.tags)
      out = out.filter((r) => r.tags.some((t) => want.has(t)))
    }
    return out
  }

  return {
    async put(rec, opts) {
      putRecord(rec, opts)
    },
    async get(id) {
      return getById(id)
    },
    async search(q: MemoryQuery) {
      const status = q.status ?? "active"
      const limit = q.limit ?? 8
      const terms = q.query ? tokenize(q.query) : []

      // Shared base filter (namespace + status [+ kind]) — the "corpus".
      let baseSql = `m.namespace = ? AND m.status = ?`
      const baseParams: SQLInputValue[] = [q.namespace, status]
      if (q.kind) {
        baseSql += ` AND m.kind = ?`
        baseParams.push(q.kind)
      }

      if (terms.length === 0) {
        // Query-less path: EXACTLY the pre-ranking behavior (index fragment,
        // listCandidates-adjacent consumers depend on pure recency order).
        const rows = db
          .prepare(
            `SELECT m.* FROM memories m WHERE ${baseSql} ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
          )
          .all(...baseParams, limit) as Record<string, unknown>[]
        let records = rows.map(rowToRecord)
        if (q.tags && q.tags.length > 0) {
          const want = new Set(q.tags)
          records = records.filter((r) => r.tags.some((t) => want.has(t)))
        }
        return records
      }

      // Hybrid path — active only when the caller supplies a query embedding.
      // Keyword ∪ vector-nearest, RRF-fused, then a bounded recency/confidence
      // multiplier. See docs/superpowers/specs/2026-07-06-vector-recall-design.md.
      if (q.queryEmbedding && q.embedderId) {
        const v = q.vector ?? opts.vector ?? {}
        const vectorK =
          typeof v.vectorK === "number" && Number.isFinite(v.vectorK) && v.vectorK > 0
            ? Math.floor(v.vectorK)
            : DEFAULT_VECTOR_K

        // Keyword-ranked records: reuse the ranked pool, ordered by relevance ONLY.
        const kwRecords = rankKeyword(q, baseSql, baseParams, terms, {
          relevance: 1,
          recency: 0,
          confidence: 0,
        })

        // Vector-ranked records: brute-force cosine over rows with a matching
        // embedder tag and a non-null embedding, cosine-sorted then sliced to K.
        const vecRows = db
          .prepare(
            `SELECT m.id AS id, m.embedding AS embedding FROM memories m
             WHERE ${baseSql} AND m.embedding_model = ? AND m.embedding IS NOT NULL`,
          )
          .all(...baseParams, q.embedderId) as { id: string; embedding: Uint8Array }[]
        const queryEmbedding = q.queryEmbedding
        const vectorRanked = vecRows
          .map((r) => {
            const emb = new Float32Array(
              r.embedding.buffer.slice(
                r.embedding.byteOffset,
                r.embedding.byteOffset + r.embedding.byteLength,
              ),
            )
            return { id: r.id, sim: cosineSimilarity(queryEmbedding, emb) }
          })
          .sort((a, b) => b.sim - a.sim || cmp(a.id, b.id))
          .slice(0, vectorK)
          .map((r) => getById(r.id))
          .filter((r): r is MemoryRecord => r !== null)

        // One half-life knob: fall back to the shared recall tuning so a
        // configured recall.recencyHalfLifeMs governs hybrid recency too.
        const recencyHalfLifeMs = v.recencyHalfLifeMs ?? opts.recall?.recencyHalfLifeMs
        return pageAndTagFilter(
          fuseHybrid({
            keywordRanked: kwRecords,
            vectorRanked,
            now: q.now,
            options: {
              ...v,
              ...(recencyHalfLifeMs !== undefined ? { recencyHalfLifeMs } : {}),
            },
          }),
          limit,
          q,
        )
      }

      // Ranked path — see docs/superpowers/specs/2026-07-05-smarter-recall-design.md.
      return pageAndTagFilter(rankKeyword(q, baseSql, baseParams, terms), limit, q)
    },
    async update(id, patch) {
      const current = getById(id)
      if (!current) throw new Error(`memory not found: ${id}`)
      putRecord({ ...current, ...patch, id }, getEmbeddingRow(id))
    },
    async supersede(id, bySupersedingId) {
      if (!getById(id)) throw new Error(`memory not found: ${id}`)
      db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(id)
      const superseding = getById(bySupersedingId)
      if (superseding) {
        const links = new Set([...(superseding.supersedes ?? []), id])
        db.prepare("UPDATE memories SET supersedes = ? WHERE id = ?").run(
          JSON.stringify([...links]),
          bySupersedingId,
        )
      }
    },
    async delete(id) {
      db.prepare("DELETE FROM memories WHERE id = ?").run(id)
    },
    async listCandidates(namespacePrefix) {
      const rows = db
        .prepare(
          "SELECT * FROM memories WHERE status = 'candidate' AND namespace LIKE ? ORDER BY created_at DESC",
        )
        .all(`${namespacePrefix}%`) as Record<string, unknown>[]
      return rows.map(rowToRecord)
    },
  }
}
