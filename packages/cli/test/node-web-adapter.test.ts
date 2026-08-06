import type { IncomingMessage, ServerResponse } from "node:http"
import { PassThrough } from "node:stream"
import { describe, expect, test } from "vitest"
import { toWebRequest, writeNodeResponse } from "../src/lib/dev/node-web-adapter.js"

function fakeReq(init: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const stream = new PassThrough()
  if (init.body !== undefined) stream.end(init.body)
  else stream.end()
  const req = stream as unknown as IncomingMessage
  Object.assign(req, {
    method: init.method ?? "GET",
    url: init.url ?? "/",
    headers: init.headers ?? {},
  })
  return req
}

describe("toWebRequest", () => {
  test("maps method, url, and headers", async () => {
    const request = toWebRequest(
      fakeReq({ method: "GET", url: "/threads", headers: { accept: "text/event-stream" } }),
    )
    expect(request.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/threads")
    expect(request.headers.get("accept")).toBe("text/event-stream")
  })

  test("carries a POST body", async () => {
    const request = toWebRequest(fakeReq({ method: "POST", url: "/threads", body: '{"a":1}' }))
    expect(await request.text()).toBe('{"a":1}')
  })

  test("aborts the request signal when the socket closes", async () => {
    const req = fakeReq({ method: "GET", url: "/" })
    const request = toWebRequest(req)
    expect(request.signal.aborted).toBe(false)
    req.emit("close")
    expect(request.signal.aborted).toBe(true)
  })
})

describe("writeNodeResponse", () => {
  test("writes status, headers, and a JSON body", async () => {
    const chunks: string[] = []
    let status = 0
    let headers: Record<string, string | string[]> = {}
    const res = {
      writeHead: (s: number, h: Record<string, string | string[]>) => {
        status = s
        headers = h
      },
      write: (c: string | Uint8Array) => {
        chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c))
        return true
      },
      end: () => {},
      on: () => {},
    } as unknown as ServerResponse

    await writeNodeResponse(res, Response.json({ ok: true }, { status: 201 }))
    expect(status).toBe(201)
    expect(String(headers["content-type"])).toContain("application/json")
    expect(JSON.parse(chunks.join(""))).toEqual({ ok: true })
  })

  test("streams a ReadableStream body incrementally", async () => {
    const seen: string[] = []
    let resolveFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((r) => {
      resolveFirst = r
    })
    const res = {
      writeHead: () => {},
      write: (c: string | Uint8Array) => {
        seen.push(typeof c === "string" ? c : new TextDecoder().decode(c))
        resolveFirst?.()
        return true
      },
      end: () => {},
      on: () => {},
    } as unknown as ServerResponse

    let push: ((s: string) => void) | undefined
    let done: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        push = (s) => controller.enqueue(enc.encode(s))
        done = () => controller.close()
      },
    })

    const writing = writeNodeResponse(res, new Response(stream))
    push?.("first\n")
    await firstWrite // the first chunk must arrive BEFORE the stream completes
    expect(seen.join("")).toBe("first\n")
    done?.()
    await writing
  })
})

// ---------------------------------------------------------------------------
// Wire-parity regressions (review findings)
// ---------------------------------------------------------------------------

interface RecordedRes {
  readonly res: ServerResponse
  readonly headers: () => Record<string, string | string[]>
  readonly status: () => number
  readonly body: () => string
  readonly ended: () => boolean
  readonly destroyed: () => boolean
  readonly destroyError: () => unknown
}

function recordingRes(): RecordedRes {
  let status = 0
  let headers: Record<string, string | string[]> = {}
  const chunks: string[] = []
  let ended = false
  let destroyed = false
  let destroyError: unknown
  const res = {
    writeHead: (s: number, h: Record<string, string | string[]>) => {
      status = s
      headers = h
    },
    write: (c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c))
      return true
    },
    end: () => {
      ended = true
    },
    destroy: (error?: Error) => {
      destroyed = true
      destroyError = error
    },
    on: () => {},
  } as unknown as ServerResponse
  return {
    body: () => chunks.join(""),
    destroyError: () => destroyError,
    destroyed: () => destroyed,
    ended: () => ended,
    headers: () => headers,
    res,
    status: () => status,
  }
}

describe("writeNodeResponse JSON framing", () => {
  test("sends JSON responses with content-length framing, not chunked", async () => {
    const recorded = recordingRes()
    await writeNodeResponse(recorded.res, Response.json({ ok: true }))

    const payload = JSON.stringify({ ok: true })
    expect(recorded.status()).toBe(200)
    expect(recorded.headers()["content-length"]).toBe(String(Buffer.byteLength(payload)))
    const headerNames = Object.keys(recorded.headers()).map((name) => name.toLowerCase())
    expect(headerNames).not.toContain("transfer-encoding")
    expect(recorded.body()).toBe(payload)
    expect(recorded.ended()).toBe(true)
    expect(recorded.destroyed()).toBe(false)
  })

  test("SSE responses still stream incrementally (no buffering)", async () => {
    const seen: string[] = []
    let resolveFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const res = {
      writeHead: () => {},
      write: (c: string | Uint8Array) => {
        seen.push(typeof c === "string" ? c : new TextDecoder().decode(c))
        resolveFirst?.()
        return true
      },
      end: () => {},
      on: () => {},
    } as unknown as ServerResponse

    let push: ((s: string) => void) | undefined
    let done: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        push = (s) => controller.enqueue(enc.encode(s))
        done = () => controller.close()
      },
    })

    const writing = writeNodeResponse(
      res,
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    )
    push?.("data: one\n\n")
    await firstWrite // must arrive BEFORE the stream completes
    expect(seen.join("")).toBe("data: one\n\n")
    done?.()
    await writing
  })
})

describe("writeNodeResponse stream-error teardown", () => {
  test("destroys the socket (and does not end) when the stream errors mid-flight", async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("data: one\n\n"))
        else controller.error(new Error("boom"))
      },
    })

    const recorded = recordingRes()
    await writeNodeResponse(
      recorded.res,
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    )

    expect(recorded.body()).toBe("data: one\n\n")
    expect(recorded.destroyed()).toBe(true)
    expect(recorded.destroyError()).toBeInstanceOf(Error)
    expect((recorded.destroyError() as Error).message).toBe("boom")
    expect(recorded.ended()).toBe(false)
  })

  test("ends (and does not destroy) on clean stream completion", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"))
        controller.close()
      },
    })

    const recorded = recordingRes()
    await writeNodeResponse(
      recorded.res,
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    )

    expect(recorded.ended()).toBe(true)
    expect(recorded.destroyed()).toBe(false)
  })
})

describe("toWebRequest host-header robustness", () => {
  test("treats an empty Host header as absent", () => {
    const request = toWebRequest(fakeReq({ url: "/threads/abc", headers: { host: "" } }))
    const url = new URL(request.url)
    expect(url.hostname).toBe("localhost")
    expect(url.pathname).toBe("/threads/abc")
  })

  test("a malformed Host header still yields a usable Request", () => {
    const request = toWebRequest(fakeReq({ url: "/healthz", headers: { host: "not a host" } }))
    expect(new URL(request.url).pathname).toBe("/healthz")
  })

  test("an unparsable req.url falls back to the root URL", () => {
    const request = toWebRequest(
      fakeReq({ url: "http://bad host/x", headers: { host: "not a host" } }),
    )
    expect(new URL(request.url).pathname).toBe("/")
  })
})
