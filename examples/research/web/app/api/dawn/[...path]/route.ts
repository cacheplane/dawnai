import { type NextRequest, NextResponse } from "next/server"
import { resolveProxyTarget } from "../../../lib/proxy-allowlist"

// Same-origin proxy to the Dawn server. A Dawn server sends no CORS headers
// unless `server.cors` is configured, and this app deliberately does not
// depend on that — the browser never learns Dawn's address. Every routing decision is in
// `lib/proxy-allowlist.ts`, which is where the tests are; this file is the
// adapter and deliberately holds no policy of its own.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Matches app/api/copilotkit/[...path]/route.ts and the dev server's own bind address.
// `localhost` is not equivalent: on a dual-stack box it resolves `::1` first,
// which either pays a failed-connect retry or times out outright if `::1` is
// blackholed, while `127.0.0.1` (what the dev server actually binds) works
// immediately.
const SERVER_URL = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3002"

// Next also routes HEAD requests into the GET export; the allowlist has no
// HEAD entries, so those deliberately fall through to the 403 branch below —
// still the honest answer: this proxy does not carry HEAD.
async function forward(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await context.params
  const target = resolveProxyTarget(request.method, path ?? [], SERVER_URL)
  if (target === null) {
    // 403, NOT 404. The workbench gives 404 a specific meaning on
    // `/threads/:id/state` — "this thread has no checkpoint yet", which
    // hydration treats as an ordinary empty thread — so a rejection that
    // answered 404 would make a broken allowlist indistinguishable from a
    // brand-new thread, and every conversation would restore as blank with no
    // error anywhere. "Refused, and deliberately" is what actually happened.
    return NextResponse.json({ error: "Not proxied" }, { status: 403 })
  }
  try {
    // Every allowlisted route takes no request body, query string or auth
    // header, so none is forwarded — widen this deliberately if you add one
    // that does. `signal` propagates a client abort so it stops holding an
    // upstream socket open; beyond that there is deliberately no timeout,
    // since undici's default is enough for a localhost dev proxy.
    const upstream = await fetch(target, { method: request.method, signal: request.signal })
    const headers: Record<string, string> = {
      // Every allowlisted route is volatile (candidates change on approve/
      // reject, thread state changes as the run progresses), so default to
      // no-store rather than let a client-facing cache serve a stale answer;
      // `force-dynamic` above only governs Next's own caches, not this.
      "cache-control": upstream.headers.get("cache-control") ?? "no-store",
    }
    const contentType = upstream.headers.get("content-type")
    if (contentType !== null) {
      headers["content-type"] = contentType
    }
    // Pass the body and status through untouched: the UI shows the Dawn
    // server's own error messages rather than a re-worded copy of them.
    return new Response(upstream.body, { headers, status: upstream.status })
  } catch (error) {
    // `fetch failed` (the error's own message) never says why; the useful
    // part of an undici network failure — ECONNREFUSED, etc. — is on `cause`.
    const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
    return NextResponse.json(
      { error: `Cannot reach the Dawn server at ${SERVER_URL}: ${String(cause)}` },
      { status: 502 },
    )
  }
}

export const GET = forward
export const POST = forward
