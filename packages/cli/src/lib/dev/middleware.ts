import type { IncomingMessage } from "node:http"
import type { DawnMiddleware, MiddlewareRequest, MiddlewareResult } from "@dawn-ai/sdk"

/**
 * Select the middleware function from a module namespace: the `default`
 * export when present (nullish falls through), else the named `middleware`
 * export; undefined when neither resolves to a function. The ONE selection
 * rule, shared by the dynamic probe below and the static manifest's
 * `normalizeMiddlewareModule` — built apps can never bind differently than dev.
 */
export function selectMiddlewareExport(mod: unknown): DawnMiddleware | undefined {
  if (!mod || typeof mod !== "object") return undefined
  const candidate = mod as { readonly default?: unknown; readonly middleware?: unknown }
  const exported = candidate.default ?? candidate.middleware
  return typeof exported === "function" ? (exported as DawnMiddleware) : undefined
}

/**
 * Load middleware from the app's middleware.ts file.
 * Convention: src/middleware.ts exports a default function (using defineMiddleware).
 */
export async function loadMiddleware(appRoot: string): Promise<DawnMiddleware | undefined> {
  const middlewarePaths = [
    `${appRoot}/src/middleware.ts`,
    `${appRoot}/src/middleware.js`,
    `${appRoot}/middleware.ts`,
    `${appRoot}/middleware.js`,
  ]

  for (const path of middlewarePaths) {
    try {
      const selected = selectMiddlewareExport(await import(path))
      if (selected) return selected
    } catch {
      // File doesn't exist or can't be loaded — try next
    }
  }

  return undefined
}

/**
 * Run middleware. Returns continue (with optional context) or reject.
 */
export async function runMiddleware(
  middleware: DawnMiddleware | undefined,
  request: MiddlewareRequest,
): Promise<MiddlewareResult> {
  if (!middleware) {
    return { action: "continue" }
  }

  return await middleware(request)
}

/** Flatten a web `Headers` object into a string map for MiddlewareRequest. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  // `Headers` iteration yields each `set-cookie` value as a separate entry, so
  // the loop above would keep only the last one. The pre-refactor Node path
  // (`parseHeaders`) joined repeated headers with ", " — preserve that shape.
  const setCookie = headers.getSetCookie?.() ?? []
  if (setCookie.length > 1) {
    record["set-cookie"] = setCookie.join(", ")
  }
  return record
}

/** Flatten an IncomingMessage's headers into a string map for MiddlewareRequest. */
export function parseHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ")
    }
  }
  return headers
}

/** Pull `[param]` route-param values out of the run input, for MiddlewareRequest.params. */
export function extractRouteParams(routeId: string, input: unknown): Record<string, string> {
  const params: Record<string, string> = {}
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  const inputRecord = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >

  for (const match of matches) {
    const name = match[1]
    if (name && name in inputRecord) {
      params[name] = String(inputRecord[name])
    }
  }

  return params
}
