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

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    })
  }

  // Pipe the upstream SSE stream directly to the client. The resume endpoint
  // now opens a new SSE stream carrying the continuation of the agent run.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  })
}
