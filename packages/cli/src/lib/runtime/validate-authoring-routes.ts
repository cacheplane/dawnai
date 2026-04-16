import type { RouteManifest } from "@dawn/core"

import { loadAuthoringRouteDefinition, loadAuthoringRouteHandler } from "./route-definition.js"
import { discoverToolDefinitions } from "./tool-discovery.js"

export async function validateAuthoringRoutes(manifest: RouteManifest): Promise<void> {
  for (const route of manifest.routes) {
    if (route.entryKind !== "route") {
      continue
    }

    const definition = await loadAuthoringRouteDefinition(route.entryFile)

    if (!definition) {
      throw new Error(`Route definition ${route.entryFile} must export a Dawn route definition`)
    }

    await loadAuthoringRouteHandler(definition)
    await discoverToolDefinitions({
      appRoot: manifest.appRoot,
      routeDir: route.routeDir,
    })
  }
}
