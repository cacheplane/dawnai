import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"

import { findDawnApp } from "@dawn/core"

import { createRouteAssistantId, deriveRouteIdentity } from "../runtime/route-identity.js"

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
  const app = await findDawnApp({ appRoot })
  const routeFiles = await collectExecutableRouteFiles(app.routesDir)

  const entries: RuntimeRegistryEntry[] = []

  for (const routeFile of routeFiles) {
    const identity = deriveRouteIdentity({
      appRoot: app.appRoot,
      routeFile,
      routesDir: app.routesDir,
    })

    if (!identity.ok) {
      continue
    }

    const mode = toRouteMode(routeFile)

    if (!mode) {
      continue
    }

    const entry: RuntimeRegistryEntry = {
      assistantId: createRouteAssistantId(identity.routeId, mode),
      mode,
      routeFile,
      routeId: identity.routeId,
      routePath: identity.routePath,
    }

    if (entries.some((existing) => existing.assistantId === entry.assistantId)) {
      throw new Error(`Duplicate runtime assistant_id detected: ${entry.assistantId}`)
    }

    entries.push(entry)
  }

  return {
    appRoot: app.appRoot,
    entries,
    lookup: (assistantId: string) => entries.find((entry) => entry.assistantId === assistantId) ?? null,
  }
}

async function collectExecutableRouteFiles(routesDir: string): Promise<readonly string[]> {
  const discovered: string[] = []
  await walkRouteTree(routesDir, discovered)
  return discovered
}

async function walkRouteTree(currentDir: string, discovered: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  const graphEntry = entries.find((entry) => entry.isFile() && entry.name === "graph.ts")
  const workflowEntry = entries.find((entry) => entry.isFile() && entry.name === "workflow.ts")

  if (graphEntry) {
    discovered.push(join(currentDir, graphEntry.name))
  }

  if (workflowEntry) {
    discovered.push(join(currentDir, workflowEntry.name))
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !isPrivateSegment(entry.name))
      .map((entry) => walkRouteTree(join(currentDir, entry.name), discovered)),
  )
}

function toRouteMode(routeFile: string): "graph" | "workflow" | null {
  const routeName = basename(routeFile)

  if (routeName === "graph.ts") {
    return "graph"
  }

  if (routeName === "workflow.ts") {
    return "workflow"
  }

  return null
}

function isPrivateSegment(segment: string): boolean {
  return segment.startsWith("_")
}
