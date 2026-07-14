import type { IncomingMessage } from "node:http"
import type { DawnMiddleware, MiddlewareRequest, MiddlewareResult } from "@dawn-ai/sdk"

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
      const mod = await import(path)
      const exported = mod.default ?? mod.middleware

      if (typeof exported === "function") {
        return exported as DawnMiddleware
      }
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
