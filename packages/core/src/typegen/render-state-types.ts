export interface RouteStateFields {
  readonly pathname: string
  readonly fields: readonly { readonly name: string; readonly type: string }[]
}

export function renderStateTypes(routeStates: readonly RouteStateFields[]): string {
  const routeStateType = "  export type RouteState<P extends DawnRoutePath> = DawnRouteState[P];"

  if (routeStates.length === 0) {
    return ["  export interface DawnRouteState {}", "", routeStateType, ""].join("\n")
  }

  const routeLines: string[] = []
  for (const route of routeStates) {
    routeLines.push(`    ${JSON.stringify(route.pathname)}: {`)
    for (const field of route.fields) {
      routeLines.push(`      readonly ${field.name}: ${field.type};`)
    }
    routeLines.push("    };")
  }

  return [
    "  export interface DawnRouteState {",
    ...routeLines,
    "  }",
    "",
    routeStateType,
    "",
  ].join("\n")
}
