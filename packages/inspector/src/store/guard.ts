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
      // Must be the inspector's OWN origin — host INCLUDING port. A localhost
      // origin on another port is still a foreign page (e.g. a malicious dev
      // server) firing state-changing requests at the inspector.
      let originHost = ""
      try {
        originHost = new URL(origin).host
      } catch {}
      if (originHost !== host) {
        return Response.json({ error: `forbidden origin ${origin}` }, { status: 403 })
      }
    }
  }
  return undefined
}
