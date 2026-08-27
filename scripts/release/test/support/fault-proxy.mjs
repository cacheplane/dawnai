import { createServer, request as httpRequest } from "node:http"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import { startupRollbackError, validateLifecycleHooks } from "./startup-lifecycle.mjs"

const LOOPBACK = "127.0.0.1"
const MAX_FORWARD_BYTES = 4 * 1024 * 1024
const FORWARD_TIMEOUT_MS = 5_000
const STARTUP_TIMEOUT_MS = 2_000
const SHUTDOWN_TIMEOUT_MS = 2_000
const MODES = new Set([
  "normal",
  "delayed-visibility",
  "stall",
  "unauthorized",
  "forbidden",
  "exact-version-e404",
  "package-e404",
  "rate-limited",
  "malformed-json",
  "server-error",
  "unavailable",
])

export async function startFaultProxy({
  upstreamUrl,
  forwardDeadlineMs = FORWARD_TIMEOUT_MS,
  signal,
  lifecycle = {},
}) {
  const cancellation = optionalAbortSignal(signal)
  cancellation?.throwIfAborted()
  const hooks = validateLifecycleHooks(
    lifecycle,
    ["afterListen", "rollbackCloseServer"],
    "Fault proxy",
  )
  const upstream = loopbackUrl(upstreamUrl, "fault proxy upstream")
  if (
    !Number.isSafeInteger(forwardDeadlineMs) ||
    forwardDeadlineMs < 10 ||
    forwardDeadlineMs > 30_000
  ) {
    throw new TypeError("Fault proxy forwarding deadline is invalid")
  }
  let mode = "normal"
  let misses = 0
  let abortedRequests = 0
  let activeForwards = 0
  const abortWaiters = new Set()
  const sockets = new Set()
  const server = createServer((request, response) => {
    routeRequest({
      request,
      response,
      upstream,
      currentMode: () => mode,
      consumeMiss: () => {
        if (misses <= 0) return false
        misses -= 1
        return true
      },
      recordAbort: () => {
        abortedRequests += 1
        for (const resolve of abortWaiters) resolve()
        abortWaiters.clear()
      },
      forwardDeadlineMs,
      recordForwardStart: () => {
        activeForwards += 1
      },
      recordForwardEnd: () => {
        activeForwards -= 1
      },
    }).catch(() => {
      if (!response.headersSent) jsonResponse(response, 502, { code: "PROXY_FAILURE" })
      else response.destroy()
    })
  })
  server.requestTimeout = FORWARD_TIMEOUT_MS + 1_000
  server.headersTimeout = FORWARD_TIMEOUT_MS + 1_000
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  let identity
  try {
    await abortable(
      deadline(
        new Promise((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, LOOPBACK, resolve)
        }),
        STARTUP_TIMEOUT_MS,
        "fault proxy readiness",
      ),
      cancellation,
    )
    cancellation?.throwIfAborted()
    const address = server.address()
    if (address === null || typeof address === "string" || address.address !== LOOPBACK) {
      throw new Error("Fault proxy did not bind to loopback")
    }
    identity = Object.freeze({
      url: `http://${LOOPBACK}:${address.port}/`,
    })
    await abortable(
      Promise.resolve().then(() => hooks.afterListen?.(identity)),
      cancellation,
    )
    cancellation?.throwIfAborted()
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      deadline(
        Promise.resolve().then(() =>
          hooks.rollbackCloseServer === undefined
            ? closeServer(server, sockets)
            : hooks.rollbackCloseServer(() => closeServer(server, sockets)),
        ),
        SHUTDOWN_TIMEOUT_MS,
        "fault proxy rollback",
      ),
    ])
    const rollbackError = startupRollbackError({
      initiatingError: error,
      cancellation,
      cleanupResults,
      rollbackCode: "FAULT_PROXY_ROLLBACK_FAILED",
      cleanupCode: "FAULT_PROXY_ROLLBACK_CLEANUP_FAILED",
      message: "Fault proxy startup rollback failed",
    })
    if (rollbackError !== null) throw rollbackError
    if (cancellation?.aborted) throw cancellation.reason
    throw new Error("Fault proxy startup failed")
  }
  let closePromise = null
  return Object.freeze({
    url: identity.url,
    setMode(nextMode, options = {}) {
      if (!MODES.has(nextMode)) throw new TypeError("Unknown fault mode")
      if (nextMode === "delayed-visibility") {
        if (
          Object.keys(options).some((key) => key !== "misses") ||
          !Number.isSafeInteger(options.misses) ||
          options.misses < 1 ||
          options.misses > 100
        ) {
          throw new TypeError("Delayed visibility requires bounded misses")
        }
        misses = options.misses
      } else {
        if (Object.keys(options).length !== 0) throw new TypeError("Fault mode options are invalid")
        misses = 0
      }
      mode = nextMode
    },
    reset() {
      mode = "normal"
      misses = 0
    },
    snapshot() {
      return Object.freeze({
        mode,
        remainingVisibilityMisses: misses,
        abortedRequests,
        activeForwards,
        openSockets: sockets.size,
      })
    },
    waitForNextAbort() {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          abortWaiters.delete(onAbort)
          reject(new Error("Timed out waiting for stalled client abort"))
        }, 1_000)
        const onAbort = () => {
          clearTimeout(timeout)
          resolve()
        }
        abortWaiters.add(onAbort)
      })
    },
    close() {
      if (closePromise !== null) return closePromise
      closePromise = deadline(
        closeServer(server, sockets),
        SHUTDOWN_TIMEOUT_MS,
        "fault proxy shutdown",
      ).catch(() => {
        closePromise = null
        throw new Error("Fault proxy cleanup failed")
      })
      return closePromise
    },
  })
}

function optionalAbortSignal(value) {
  if (value === undefined) return null
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("Fault proxy signal is invalid")
  }
  return value
}

function abortable(promise, signal) {
  if (signal === null) return promise
  signal.throwIfAborted()
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort)
  })
}

async function routeRequest({
  request,
  response,
  upstream,
  currentMode,
  consumeMiss,
  recordAbort,
  forwardDeadlineMs,
  recordForwardStart,
  recordForwardEnd,
}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    jsonResponse(response, 405, { code: "METHOD_NOT_ALLOWED" })
    return
  }
  const requestTarget = request.url ?? "/"
  if (requestTarget.startsWith("//")) {
    jsonResponse(response, 400, { code: "INVALID_TARGET" })
    return
  }
  let target
  try {
    target = new URL(requestTarget, upstream)
  } catch {
    jsonResponse(response, 400, { code: "INVALID_TARGET" })
    return
  }
  if (target.origin !== upstream.origin) {
    jsonResponse(response, 400, { code: "INVALID_TARGET" })
    return
  }
  const exactVersionRequest = target.pathname.split("/").filter(Boolean).length >= 2
  const mode = currentMode()
  if (mode === "delayed-visibility" && exactVersionRequest && consumeMiss()) {
    jsonResponse(response, 404, { code: "E404" })
    return
  }
  if (mode === "stall") {
    let recorded = false
    const recordOnce = () => {
      if (recorded || response.writableEnded) return
      recorded = true
      recordAbort()
    }
    request.once("aborted", recordOnce)
    response.once("close", recordOnce)
    return
  }
  if (mode === "unauthorized") return jsonResponse(response, 401, { code: "EAUTH" })
  if (mode === "forbidden") return jsonResponse(response, 403, { code: "E403" })
  if (mode === "rate-limited") return jsonResponse(response, 429, { code: "ERATELIMIT" })
  if (mode === "server-error") return jsonResponse(response, 500, { code: "E500" })
  if (mode === "unavailable") return jsonResponse(response, 503, { code: "E503" })
  if (mode === "exact-version-e404" && exactVersionRequest) {
    return jsonResponse(response, 404, { code: "E404" })
  }
  if (mode === "package-e404" && !exactVersionRequest) {
    return jsonResponse(response, 404, { code: "E404" })
  }
  if (mode === "malformed-json") {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end("{")
    return
  }
  recordForwardStart()
  try {
    await forward({
      request,
      response,
      upstream,
      path: `${target.pathname}${target.search}`,
      forwardDeadlineMs,
    })
  } finally {
    recordForwardEnd()
  }
}

async function forward({ request, response, upstream, path, forwardDeadlineMs }) {
  let upstreamRequest
  let upstreamResponse
  let deadlineTimer
  const deadlineError = new Error("upstream request exceeded its deadline")
  const deadlinePromise = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      upstreamResponse?.destroy(deadlineError)
      upstreamRequest?.destroy(deadlineError)
      response.destroy(deadlineError)
      reject(deadlineError)
    }, forwardDeadlineMs)
  })
  const operation = new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    upstreamRequest = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path,
        headers:
          typeof request.headers.accept === "string" ? { Accept: request.headers.accept } : {},
        timeout: FORWARD_TIMEOUT_MS,
      },
      (incoming) => {
        upstreamResponse = incoming
        const declaredLength = Number(incoming.headers["content-length"])
        if (
          incoming.headers["content-length"] !== undefined &&
          (!Number.isSafeInteger(declaredLength) ||
            declaredLength < 0 ||
            declaredLength > MAX_FORWARD_BYTES)
        ) {
          incoming.destroy(new Error("upstream response size is invalid"))
          settle(reject, new Error("upstream response size is invalid"))
          return
        }
        const responseHeaders = {}
        if (typeof incoming.headers["content-type"] === "string") {
          responseHeaders["Content-Type"] = incoming.headers["content-type"]
        }
        if (Number.isSafeInteger(declaredLength)) responseHeaders["Content-Length"] = declaredLength
        response.writeHead(incoming.statusCode ?? 502, responseHeaders)
        let bytes = 0
        const limiter = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length
            callback(
              bytes > MAX_FORWARD_BYTES ? new Error("upstream response too large") : null,
              bytes > MAX_FORWARD_BYTES ? undefined : chunk,
            )
          },
        })
        incoming.once("aborted", () => settle(reject, new Error("upstream response aborted")))
        incoming.once("close", () => {
          if (!incoming.complete) settle(reject, new Error("upstream response closed prematurely"))
        })
        pipeline(incoming, limiter, response).then(
          () => settle(resolve),
          (error) => settle(reject, error),
        )
      },
    )
    upstreamRequest.once("timeout", () => upstreamRequest.destroy(new Error("upstream timeout")))
    upstreamRequest.once("error", (error) => settle(reject, error))
    response.once("close", () => upstreamRequest.destroy())
    upstreamRequest.end()
  })
  try {
    await Promise.race([operation, deadlinePromise])
  } finally {
    clearTimeout(deadlineTimer)
  }
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  })
  response.end(body)
}

function loopbackUrl(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`Invalid ${label}`)
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new TypeError(`Invalid ${label}`)
  }
  return url
}

async function closeServer(server, sockets) {
  await new Promise((resolve, reject) => {
    server.close((error) =>
      error === undefined || error?.code === "ERR_SERVER_NOT_RUNNING" ? resolve() : reject(error),
    )
    for (const socket of sockets) socket.destroy()
  })
  sockets.clear()
}

function deadline(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
