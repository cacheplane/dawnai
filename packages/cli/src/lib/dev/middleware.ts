import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Dawn middleware hook — runs before route execution.
 * Return a response to short-circuit, or undefined to continue.
 */
export interface DawnMiddleware {
  (context: MiddlewareContext): Promise<MiddlewareResult> | MiddlewareResult
}

export interface MiddlewareContext {
  readonly request: IncomingMessage
  readonly routeId: string
  readonly assistantId: string
}

export type MiddlewareResult =
  | { readonly action: "continue"; readonly context?: Record<string, unknown> }
  | { readonly action: "reject"; readonly status: number; readonly body: unknown }

/**
 * Load middleware hooks from the app's middleware.ts file.
 * Convention: src/middleware.ts exports a default function or array.
 */
export async function loadMiddleware(appRoot: string): Promise<readonly DawnMiddleware[]> {
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
        return [exported as DawnMiddleware]
      }

      if (Array.isArray(exported)) {
        return exported.filter((fn): fn is DawnMiddleware => typeof fn === "function")
      }
    } catch {
      // File doesn't exist or can't be loaded — try next
    }
  }

  return []
}

/**
 * Run middleware chain. Returns the first rejection, or continue with merged context.
 */
export async function runMiddleware(
  middlewares: readonly DawnMiddleware[],
  context: MiddlewareContext,
): Promise<MiddlewareResult> {
  let mergedContext: Record<string, unknown> = {}

  for (const mw of middlewares) {
    const result = await mw(context)

    if (result.action === "reject") {
      return result
    }

    if (result.context) {
      mergedContext = { ...mergedContext, ...result.context }
    }
  }

  return { action: "continue", context: mergedContext }
}
