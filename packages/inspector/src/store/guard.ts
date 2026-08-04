/**
 * Localhost-only protection: the inspector binds 127.0.0.1, but any website the
 * developer has open can still fire cross-origin requests at it (CSRF/DNS
 * rebinding). Verify Host, and reject state-changing requests whose Origin is
 * present and foreign.
 */
export function assertLocalRequest(req: Request): Response | undefined {
  const host = req.headers.get("host") ?? ""
  const hostname = host.split(":")[0]
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    return Response.json({ error: `forbidden host ${host}` }, { status: 403 })
  }
  if (req.method !== "GET") {
    const origin = req.headers.get("origin")
    if (origin) {
      let originHost = ""
      try {
        originHost = new URL(origin).hostname
      } catch {}
      if (originHost !== "127.0.0.1" && originHost !== "localhost") {
        return Response.json({ error: `forbidden origin ${origin}` }, { status: 403 })
      }
    }
  }
  return undefined
}
