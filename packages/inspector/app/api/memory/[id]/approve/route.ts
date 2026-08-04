import { assertLocalRequest } from "../../../../../src/store/guard"
import { type ResolvedIdentity, resolveIdentityKeys } from "../../../../../src/store/identity"
import { storeOr500 } from "../../../../../src/store/resolve"
import { importMemory } from "../../../../../src/store/runtime-imports"

export const dynamic = "force-dynamic"

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { id } = await ctx.params
  const resolved = await storeOr500()
  if (resolved instanceof Response) return resolved
  const { store, appRoot } = resolved
  const rec = await store.get(id)
  if (!rec) return Response.json({ error: "not found" }, { status: 404 })
  // Identity-resolution failures (a route memory.ts that exists but is broken)
  // must SURFACE as 500 — never silently fall back to default keys, and never
  // be conflated with a 409 reconcile conflict.
  let identity: ResolvedIdentity
  try {
    identity = await resolveIdentityKeys(appRoot, rec.namespace)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return Response.json({ error: message }, { status: 500 })
  }
  const { approveWithReconcile } = await importMemory()
  try {
    const res = await approveWithReconcile(store, id, {
      identityKeys: identity.keys,
      now: new Date().toISOString(),
    })
    return Response.json({ ...res, identityFallback: identity.fallback })
  } catch (cause) {
    // "not found" / "not a candidate" / vanished-target reconcile races.
    const message = cause instanceof Error ? cause.message : String(cause)
    return Response.json({ error: message }, { status: 409 })
  }
}
