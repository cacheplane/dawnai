/**
 * The `node:`-free half of the static-module manifest: its types, the
 * build-time route/middleware normalizers, and the shape guard. Split from
 * `static-modules.ts` (which registers the tsx loader to link a generated
 * `modules.mjs`) so the `@dawn-ai/cli/fetch` graph never reaches tsx.
 */

import {
  type NormalizedRouteModule,
  type ResolvedStateField,
  type RouteKind,
  resolveStateFields,
} from "@dawn-ai/core"
import type { DawnMiddleware, ThreadAccessPolicy } from "@dawn-ai/sdk"

import { selectMiddlewareExport } from "../dev/middleware.js"
import { selectThreadAccessExport, validateThreadAccessPolicy } from "../dev/thread-access.js"
import { pureDirname, pureJoin } from "./pure-path.js"
import { createRouteAssistantId } from "./route-identity.js"
import { type LoadedRouteMemory, normalizeRouteMemoryExport } from "./route-memory-shape.js"
import { normalizeRouteModuleObject } from "./route-module-shape.js"
import {
  type DiscoveredToolDefinition,
  injectGeneratedSchemas,
  normalizeToolModule,
  type ToolScope,
} from "./tool-shape.js"

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
  /**
   * Skill directory names this route had at BUILD time; absent when it had
   * none.
   *
   * Carried for one consumer only — `collectRuntimeCapabilityGaps`, which uses
   * it to raise DAWN_E1005 on a runtime with no filesystem. Nothing loads a
   * skill from this: bodies still come off disk through the skills capability's
   * MarkerFs on node, and on a filesystem-less runtime there is nothing to load,
   * which is precisely what the guard exists to report. Deliberately NOT part
   * of `PreparedRouteModules` — the per-route execution cache has no use for it.
   */
  readonly skills?: readonly string[]
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
  /**
   * App-level thread access policy bound from the manifest's static import,
   * when the app has a policy file.
   *
   * Emitted by the web build targets (`modules-emitter.ts` writes
   * `threadAccess: normalizeThreadAccessModule(...)` into the manifest) and
   * re-validated on the boot path (`static-modules.ts` runs
   * `validateThreadAccessPolicy` because types are erased across the manifest
   * boundary). A hand-rolled edge embed that constructs `DawnStaticModules`
   * itself can also populate it directly.
   */
  readonly threadAccess?: ThreadAccessPolicy
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
   * Skill directory names found under `<routeDir>/skills` at build time.
   * Omitted by the generator when the route has none.
   */
  readonly skills?: readonly string[]
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
          pureJoin(pureDirname(input.routeFile), "memory.ts"),
        )

  return {
    assistantId: createRouteAssistantId(input.routeId, module.kind),
    kind: module.kind,
    memory,
    module,
    routeFile: input.routeFile,
    routeId: input.routeId,
    routePath: input.routePath,
    // Conditional spread, not `skills: input.skills`: under
    // exactOptionalPropertyTypes an explicit `undefined` is not assignable to
    // an optional field, and an absent key is what "no skills" means here.
    ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
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
 * A manifest whose thread-access entry bound nothing usable.
 *
 * A local class rather than `CliError`: `../output.js` is node-only and this
 * module is in the `@dawn-ai/cli/fetch` graph — the same reason
 * `runtime-fetch-core.ts` rolls its own. `dawnErrorCodeOf` reads the code back.
 */
class ManifestThreadAccessError extends Error {
  /** Registry code, the same one the dynamic loader raises. */
  readonly code = "DAWN_E3003"
  constructor(reason: string) {
    super(
      `The thread access policy in this app's static module manifest is not usable: ${reason}. ` +
        "The manifest carries a policy only for an app that HAS a policy file, so Dawn will not " +
        "boot with every thread endpoint ungated — fix the policy file and re-run `dawn build`.",
    )
    this.name = "ManifestThreadAccessError"
  }
}

/**
 * Runtime companion for the manifest's thread-access entry: pick the policy out
 * of the statically-imported `import * as` namespace using the SAME selection
 * rule the dynamic probe (`loadThreadAccess`) applies — `default` first, then
 * the named `threadAccess` export — and validate it with the same shape check.
 *
 * Deliberately NOT `normalizeMiddlewareModule`'s ending: that one returns
 * undefined when a middleware file binds nothing, because dev ignores such a
 * file too. Here, "binds nothing" THROWS, for the reason `loadThreadAccess`
 * throws on it: the emitter only ever writes this call for an app that has a
 * policy file, so a selection that comes back empty means the built app would
 * serve every thread endpoint ungated while logging that it has no policy —
 * degrading to `undefined` would make that failure indistinguishable from an
 * app that never had a policy at all.
 *
 * Throwing here also runs at manifest LINK time, on both targets: the edge
 * flavor is imported directly by the generated `app.mjs`, never through
 * `loadStaticModules`, so this is the only seam a bundled deploy passes.
 */
export function normalizeThreadAccessModule(mod: unknown): ThreadAccessPolicy {
  const selected = selectThreadAccessExport(mod)
  if (selected === undefined || selected === null) {
    throw new ManifestThreadAccessError(
      "the built module has no `default` or `threadAccess` export " +
        "(export the policy with `export default defineThreadAccess({ … })`)",
    )
  }
  const reason = validateThreadAccessPolicy(selected)
  if (reason) throw new ManifestThreadAccessError(reason)
  return selected as ThreadAccessPolicy
}
