import type { WorkspaceFs } from "@dawn-ai/sdk"

import type { DiscoveredToolDefinition } from "./tool-discovery.js"

export interface DawnRouteContext {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly tools: Record<string, (input: unknown) => Promise<unknown>>
  readonly fs: WorkspaceFs
}

export function createDawnContext(options: {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
  readonly tools: readonly DiscoveredToolDefinition[]
  readonly fs: WorkspaceFs
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
          fs: options.fs,
        }),
    ]),
  )

  const context: DawnRouteContext = { signal, tools, fs: options.fs }
  if (middleware) {
    return { ...context, middleware }
  }
  return context
}
