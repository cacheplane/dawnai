import { pathToFileURL } from "node:url"
import type { NormalizedRouteModule } from "@dawn-ai/core"
import type { RouteKind } from "@dawn-ai/sdk"

import { importModule } from "./import-module.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import { normalizeRouteModuleObject } from "./route-module-shape.js"

export type { NormalizedRouteModule } from "@dawn-ai/core"
export { normalizeRouteModuleObject } from "./route-module-shape.js"

export async function loadRouteKind(routeFile: string): Promise<RouteKind> {
  const normalized = await normalizeRouteModule(routeFile)
  return normalized.kind
}

export async function normalizeRouteModule(
  routeFile: string,
  appRoot?: string,
): Promise<NormalizedRouteModule> {
  await registerTsxLoader()
  const routeModule = await importModule(pathToFileURL(routeFile).href, {
    kind: "route",
    ...(appRoot ? { appRoot } : {}),
    sourcePath: routeFile,
  })
  return normalizeRouteModuleObject(routeModule, routeFile)
}
