import assert from "node:assert/strict"
import test from "node:test"

import {
  createHttpGet,
  DEFAULT_HTTP_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_TIMEOUT_MS,
} from "../adapters/http.mjs"

test("createHttpGet exposes only bounded GET body readers with fixed request options", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true })
  }
  const http = createHttpGet({ fetchImpl })

  assert.deepEqual(Object.keys(http).sort(), ["getBinary", "getJson", "getText"])
  assert.equal(DEFAULT_HTTP_TIMEOUT_MS, 15_000)
  assert.equal(DEFAULT_HTTP_MAX_RESPONSE_BYTES, 64 * 1024 * 1024)
  assert.deepEqual(
    await http.getJson({
      url: "https://example.test/data",
      headers: { Accept: "application/json" },
    }),
    {
      status: "OK",
      httpStatus: 200,
      code: null,
      headers: { link: null, location: null, rateLimitRemaining: null },
      bodyBytes: 11,
      body: { ok: true },
    },
  )
  assert.equal(calls[0].init.method, "GET")
  assert.equal(calls[0].init.redirect, "manual")
  assert.equal(calls[0].init.headers.Accept, "application/json")
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})

test("HTTP GET rejects redirects and ignores contradictory response ok values", async () => {
  const redirect = createHttpGet({
    fetchImpl: async () => responseLike({ status: 302, ok: true, body: "{}" }),
  })
  assert.deepEqual(await redirect.getJson({ url: "https://example.test/data" }), {
    status: "ERROR",
    httpStatus: 302,
    code: "REDIRECT",
    headers: { link: null, location: null, rateLimitRemaining: null },
  })

  const concealed = createHttpGet({
    fetchImpl: async () =>
      responseLike({
        status: 404,
        ok: true,
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
  })
  assert.deepEqual(await concealed.getJson({ url: "https://example.test/data" }), {
    status: "HTTP_ERROR",
    httpStatus: 404,
    code: null,
    headers: { link: null, location: null, rateLimitRemaining: null },
    bodyBytes: 2,
    body: {},
  })
})

test("HTTP GET validates status, headers, body stream, URL, and constructor bounds", async () => {
  for (const response of [
    { status: 99, headers: new Headers(), body: null },
    { status: 600, headers: new Headers(), body: null },
    { status: 200, headers: {}, body: null },
    { status: 200, headers: new Headers({ "content-type": "application/json" }), body: {} },
  ]) {
    const http = createHttpGet({ fetchImpl: async () => response })
    assert.deepEqual(await http.getJson({ url: "https://example.test/data" }), {
      status: "ERROR",
      httpStatus: Number.isInteger(response.status) ? response.status : null,
      code: "MALFORMED_RESPONSE",
    })
  }

  const throwingStatus = createHttpGet({
    fetchImpl: async () => ({
      get status() {
        throw new Error("Authorization: Bearer transport_secret")
      },
    }),
  })
  const malformed = await throwingStatus.getJson({ url: "https://example.test/data" })
  assert.deepEqual(malformed, {
    status: "ERROR",
    httpStatus: null,
    code: "MALFORMED_RESPONSE",
  })
  assert.doesNotMatch(JSON.stringify(malformed), /transport_secret|authorization|bearer/iu)

  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { timeoutMs: 300_001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1.5 },
    { maxResponseBytes: 64 * 1024 * 1024 + 1 },
  ]) {
    assert.throws(() => createHttpGet({ fetchImpl: assert.fail, ...options }), /HTTP/u)
  }

  const http = createHttpGet({ fetchImpl: assert.fail })
  for (const url of [
    "ftp://example.test/data",
    "https://user:secret@example.test/data",
    "https://example.test/data#fragment",
  ]) {
    assert.rejects(http.getJson({ url }), /HTTP URL/u)
  }
})

test("HTTP GET enforces its deadline and composes a caller abort signal", async () => {
  const timeout = createHttpGet({
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  })
  assert.deepEqual(await timeout.getJson({ url: "https://example.test/data" }), {
    status: "ERROR",
    httpStatus: null,
    code: "TIMEOUT",
  })

  const controller = new AbortController()
  const aborted = createHttpGet({
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("secret", "AbortError")), {
          once: true,
        })
      }),
  })
  const pending = aborted.getJson({ url: "https://example.test/data", signal: controller.signal })
  controller.abort()
  assert.deepEqual(await pending, {
    status: "ERROR",
    httpStatus: null,
    code: "ABORTED",
  })
})

test("HTTP GET returns ABORTED synchronously without fetching for a pre-aborted caller", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const http = createHttpGet({
    fetchImpl: async () => {
      calls += 1
      return new Promise(() => {})
    },
  })

  assert.deepEqual(
    await http.getJson({ url: "https://example.test/data", signal: controller.signal }),
    { status: "ERROR", httpStatus: null, code: "ABORTED" },
  )
  assert.equal(calls, 0)
})

test("HTTP GET cancels response bodies on every early return without masking errors", async () => {
  for (const row of [
    { status: 302, headers: { location: "https://example.test/next" }, code: "REDIRECT" },
    { status: 200, headers: { "content-type": "text/html" }, code: "UNEXPECTED_CONTENT_TYPE" },
    {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "100" },
      code: "RESPONSE_TOO_LARGE",
    },
  ]) {
    let cancellations = 0
    const body = {
      cancel() {
        cancellations += 1
        throw new Error("cancel failure must be ignored")
      },
    }
    const http = createHttpGet({
      maxResponseBytes: 4,
      fetchImpl: async () => ({ status: row.status, headers: new Headers(row.headers), body }),
    })
    const result = await http.getJson({ url: "https://example.test/data" })
    assert.equal(result.code, row.code)
    assert.equal(cancellations, 1)
  }
})

test("HTTP GET does not wait indefinitely for best-effort body cancellation", async () => {
  let cancellations = 0
  const http = createHttpGet({
    timeoutMs: 5,
    fetchImpl: async () => ({
      status: 302,
      headers: new Headers({ location: "https://example.test/next" }),
      body: {
        cancel() {
          cancellations += 1
          return new Promise(() => {})
        },
      },
    }),
  })
  const result = await Promise.race([
    http.getJson({ url: "https://example.test/data" }),
    new Promise((resolve) => setTimeout(() => resolve({ code: "STUCK" }), 20)),
  ])
  assert.equal(result.code, "REDIRECT")
  assert.equal(cancellations, 1)
})

test("HTTP GET supports smaller per-request remaining deadline and byte budgets", async () => {
  const timeout = createHttpGet({
    timeoutMs: 100,
    maxResponseBytes: 100,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("", "AbortError")), {
          once: true,
        })
      }),
  })
  assert.equal(
    (await timeout.getJson({ url: "https://example.test/data", timeoutMs: 5 })).code,
    "TIMEOUT",
  )

  const bytes = createHttpGet({
    timeoutMs: 100,
    maxResponseBytes: 100,
    fetchImpl: async () => jsonResponse({ value: "12345" }),
  })
  assert.deepEqual(await bytes.getJson({ url: "https://example.test/data", maxResponseBytes: 4 }), {
    status: "ERROR",
    httpStatus: 200,
    code: "RESPONSE_TOO_LARGE",
  })
})

test("HTTP GET rejects oversized declared and streamed bodies before parsing", async () => {
  const declared = createHttpGet({
    maxResponseBytes: 4,
    fetchImpl: async () =>
      responseLike({
        status: 200,
        body: "{}",
        headers: { "content-type": "application/json", "content-length": "5" },
      }),
  })
  assert.deepEqual(await declared.getJson({ url: "https://example.test/data" }), {
    status: "ERROR",
    httpStatus: 200,
    code: "RESPONSE_TOO_LARGE",
  })

  const streamed = createHttpGet({
    maxResponseBytes: 4,
    fetchImpl: async () =>
      responseLike({ status: 200, body: "12345", headers: { "content-type": "text/plain" } }),
  })
  assert.deepEqual(await streamed.getText({ url: "https://example.test/data" }), {
    status: "ERROR",
    httpStatus: 200,
    code: "RESPONSE_TOO_LARGE",
  })
})

test("HTTP GET validates JSON and text content types and parses only bounded bytes", async () => {
  for (const [response, code] of [
    [
      responseLike({ status: 200, body: "{}", headers: { "content-type": "text/html" } }),
      "UNEXPECTED_CONTENT_TYPE",
    ],
    [
      responseLike({ status: 200, body: "{", headers: { "content-type": "application/json" } }),
      "MALFORMED_JSON",
    ],
    [
      responseLike({
        status: 200,
        body: new Uint8Array([0xff]),
        headers: { "content-type": "text/plain" },
      }),
      "MALFORMED_TEXT",
    ],
  ]) {
    const http = createHttpGet({ fetchImpl: async () => response })
    const result =
      code === "MALFORMED_TEXT"
        ? await http.getText({ url: "https://example.test/data" })
        : await http.getJson({ url: "https://example.test/data" })
    assert.equal(result.code, code)
  }
})

test("HTTP binary reads are bounded and return JSON-safe canonical base64", async () => {
  const http = createHttpGet({
    fetchImpl: async () =>
      responseLike({
        status: 200,
        body: new Uint8Array([0, 255]),
        headers: { "content-type": "application/octet-stream" },
      }),
  })
  assert.deepEqual(await http.getBinary({ url: "https://example.test/data" }), {
    status: "OK",
    httpStatus: 200,
    code: null,
    headers: { link: null, location: null, rateLimitRemaining: null },
    bodyBytes: 2,
    contentBase64: "AP8=",
  })
})

function jsonResponse(value) {
  return responseLike({
    status: 200,
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
  })
}

function responseLike({ status, ok = status >= 200 && status < 300, body, headers = {} }) {
  const bytes =
    body instanceof Uint8Array
      ? body
      : new TextEncoder().encode(typeof body === "string" ? body : "")
  return {
    status,
    ok,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}
