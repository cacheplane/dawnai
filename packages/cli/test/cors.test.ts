import { describe, expect, it } from "vitest"
import {
  applyCorsHeaders,
  CorsConfigError,
  corsPreflightResponse,
  corsResponseHeaders,
  resolveCorsPolicy,
} from "../src/lib/dev/cors.js"

const ORIGIN = "http://localhost:3010"

function req(
  method: string,
  headers: Record<string, string> = {},
  url = "http://127.0.0.1:3002/agui/x",
): Request {
  return new Request(url, { method, headers })
}

describe("resolveCorsPolicy", () => {
  it("is off when unconfigured", () => {
    expect(resolveCorsPolicy(undefined)).toBeUndefined()
  })

  it("normalizes configured origins so a trailing slash still matches", () => {
    const policy = resolveCorsPolicy({ origins: ["HTTP://LocalHost:3010/"] })
    expect(policy?.origins.has("http://localhost:3010")).toBe(true)
  })

  it("rejects a wildcard combined with credentials", () => {
    expect(() => resolveCorsPolicy({ origins: "*", credentials: true })).toThrow(CorsConfigError)
  })

  it("rejects an empty origin list", () => {
    expect(() => resolveCorsPolicy({ origins: [] })).toThrow(CorsConfigError)
  })

  it("rejects an origin carrying a path", () => {
    expect(() => resolveCorsPolicy({ origins: ["http://localhost:3010/app"] })).toThrow(
      CorsConfigError,
    )
  })

  it("rejects a value that is not a URL at all", () => {
    expect(() => resolveCorsPolicy({ origins: ["localhost:3010"] })).toThrow(CorsConfigError)
  })
})

describe("corsResponseHeaders", () => {
  it("adds nothing when CORS is off", () => {
    expect(corsResponseHeaders(undefined, req("GET", { origin: ORIGIN }))).toBeUndefined()
  })

  it("adds nothing when the request carries no Origin", () => {
    const policy = resolveCorsPolicy({ origins: [ORIGIN] })
    expect(corsResponseHeaders(policy, req("GET"))).toBeUndefined()
  })

  it("adds nothing for an origin that is not on the list", () => {
    const policy = resolveCorsPolicy({ origins: [ORIGIN] })
    expect(corsResponseHeaders(policy, req("GET", { origin: "http://evil.test" }))).toBeUndefined()
  })

  it("echoes an allowed origin and varies on it", () => {
    const policy = resolveCorsPolicy({ origins: [ORIGIN] })
    expect(corsResponseHeaders(policy, req("GET", { origin: ORIGIN }))).toEqual({
      "access-control-allow-origin": ORIGIN,
      vary: "Origin",
    })
  })

  it("echoes the origin rather than a literal star under origins: '*'", () => {
    const policy = resolveCorsPolicy({ origins: "*" })
    const headers = corsResponseHeaders(policy, req("GET", { origin: "http://anywhere.test" }))
    expect(headers?.["access-control-allow-origin"]).toBe("http://anywhere.test")
  })

  it("advertises credentials only when configured", () => {
    const withCreds = resolveCorsPolicy({ origins: [ORIGIN], credentials: true })
    expect(
      corsResponseHeaders(withCreds, req("GET", { origin: ORIGIN }))?.[
        "access-control-allow-credentials"
      ],
    ).toBe("true")
    const without = resolveCorsPolicy({ origins: [ORIGIN] })
    expect(
      corsResponseHeaders(without, req("GET", { origin: ORIGIN }))?.[
        "access-control-allow-credentials"
      ],
    ).toBeUndefined()
  })

  it("exposes configured response headers", () => {
    const policy = resolveCorsPolicy({ origins: [ORIGIN], exposeHeaders: ["x-dawn-run-id"] })
    expect(
      corsResponseHeaders(policy, req("GET", { origin: ORIGIN }))?.[
        "access-control-expose-headers"
      ],
    ).toBe("x-dawn-run-id")
  })
})

describe("corsPreflightResponse", () => {
  const policy = resolveCorsPolicy({ origins: [ORIGIN] })

  it("ignores a non-OPTIONS request", () => {
    expect(corsPreflightResponse(policy, req("POST", { origin: ORIGIN }))).toBeUndefined()
  })

  it("ignores a bare OPTIONS with no Access-Control-Request-Method", () => {
    // Deliberate: the runtime serves no OPTIONS route, so this must fall
    // through to the router's 404 rather than be answered 204.
    expect(corsPreflightResponse(policy, req("OPTIONS", { origin: ORIGIN }))).toBeUndefined()
  })

  it("answers 204 with the advertised methods and echoed headers", () => {
    const response = corsPreflightResponse(
      policy,
      req("OPTIONS", {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      }),
    )
    expect(response?.status).toBe(204)
    expect(response?.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(response?.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS")
    expect(response?.headers.get("access-control-allow-headers")).toBe(
      "content-type, authorization",
    )
    expect(response?.headers.get("access-control-max-age")).toBe("600")
    expect(response?.headers.get("vary")).toBe("Origin, Access-Control-Request-Headers")
  })

  it("prefers a configured header allowlist over echoing the request", () => {
    const pinned = resolveCorsPolicy({ origins: [ORIGIN], headers: ["content-type"] })
    const response = corsPreflightResponse(
      pinned,
      req("OPTIONS", {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-smuggled",
      }),
    )
    expect(response?.headers.get("access-control-allow-headers")).toBe("content-type")
  })

  it("refuses a preflight from an origin that is not on the list", () => {
    const response = corsPreflightResponse(
      policy,
      req("OPTIONS", { origin: "http://evil.test", "access-control-request-method": "POST" }),
    )
    expect(response?.status).toBe(403)
    expect(response?.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("applyCorsHeaders", () => {
  const policy = resolveCorsPolicy({ origins: [ORIGIN] })

  it("returns the response untouched when the origin is not allowed", () => {
    const original = Response.json({ ok: true })
    const result = applyCorsHeaders(policy, req("GET", { origin: "http://evil.test" }), original)
    expect(result).toBe(original)
    expect(result.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("stamps headers onto an existing response without rebuilding it", () => {
    const original = Response.json({ ok: true })
    const result = applyCorsHeaders(policy, req("GET", { origin: ORIGIN }), original)
    expect(result).toBe(original)
    expect(result.headers.get("access-control-allow-origin")).toBe(ORIGIN)
  })

  it("leaves a streaming body readable and unconsumed", async () => {
    // The SSE routes hand back a Response whose body is still streaming; the
    // header stamp must not touch it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"))
        controller.close()
      },
    })
    const original = new Response(stream, { headers: { "content-type": "text/event-stream" } })
    const result = applyCorsHeaders(policy, req("GET", { origin: ORIGIN }), original)
    expect(result.bodyUsed).toBe(false)
    expect(result.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(await result.text()).toBe("data: hi\n\n")
  })
})
