import { createHash } from "node:crypto"

// Raw representations only: each reuse requires a new authenticated server response.
export function createConditionalJsonReader({ http, now = Date.now }) {
  const entries = new Map()
  let lastNow = now()
  const expiresAt = lastNow + 1_200_000
  const pending = new Map()
  let retainedBytes = 0,
    closed = false
  const remove = (key) => {
    const previous = entries.get(key)
    if (previous) retainedBytes -= previous.bytes
    entries.delete(key)
  }
  const dispose = () => {
    closed = true
    entries.clear()
    pending.clear()
    retainedBytes = 0
  }
  const live = () => {
    const current = now()
    if (
      !Number.isFinite(lastNow) ||
      !Number.isFinite(current) ||
      current < lastNow ||
      current >= expiresAt
    )
      dispose()
    lastNow = current
    return !closed
  }
  return Object.freeze({
    dispose,
    async getJson(request, { canRetain = () => false } = {}) {
      if (!live()) return failed("CONDITIONAL_READ_CLOSED")
      const headers = new Headers(request.headers)
      const eligible =
        new URL(request.url).origin === "https://api.github.com" &&
        headers.has("authorization") &&
        !headers.has("if-none-match") &&
        !headers.has("if-modified-since")
      const key = createHash("sha256")
        .update(JSON.stringify([request.url, [...headers]]))
        .digest("hex")
      if (pending.size >= 128) return failed("CONDITIONAL_READ_CAPACITY")
      const generation = {}
      pending.set(key, generation)
      const previous = eligible ? entries.get(key) : null
      // Remove while in flight: overlapping requests cannot consume the same entry.
      remove(key)
      const result = await http.getJson({
        ...request,
        allowNotModified: eligible,
        ...(previous ? { headers: { ...request.headers, "If-None-Match": previous.etag } } : {}),
      })
      const current = pending.get(key) === generation
      if (current) pending.delete(key)
      if (!live() || request.signal?.aborted || !current) return failed("CONDITIONAL_READ_CLOSED")
      if (result.status === "NOT_MODIFIED") {
        if (
          !previous ||
          !etagValue(result.headers?.etag) ||
          etagValue(result.headers.etag) !== etagValue(previous.etag) ||
          result.headers.link !== null ||
          result.headers.location !== null ||
          result.bodyBytes !== 0
        )
          return failed("INVALID_NOT_MODIFIED", 304)
        if (previous.bytes > (request.maxResponseBytes ?? Infinity))
          return failed("RESPONSE_TOO_LARGE", 304)
        const resolved = { ...result, bodyBytes: previous.bytes, body: JSON.parse(previous.text) }
        if (!canRetain(resolved.body)) return failed("INVALID_NOT_MODIFIED", 304)
        keep(key, previous)
        return resolved
      }
      if (
        eligible &&
        result.status === "OK" &&
        result.httpStatus === 200 &&
        etagValue(result.headers?.etag) &&
        result.headers.link === null &&
        result.headers.location === null &&
        canRetain(result.body)
      ) {
        const text = JSON.stringify(result.body)
        const bytes = Math.max(Buffer.byteLength(text), result.bodyBytes)
        if (bytes <= 2 * 1024 * 1024) keep(key, { text, bytes, etag: result.headers.etag })
      }
      return result
    },
  })
  function keep(key, entry) {
    remove(key)
    while (entries.size >= 128 || retainedBytes + entry.bytes > 16 * 1024 * 1024)
      remove(entries.keys().next().value)
    entries.set(key, entry)
    retainedBytes += entry.bytes
  }
}
function etagValue(value) {
  return typeof value === "string" &&
    value.length <= 1024 &&
    /^(?:W\/)?"[\x21\x23-\x7e]+"$/u.test(value)
    ? value.replace(/^W\//u, "")
    : null
}
function failed(code, httpStatus = null) {
  return { status: "ERROR", httpStatus, code }
}
