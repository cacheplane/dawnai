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
