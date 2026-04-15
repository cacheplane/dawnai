import { discoverRoutes } from "@dawn/core"

import { createRouteAssistantId } from "../runtime/route-identity.js"

export interface RuntimeRegistryEntry {
  readonly assistantId: string
  readonly mode: "graph" | "workflow"
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
    const executable = resolveExecutableRoute(route)

    if (!executable) {
      continue
    }

    const entry = {
      assistantId: createRouteAssistantId(route.id, executable.mode),
      mode: executable.mode,
      routeFile: executable.routeFile,
      routeId: route.id,
      routePath: executable.routeFile
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

function isExecutableRoute(kind: string): kind is "graph" | "workflow" {
  return kind === "graph" || kind === "workflow"
}

function resolveExecutableRoute(route: {
  readonly boundEntryFile?: string
  readonly boundEntryKind?: string
  readonly entryFile: string
  readonly entryKind: string
}): { readonly mode: "graph" | "workflow"; readonly routeFile: string } | null {
  if (isExecutableRoute(route.entryKind)) {
    return {
      mode: route.entryKind,
      routeFile: route.entryFile,
    }
  }

  if (
    typeof route.boundEntryKind === "string" &&
    isExecutableRoute(route.boundEntryKind) &&
    typeof route.boundEntryFile === "string"
  ) {
    return {
      mode: route.boundEntryKind,
      routeFile: route.boundEntryFile,
    }
  }

  return null
}
