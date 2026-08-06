import { type RouteDefinition, type RouteManifest, resolveSubagentRegistry } from "@dawn-ai/core"
import { type DawnAgent, isDawnAgent } from "@dawn-ai/sdk"

import { buildDescriptorRouteIndex } from "./descriptor-route-index.js"
import { normalizeRouteModule } from "./load-route-kind.js"

interface LoadedAgentRoute {
  readonly descriptor: DawnAgent
  readonly route: RouteDefinition
}

interface ToolScopeShape {
  readonly allow?: unknown
  readonly approve?: unknown
  readonly constrain?: unknown
  readonly deny?: unknown
}

const TOOL_SCOPE_FIELDS = ["allow", "deny", "approve"] as const

export async function collectDelegationErrors(manifest: RouteManifest): Promise<readonly string[]> {
  const loadedRoutes = (
    await Promise.all(
      manifest.routes
        .filter((route) => route.kind === "agent")
        .map(async (route): Promise<LoadedAgentRoute | undefined> => {
          try {
            const normalized = await normalizeRouteModule(route.entryFile, manifest.appRoot)
            return isDawnAgent(normalized.entry)
              ? { descriptor: normalized.entry, route }
              : undefined
          } catch {
            return undefined
          }
        }),
    )
  ).filter((loaded): loaded is LoadedAgentRoute => loaded !== undefined)

  const descriptorRouteIndex = await buildDescriptorRouteIndex(manifest)
  const descriptorByRouteId = new Map(
    loadedRoutes.map(({ descriptor, route }) => [route.id, descriptor] as const),
  )
  const errors: string[] = []

  for (const { descriptor, route } of loadedRoutes) {
    errors.push(...collectReservedTaskErrors(descriptor, route))
    try {
      await resolveSubagentRegistry({
        descriptor,
        descriptorRouteIndex,
        parentRouteDir: route.routeDir,
        parentRouteId: route.id,
        routeManifest: manifest,
        loadDescription: async (childRoute): Promise<string> =>
          descriptorByRouteId.get(childRoute.id)?.description ?? "No description provided.",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("[DAWN_E1004]")) {
        errors.push(`✗ ${route.pathname}: ${message}`)
      }
    }
  }

  return errors
}

function collectReservedTaskErrors(
  descriptor: DawnAgent,
  route: RouteDefinition,
): readonly string[] {
  const tools = (descriptor as unknown as { readonly tools?: ToolScopeShape }).tools
  if (typeof tools !== "object" || tools === null) return []

  const fields: string[] = []
  for (const field of TOOL_SCOPE_FIELDS) {
    const value = tools[field]
    if (Array.isArray(value) && value.includes("task")) fields.push(field)
  }
  if (
    typeof tools.constrain === "object" &&
    tools.constrain !== null &&
    Object.hasOwn(tools.constrain, "task")
  ) {
    fields.push("constrain")
  }

  return fields.map(
    (field) =>
      `✗ ${route.pathname}: [DAWN_E1004] tools.${field} references the reserved internal ` +
      '"task" tool. Remove that entry and use delegation to control subagent dispatch.',
  )
}
