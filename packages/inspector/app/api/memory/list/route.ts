import type { MemoryKind, MemorySource, MemoryStatus } from "@dawn-ai/memory"
import { assertLocalRequest } from "../../../../src/store/guard"
import { storeOr500 } from "../../../../src/store/resolve"

export const dynamic = "force-dynamic"

const STATUSES: readonly MemoryStatus[] = ["candidate", "active", "superseded"]
const KINDS: readonly MemoryKind[] = ["semantic", "episodic", "procedural", "reflection"]
const SOURCE_TYPES: readonly MemorySource["type"][] = ["run", "user", "tool", "eval", "human"]

/** undefined when absent, the narrowed literal when valid, a 400 Response otherwise. */
function parseEnum<T extends string>(
  value: string | null,
  allowed: readonly T[],
  name: string,
): T | undefined | Response {
  if (value === null) return undefined
  if ((allowed as readonly string[]).includes(value)) return value as T
  return Response.json(
    { error: `invalid ${name} "${value}" (expected one of: ${allowed.join(", ")})` },
    { status: 400 },
  )
}

/** undefined when absent, the value normalized to full-ISO-Z when Date.parse-able,
 *  a 400 Response otherwise. Normalization matters: the store compares these
 *  lexicographically against stored full-ISO-Z strings, so raw offset-ISO
 *  ("...+02:00"), zoneless-local, or loose forms would window silently wrong. */
function parseInstant(value: string | null, name: string): string | undefined | Response {
  if (value === null) return undefined
  const t = Date.parse(value)
  if (Number.isFinite(t)) return new Date(t).toISOString()
  return Response.json(
    { error: `invalid ${name} "${value}" (expected an ISO-8601 date-time)` },
    { status: 400 },
  )
}

export async function GET(req: Request): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const sp = new URL(req.url).searchParams
  const status = parseEnum(sp.get("status"), STATUSES, "status")
  if (status instanceof Response) return status
  const kind = parseEnum(sp.get("kind"), KINDS, "kind")
  if (kind instanceof Response) return kind
  const sourceType = parseEnum(sp.get("sourceType"), SOURCE_TYPES, "sourceType")
  if (sourceType instanceof Response) return sourceType
  const since = parseInstant(sp.get("since"), "since")
  if (since instanceof Response) return since
  const until = parseInstant(sp.get("until"), "until")
  if (until instanceof Response) return until
  // Supplying `now` makes browse exclude rows with expiresAt <= now; the
  // inspector is a debugging surface, so includeExpired=1 omits it to reveal
  // expired-but-not-yet-pruned rows.
  const includeExpired = sp.get("includeExpired") === "1"
  const namespacePrefix = sp.get("namespacePrefix")
  const limit = Number(sp.get("limit") ?? 50)
  const offset = Number(sp.get("offset") ?? 0)
  const resolved = await storeOr500()
  if (resolved instanceof Response) return resolved
  const page = await resolved.store.browse({
    ...(namespacePrefix ? { namespacePrefix } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(includeExpired ? {} : { now: new Date().toISOString() }),
    // Store clamps to ≥0 integers; guard NaN from garbage params here.
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  })
  return Response.json(page)
}
