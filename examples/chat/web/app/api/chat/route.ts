import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest): Promise<Response> {
  const serverUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
  const body = (await req.json()) as {
    threadId: string
    message: string
  }

  const upstream = await fetch(`${serverUrl}/runs/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assistant_id: "/chat#agent",
      input: {
        messages: [{ role: "user", content: body.message }],
      },
      metadata: {
        dawn: {
          mode: "agent",
          route_id: "/chat",
          route_path: "src/app/chat/index.ts",
          thread_id: body.threadId,
        },
      },
      on_completion: "delete",
    }),
  })

  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream error: ${upstream.status}`, { status: 502 })
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}
