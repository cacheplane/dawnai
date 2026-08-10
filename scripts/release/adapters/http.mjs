export const DEFAULT_HTTP_TIMEOUT_MS = 15_000
export const DEFAULT_HTTP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

const MAX_HTTP_TIMEOUT_MS = 300_000
const MAX_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024
const JSON_CONTENT_TYPE = /(?:\/json|\+json)(?:;|$)/iu
const TEXT_CONTENT_TYPE = /^text\//iu
const BINARY_CONTENT_TYPES = new Set(["application/octet-stream", "application/zip"])

export function createHttpGet({
  fetchImpl = fetch,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_HTTP_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("HTTP fetch implementation must be a function")
  }
  assertBoundedInteger(timeoutMs, 1, MAX_HTTP_TIMEOUT_MS, "HTTP timeout")
  assertBoundedInteger(maxResponseBytes, 1, MAX_HTTP_RESPONSE_BYTES, "HTTP maximum response bytes")
  const context = { fetchImpl, timeoutMs, maxResponseBytes }

  return {
    getJson(request) {
      return get(context, request, "json")
    },
    getText(request) {
      return get(context, request, "text")
    },
    getBinary(request) {
      return get(context, request, "binary")
    },
  }
}

async function get(context, request, bodyType) {
  const { href, headers, signal, timeoutMs, maxResponseBytes } = normalizeRequest(request, context)
  if (signal?.aborted === true) {
    return transportError(null, "ABORTED")
  }
  const deadline = createDeadline(timeoutMs, signal)
  let response
  try {
    response = await deadline.race(
      context.fetchImpl(href, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: deadline.signal,
      }),
    )
  } catch (error) {
    deadline.dispose()
    return transportError(null, deadline.code(error))
  }

  let statusValue
  let responseHeadersObject
  let responseBody
  try {
    statusValue = response?.status
    responseHeadersObject = response?.headers
    responseBody = response?.body
  } catch {
    deadline.dispose()
    return transportError(null, "MALFORMED_RESPONSE")
  }
  const httpStatus = Number.isInteger(statusValue) ? statusValue : null
  if (
    response === null ||
    typeof response !== "object" ||
    httpStatus === null ||
    httpStatus < 100 ||
    httpStatus > 599 ||
    responseHeadersObject === null ||
    typeof responseHeadersObject !== "object" ||
    typeof responseHeadersObject.get !== "function"
  ) {
    await safelyCancelBody(responseBody)
    deadline.dispose()
    return transportError(httpStatus, "MALFORMED_RESPONSE")
  }

  let responseHeaders
  let declaredLength
  let contentType
  try {
    responseHeaders = normalizedResponseHeaders(responseHeadersObject)
    declaredLength = responseHeadersObject.get("content-length")
    contentType = responseHeadersObject.get("content-type")
  } catch {
    await safelyCancelBody(responseBody)
    deadline.dispose()
    return transportError(httpStatus, "MALFORMED_RESPONSE")
  }
  if (httpStatus >= 300 && httpStatus < 400) {
    await safelyCancelBody(responseBody)
    deadline.dispose()
    return transportError(httpStatus, "REDIRECT", { headers: responseHeaders })
  }
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      await safelyCancelBody(responseBody)
      deadline.dispose()
      return transportError(httpStatus, "MALFORMED_RESPONSE")
    }
    if (BigInt(declaredLength) > BigInt(maxResponseBytes)) {
      await safelyCancelBody(responseBody)
      deadline.dispose()
      return transportError(httpStatus, "RESPONSE_TOO_LARGE")
    }
  }

  if (!contentTypeMatches(bodyType, contentType)) {
    await safelyCancelBody(responseBody)
    deadline.dispose()
    return transportError(httpStatus, "UNEXPECTED_CONTENT_TYPE")
  }

  let bytes
  try {
    bytes = await readBoundedBody(responseBody, maxResponseBytes, deadline)
  } catch (error) {
    deadline.dispose()
    return transportError(httpStatus, bodyReadCode(error, deadline))
  }
  deadline.dispose()

  if (bodyType === "binary") {
    return transportSuccess(httpStatus, responseHeaders, {
      bodyBytes: bytes.byteLength,
      contentBase64: Buffer.from(bytes).toString("base64"),
    })
  }

  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return transportError(httpStatus, bodyType === "json" ? "MALFORMED_JSON" : "MALFORMED_TEXT")
  }
  if (bodyType === "text") {
    return transportSuccess(httpStatus, responseHeaders, {
      bodyBytes: bytes.byteLength,
      body: text,
    })
  }
  try {
    return transportSuccess(httpStatus, responseHeaders, {
      bodyBytes: bytes.byteLength,
      body: JSON.parse(text),
    })
  } catch {
    return transportError(httpStatus, "MALFORMED_JSON")
  }
}

function normalizeRequest(request, context) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Invalid HTTP request")
  }
  let url
  try {
    url = new URL(request.url)
  } catch {
    throw new TypeError("Invalid HTTP URL")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Invalid HTTP URL")
  }
  const headers = normalizeRequestHeaders(request.headers)
  const timeoutMs = normalizeRequestLimit(
    request.timeoutMs,
    context.timeoutMs,
    "HTTP request timeout",
  )
  const maxResponseBytes = normalizeRequestLimit(
    request.maxResponseBytes,
    context.maxResponseBytes,
    "HTTP request maximum response bytes",
  )
  const signal = request.signal
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new TypeError("Invalid HTTP abort signal")
  }
  return { href: url.href, headers, signal: signal ?? null, timeoutMs, maxResponseBytes }
}

function normalizeRequestLimit(value, configuredMaximum, label) {
  if (value === undefined) {
    return configuredMaximum
  }
  assertBoundedInteger(value, 1, configuredMaximum, label)
  return value
}

function normalizeRequestHeaders(value) {
  if (value === undefined) {
    return {}
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("Invalid HTTP request headers")
  }
  const result = {}
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9-]+$/u.test(name) ||
      typeof headerValue !== "string" ||
      /[\r\n]/u.test(headerValue)
    ) {
      throw new TypeError("Invalid HTTP request headers")
    }
    result[name] = headerValue
  }
  return result
}

function normalizedResponseHeaders(headers) {
  const link = headers.get("link")
  const location = headers.get("location")
  const rateLimitRemaining = headers.get("x-ratelimit-remaining")
  if (
    (link !== null && typeof link !== "string") ||
    (location !== null && typeof location !== "string") ||
    (rateLimitRemaining !== null && typeof rateLimitRemaining !== "string")
  ) {
    throw new TypeError("Malformed HTTP response headers")
  }
  return { link, location, rateLimitRemaining }
}

function contentTypeMatches(bodyType, value) {
  if (typeof value !== "string") {
    return false
  }
  if (bodyType === "json") {
    return JSON_CONTENT_TYPE.test(value)
  }
  if (bodyType === "text") {
    return TEXT_CONTENT_TYPE.test(value)
  }
  return BINARY_CONTENT_TYPES.has(value.split(";", 1)[0].trim().toLowerCase())
}

async function readBoundedBody(body, maxResponseBytes, deadline) {
  if (body === null) {
    return new Uint8Array()
  }
  if (typeof body !== "object" || typeof body.getReader !== "function") {
    throw new BodyReadError("MALFORMED_RESPONSE")
  }
  const reader = body.getReader()
  if (
    reader === null ||
    typeof reader !== "object" ||
    typeof reader.read !== "function" ||
    typeof reader.releaseLock !== "function"
  ) {
    throw new BodyReadError("MALFORMED_RESPONSE")
  }
  const chunks = []
  let size = 0
  try {
    while (true) {
      const result = await deadline.race(reader.read())
      if (
        result === null ||
        typeof result !== "object" ||
        typeof result.done !== "boolean" ||
        (result.done === false && !(result.value instanceof Uint8Array))
      ) {
        throw new BodyReadError("MALFORMED_RESPONSE")
      }
      if (result.done) {
        break
      }
      size += result.value.byteLength
      if (size > maxResponseBytes) {
        safelyCancel(reader)
        throw new BodyReadError("RESPONSE_TOO_LARGE")
      }
      chunks.push(result.value)
    }
  } catch (error) {
    safelyCancel(reader)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function safelyCancel(reader) {
  if (typeof reader.cancel === "function") {
    try {
      Promise.resolve(reader.cancel()).catch(() => {})
    } catch {
      // The bounded read has already failed closed.
    }
  }
}

function safelyCancelBody(body) {
  if (body !== null && typeof body === "object" && typeof body.cancel === "function") {
    try {
      Promise.resolve(body.cancel()).catch(() => {})
    } catch {
      // Preserve the primary fail-closed result.
    }
  }
}

function createDeadline(timeoutMs, callerSignal) {
  const controller = new AbortController()
  let abortCode = null
  let rejectAbort
  const abortPromise = new Promise((_resolve, reject) => {
    rejectAbort = reject
  })
  const abort = (code) => {
    if (abortCode === null) {
      abortCode = code
      controller.abort()
      rejectAbort(new DeadlineError())
    }
  }
  const onCallerAbort = () => abort("ABORTED")
  if (callerSignal?.aborted === true) {
    onCallerAbort()
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
  }
  const timer = setTimeout(() => abort("TIMEOUT"), timeoutMs)
  return {
    signal: controller.signal,
    race(promise) {
      return Promise.race([Promise.resolve(promise), abortPromise])
    },
    code(error) {
      return abortCode ?? (error?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR")
    },
    dispose() {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)
    },
  }
}

function bodyReadCode(error, deadline) {
  return error instanceof BodyReadError ? error.code : deadline.code(error)
}

class BodyReadError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

class DeadlineError extends Error {}

function transportSuccess(httpStatus, headers, body) {
  return {
    status: httpStatus >= 200 && httpStatus < 300 ? "OK" : "HTTP_ERROR",
    httpStatus,
    code: null,
    headers,
    ...body,
  }
}

function transportError(httpStatus, code, details = {}) {
  return { status: "ERROR", httpStatus, code, ...details }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ${label}: ${String(value)}`)
  }
}
