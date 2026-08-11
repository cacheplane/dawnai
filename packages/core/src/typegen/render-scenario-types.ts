import type { RouteManifest, RouteToolTypes } from "../types.js"

export const SCENARIO_TYPES_FILE = "scenarios.generated.d.ts"

export function renderScenarioTypes(
  manifest: RouteManifest,
  routeTools: readonly RouteToolTypes[],
): string {
  const toolsByPath = new Map(routeTools.map((route) => [route.pathname, route.tools]))
  const lines = [
    'import "@dawn-ai/sdk/testing"',
    "",
    'declare module "@dawn-ai/sdk/testing" {',
    "  interface RouteScenarioMap {",
  ]

  for (const route of manifest.routes) {
    const tools = toolsByPath.get(route.pathname) ?? []
    lines.push(`    ${JSON.stringify(route.pathname)}: {`)
    if (tools.length === 0) {
      lines.push("      readonly tools: Record<never, never>")
    } else {
      lines.push("      readonly tools: {")
      for (const tool of tools) {
        const signature =
          tool.inputType === "void"
            ? `() => Promise<${tool.outputType}>`
            : `(input: ${tool.inputType}) => Promise<${tool.outputType}>`
        lines.push(`        readonly ${JSON.stringify(tool.name)}: ${signature}`)
      }
      lines.push("      }")
    }
    lines.push("    }")
  }

  lines.push("  }")
  lines.push("}")
  lines.push("")
  return lines.join("\n")
}
