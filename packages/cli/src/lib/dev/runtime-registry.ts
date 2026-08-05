import { dirname } from "node:path"

import {
  discoverRoutes,
  type RouteDefinition,
  type RouteManifest,
  toRouteSegments,
} from "@dawn-ai/core"

import { createRouteAssistantId } from "../runtime/route-identity.js"
import type { DawnStaticModules } from "../runtime/static-modules.js"

export interface RuntimeRegistryEntry {
  readonly assistantId: string
  readonly mode: "agent" | "chain" | "graph" | "workflow"
  readonly routeId: string
  readonly routePath: string
  readonly routeFile: string
}

export interface RuntimeRegistry {
  readonly appRoot: string
  readonly lookup: (assistantId: string) => RuntimeRegistryEntry | null
  readonly entries: readonly RuntimeRegistryEntry[]
  /**
   * The boot-time route manifest the entries were derived from. The HTTP
   * handlers thread this into route execution (`routeManifest`) so no request
   * ever re-walks the route tree, and so the manifest's stable object
   * identity keeps identity-keyed caches (descriptor route map) warm.
   * Optional so hand-rolled test registries stay valid.
   */
  readonly manifest?: RouteManifest
}

export async function createRuntimeRegistry(
  appRoot: string,
  modules?: DawnStaticModules,
): Promise<RuntimeRegistry> {
  if (modules) {
    return createStaticRuntimeRegistry(appRoot, modules)
  }

  const manifest = await discoverRoutes({ appRoot })
  const entries: RuntimeRegistryEntry[] = []

  for (const route of manifest.routes) {
    const entry = {
      assistantId: createRouteAssistantId(route.id, route.kind),
      mode: route.kind,
      routeFile: route.entryFile,
      routeId: route.id,
      routePath: route.entryFile
        .slice(manifest.appRoot.length + 1)
        .split("\\")
        .join("/"),
    } satisfies RuntimeRegistryEntry

    entries.push(entry)
  }

  return {
    appRoot: manifest.appRoot,
    entries,
    lookup: (assistantId: string) =>
      entries.find((entry) => entry.assistantId === assistantId) ?? null,
    manifest,
  }
}

/**
 * Build a registry from a prebuilt `DawnStaticModules` manifest — zero
 * filesystem access, no route-file imports. Used when the runtime boots from
 * a build-time-generated module manifest (PR 2's static-wiring seam).
 *
 * The `RouteManifest` field is synthesized from the static entries (rather
 * than left absent) so every downstream consumer that threads `manifest`
 * through `routeManifest` (capability resolution, the subagent
 * descriptor-route map, `dawn check`) keeps working unmodified — it only
 * ever reads route identity/shape fields, never re-imports `entryFile`.
 */
function createStaticRuntimeRegistry(appRoot: string, modules: DawnStaticModules): RuntimeRegistry {
  const entries: RuntimeRegistryEntry[] = modules.routes.map(
    (route) =>
      ({
        assistantId: route.assistantId,
        mode: route.kind,
        routeFile: route.routeFile,
        routeId: route.routeId,
        routePath: route.routePath,
      }) satisfies RuntimeRegistryEntry,
  )

  const routes: RouteDefinition[] = modules.routes.map((route) => {
    const segments = route.routeId
      .replace(/^\//, "")
      .split("/")
      .filter((segment) => segment.length > 0)

    return {
      entryFile: route.routeFile,
      id: route.routeId,
      kind: route.kind,
      pathname: route.routeId,
      routeDir: dirname(route.routeFile),
      segments: toRouteSegments(segments),
    } satisfies RouteDefinition
  })

  const manifest: RouteManifest = { appRoot, routes }

  return {
    appRoot,
    entries,
    lookup: (assistantId: string) =>
      entries.find((entry) => entry.assistantId === assistantId) ?? null,
    manifest,
  }
}
