import { assertLocalRequest } from "../../../../src/store/guard"
import { storeOr500 } from "../../../../src/store/resolve"

export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const resolved = await storeOr500()
  if (resolved instanceof Response) return resolved
  const namespacePrefix = new URL(req.url).searchParams.get("namespacePrefix")
  const stats = await resolved.store.stats(namespacePrefix ? { namespacePrefix } : undefined)
  return Response.json(stats)
}
