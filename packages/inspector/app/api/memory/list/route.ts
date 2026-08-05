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
    // Store clamps to ≥0 integers; guard NaN from garbage params here.
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  })
  return Response.json(page)
}
