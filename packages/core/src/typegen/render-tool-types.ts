import type { RouteToolTypes } from "../types.js"

export function renderToolTypes(routeTools: readonly RouteToolTypes[]): string {
  const routesWithTools = routeTools.filter((r) => r.tools.length > 0)

  const routeToolsType = "  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];"

  if (routesWithTools.length === 0) {
    return ["  export interface DawnRouteTools {}", "", routeToolsType, ""].join("\n")
  }

  const routeLines: string[] = []
  for (const route of routesWithTools) {
    routeLines.push(`    ${JSON.stringify(route.pathname)}: {`)
    for (const tool of route.tools) {
      const sig =
        tool.inputType === "void"
          ? `() => Promise<${tool.outputType}>`
          : `(input: ${tool.inputType}) => Promise<${tool.outputType}>`
      routeLines.push(`      readonly ${tool.name}: ${sig};`)
    }
    routeLines.push("    };")
  }

  return ["  export interface DawnRouteTools {", ...routeLines, "  }", "", routeToolsType, ""].join(
    "\n",
  )
}
