import { dirname, join } from "node:path"

import {
  type NormalizedRouteModule,
  type ResolvedStateField,
  type RouteKind,
  resolveStateFields,
} from "@dawn-ai/core"
import type { DawnMiddleware } from "@dawn-ai/sdk"

import { selectMiddlewareExport } from "../dev/middleware.js"
import { type LoadedRouteMemory, normalizeRouteMemoryExport } from "./load-memory.js"
import { normalizeRouteModuleObject } from "./load-route-kind.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import { createRouteAssistantId } from "./route-identity.js"
import {
  type DiscoveredToolDefinition,
  injectGeneratedSchemas,
  normalizeToolModule,
  type ToolScope,
} from "./tool-discovery.js"

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
  /**
   * App-level middleware bound from the manifest's static import, when the
   * app has a middleware file. `undefined` also covers a middleware file with
   * no usable export — the dynamic probe ignores such a file too.
   */
  readonly middleware?: DawnMiddleware
  readonly routes: readonly StaticRouteModule[]
}

/** One statically-imported tool module plus its build-time-known identity. */
export interface StaticToolModuleInput {
  /** Absolute tool file path at runtime (resolved from `import.meta.url`). */
  readonly filePath: string
  /** The tool module's full namespace object (from `import * as`). */
  readonly module: unknown
  /** Tool name — the build-time `basename(filePath, ".ts")`. */
  readonly name: string
  readonly scope: ToolScope
}

/**
 * The plain inputs a generated `modules.mjs` hands `buildStaticRouteModule`
 * per route: live module namespaces (route index, tools, memory, reducers)
 * plus inlined build-time literals (identity, `tools.json` schemas, state
 * defaults). Everything shape-dependent is normalized at RUNTIME by the same
 * code the dynamic path uses — codegen stays dumb imports + literals.
 */
export interface StaticRouteModuleInput {
  /** Route kind as discovered at build time (drift-checked at runtime). */
  readonly kind: RouteKind
  /** The route's `memory.ts` namespace object, when the file exists. */
  readonly memoryModule?: unknown
  /** Absolute route entry file path at runtime. */
  readonly routeFile: string
  readonly routeId: string
  /** The route index module's full namespace object (from `import * as`). */
  readonly routeModule: unknown
  /** Route entry file path relative to appRoot, forward-slash separated. */
  readonly routePath: string
  /**
   * `state.ts` defaults extracted at build time (the same values
   * `discoverStateDefinition` derives), as entries. Present exactly when the
   * dynamic path would have found a state definition — an empty array is a
   * defined-but-empty definition, `undefined` means no `state.ts`.
   */
  readonly stateDefaults?: readonly (readonly [string, unknown])[]
  /** Live reducer-override functions (from `reducers/<field>.ts` defaults). */
  readonly stateReducers?: readonly (readonly [
    string,
    (current: unknown, incoming: unknown) => unknown,
  ])[]
  /** Inlined `.dawn/routes/<slug>/tools.json` content, when present. */
  readonly toolSchemas?: Record<string, unknown>
  readonly tools: readonly StaticToolModuleInput[]
}

/**
 * Runtime companion to the build-time generator: turn a generated
 * `modules.mjs` route entry (live imports + inlined literals) into a full
 * `StaticRouteModule` by running the SAME normalization the dynamic path uses
 * — `normalizeRouteModuleObject` for the route, `normalizeToolModule` +
 * `injectGeneratedSchemas` for tools, `resolveStateFields` for state, and
 * `normalizeRouteMemoryExport` for memory. Codegen can therefore never drift
 * from the runtime's normalization rules.
 */
export function buildStaticRouteModule(input: StaticRouteModuleInput): StaticRouteModule {
  const module = normalizeRouteModuleObject(input.routeModule, input.routeFile)
  if (module.kind !== input.kind) {
    throw new Error(
      `Static module manifest is stale for route ${input.routeId}: built as kind "${input.kind}" ` +
        `but the route module now normalizes to "${module.kind}" — re-run \`dawn build\`.`,
    )
  }

  const normalizedTools = input.tools.map((tool) =>
    normalizeToolModule(tool.module, {
      filePath: tool.filePath,
      name: tool.name,
      scope: tool.scope,
    }),
  )
  const tools = input.toolSchemas
    ? injectGeneratedSchemas(normalizedTools, input.toolSchemas)
    : normalizedTools

  const stateFields = input.stateDefaults
    ? resolveStateFields({
        defaults: new Map(input.stateDefaults),
        reducerOverrides: new Map(input.stateReducers ?? []),
      })
    : undefined

  const memory =
    input.memoryModule === undefined
      ? null
      : normalizeRouteMemoryExport(
          ((input.memoryModule ?? {}) as { readonly default?: unknown }).default,
          join(dirname(input.routeFile), "memory.ts"),
        )

  return {
    assistantId: createRouteAssistantId(input.routeId, module.kind),
    kind: module.kind,
    memory,
    module,
    routeFile: input.routeFile,
    routeId: input.routeId,
    routePath: input.routePath,
    stateFields,
    tools,
  }
}

/**
 * Runtime companion for the manifest's middleware entry: pick the middleware
 * function out of the statically-imported `import * as` namespace using the
 * SAME selection rule the dynamic probe (`loadMiddleware`) applies — `default`
 * first, then the named `middleware` export. Returns undefined when neither
 * is a function (a middleware file with no usable export — dev ignores it).
 */
export function normalizeMiddlewareModule(mod: unknown): DawnMiddleware | undefined {
  return selectMiddlewareExport(mod)
}

/**
 * Boot-time loader for a generated `modules.mjs` — what the node target's
 * `server.mjs` calls. The manifest statically imports the app's TypeScript
 * sources, so the TS loader must be registered BEFORE the manifest is linked;
 * a bare static `import` in server.mjs would fail to resolve them under plain
 * Node. Registers the loader, imports the manifest, and validates its shape.
 */
export async function loadStaticModules(manifestUrl: URL | string): Promise<DawnStaticModules> {
  await registerTsxLoader()
  const href = typeof manifestUrl === "string" ? manifestUrl : manifestUrl.href
  const mod = (await import(href)) as { readonly default?: unknown }
  const manifest = mod.default
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Array.isArray((manifest as { readonly routes?: unknown }).routes)
  ) {
    throw new Error(
      `Static module manifest at ${href} must default-export { routes: [...] } — re-run \`dawn build\`.`,
    )
  }
  // Middleware is optional, and `undefined` is legitimate (the emitted
  // `normalizeMiddlewareModule(...)` returns undefined for a middleware file
  // with no usable export) — but any other non-function value is corruption.
  const middleware = (manifest as { readonly middleware?: unknown }).middleware
  if (middleware !== undefined && typeof middleware !== "function") {
    throw new Error(
      `Static module manifest at ${href} has a non-function middleware entry — re-run \`dawn build\`.`,
    )
  }
  const routes = (manifest as { readonly routes: readonly unknown[] }).routes
  for (const entry of routes) {
    if (!isStaticRouteModuleLike(entry)) {
      throw new Error(
        `Static module manifest at ${href} contains a malformed route entry — ` +
          `each entry needs assistantId/routeId/routeFile/module/tools. Re-run \`dawn build\`.`,
      )
    }
  }
  return manifest as DawnStaticModules
}

/**
 * Per-entry structural check: the manifest file is generated, but this loader
 * is a public export — a near-miss object (or an entry-level corruption the
 * `{ routes: [] }` shape check can't see) should fail here with the re-run
 * message, not degrade into 404s and undefined cache keys at serve time.
 */
function isStaticRouteModuleLike(entry: unknown): entry is StaticRouteModule {
  if (!entry || typeof entry !== "object") return false
  const candidate = entry as {
    readonly assistantId?: unknown
    readonly module?: unknown
    readonly routeFile?: unknown
    readonly routeId?: unknown
    readonly tools?: unknown
  }
  return (
    typeof candidate.assistantId === "string" &&
    typeof candidate.routeId === "string" &&
    typeof candidate.routeFile === "string" &&
    typeof candidate.module === "object" &&
    candidate.module !== null &&
    Array.isArray(candidate.tools)
  )
}
