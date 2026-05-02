import type { RouteManifest, RouteSegment, RouteToolTypes } from "../types.js"
import { type RouteStateFields, renderStateTypes } from "./render-state-types.js"
import { renderToolTypes } from "./render-tool-types.js"

export function renderDawnTypes(
  manifest: RouteManifest,
  toolTypes: readonly RouteToolTypes[],
  stateTypes?: readonly RouteStateFields[],
): string {
  const pathUnion =
    manifest.routes.length > 0
      ? manifest.routes.map((route) => JSON.stringify(route.pathname)).join(" | ")
      : "never"

  const paramLines = manifest.routes.map((route) => {
    const params = renderParamsForSegments(route.segments)
    return `  ${JSON.stringify(route.pathname)}: ${params};`
  })

  const paramBlock =
    paramLines.length === 0
      ? "  export interface DawnRouteParams {}"
      : ["  export interface DawnRouteParams {", ...paramLines, "  }"].join("\n")

  const toolBlock = renderToolTypes(toolTypes).trimEnd()

  const parts: string[] = [
    'declare module "dawn:routes" {',
    `  export type DawnRoutePath = ${pathUnion};`,
    "",
    paramBlock,
    "",
    toolBlock,
  ]

  if (stateTypes && stateTypes.length > 0) {
    parts.push("")
    parts.push(renderStateTypes(stateTypes).trimEnd())
  }

  parts.push("}")
  parts.push("")

  return parts.join("\n")
}

export function renderRouteTypes(manifest: RouteManifest): string {
  const pathUnion =
    manifest.routes.length > 0
      ? manifest.routes.map((route) => JSON.stringify(route.pathname)).join(" | ")
      : "never"
  const paramLines = manifest.routes.map((route) => {
    const params = renderParamsForSegments(route.segments)
    return `  ${JSON.stringify(route.pathname)}: ${params};`
  })

  if (paramLines.length === 0) {
    return [
      'declare module "dawn:routes" {',
      `  export type DawnRoutePath = ${pathUnion};`,
      "",
      "  export interface DawnRouteParams {}",
      "}",
      "",
    ].join("\n")
  }

  return [
    'declare module "dawn:routes" {',
    `  export type DawnRoutePath = ${pathUnion};`,
    "",
    "  export interface DawnRouteParams {",
    ...paramLines,
    "  }",
    "}",
    "",
  ].join("\n")
}

function renderParamsForSegments(segments: readonly RouteSegment[]): string {
  const params = segments.filter((segment) => segment.kind !== "static")

  if (params.length === 0) {
    return "{}"
  }

  return `{ ${params.map(renderParam).join("; ")} }`
}

function renderParam(segment: Exclude<RouteSegment, { kind: "static" }>): string {
  switch (segment.kind) {
    case "dynamic":
      return `${segment.name}: string`
    case "catchall":
      return `${segment.name}: string[]`
    case "optional-catchall":
      return `${segment.name}?: string[]`
  }
}
