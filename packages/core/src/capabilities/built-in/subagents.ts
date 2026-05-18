import { pathToFileURL } from "node:url"
import { z } from "zod"
import { isDawnAgent } from "@dawn-ai/sdk"
import type { CapabilityMarker, CapabilityMarkerContext, PromptFragment } from "../types.js"
import type { RouteDefinition } from "../../types.js"

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

async function loadDescription(route: RouteDefinition): Promise<string> {
  try {
    const mod = (await import(pathToFileURL(route.entryFile).href)) as {
      default?: unknown
    }
    if (isDawnAgent(mod.default) && typeof mod.default.description === "string") {
      return mod.default.description
    }
  } catch {
    // fall through to default — never fail capability composition over a description
  }
  return "No description provided."
}

export function createSubagentsMarker(): CapabilityMarker {
  return {
    name: "subagents",
    detect: async (routeDir, context) => {
      return findConventionSubagents(routeDir, context.routeManifest).length > 0
    },
    load: async (routeDir, context) => {
      const conventionRoutes = findConventionSubagents(routeDir, context.routeManifest)
      if (conventionRoutes.length === 0) return {}

      const discovered: DiscoveredSubagent[] = []
      for (const r of conventionRoutes) {
        const prefix = `${routeDir}/subagents/`
        const leafName = r.routeDir.slice(prefix.length)
        const description = await loadDescription(r)
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
