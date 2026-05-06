import type { DiscoveredToolDefinition } from "./tool-discovery.js"

export interface DawnRouteContext {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly tools: Record<string, (input: unknown) => Promise<unknown>>
}

export function createDawnContext(options: {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
  readonly tools: readonly DiscoveredToolDefinition[]
}): DawnRouteContext {
  const signal = options.signal ?? new AbortController().signal
  const middleware = options.middleware
  const tools = Object.fromEntries(
    options.tools.map((tool) => [
      tool.name,
      async (input: unknown) =>
        await tool.run(input, {
          ...(middleware ? { middleware } : {}),
          signal,
        }),
    ]),
  )

  const context: DawnRouteContext = { signal, tools }
  if (middleware) {
    return { ...context, middleware }
  }
  return context
}
