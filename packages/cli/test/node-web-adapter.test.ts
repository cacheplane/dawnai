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
