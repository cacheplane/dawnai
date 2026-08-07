import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch"
import type { RunnableConfig } from "@langchain/core/runnables"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { isGraphInterrupt } from "@langchain/langgraph"
import type { z } from "zod"

export interface ResolvedSubagentGraph {
  readonly routeId: string
  readonly graph: {
    invoke(input: unknown, config: RunnableConfig): Promise<unknown>
  }
}

export type SubagentResolver = (request: {
  readonly callId: string
  readonly name: string
  readonly input: string
  readonly config: RunnableConfig
}) => Promise<
  | { readonly ok: true; readonly child: ResolvedSubagentGraph }
  | { readonly ok: false; readonly message: string }
>

interface SubagentTaskPlaceholder {
  readonly description?: string
  readonly name: string
  readonly schema?: unknown
}

interface DawnSubagentStackEntry {
  readonly callId: string
  readonly name: string
  readonly routeId: string
}

const MAX_SUBAGENT_DEPTH = 3

export function convertSubagentTaskToLangChain(
  tool: SubagentTaskPlaceholder,
  resolver: SubagentResolver,
): DynamicStructuredTool {
  if (tool.schema === undefined) {
    throw new Error("[dawn] subagent task placeholder is missing its input schema")
  }
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema: tool.schema as z.ZodTypeAny,
    func: async (rawInput, manager, config) => {
      const liveConfig = config ?? {}
      const callId = readCallId(liveConfig) ?? `task-${globalThis.crypto.randomUUID()}`
      const toolRunId =
        typeof manager?.runId === "string" && manager.runId !== "" ? manager.runId : undefined
      const input = rawInput as { input: string; subagent: string }
      const parentDawn = readDawnMetadata(liveConfig)
      const nextDepth = readDepth(parentDawn) + 1

      if (nextDepth > MAX_SUBAGENT_DEPTH) {
        return `[DAWN_E5003] Cannot dispatch '${input.subagent}' at depth ${nextDepth}; the maximum subagent depth is ${MAX_SUBAGENT_DEPTH}.`
      }

      const resolved = await resolver({
        callId,
        name: input.subagent,
        input: input.input,
        config: liveConfig,
      })
      if (!resolved.ok) return resolved.message

      const parentStack = readSubagentStack(parentDawn)
      const stackEntry: DawnSubagentStackEntry = {
        callId,
        name: input.subagent,
        routeId: resolved.child.routeId,
      }
      const childConfig: RunnableConfig = {
        ...liveConfig,
        metadata: {
          ...(liveConfig.metadata ?? {}),
          dawn: {
            ...parentDawn,
            subagent_depth: nextDepth,
            subagent_stack: [...parentStack, stackEntry],
          },
        },
      }
      const eventBase = {
        call_id: callId,
        ...(toolRunId !== undefined ? { tool_run_id: toolRunId } : {}),
        subagent: input.subagent,
        route_id: resolved.child.routeId,
        depth: nextDepth,
      }

      await dispatchCustomEvent("dawn.subagent", { phase: "start", ...eventBase }, childConfig)

      let output: unknown
      try {
        output = await resolved.child.graph.invoke(
          { messages: [{ role: "user", content: input.input }] },
          childConfig,
        )
      } catch (error) {
        if (isGraphInterrupt(error) || liveConfig.signal?.aborted || isAbortError(error)) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        await dispatchCustomEvent(
          "dawn.subagent",
          { phase: "end", ...eventBase, error: message },
          childConfig,
        )
        return `subagent_failed: ${message}`
      }

      const finalText = extractFinalAiText(output)
      await dispatchCustomEvent(
        "dawn.subagent",
        { phase: "end", ...eventBase, final_message: finalText },
        childConfig,
      )
      return finalText
    },
  })
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { code?: unknown; name?: unknown }
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR"
}

function readCallId(config: RunnableConfig): string | undefined {
  const toolCall = (config as RunnableConfig & { toolCall?: { id?: unknown } }).toolCall
  if (typeof toolCall?.id === "string" && toolCall.id !== "") return toolCall.id

  const configurableId = config.configurable?.toolCallId
  if (typeof configurableId === "string" && configurableId !== "") return configurableId

  const metadataId = config.metadata?.tool_call_id
  return typeof metadataId === "string" && metadataId !== "" ? metadataId : undefined
}

function readDawnMetadata(config: RunnableConfig): Record<string, unknown> {
  const dawn = config.metadata?.dawn
  return typeof dawn === "object" && dawn !== null && !Array.isArray(dawn)
    ? (dawn as Record<string, unknown>)
    : {}
}

function readDepth(dawn: Record<string, unknown>): number {
  const depth = dawn.subagent_depth
  return typeof depth === "number" && Number.isFinite(depth) ? depth : 0
}

function readSubagentStack(dawn: Record<string, unknown>): readonly DawnSubagentStackEntry[] {
  const stack = dawn.subagent_stack
  if (!Array.isArray(stack)) return []
  return stack.filter(isSubagentStackEntry)
}

function isSubagentStackEntry(value: unknown): value is DawnSubagentStackEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.callId === "string" &&
    typeof entry.name === "string" &&
    typeof entry.routeId === "string"
  )
}

function extractFinalAiText(output: unknown): string {
  const messages = (output as { messages?: unknown[] } | undefined)?.messages
  if (!Array.isArray(messages)) return ""

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      | { content?: unknown; getType?: () => string; type?: string }
      | undefined
    const type = typeof message?.getType === "function" ? message.getType() : message?.type
    if (type !== "ai") continue
    if (typeof message?.content === "string") return message.content
    if (Array.isArray(message?.content)) {
      return message.content
        .map((block) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
            ? ((block as Record<string, unknown>).text as string)
            : "",
        )
        .join("")
    }
  }
  return ""
}
