/**
 * The `node:`-free half of `load-route-kind.ts`: classify an already-imported
 * route module namespace. Shared by the tsx-backed disk loader and
 * `buildStaticRouteModule`, and reachable from the `@dawn-ai/cli/fetch` graph
 * (which the loader is not).
 */

import type { NormalizedRouteModule } from "@dawn-ai/core"
import { isDawnAgent } from "@dawn-ai/sdk"

export type { NormalizedRouteModule } from "@dawn-ai/core"

/**
 * The object-normalizing core of {@link normalizeRouteModule}: classify an
 * already-imported route module namespace. Exported so the static-modules
 * runtime helper (`buildStaticRouteModule`) applies the exact same
 * normalization rules to statically-imported route modules — codegen never
 * re-implements them.
 */
export function normalizeRouteModuleObject(
  routeModuleValue: unknown,
  routeFile: string,
): NormalizedRouteModule {
  const routeModule = (routeModuleValue ?? {}) as {
    readonly agent?: unknown
    readonly chain?: unknown
    readonly config?: Record<string, unknown>
    readonly default?: unknown
    readonly graph?: unknown
    readonly workflow?: unknown
  }

  // Check default export for DawnAgent descriptor (preferred path)
  if ("default" in routeModule && isDawnAgent(routeModule.default)) {
    return { kind: "agent", entry: routeModule.default, config: routeModule.config ?? {} }
  }

  const hasAgent = "agent" in routeModule && routeModule.agent !== undefined
  const hasChain = "chain" in routeModule && routeModule.chain !== undefined
  const hasGraph = "graph" in routeModule && routeModule.graph !== undefined
  const hasWorkflow = "workflow" in routeModule && routeModule.workflow !== undefined

  const count = [hasAgent, hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(
      `Route index.ts at ${routeFile} must export exactly one of "agent", "workflow", "graph", or "chain"`,
    )
  }

  if (hasAgent) {
    return { kind: "agent", entry: routeModule.agent, config: routeModule.config ?? {} }
  }

  if (hasChain) {
    return { kind: "chain", entry: routeModule.chain, config: routeModule.config ?? {} }
  }

  if (hasGraph) {
    return { kind: "graph", entry: routeModule.graph, config: routeModule.config ?? {} }
  }

  if (hasWorkflow) {
    return { kind: "workflow", entry: routeModule.workflow, config: routeModule.config ?? {} }
  }

  throw new Error(
    `Route index.ts at ${routeFile} exports neither "agent", "workflow", "graph", nor "chain"`,
  )
}
