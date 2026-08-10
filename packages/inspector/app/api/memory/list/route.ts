import type { BrowseQuery } from "@dawn-ai/memory/browse"
import { isBrowseQueryError, parseBrowseQuery } from "../../../../src/store/browse-params"
import { assertLocalRequest } from "../../../../src/store/guard"
import { storeOr500 } from "../../../../src/store/resolve"

export const dynamic = "force-dynamic"

/**
 * Browse the memory store.
 *
 * Every parameter is decoded and validated by the SHARED validator in
 * `@dawn-ai/memory/browse` — the same one the stores run defensively — so the HTTP
 * contract cannot drift from the store contract. `filters` and `orderBy` are
 * JSON-encoded; `cursor` is opaque. Note the import is the PURE `/browse` subpath:
 * a bare "@dawn-ai/memory" import here would drag node:sqlite into the Next bundle
 * (see src/store/runtime-imports.ts).
 *
 * A 400 body carries `code` beside `error`. Clients match on the code: the prose is the
 * only part that varies across the several ways one continuation can be wrong.
 */
export async function GET(req: Request): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const sp = new URL(req.url).searchParams
  let query: BrowseQuery
  try {
    // Only a DEFAULT, and one that cannot walk: `now` is part of the cursor fingerprint,
    // so a caller paging through continuations pins its own.
    query = parseBrowseQuery(sp, { now: new Date().toISOString() })
  } catch (error) {
    if (isBrowseQueryError(error))
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    throw error
  }
  const resolved = await storeOr500()
  if (resolved instanceof Response) return resolved
  try {
    return Response.json(await resolved.store.browse(query))
  } catch (error) {
    // A store-side rejection (a stale or forged continuation, most likely) is a bad
    // request, not a server fault.
    if (isBrowseQueryError(error))
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    throw error
  }
}
