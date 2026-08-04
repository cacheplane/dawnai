import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Wrap a Node request as a Web `Request`. The socket closing aborts
 * `request.signal`.
 *
 * When the paired `ServerResponse` is available, pass it: on a real server
 * (Node >= 16) the IncomingMessage's own `close` event fires when the request
 * *message* completes — i.e. as soon as the body has been received — not when
 * the client disconnects. A premature client disconnect is instead observable
 * as the response closing before it ended, so with `res` provided the abort
 * signal keys off that. Without `res` (e.g. a bare injected request), the
 * request's `close` event is the only disconnect signal available.
 */
export function toWebRequest(req: IncomingMessage, res?: ServerResponse): Request {
  const controller = new AbortController()
  if (res) {
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })
  } else {
    req.on("close", () => controller.abort())
  }

  // `||` (not `??`): an empty Host header must fall back too, or the URL
  // constructor below throws on `http://`.
  const host = req.headers.host || "localhost"
  let url: URL
  try {
    url = new URL(req.url ?? "/", `http://${host}`)
  } catch {
    // The Host header did not form a valid URL authority (e.g. `Host: not a
    // host`). The pre-refactor server never parsed the Host header, so a
    // malformed one must not turn into a 500 — fall back to localhost.
    try {
      url = new URL(req.url ?? "/", "http://localhost")
    } catch {
      // req.url itself is unparsable — last-resort root URL.
      url = new URL("/", "http://localhost")
    }
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else headers.set(key, value)
  }

  const method = req.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"

  return new Request(url, {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody ? { body: req as unknown as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" })
}

/** Pipe a Web `Response` into a Node response, streaming the body incrementally. */
export async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    // `getSetCookie` preserves multiple Set-Cookie headers, which `Headers`
    // iteration would otherwise join into one comma-separated value.
    if (key.toLowerCase() === "set-cookie") continue
    headers[key] = value
  }
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) headers["set-cookie"] = setCookie

  if (!response.body) {
    res.writeHead(response.status, headers)
    res.end()
    return
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (/^application\/json\b/i.test(contentType)) {
    // JSON replies were sent by the pre-refactor server as a single
    // `res.end(payload)`, which Node frames with `Content-Length`. Piping the
    // Response's ReadableStream chunk-by-chunk would instead emit
    // `Transfer-Encoding: chunked` — buffer and send in one shot with an
    // explicit Content-Length to stay indistinguishable on the wire.
    const buf = Buffer.from(await response.arrayBuffer())
    headers["content-length"] = String(buf.byteLength)
    res.writeHead(response.status, headers)
    res.write(buf)
    res.end()
    return
  }

  res.writeHead(response.status, headers)
  const reader = response.body.getReader()
  while (true) {
    let next: Awaited<ReturnType<typeof reader.read>>
    try {
      next = await reader.read()
    } catch (error) {
      // The stream errored mid-flight after headers were sent. Ending the
      // response here would frame the truncated body as a clean success —
      // destroy the socket instead so the client sees an aborted body (a
      // chunked stream without its terminator), the honest transport-error
      // signal.
      res.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (next.done) break
    if (next.value) res.write(next.value)
  }
  res.end()
}
