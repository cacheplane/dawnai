import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest): Promise<Response> {
  const serverUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
  const body = (await req.json()) as {
    threadId: string
    interruptId: string
    decision: "once" | "always" | "deny"
  }

  const upstream = await fetch(
    `${serverUrl}/threads/${encodeURIComponent(body.threadId)}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interrupt_id: body.interruptId,
        decision: body.decision,
      }),
    },
  )

  const text = await upstream.text()
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  })
}
