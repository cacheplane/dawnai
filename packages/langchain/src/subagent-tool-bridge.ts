import { dispatchSubagent, type SubagentEvent } from "./subagent-dispatcher.js"

export interface SubagentResolverResult {
  readonly routeId: string
  readonly graph: {
    readonly invoke: (input: unknown, config: unknown) => Promise<unknown>
    readonly streamEvents?: (
      input: unknown,
      options: Record<string, unknown>,
    ) => AsyncIterable<unknown>
  }
}

export interface BridgeOptions {
  readonly subagentResolver: (leafName: string) => SubagentResolverResult | undefined
  readonly writer: (event: SubagentEvent) => void
  readonly parentConfig?: Record<string, unknown>
}

export interface BridgedTaskTool {
  readonly name: "task"
  readonly description: string
  readonly run: (input: unknown, context: { readonly signal: AbortSignal }) => Promise<string>
}

const TASK_TOOL_DESCRIPTION =
  "Dispatch a sub-task to a specialized subagent. See the # Subagents section of your system prompt for available agents and when to use each."

function generateCallId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function bridgeSubagentTool(options: BridgeOptions): BridgedTaskTool {
  return {
    name: "task",
    description: TASK_TOOL_DESCRIPTION,
    run: async (input: unknown, _ctx) => {
      const { subagent, input: taskInput } = input as { subagent: string; input: string }
      const resolved = options.subagentResolver(subagent)
      if (!resolved) {
        return `subagent_unknown: no subagent named '${subagent}' (resolver returned undefined)`
      }
      // Cast through `never`: dispatcher's `childGraph` type expects a `Streamable`-shaped
      // graph; resolver returns a slightly different shape with optional streamEvents. The
      // dispatcher narrows internally via its own type guards.
      const result = await dispatchSubagent({
        childGraph: resolved.graph as never,
        input: taskInput,
        parentConfig: options.parentConfig ?? {},
        writer: options.writer,
        callId: generateCallId(),
        childRouteId: resolved.routeId,
        subagentName: subagent,
      })
      return result.finalText
    },
  }
}
