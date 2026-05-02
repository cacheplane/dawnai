import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ExtractedToolSchema, ResolvedStateField, RouteManifest, RouteToolTypes } from "@dawn-ai/core"
import {
  extractToolSchemasForRoute,
  extractToolTypesForRoute,
  renderDawnTypes,
  resolveStateFields,
} from "@dawn-ai/core"
import type { RouteStateFields } from "@dawn-ai/core"

import { discoverStateDefinition } from "../runtime/state-discovery.js"

export interface TypegenResult {
  readonly routeCount: number
  readonly toolSchemaCount: number
  readonly stateRouteCount: number
}

export async function runTypegen(options: {
  readonly appRoot: string
  readonly manifest: RouteManifest
}): Promise<TypegenResult> {
  const { appRoot, manifest } = options
  const dawnDir = join(appRoot, ".dawn")
  const sharedToolsDir = join(appRoot, "src")

  const routeToolTypes: RouteToolTypes[] = []
  const routeStateFields: RouteStateFields[] = []
  let toolSchemaCount = 0

  for (const route of manifest.routes) {
    // Extract tool types for .d.ts
    const tools = await extractToolTypesForRoute({
      routeDir: route.routeDir,
      sharedToolsDir,
    })
    routeToolTypes.push({ pathname: route.pathname, tools })

    // Extract tool schemas for JSON
    const schemas = await extractToolSchemasForRoute({
      routeDir: route.routeDir,
      sharedToolsDir,
    })

    if (schemas.length > 0) {
      toolSchemaCount += schemas.length
      await writeToolSchemas(dawnDir, route.id, schemas)
    }

    // Discover state
    const stateDefinition = await discoverStateDefinition({ routeDir: route.routeDir })
    if (stateDefinition) {
      const fields = resolveStateFields({
        defaults: stateDefinition.defaults,
        reducerOverrides: stateDefinition.reducerOverrides,
      })

      await writeStateManifest(dawnDir, route.id, fields)

      routeStateFields.push({
        pathname: route.pathname,
        fields: fields.map((f) => ({
          name: f.name,
          type: inferTypeFromDefault(f.default),
        })),
      })
    }
  }

  // Write .dawn/dawn.generated.d.ts
  const dtsContent = renderDawnTypes(manifest, routeToolTypes, routeStateFields)
  const dtsPath = join(dawnDir, "dawn.generated.d.ts")
  await mkdir(dawnDir, { recursive: true })
  await writeFile(dtsPath, dtsContent, "utf8")

  return {
    routeCount: manifest.routes.length,
    toolSchemaCount,
    stateRouteCount: routeStateFields.length,
  }
}

async function writeToolSchemas(
  dawnDir: string,
  routeId: string,
  schemas: readonly ExtractedToolSchema[],
): Promise<void> {
  const routeSlug = routeIdToSlug(routeId)
  const dir = join(dawnDir, "routes", routeSlug)
  await mkdir(dir, { recursive: true })

  const output: Record<string, unknown> = {}
  for (const schema of schemas) {
    output[schema.name] = {
      description: schema.description,
      parameters: schema.parameters,
    }
  }

  await writeFile(join(dir, "tools.json"), JSON.stringify(output, null, 2) + "\n", "utf8")
}

async function writeStateManifest(
  dawnDir: string,
  routeId: string,
  fields: readonly ResolvedStateField[],
): Promise<void> {
  const routeSlug = routeIdToSlug(routeId)
  const dir = join(dawnDir, "routes", routeSlug)
  await mkdir(dir, { recursive: true })

  const output = fields.map((f) => ({
    name: f.name,
    reducer: typeof f.reducer === "function" ? "custom" : f.reducer,
    default: f.default,
  }))

  await writeFile(join(dir, "state.json"), JSON.stringify(output, null, 2) + "\n", "utf8")
}

function routeIdToSlug(routeId: string): string {
  return routeId
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/\[/g, "")
    .replace(/\]/g, "")
}

function inferTypeFromDefault(value: unknown): string {
  if (Array.isArray(value)) return "string[]"
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  return "string"
}
