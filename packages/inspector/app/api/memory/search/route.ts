import type { MemoryRecord } from "@dawn-ai/memory"
import { assertLocalRequest } from "../../../../src/store/guard"
import { storeOr500 } from "../../../../src/store/resolve"

export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const sp = new URL(req.url).searchParams
  const q = sp.get("q") ?? ""
  const namespace = sp.get("namespace") ?? ""
  if (!q) return Response.json({ groups: [] })
  const resolved = await storeOr500()
  if (resolved instanceof Response) return resolved
  const { store, embedder } = resolved
  let queryEmbedding: Float32Array | undefined
  let embedderId: string | undefined
  if (embedder) {
    try {
      const [vec] = await embedder.embed([q])
      if (vec) {
        queryEmbedding = vec
        embedderId = embedder.id
      }
    } catch {
      // Embedder outage must not break search — degrade to keyword-only.
    }
  }
  const namespaces = namespace ? [namespace] : Object.keys((await store.stats()).byNamespace)
  const groups: { namespace: string; records: readonly MemoryRecord[] }[] = []
  // One recency snapshot for every namespace — consistent ranking across groups.
  const now = new Date().toISOString()
  for (const ns of namespaces) {
    const records = await store.search({
      namespace: ns,
      query: q,
      status: "active",
      limit: 8,
      now,
      ...(queryEmbedding && embedderId ? { queryEmbedding, embedderId } : {}),
    })
    if (records.length > 0) groups.push({ namespace: ns, records })
  }
  return Response.json({ groups, hybrid: Boolean(queryEmbedding) })
}
