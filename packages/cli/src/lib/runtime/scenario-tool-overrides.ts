import type { ScenarioToolCallRecord, ScenarioToolMockDescriptor } from "@dawn-ai/sdk/testing"
import type { DiscoveredToolDefinition } from "./tool-shape.js"

export type ScenarioToolOverride = ScenarioToolMockDescriptor
export type ScenarioToolCallJournal = ScenarioToolCallRecord[]

export function applyScenarioToolOverrides(options: {
  readonly journal: ScenarioToolCallJournal
  readonly overrides: readonly ScenarioToolOverride[]
  readonly tools: readonly DiscoveredToolDefinition[]
}):
  | { readonly ok: true; readonly tools: readonly DiscoveredToolDefinition[] }
  | { readonly message: string; readonly ok: false } {
  const availableNames = options.tools
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right))
  const availableNameSet = new Set(availableNames)
  const unknownOverride = options.overrides.find((override) => !availableNameSet.has(override.name))

  if (unknownOverride) {
    return {
      message: `Scenario tool override "${unknownOverride.name}" does not match an application tool. Available tools: ${availableNames.length > 0 ? availableNames.join(", ") : "(none)"}`,
      ok: false,
    }
  }

  const overridesByName = new Map(options.overrides.map((override) => [override.name, override]))
  const tools = options.tools.map((tool) => {
    const override = overridesByName.get(tool.name)
    if (!override) return tool

    return {
      ...tool,
      run: (input: unknown) => {
        options.journal.push({
          args: input,
          name: tool.name,
          sequence: options.journal.length,
        })
        return override.implementation(input)
      },
    }
  })

  return { ok: true, tools }
}
