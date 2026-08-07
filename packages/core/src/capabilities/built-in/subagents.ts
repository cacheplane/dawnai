import type { DawnAgent } from "@dawn-ai/sdk"
import { z } from "zod"
import type { RouteDefinition } from "../../types.js"
import type { CapabilityMarker, CapabilityMarkerContext, PromptFragment } from "../types.js"

const DEFAULT_DESCRIPTION = "No description provided."

const SUBAGENTS_PROMPT_HEADER = `# Subagents

The following subagents are available. Call \`task({ subagent, input })\` to dispatch a sub-task. Use the description to choose the right subagent for each piece of work.`

interface DiscoveredSubagent {
  readonly leafName: string
  readonly routeId: string
  readonly description: string
}

function findConventionSubagents(
  routeDir: string,
  routeManifest: CapabilityMarkerContext["routeManifest"],
): readonly RouteDefinition[] {
  const prefix = `${routeDir}/subagents/`
  return routeManifest.routes.filter((r) => {
    if (!r.routeDir.startsWith(prefix)) return false
    // immediate child of <routeDir>/subagents/ — no further slashes
    const tail = r.routeDir.slice(prefix.length)
    return tail.length > 0 && !tail.includes("/")
  })
}

async function loadDescription(
  route: RouteDefinition,
  routeDescriptors: ReadonlyMap<string, DawnAgent> | undefined,
  loadRouteDescription: CapabilityMarkerContext["loadRouteDescription"],
): Promise<string> {
  // Static-modules path: when the map exists it is authoritative — it holds
  // every route whose entry passes isDawnAgent, so a route absent from it
  // provably cannot yield a description via the loader either (the loader also
  // requires isDawnAgent). Consulting no loader here keeps the static path
  // zero-import: edge runtimes have no disk to import from.
  if (routeDescriptors !== undefined) {
    return routeDescriptors.get(route.id)?.description ?? DEFAULT_DESCRIPTION
  }
  // Dynamic path. The loader reads the entry file, which needs node:url —
  // hence the injection. No loader (or no description) ⇒ the same default the
  // failed-import case has always produced.
  return (await loadRouteDescription?.(route)) ?? DEFAULT_DESCRIPTION
}

export function createSubagentsMarker(): CapabilityMarker {
  return {
    name: "subagents",
    detect: async (routeDir, context) => {
      if (findConventionSubagents(routeDir, context.routeManifest).length > 0) return true
      return (context.descriptor?.subagents?.length ?? 0) > 0
    },
    load: async (routeDir, context) => {
      const conventionRoutes = findConventionSubagents(routeDir, context.routeManifest)
      const overrideDescriptors = context.descriptor?.subagents ?? []

      const overrideRoutes: RouteDefinition[] = []
      for (const desc of overrideDescriptors) {
        const routeId = context.descriptorRouteMap?.get(desc)
        if (!routeId) {
          console.warn(
            `subagents marker: could not resolve override descriptor for route at ${routeDir}`,
          )
          continue
        }
        const found = context.routeManifest.routes.find((r) => r.id === routeId)
        if (found) overrideRoutes.push(found)
      }

      const allRoutes = [...conventionRoutes, ...overrideRoutes]
      if (allRoutes.length === 0) return {}

      const conventionPrefix = `${routeDir}/subagents/`
      const discovered: DiscoveredSubagent[] = []
      const seen = new Set<string>()
      for (const r of allRoutes) {
        const lastSegment = r.segments.at(-1)
        const lastSegmentName =
          typeof lastSegment === "string"
            ? lastSegment
            : (lastSegment?.raw ?? r.id.replace(/^\//, ""))
        const leafName = r.routeDir.startsWith(conventionPrefix)
          ? r.routeDir.slice(conventionPrefix.length)
          : lastSegmentName
        if (seen.has(leafName)) {
          throw new Error(
            `subagents marker: duplicate leaf name "${leafName}" (collision between convention and override). Rename one of the subagent routes.`,
          )
        }
        seen.add(leafName)
        const description = await loadDescription(
          r,
          context.routeDescriptors,
          context.loadRouteDescription,
        )
        discovered.push({ leafName, routeId: r.id, description })
      }

      const leafNames = discovered.map((d) => d.leafName) as [string, ...string[]]

      const taskSchema = z.object({
        subagent: z.enum(leafNames),
        input: z.string().describe("The task description for the subagent to handle."),
      })

      const task = {
        name: "task",
        description:
          "Dispatch a sub-task to a specialized subagent. See the # Subagents section of your system prompt for available agents and when to use each.",
        schema: taskSchema,
        run: async (_input: unknown) => {
          throw new Error(
            "subagents marker: task tool was invoked outside the langchain bridge (dispatcher not wired)",
          )
        },
      }

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        render: () => {
          const lines = discovered
            .slice()
            .sort((a, b) => a.leafName.localeCompare(b.leafName))
            .map((s) => `- **${s.leafName}** — ${s.description}`)
            .join("\n")
          return `${SUBAGENTS_PROMPT_HEADER}\n\n${lines}`
        },
      }

      return { tools: [task], promptFragment }
    },
  }
}
