import { type NextRequest, NextResponse } from "next/server"
import { resolveProxyTarget } from "@/app/lib/proxy-allowlist"

// Same-origin proxy to the Dawn server. The dev server sets no CORS headers,
// so the browser cannot read it directly. Every routing decision is in
// `lib/proxy-allowlist.ts`, which is where the tests are; this file is the
// adapter and deliberately holds no policy of its own.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SERVER_URL = process.env.DAWN_SERVER_URL ?? "http://localhost:3002"

async function forward(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await context.params
  const target = resolveProxyTarget(request.method, path ?? [], SERVER_URL)
  if (target === null) {
    return NextResponse.json({ error: "Not proxied" }, { status: 404 })
  }
  try {
    const upstream = await fetch(target, { method: request.method })
    // Pass the body and status through untouched: the UI shows the Dawn
    // server's own error messages rather than a re-worded copy of them.
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      status: upstream.status,
    })
  } catch (error) {
    return NextResponse.json(
      { error: `Cannot reach the Dawn server at ${SERVER_URL}: ${String(error)}` },
      { status: 502 },
    )
  }
}

export const GET = forward
export const POST = forward
