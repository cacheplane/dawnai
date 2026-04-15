import type { DiscoveredToolDefinition } from "./tool-discovery.js"

export interface DawnRouteContext {
  readonly signal: AbortSignal
  readonly tools: Record<string, (input: unknown) => Promise<unknown>>
}

export function createDawnContext(options: {
  readonly signal?: AbortSignal
  readonly tools: readonly DiscoveredToolDefinition[]
}): DawnRouteContext {
  const signal = options.signal ?? new AbortController().signal
  const tools = Object.fromEntries(
    options.tools.map((tool) => [
      tool.name,
      async (input: unknown) => await tool.run(input, { signal }),
    ]),
  )

  return {
    signal,
    tools,
  }
}
