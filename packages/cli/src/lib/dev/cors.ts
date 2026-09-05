/**
 * CORS for the Dawn runtime.
 *
 * Off unless `dawn.config.ts` sets `server.cors`. A Dawn server with no CORS
 * config answers exactly as it did before this module existed — no
 * `Access-Control-*` header on any response, and `OPTIONS` still falling
 * through the route table to its 404. That default is deliberate: turning on
 * cross-origin access is a deployment decision, not something a framework
 * should assume.
 *
 * Everything here is pure — `Request` in, header decisions out — so the policy
 * is tested directly rather than through a live server.
 */

import type { CorsConfig } from "@dawn-ai/core"

export type { CorsConfig }

/** The config after validation, with defaults resolved. */
export interface CorsPolicy {
  readonly allowAnyOrigin: boolean
  readonly origins: ReadonlySet<string>
  readonly credentials: boolean
  readonly methods: readonly string[]
  readonly headers?: readonly string[]
  readonly exposeHeaders: readonly string[]
  readonly maxAgeSeconds: number
}

/** Every method the route table serves, plus the preflight method itself. */
const DEFAULT_METHODS = ["GET", "POST", "DELETE", "OPTIONS"] as const
const DEFAULT_MAX_AGE_SECONDS = 600

export class CorsConfigError extends Error {
  constructor(message: string) {
    super(`Invalid server.cors config — ${message}`)
    this.name = "CorsConfigError"
  }
}

/**
 * An origin as the `Origin` header serializes it: scheme + host + optional
 * port, lowercased, no trailing slash. Config is normalized the same way so
 * that `"http://localhost:3010/"` in a config file still matches.
 */
function normalizeOrigin(value: string): string {
  const trimmed = value.trim()
  if (trimmed === "null") return "null"
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new CorsConfigError(
      `"${value}" is not a valid origin. Use scheme://host[:port], e.g. "http://localhost:3010".`,
    )
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new CorsConfigError(
      `"${value}" is not an origin — it carries a path, query or fragment. Use just scheme://host[:port].`,
    )
  }
  return url.origin.toLowerCase()
}

/**
 * Validate and resolve `server.cors`. Returns undefined when CORS is off,
 * which every caller treats as "change nothing about the response".
 *
 * Throws at boot rather than per request: a bad origin list is a config
 * mistake the operator should learn about when the server starts, not on the
 * first cross-origin call.
 */
export function resolveCorsPolicy(config: CorsConfig | undefined): CorsPolicy | undefined {
  if (config === undefined) return undefined
  const credentials = config.credentials ?? false
  const allowAnyOrigin = config.origins === "*"

  if (allowAnyOrigin && credentials) {
    throw new CorsConfigError(
      'origins: "*" cannot be combined with credentials: true — browsers reject a wildcard ' +
        "allow-origin on a credentialed request. List the origins explicitly instead.",
    )
  }
  if (!allowAnyOrigin && config.origins.length === 0) {
    throw new CorsConfigError(
      "origins is empty, so no cross-origin request could ever succeed. Remove server.cors to " +
        'turn CORS off, or list at least one origin (or "*").',
    )
  }

  return {
    allowAnyOrigin,
    origins: allowAnyOrigin
      ? new Set<string>()
      : new Set(config.origins.map((origin) => normalizeOrigin(origin))),
    credentials,
    methods: config.methods ?? [...DEFAULT_METHODS],
    ...(config.headers ? { headers: config.headers } : {}),
    exposeHeaders: config.exposeHeaders ?? [],
    maxAgeSeconds: config.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
  }
}

function isAllowedOrigin(policy: CorsPolicy, origin: string): boolean {
  if (policy.allowAnyOrigin) return true
  return policy.origins.has(origin.toLowerCase())
}

/**
 * The `Access-Control-*` headers that belong on an actual (non-preflight)
 * response, or undefined when the request gets none — no policy, no `Origin`
 * header (a same-origin or non-browser caller), or an origin not on the list.
 *
 * A disallowed origin is NOT an error: the response goes back unchanged and
 * the browser is the thing that refuses to hand it to the page. Rejecting with
 * a 403 here would break every non-browser client that happens to send an
 * `Origin`.
 */
export function corsResponseHeaders(
  policy: CorsPolicy | undefined,
  request: Request,
): Record<string, string> | undefined {
  if (policy === undefined) return undefined
  const origin = request.headers.get("origin")
  if (origin === null) return undefined
  if (!isAllowedOrigin(policy, origin)) return undefined

  const headers: Record<string, string> = {
    // Echoed rather than `*` even in the any-origin case, so that one code
    // path serves both and the credentialed case cannot regress into an
    // invalid wildcard. `Vary` is then mandatory: without it a shared cache
    // could hand origin A the response minted for origin B.
    "access-control-allow-origin": origin,
    vary: "Origin",
  }
  if (policy.credentials) headers["access-control-allow-credentials"] = "true"
  if (policy.exposeHeaders.length > 0) {
    headers["access-control-expose-headers"] = policy.exposeHeaders.join(", ")
  }
  return headers
}

/**
 * A preflight response, or undefined when this request is not a preflight and
 * should continue to the route table.
 *
 * A preflight is `OPTIONS` + `Origin` + `Access-Control-Request-Method`. A
 * bare `OPTIONS` is not one, and deliberately falls through to the router's
 * 404 — the runtime serves no `OPTIONS` route, and answering 204 to any
 * `OPTIONS` would claim otherwise.
 */
export function corsPreflightResponse(
  policy: CorsPolicy | undefined,
  request: Request,
): Response | undefined {
  if (policy === undefined) return undefined
  if (request.method !== "OPTIONS") return undefined
  const origin = request.headers.get("origin")
  const requestedMethod = request.headers.get("access-control-request-method")
  if (origin === null || requestedMethod === null) return undefined

  // An origin off the list gets a 403 rather than a silent 204 without
  // headers. Both make the browser block the real request; only this one is
  // legible in a network panel, and a preflight has no non-browser caller to
  // break (unlike an actual request, which is why that path stays a 200).
  if (!isAllowedOrigin(policy, origin)) {
    return new Response(null, { status: 403 })
  }

  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": policy.methods.join(", "),
    "access-control-max-age": String(policy.maxAgeSeconds),
    // Both inputs vary the answer: Origin picks the allow-origin, and the
    // requested-headers echo below is copied straight from the request.
    vary: "Origin, Access-Control-Request-Headers",
  }
  if (policy.credentials) headers["access-control-allow-credentials"] = "true"

  const requestedHeaders = request.headers.get("access-control-request-headers")
  const allowHeaders = policy.headers?.join(", ") ?? requestedHeaders
  if (allowHeaders !== null && allowHeaders !== undefined && allowHeaders !== "") {
    headers["access-control-allow-headers"] = allowHeaders
  }

  return new Response(null, { headers, status: 204 })
}

/**
 * Stamp CORS headers onto a response that is already built.
 *
 * Mutates `response.headers` in place instead of rebuilding the Response. That
 * matters for the SSE routes: re-wrapping a streaming body would be a second
 * `new Response(body)` around a stream the runtime is already tracking for
 * lifetime purposes, and the header guard on a constructed Response permits
 * `set()`, so there is nothing to gain from the copy.
 */
export function applyCorsHeaders(
  policy: CorsPolicy | undefined,
  request: Request,
  response: Response,
): Response {
  const headers = corsResponseHeaders(policy, request)
  if (headers === undefined) return response
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value)
  }
  return response
}
