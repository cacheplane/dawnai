import { discoverRoutes } from "@dawn-ai/core"

import { createRouteAssistantId } from "../runtime/route-identity.js"

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
}

export async function createRuntimeRegistry(appRoot: string): Promise<RuntimeRegistry> {
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
  }
}
