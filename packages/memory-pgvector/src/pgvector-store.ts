import {
  DEFAULT_CANDIDATE_POOL,
  DEFAULT_VECTOR_K,
  fuseHybrid,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryStore,
  type RecallRankingOptions,
  rankKeywordCandidates,
  tokenize,
  type VectorRankingOptions,
} from "@dawn-ai/memory"
import { Pool, type PoolClient } from "pg"
import pgvector from "pgvector/pg"
import { pageAndTagFilter, rowToRecord, tokensFor } from "./queries.js"
import { assertIdentifier, initSchema } from "./schema.js"

// Default HNSW build/search parameters (pgvector defaults; overridable per store).
const DEFAULT_M = 16
const DEFAULT_EF_CONSTRUCTION = 64
const DEFAULT_EF_SEARCH = 40

export interface PgvectorMemoryStore extends MemoryStore {
  /** Close the underlying pool. No-op if an external pool was injected. */
  close(): Promise<void>
}

export function pgvectorMemoryStore(opts: {
  /** Postgres connection string; used to build an owned pool. */
  connectionString?: string
  /** An existing pool to use instead of building one from `connectionString`. */
  pool?: Pool
  /** Embedding dimensions (≤2000 → `vector`, ≤4000 → `halfvec`). */
  dimensions: number
  /** HNSW index/search tuning; all fields defaulted. */
  index?: { m?: number; efConstruction?: number; efSearch?: number }
  /** Postgres schema to place tables in. */
  schema?: string
  /** Table name prefix (isolates multiple stores in one database). */
  tablePrefix?: string
  /** Recall ranking tuning; all fields defaulted. See @dawn-ai/memory score.ts. */
  recall?: RecallRankingOptions
  /** Store-level hybrid tuning; used when a query omits `vector`. All fields defaulted. */
  vector?: VectorRankingOptions
}): PgvectorMemoryStore {
  const schema = opts.schema ?? "public"
  const prefix = opts.tablePrefix ?? "dawn_memory"
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  const m = opts.index?.m ?? DEFAULT_M
  const efConstruction = opts.index?.efConstruction ?? DEFAULT_EF_CONSTRUCTION
  const efSearch = opts.index?.efSearch ?? DEFAULT_EF_SEARCH

  // Fully-qualified table identifiers (both parts validated above).
  const T = `${schema}.${prefix}_memories`
  const TK = `${schema}.${prefix}_tokens`

  const ownsPool = !opts.pool
  const pool =
    opts.pool ?? new Pool(opts.connectionString ? { connectionString: opts.connectionString } : {})

  // Memoized idempotent schema init. Every method awaits ready() first so the
  // first call to touch the store creates the extension/tables/indexes exactly
  // once; concurrent callers share the single in-flight promise.
  let initP: Promise<void> | undefined
  function ready(): Promise<void> {
    initP ??= (async () => {
      const c = await pool.connect()
      try {
        await initSchema(c, { prefix, schema, dimensions: opts.dimensions, m, efConstruction })
        // Register pgvector type parsers on this connection (needs the extension
        // to exist, which initSchema just guaranteed). New pool connections get
        // registration via the "connect" handler below.
        await pgvector.registerTypes(c)
      } finally {
        c.release()
      }
    })()
    return initP
  }

  // Register vector type parsers on every future pooled connection. Safe once the
  // extension exists; the very first connection is registered inside ready().
  pool.on("connect", (c) => {
    pgvector.registerTypes(c).catch(() => {
      // Extension not yet present on a brand-new database — ready() registers the
      // first connection explicitly, so ignore the race here.
    })
  })

  // -------------------------------------------------------------------------
  // Row-level helpers
  // -------------------------------------------------------------------------

  async function getById(id: string): Promise<MemoryRecord | null> {
    const res = await pool.query(`SELECT * FROM ${T} WHERE id = $1`, [id])
    const row = res.rows[0] as Record<string, unknown> | undefined
    return row ? rowToRecord(row) : null
  }

  async function reindex(client: PoolClient, rec: MemoryRecord): Promise<void> {
    await client.query(`DELETE FROM ${TK} WHERE memory_id = $1`, [rec.id])
    for (const t of tokensFor(rec)) {
      await client.query(`INSERT INTO ${TK} (memory_id, token) VALUES ($1, $2)`, [rec.id, t])
    }
  }

  async function putRecord(
    rec: MemoryRecord,
    embed?: { embedding?: Float32Array; embeddingModel?: string },
  ): Promise<void> {
    const hasEmbedding = Boolean(embed?.embedding && embed.embeddingModel)
    const vec = hasEmbedding ? pgvector.toSql(Array.from(embed?.embedding ?? [])) : null
    const model = hasEmbedding ? (embed?.embeddingModel ?? null) : null
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `INSERT INTO ${T}
          (id,kind,namespace,content,data,source,confidence,tags,status,supersedes,created_at,updated_at,effective_at,expires_at,embedding,embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind, namespace = EXCLUDED.namespace, content = EXCLUDED.content,
           data = EXCLUDED.data, source = EXCLUDED.source, confidence = EXCLUDED.confidence,
           tags = EXCLUDED.tags, status = EXCLUDED.status, supersedes = EXCLUDED.supersedes,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           effective_at = EXCLUDED.effective_at, expires_at = EXCLUDED.expires_at,
           embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model`,
        [
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
          vec,
          model,
        ],
      )
      await reindex(client, rec)
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  // Re-read a row's persisted embedding so update() does not drop it (putRecord
  // rewrites the full row; without this the embedding columns would go null).
  // Returns the raw pgvector-serialized string for the embedding column so we can
  // re-INSERT it verbatim without a Float32Array round-trip.
  async function getEmbeddingRow(
    id: string,
  ): Promise<{ embedding?: Float32Array; embeddingModel?: string }> {
    const res = await pool.query(
      `SELECT embedding::text AS embedding, embedding_model FROM ${T} WHERE id = $1`,
      [id],
    )
    const row = res.rows[0] as { embedding?: string; embedding_model?: string } | undefined
    if (row?.embedding && row.embedding_model) {
      // `embedding::text` is a pgvector literal like "[1,0,0]"; parse to floats.
      const floats = row.embedding
        .slice(1, -1)
        .split(",")
        .filter((s) => s.length > 0)
        .map(Number)
      return { embedding: Float32Array.from(floats), embeddingModel: row.embedding_model }
    }
    return {}
  }

  // -------------------------------------------------------------------------
  // Keyword ranking — candidate pool + live corpus stats → shared pure core.
  // -------------------------------------------------------------------------

  async function rankKeyword(
    q: MemoryQuery,
    baseSql: string,
    baseParams: unknown[],
    terms: string[],
    weightsOverride?: RecallRankingOptions["weights"],
  ): Promise<MemoryRecord[]> {
    const rawPool = opts.recall?.candidatePool
    const pool_ =
      typeof rawPool === "number" && Number.isFinite(rawPool) && rawPool > 0
        ? Math.floor(rawPool)
        : DEFAULT_CANDIDATE_POOL

    const n = baseParams.length
    const termPlaceholders = terms.map((_, i) => `$${n + 1 + i}`).join(",")

    // 1) Candidate pool: rows matching ≥1 query token, newest first.
    const candidateRes = await pool.query(
      `SELECT m.* FROM ${T} m WHERE ${baseSql}
         AND m.id IN (SELECT memory_id FROM ${TK} WHERE token IN (${termPlaceholders}))
         ORDER BY m.updated_at DESC, m.id ASC LIMIT $${n + 1 + terms.length}`,
      [...baseParams, ...terms, pool_],
    )
    const candidates = (candidateRes.rows as Record<string, unknown>[]).map(rowToRecord)
    if (candidates.length === 0) return []

    // 2) Corpus stats, computed live (nothing cached → nothing to go stale).
    const corpusRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${T} m WHERE ${baseSql}`,
      baseParams,
    )
    const corpusSize = (corpusRes.rows[0] as { n: number }).n

    const dfRes = await pool.query(
      `SELECT t.token AS token, COUNT(DISTINCT t.memory_id)::int AS df
         FROM ${TK} t JOIN ${T} m ON m.id = t.memory_id
         WHERE ${baseSql} AND t.token IN (${termPlaceholders}) GROUP BY t.token`,
      [...baseParams, ...terms],
    )
    const dfByToken = new Map(
      (dfRes.rows as { token: string; df: number }[]).map((r) => [r.token, r.df]),
    )

    // 3) Score + sort via the shared pure ranking core.
    const options: RecallRankingOptions | undefined =
      weightsOverride || opts.recall
        ? { ...opts.recall, ...(weightsOverride ? { weights: weightsOverride } : {}) }
        : undefined
    return rankKeywordCandidates(candidates, dfByToken, corpusSize, terms, q.now, options, tokenize)
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  return {
    async put(rec, putOpts) {
      await ready()
      await putRecord(rec, putOpts)
    },

    async get(id) {
      await ready()
      return getById(id)
    },

    async search(q: MemoryQuery) {
      await ready()
      const status = q.status ?? "active"
      const limit = q.limit ?? 8
      const terms = q.query ? tokenize(q.query) : []

      // Shared base filter (namespace + status [+ kind]) — the "corpus".
      let baseSql = "m.namespace = $1 AND m.status = $2"
      const baseParams: unknown[] = [q.namespace, status]
      if (q.kind) {
        baseParams.push(q.kind)
        baseSql += ` AND m.kind = $${baseParams.length}`
      }

      if (terms.length === 0) {
        // Query-less path: pure recency order (index-fragment behavior).
        const res = await pool.query(
          `SELECT m.* FROM ${T} m WHERE ${baseSql} ORDER BY m.updated_at DESC, m.id ASC LIMIT $${baseParams.length + 1}`,
          [...baseParams, limit],
        )
        let records = (res.rows as Record<string, unknown>[]).map(rowToRecord)
        if (q.tags && q.tags.length > 0) {
          const want = new Set(q.tags)
          records = records.filter((r) => r.tags.some((t) => want.has(t)))
        }
        return records
      }

      // Hybrid path — active only when the caller supplies a query embedding.
      if (q.queryEmbedding && q.embedderId) {
        const v = q.vector ?? opts.vector ?? {}
        const vectorK =
          typeof v.vectorK === "number" && Number.isFinite(v.vectorK) && v.vectorK > 0
            ? Math.floor(v.vectorK)
            : DEFAULT_VECTOR_K

        // Keyword-ranked records: reuse the ranked pool, ordered by relevance ONLY.
        const kwRecords = await rankKeyword(q, baseSql, baseParams, terms, {
          relevance: 1,
          recency: 0,
          confidence: 0,
        })

        // Vector-ranked records: pgvector HNSW top-K by cosine distance (<=>),
        // filtered to the matching embedder tag with a non-null embedding. Run in
        // a transaction so SET LOCAL hnsw.ef_search applies to just this query.
        const queryVec = pgvector.toSql(Array.from(q.queryEmbedding))
        const client = await pool.connect()
        let vectorRanked: MemoryRecord[]
        try {
          await client.query("BEGIN")
          await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`)
          const modelIdx = baseParams.length + 1
          const vecIdx = baseParams.length + 2
          const kIdx = baseParams.length + 3
          const vecRes = await client.query(
            `SELECT m.* FROM ${T} m
               WHERE ${baseSql} AND m.embedding_model = $${modelIdx} AND m.embedding IS NOT NULL
               ORDER BY m.embedding <=> $${vecIdx} LIMIT $${kIdx}`,
            [...baseParams, q.embedderId, queryVec, vectorK],
          )
          await client.query("COMMIT")
          vectorRanked = (vecRes.rows as Record<string, unknown>[]).map(rowToRecord)
        } catch (err) {
          await client.query("ROLLBACK")
          throw err
        } finally {
          client.release()
        }

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
          q.tags,
        )
      }

      // Ranked path — keyword-only recall.
      return pageAndTagFilter(await rankKeyword(q, baseSql, baseParams, terms), limit, q.tags)
    },

    async update(id, patch) {
      await ready()
      const current = await getById(id)
      if (!current) throw new Error(`memory not found: ${id}`)
      const embed = await getEmbeddingRow(id)
      await putRecord({ ...current, ...patch, id }, embed)
    },

    async supersede(id, bySupersedingId) {
      await ready()
      if (!(await getById(id))) throw new Error(`memory not found: ${id}`)
      await pool.query(`UPDATE ${T} SET status = 'superseded' WHERE id = $1`, [id])
      const superseding = await getById(bySupersedingId)
      if (superseding) {
        const links = new Set([...(superseding.supersedes ?? []), id])
        await pool.query(`UPDATE ${T} SET supersedes = $1 WHERE id = $2`, [
          JSON.stringify([...links]),
          bySupersedingId,
        ])
      }
    },

    async delete(id) {
      await ready()
      await pool.query(`DELETE FROM ${T} WHERE id = $1`, [id])
    },

    async listCandidates(namespacePrefix) {
      await ready()
      const res = await pool.query(
        `SELECT * FROM ${T} WHERE status = 'candidate' AND namespace LIKE $1 ORDER BY created_at DESC`,
        [`${namespacePrefix}%`],
      )
      return (res.rows as Record<string, unknown>[]).map(rowToRecord)
    },

    async close() {
      if (ownsPool) await pool.end()
    },
  }
}
