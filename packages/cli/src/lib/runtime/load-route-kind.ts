import { pathToFileURL } from "node:url"

import { normalizeRouteModule } from "@dawn/langgraph"
import type { RouteKind } from "@dawn/sdk"

import { registerTsxLoader } from "./register-tsx-loader.js"

export async function loadRouteKind(routeFile: string): Promise<RouteKind> {
  await registerTsxLoader()
  const routeModule = await import(pathToFileURL(routeFile).href)

  try {
    return normalizeRouteModule(routeModule).kind
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Route index.ts exports neither "workflow" nor "graph"`
    ) {
      throw new Error(`Route index.ts at ${routeFile} exports neither "workflow" nor "graph"`, {
        cause: error,
      })
    }

    throw error
  }
}
