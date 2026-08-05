import { assertLocalRequest } from "../../../../../src/store/guard"
import { storeOr500 } from "../../../../../src/store/resolve"

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
  const { store } = resolved
  const rec = await store.get(id)
  if (!rec) return Response.json({ error: "not found" }, { status: 404 })
  // No candidate guard: forget removes a record in ANY status.
  await store.delete(id)
  return Response.json({ deleted: id })
}
