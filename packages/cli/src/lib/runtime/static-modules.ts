import type { NormalizedRouteModule, ResolvedStateField, RouteKind } from "@dawn-ai/core"

import type { LoadedRouteMemory } from "./load-memory.js"
import type { DiscoveredToolDefinition } from "./tool-discovery.js"

/**
 * A single route's build-time-resolved payload — everything
 * `prepareRouteExecution` would otherwise load from disk on that route's
 * first request (see `PreparedRouteModules` in `execute-route.ts`), plus the
 * identity fields the runtime registry derives from a discovered
 * `RouteDefinition`.
 *
 * Deliberately mirrors `PreparedRouteModules`'s `{ module, tools, stateFields,
 * memory }` shape exactly (same field names, same optionality) so consuming a
 * `StaticRouteModule` is a straight pick into the per-route prepared-modules
 * cache — no shape translation, no second code path in
 * `prepareRouteExecution`.
 *
 * No `toolSchemas` field: `PreparedRouteModules.tools` already carries
 * `DiscoveredToolDefinition`s with generated `tools.json` schemas injected
 * (`injectGeneratedSchemas` runs before the value is cached — see
 * `loadPreparedRouteModules`). A build-time generator inlines schemas onto
 * each tool's `schema` field the same way; a separate `toolSchemas` map would
 * duplicate data already present on `tools[].schema` and nothing would ever
 * read it.
 */
export interface StaticRouteModule {
  /** `${routeId}#${kind}` — the same value `createRouteAssistantId` derives. */
  readonly assistantId: string
  readonly routeId: string
  /** Route entry file path, relative to `appRoot`, forward-slash separated. */
  readonly routePath: string
  /** Absolute path to the route's `index.ts` (mirrors `RouteDefinition.entryFile`). */
  readonly routeFile: string
  readonly kind: RouteKind
  /** Normalized route module (kind + entry), from `normalizeRouteModule`. */
  readonly module: NormalizedRouteModule
  /**
   * Discovered tool definitions with generated `tools.json` schemas already
   * injected — the exact pre-capability, pre-wrap set `prepareRouteExecution`
   * derives per request today.
   */
  readonly tools: readonly DiscoveredToolDefinition[]
  /** Resolved state.ts fields (agent routes only; undefined otherwise). */
  readonly stateFields: readonly ResolvedStateField[] | undefined
  /** The route's memory.ts descriptor, or null when none exists. */
  readonly memory: LoadedRouteMemory | null
}

/**
 * The full build-time module manifest for an app: one entry per discovered
 * route. Threaded through `StartRuntimeServerOptions.modules` (PR 2's seam);
 * when present, `createRuntimeRegistry` and the per-route prepared-modules
 * cache are seeded from it and no filesystem discovery happens at boot or per
 * request.
 */
export interface DawnStaticModules {
  readonly routes: readonly StaticRouteModule[]
}
