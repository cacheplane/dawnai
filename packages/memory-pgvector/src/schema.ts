import type { PoolClient } from "pg"

/** pgvector index dimension ceilings: plain vector ≤2000, halfvec ≤4000. */
export function vectorColumnDef(dimensions: number): { type: string; ops: string } {
  if (!Number.isInteger(dimensions) || dimensions <= 0)
    throw new Error(`pgvector: dimensions must be a positive integer, got ${dimensions}`)
  if (dimensions <= 2000) return { type: `vector(${dimensions})`, ops: "vector_cosine_ops" }
  if (dimensions <= 4000) return { type: `halfvec(${dimensions})`, ops: "halfvec_cosine_ops" }
  throw new Error(
    `pgvector: ${dimensions} dims exceeds the 4000 halfvec index ceiling; reduce embedding dimensions or use a smaller model`,
  )
}

/**
 * Guard SQL identifiers that are interpolated into DDL (they can't be bound as
 * $1 placeholders in Postgres). `prefix`/`schema` come from the store's own
 * config, not untrusted query input, but a malformed config must not produce
 * broken/injected DDL — so reject anything that isn't a plain identifier.
 */
export function assertIdentifier(name: string, value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value))
    throw new Error(
      `pgvector: ${name} must be a valid SQL identifier (/^[a-z_][a-z0-9_]*$/i), got ${JSON.stringify(value)}`,
    )
}

/** Idempotent schema init. Safe to call repeatedly (IF NOT EXISTS everywhere). */
export async function initSchema(
  client: PoolClient,
  opts: { prefix: string; schema: string; dimensions: number; m: number; efConstruction: number },
): Promise<void> {
  const { prefix, schema, dimensions, m, efConstruction } = opts
  assertIdentifier("prefix", prefix)
  assertIdentifier("schema", schema)
  const t = `${schema}.${prefix}_memories`
  const tk = `${schema}.${prefix}_tokens`
  const { type, ops } = vectorColumnDef(dimensions)
  await client.query("CREATE EXTENSION IF NOT EXISTS vector")
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  await client.query(`CREATE TABLE IF NOT EXISTS ${t} (
    id text PRIMARY KEY, kind text NOT NULL, namespace text NOT NULL, content text NOT NULL,
    data jsonb NOT NULL, source jsonb NOT NULL, confidence real NOT NULL, tags jsonb NOT NULL,
    status text NOT NULL, supersedes jsonb, created_at text NOT NULL, updated_at text NOT NULL,
    effective_at text, expires_at text, embedding ${type}, embedding_model text)`)
  await client.query(`CREATE TABLE IF NOT EXISTS ${tk} (
    memory_id text NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE, token text NOT NULL)`)
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${prefix}_ns_status_updated ON ${t} (namespace, status, updated_at DESC)`,
  )
  await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_tok ON ${tk} (token)`)
  await client.query(`CREATE INDEX IF NOT EXISTS ${prefix}_tok_mem ON ${tk} (memory_id)`)
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${prefix}_hnsw ON ${t} USING hnsw (embedding ${ops}) WITH (m = ${m}, ef_construction = ${efConstruction})`,
  )
}
