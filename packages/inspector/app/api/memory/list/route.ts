import { resolveStore } from "../../../../src/store/resolve"

export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  const { store } = await resolveStore()
  const candidates = await store.listCandidates("")
  return Response.json({ records: candidates })
}
