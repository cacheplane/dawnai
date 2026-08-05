import { z } from "zod"
import { dispatchableSubagents } from "../../subagents/registry.js"
import type { CapabilityMarker, PromptFragment } from "../types.js"

const SUBAGENTS_PROMPT_HEADER = `# Subagents

The following subagents are available. Call \`task({ subagent, input })\` to dispatch a sub-task. Use the description to choose the right subagent for each piece of work.`

function compareNames(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export function createSubagentsMarker(): CapabilityMarker {
  return {
    name: "subagents",
    detect: async (_routeDir, context) => (context.subagentRegistry?.length ?? 0) > 0,
    load: async (_routeDir, context) => {
      const subagentRegistry = context.subagentRegistry
      if (subagentRegistry === undefined) return {}

      const dispatchable = dispatchableSubagents(subagentRegistry)
        .slice()
        .sort((a, b) => compareNames(a.name, b.name))
      if (dispatchable.length === 0) return { subagentRegistry }

      const names = dispatchable.map(({ name }) => name) as [string, ...string[]]
      const task = {
        name: "task",
        description:
          "Dispatch a sub-task to a specialized subagent. See the # Subagents section of your system prompt for available agents and when to use each.",
        schema: z.object({
          subagent: z.enum(names),
          input: z.string().describe("The task description for the subagent to handle."),
        }),
        run: async (_input: unknown) => {
          throw new Error(
            "subagents marker: task tool was invoked outside the langchain bridge (dispatcher not wired)",
          )
        },
      }

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        render: () => {
          const lines = dispatchable
            .map(({ name, description }) => `- **${name}** — ${description}`)
            .join("\n")
          return `${SUBAGENTS_PROMPT_HEADER}\n\n${lines}`
        },
      }

      return { tools: [task], promptFragment, subagentRegistry }
    },
  }
}
