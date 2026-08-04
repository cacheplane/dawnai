import { assertLocalRequest } from "../../../../src/store/guard"
import { storeOr500 } from "../../../../src/store/resolve"

export const dynamic = "force-dynamic"

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { id } = await ctx.params
  const resolved = await storeOr500()
  if (resolved instanceof Response) return resolved
  const rec = await resolved.store.get(id)
  if (!rec) return Response.json({ error: "not found" }, { status: 404 })
  return Response.json(rec)
}
