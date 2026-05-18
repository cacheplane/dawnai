export interface SubagentEvent {
  readonly event: string
  readonly data: Record<string, unknown>
}

type Streamable = {
  invoke: (input: unknown, config: unknown) => Promise<unknown>
  streamEvents?: (
    input: unknown,
    options: Record<string, unknown>,
  ) => AsyncIterable<{
    event: string
    name?: string
    data: { chunk?: unknown; output?: unknown }
  }>
  // Dawn-native stream. Yields StreamChunks directly. When present,
  // the dispatcher prefers this over streamEvents/invoke so intermediate
  // child events bubble up as subagent.<type> envelopes.
  dawnStream?: (
    input: unknown,
    config: unknown,
  ) => AsyncIterable<{
    type: string
    data?: unknown
    name?: string
    input?: unknown
    output?: unknown
  }>
}

export interface DispatchArgs {
  readonly childGraph: { invoke: (input: unknown, config: unknown) => Promise<unknown> }
  readonly input: string
  readonly parentConfig: Record<string, unknown>
  readonly writer: (event: SubagentEvent) => void
  readonly callId: string
  readonly childRouteId: string
  readonly subagentName: string
}

export interface DispatchResult {
  readonly finalText: string
}

export const MAX_SUBAGENT_DEPTH = 3

function readDepth(config: Record<string, unknown>): number {
  const meta = (config?.metadata as Record<string, unknown> | undefined) ?? {}
  const dawn = (meta.dawn as Record<string, unknown> | undefined) ?? {}
  const depth = dawn.subagent_depth
  return typeof depth === "number" ? depth : 0
}

function buildChildConfig(
  parentConfig: Record<string, unknown>,
  nextDepth: number,
  callId: string,
): Record<string, unknown> {
  const parentMeta = (parentConfig.metadata as Record<string, unknown> | undefined) ?? {}
  const parentDawn = (parentMeta.dawn as Record<string, unknown> | undefined) ?? {}
  return {
    ...parentConfig,
    metadata: {
      ...parentMeta,
      dawn: {
        ...parentDawn,
        subagent_depth: nextDepth,
        parent_call_id: callId,
      },
    },
  }
}

function extractFinalText(graphOutput: unknown): string {
  const messages = (graphOutput as { messages?: unknown[] })?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { content?: unknown; getType?: () => string; type?: string }
    const kind = typeof m.getType === "function" ? m.getType() : m.type
    if (kind === "ai" && typeof m.content === "string") return m.content
  }
  return ""
}

export async function dispatchSubagent(args: DispatchArgs): Promise<DispatchResult> {
  const currentDepth = readDepth(args.parentConfig)
  const nextDepth = currentDepth + 1

  if (nextDepth > MAX_SUBAGENT_DEPTH) {
    return {
      finalText: `subagent_depth_exceeded: cannot dispatch '${args.subagentName}' at depth ${nextDepth} (max ${MAX_SUBAGENT_DEPTH}).`,
    }
  }

  const childConfig = buildChildConfig(args.parentConfig, nextDepth, args.callId)

  args.writer({
    event: "subagent.start",
    data: {
      call_id: args.callId,
      subagent: args.subagentName,
      route_id: args.childRouteId,
      depth: nextDepth,
    },
  })

  let output: unknown
  try {
    const streamable = args.childGraph as Streamable
    if (typeof streamable.dawnStream === "function") {
      for await (const chunk of streamable.dawnStream(
        { messages: [{ role: "user", content: args.input }] },
        childConfig,
      )) {
        switch (chunk.type) {
          case "done":
            output = (chunk as { output?: unknown }).output
            break
          case "tool_call":
            args.writer({
              event: "subagent.tool_call",
              data: {
                call_id: args.callId,
                tool: (chunk as { name?: string }).name,
                input: (chunk as { input?: unknown }).input,
              },
            })
            break
          case "tool_result":
            args.writer({
              event: "subagent.tool_result",
              data: {
                call_id: args.callId,
                tool: (chunk as { name?: string }).name,
                output: (chunk as { output?: unknown }).output,
              },
            })
            break
          case "chunk": {
            const data = (chunk as { data?: unknown }).data
            if (typeof data === "string" && data.length > 0) {
              args.writer({
                event: "subagent.message",
                data: { call_id: args.callId, chunk: data },
              })
            }
            break
          }
          default: {
            // Capability-contributed events (e.g. plan_update). Prefix with
            // subagent. and forward the chunk's data payload verbatim,
            // attaching call_id.
            const data = (chunk as { data?: unknown }).data
            args.writer({
              event: `subagent.${chunk.type}`,
              data: {
                call_id: args.callId,
                ...(typeof data === "object" && data !== null ? (data as object) : { value: data }),
              },
            })
            break
          }
        }
      }
    } else if (typeof streamable.streamEvents === "function") {
      for await (const event of streamable.streamEvents(
        { messages: [{ role: "user", content: args.input }] },
        { ...childConfig, version: "v2" },
      )) {
        switch (event.event) {
          case "on_tool_start":
            args.writer({
              event: "subagent.tool_call",
              data: {
                call_id: args.callId,
                tool: event.name,
                input: event.data.chunk ?? event.data.output,
              },
            })
            break
          case "on_tool_end":
            args.writer({
              event: "subagent.tool_result",
              data: { call_id: args.callId, tool: event.name, output: event.data.output },
            })
            break
          case "on_chat_model_stream": {
            const content = (event.data.chunk as { content?: unknown })?.content
            if (typeof content === "string" && content.length > 0) {
              args.writer({
                event: "subagent.message",
                data: { call_id: args.callId, chunk: content },
              })
            }
            break
          }
          case "on_chain_end":
            if (event.name === "LangGraph") {
              output = event.data.output
            }
            break
        }
      }
    } else {
      output = await streamable.invoke(
        { messages: [{ role: "user", content: args.input }] },
        childConfig,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    args.writer({
      event: "subagent.end",
      data: { call_id: args.callId, error: message },
    })
    return { finalText: `subagent_failed: ${message}` }
  }

  const finalText = extractFinalText(output)

  args.writer({
    event: "subagent.end",
    data: { call_id: args.callId, final_message: finalText },
  })

  return { finalText }
}
