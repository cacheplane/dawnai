import { snapshotJson } from "../adapter-normalize.mjs"

const JSON_ACCEPT = "application/vnd.github+json"
const MAX_JSON_REQUEST_BYTES = 4 * 1024 * 1024
const FAILURE_SNIPPET_MAX_LENGTH = 200
const FAILURE_SNIPPET_MAX_INPUT_LENGTH = 4096
const FAILURE_SNIPPET_REDACTIONS = Object.freeze([
  /gh[pous]_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /npm_[A-Za-z0-9]{20,}/gu,
  /Bearer\s+\S+/giu,
  /authorization:\s*\S+(?:\s+\S+)?/giu,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu,
])

export async function requestGitHubJson(
  context,
  {
    url,
    method,
    apiVersion,
    body,
    bodyBytes,
    contentType = "application/json",
    maxRequestBytes = MAX_JSON_REQUEST_BYTES,
  },
) {
  const bytes =
    bodyBytes === undefined
      ? Buffer.from(JSON.stringify(canonicalize(body)), "utf8")
      : Buffer.from(bodyBytes)
  if (bytes.length > maxRequestBytes) throw new TypeError("GitHub write request exceeds byte limit")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs)
  try {
    let response
    try {
      response = await context.fetchImpl(url, {
        method,
        redirect: "manual",
        headers: {
          Accept: JSON_ACCEPT,
          "Content-Type": contentType,
          "X-GitHub-Api-Version": apiVersion,
          ...(context.token === null ? {} : { Authorization: `Bearer ${context.token}` }),
        },
        body: bytes,
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(
        controller.signal.aborted
          ? `GitHub write timed out after ${context.timeoutMs} ms (${method})`
          : `GitHub write failed (${method})`,
        {
          cause: error,
        },
      )
    }
    const status = response?.status
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      cancelResponseBody(response?.body)
      throw new Error("GitHub write returned a malformed response")
    }
    if (status >= 300 && status < 400) {
      cancelResponseBody(response.body)
      throw new Error("GitHub write redirects are forbidden")
    }
    let responseBytes
    try {
      responseBytes = await readBoundedResponse(
        response.body,
        context.maxResponseBytes,
        controller.signal,
      )
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `GitHub write timed out after ${context.timeoutMs} ms reading the ${method} response`,
          { cause: error },
        )
      }
      throw error
    }
    const responseContentType = response.headers?.get?.("content-type")
    if (status < 200 || status >= 300) {
      // A failed write's body is never consumed as data; it is only summarized for the operator,
      // so the JSON content-type contract below does not apply to it.
      return {
        httpStatus: status,
        body: null,
        detail: describeFailureBody(responseBytes, responseContentType),
      }
    }
    if (responseBytes.length === 0) return { httpStatus: status, body: null, detail: null }
    if (
      typeof responseContentType !== "string" ||
      !/^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/iu.test(responseContentType)
    ) {
      throw new Error("GitHub write response content type is not JSON")
    }
    let parsed
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes))
    } catch (error) {
      throw new Error("GitHub write response JSON is malformed", { cause: error })
    }
    return { httpStatus: status, body: snapshotJson(parsed), detail: null }
  } finally {
    clearTimeout(timeout)
  }
}

export function writeFailureMessage(prefix, response) {
  const head = `${prefix} returned HTTP ${response.httpStatus}`
  return response.detail === null ? head : `${head}: ${response.detail}`
}

function describeFailureBody(bytes, contentType) {
  if (bytes.length === 0) return null
  // The body is already bounded by maxResponseBytes; decode leniently so a truncated or
  // non-UTF-8 error page still yields a glimpse instead of a second failure.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  let raw = text
  if (typeof contentType === "string" && /json/iu.test(contentType)) {
    try {
      const parsed = JSON.parse(text)
      const parts = []
      if (isRecord(parsed)) {
        if (typeof parsed.message === "string") parts.push(parsed.message)
        if (parsed.errors !== undefined) parts.push(`errors=${JSON.stringify(parsed.errors)}`)
      }
      if (parts.length > 0) raw = parts.join(" ")
    } catch {
      // Fall through to the text snippet: a malformed error body is still worth a glimpse.
    }
  }
  return sanitizeFailureSnippet(raw)
}

function sanitizeFailureSnippet(value) {
  let snippet = Array.from(value.slice(0, FAILURE_SNIPPET_MAX_INPUT_LENGTH), (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
      ? " "
      : character
  }).join("")
  snippet = snippet.replace(/https?:\/\/[^\s?#]*\?\S*/gu, (token) =>
    token.slice(0, token.indexOf("?")),
  )
  for (const pattern of FAILURE_SNIPPET_REDACTIONS) {
    snippet = snippet.replace(pattern, "[redacted]")
  }
  snippet = snippet.replace(/\s+/gu, " ").trim()
  if (snippet.length === 0) return null
  if (snippet.length > FAILURE_SNIPPET_MAX_LENGTH) {
    snippet = `${snippet.slice(0, FAILURE_SNIPPET_MAX_LENGTH - 1)}\u2026`
  }
  return snippet
}

async function readBoundedResponse(stream, maximum, signal) {
  if (stream === null) return Buffer.alloc(0)
  if (stream === undefined || typeof stream.getReader !== "function") {
    throw new Error("GitHub write response body is malformed")
  }
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal)
      if (done) break
      if (!(value instanceof Uint8Array)) throw new Error("GitHub write response body is malformed")
      total += value.byteLength
      if (total > maximum) throw new Error("GitHub write response exceeds byte limit")
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total)
}

async function readWithAbort(reader, signal) {
  if (signal.aborted) throw new Error("GitHub write timed out")
  let rejectAbort
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = () => reject(new Error("GitHub write timed out"))
    signal.addEventListener("abort", rejectAbort, { once: true })
  })
  try {
    return await Promise.race([reader.read(), aborted])
  } finally {
    signal.removeEventListener("abort", rejectAbort)
  }
}

function cancelResponseBody(body) {
  if (body !== null && body !== undefined && typeof body.cancel === "function") {
    void body.cancel().catch(() => {})
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
