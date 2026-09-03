import { createHash } from "node:crypto"

/**
 * Recording fetch helpers for the terminal recovery writer tests. These mirror
 * the duplicate-draft adapter tests' own recorder and response builders so both
 * suites drive their writers through byte-identical transport fixtures.
 */
export function routingFetch(calls, route) {
  return async (url, init) => {
    calls.push({ url, init })
    return route(url, init)
  }
}

export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

export function binaryResponse(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: { "content-type": "application/octet-stream", ...headers },
  })
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function canonicalizeForTest(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForTest)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeForTest(value[key])]),
  )
}

export function requestBody(init) {
  return JSON.parse(Buffer.from(init.body).toString("utf8"))
}
