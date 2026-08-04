import type { IncomingMessage, ServerResponse } from "node:http"

/** Wrap a Node request as a Web `Request`. The socket closing aborts `request.signal`. */
export function toWebRequest(req: IncomingMessage): Request {
  const controller = new AbortController()
  req.on("close", () => controller.abort())

  const host = req.headers.host ?? "localhost"
  const url = new URL(req.url ?? "/", `http://${host}`)

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

  res.writeHead(response.status, headers)

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(value)
    }
  } finally {
    res.end()
  }
}
