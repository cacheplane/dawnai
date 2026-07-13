import type { NextRequest } from "next/server"

// Same-origin proxy to Dawn's memory-candidate endpoints (Slice B:
// GET /memory/candidates, POST /memory/candidates/:id/approve|reject) so the
// browser avoids CORS — mirrors the shape of app/api/copilotkit/route.ts,
// which also talks to the Dawn dev server via DAWN_SERVER_URL.
const DAWN = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3002"

interface RouteContext {
  readonly params: Promise<{ readonly path: ReadonlyArray<string> }>
}

async function forward(req: NextRequest, path: ReadonlyArray<string>): Promise<Response> {
  const search = req.nextUrl.search
  const url = `${DAWN}/memory/${path.join("/")}${search}`
  const init: RequestInit = {
    method: req.method,
    headers: { "content-type": "application/json" },
  }
  if (req.method === "POST") {
    init.body = await req.text()
  }
  const upstream = await fetch(url, init)
  const body = await upstream.text()
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  })
}

export async function GET(req: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params
  return forward(req, path)
}

export async function POST(req: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params
  return forward(req, path)
}
