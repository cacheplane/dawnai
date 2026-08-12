/**
 * The NODE layer of route execution: the filesystem-backed resolutions the
 * request-path core (`execute-route-core.ts`) falls back to when the caller
 * did not supply an instance, plus the CLI's disk-first `executeRoute` entry.
 *
 * This module is deliberately absent from the `@dawn-ai/cli/fetch` graph —
 * everything here reaches `node:fs`, `node:sqlite`, or `tsx`. Every export the
 * core owns is re-exported from here with `bootFallbacks: nodeBootFallbacks`
 * pre-applied, so importing `execute-route.js` behaves exactly as it did
 * before the split.
 */

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type DawnConfig,
  type ResolvedStateField,
  type RouteDefinition,
  type RouteManifest,
  resolveStateFields,
} from "@dawn-ai/core"
import { discoverRoutes, findDawnApp } from "@dawn-ai/core/node"
import type { PermissionMode, PermissionsStore } from "@dawn-ai/permissions"
import { createPermissionsStore } from "@dawn-ai/permissions/node"
import { isDawnAgent } from "@dawn-ai/sdk"
import { createThreadsStore, sqliteCheckpointer, type ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import { localExec, localFilesystem } from "@dawn-ai/workspace/node"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { loadMiddleware } from "../dev/middleware.js"
import { loadThreadAccess } from "../dev/thread-access-node.js"
import { loadDawnConfig } from "../node-config.js"
import {
  __resetDescriptorRouteIndexCacheForTests,
  getCachedDescriptorRouteIndex,
} from "./descriptor-route-index.js"
import {
  __resetPreparedRouteModulesForTests,
  __resetStaticDescriptorMapsForTests,
  type BootResolvedInstances,
  executeResolvedRoute as executeResolvedRouteCore,
  executeRouteAtResolvedPath,
  invokeResolvedRoute as invokeResolvedRouteCore,
  type MaterializeResolvedRouteGraphOptions,
  materializeResolvedRouteGraph as materializeResolvedRouteGraphCore,
  type PreparedRoute,
  type PreparedRouteError,
  type PreparedRouteModules,
  prepareRouteExecution as prepareRouteExecutionCore,
  type RuntimeBootFallbacks,
  streamResolvedRoute as streamResolvedRouteCore,
} from "./execute-route-core.js"
import { loadRouteMemory } from "./load-memory.js"
import { normalizeRouteModule } from "./load-route-kind.js"
import { nodeMarkerFs } from "./node-marker-fs.js"
import { pureDirname, pureJoin } from "./pure-path.js"
import { resolveIdentityKeys } from "./resolve-identity.js"
import { resolveMemoryStore, resolveMemoryWrites } from "./resolve-memory.js"
import { resolveSandboxManager } from "./resolve-sandbox.js"
import {
  createRuntimeFailureResult,
  formatErrorMessage,
  type RuntimeExecutionResult,
} from "./result.js"
import { deriveRouteIdentity } from "./route-identity-node.js"
import type { ScenarioToolCallJournal, ScenarioToolOverride } from "./scenario-tool-overrides.js"
import { discoverStateDefinition } from "./state-discovery.js"
import type { StreamChunk } from "./stream-types.js"
import {
  type DiscoveredToolDefinition,
  discoverToolDefinitions,
  injectGeneratedSchemas,
} from "./tool-discovery.js"
import { fileExists } from "./utils.js"

export type {
  BootResolvedInstances,
  MaterializeResolvedRouteGraphOptions,
  PreparedRouteModules,
  RouteResumePayload,
  RuntimeBootFallbacks,
  StaticDescriptorMaps,
} from "./execute-route-core.js"
// Core surface no node caller resolves differently.
export {
  __resetPreparedRouteModulesForTests,
  buildDescriptorMapsFromStaticModules,
  buildGuardedSubagentResolver,
  exemptToolSet,
  getCachedStaticDescriptorMaps,
  seedPreparedRouteModules,
  toAgentInput,
} from "./execute-route-core.js"

export interface ExecuteRouteOptions {
  readonly appRoot?: string
  readonly cwd?: string
  readonly input: unknown
  readonly routeFile: string
  readonly signal?: AbortSignal
  readonly toolCallJournal?: ScenarioToolCallJournal
  readonly toolOverrides?: readonly ScenarioToolOverride[]
}

// ---------------------------------------------------------------------------
// Node fallbacks — the filesystem-backed half of route preparation
// ---------------------------------------------------------------------------

/**
 * Per-process caches for the node-only resolutions. Promises are cached so
 * concurrent first requests share one load; rejections are evicted so a
 * transient load error (e.g. a syntax error mid-edit in dev) does not poison
 * the process.
 */
const routeManifestCache = new Map<string, Promise<RouteManifest>>()
const workspaceDirProbeCache = new Map<string, boolean>()

/**
 * Default filesystem backend, constructed at most once per process and only
 * when a request actually needs it (no sandbox/config backend provided).
 * Always constructed options-free, so the instance carries no per-app or
 * per-request state — one shared instance is safe, and it is deliberately
 * NOT cleared by `__resetRouteLoadCachesForTests` (nothing about it can go
 * stale).
 */
let defaultLocalFilesystem: FilesystemBackend | undefined
function getDefaultLocalFilesystem(): FilesystemBackend {
  defaultLocalFilesystem ??= localFilesystem()
  return defaultLocalFilesystem
}

/** Same contract as `getDefaultLocalFilesystem`, for the workspace capability's `runBash`. */
let defaultLocalExec: ExecBackend | undefined
function getDefaultLocalExec(): ExecBackend {
  defaultLocalExec ??= localExec()
  return defaultLocalExec
}

/**
 * `workspace/` existence probe for the offload store, memoizing only
 * POSITIVE results per appRoot: the runtime never un-creates a workspace
 * dir, so `true` is stable for the process lifetime. Negative results are
 * re-probed on every request (one `existsSync` until the dir appears, zero
 * after) because agent tools can create `workspace/` mid-process
 * (`localFilesystem.writeFile` mkdirs recursively) and the dev watcher
 * deliberately ignores workspace/ changes — no restart would refresh a
 * cached `false`. Internal; exported for tests only. Reset via
 * `__resetRouteLoadCachesForTests`.
 */
export function hasWorkspaceDir(appRoot: string): boolean {
  if (workspaceDirProbeCache.get(appRoot)) return true
  const present = existsSync(pureJoin(appRoot, "workspace"))
  if (present) workspaceDirProbeCache.set(appRoot, present)
  return present
}

async function loadPreparedRouteModules(options: {
  readonly appRoot: string
  readonly routeFile: string
  readonly routeId: string
}): Promise<PreparedRouteModules> {
  const routeDir = pureDirname(options.routeFile)

  const normalized = await normalizeRouteModule(options.routeFile, options.appRoot)

  const discoveredTools = await discoverToolDefinitions({
    appRoot: options.appRoot,
    routeDir,
  })

  // Inject codegen-generated schemas for tools without explicit schema exports
  const routeSlug =
    options.routeId.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") ||
    "index"
  const schemaManifestPath = pureJoin(options.appRoot, ".dawn", "routes", routeSlug, "tools.json")
  let tools: readonly DiscoveredToolDefinition[] = discoveredTools
  if (existsSync(schemaManifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(schemaManifestPath, "utf-8")) as Record<
        string,
        unknown
      >
      tools = injectGeneratedSchemas(discoveredTools, manifest)
    } catch {
      // Generated schema is best-effort — fall through on parse errors
    }
  }

  let stateFields: readonly ResolvedStateField[] | undefined
  if (normalized.kind === "agent") {
    const stateDefinition = await discoverStateDefinition({ routeDir })
    if (stateDefinition) {
      stateFields = resolveStateFields({
        defaults: stateDefinition.defaults,
        reducerOverrides: stateDefinition.reducerOverrides,
      })
    }
  }

  const memoryFile = pureJoin(routeDir, "memory.ts")
  const memory =
    normalized.kind === "agent" && existsSync(memoryFile) ? await loadRouteMemory(memoryFile) : null

  return { memory, module: normalized, stateFields, tools }
}

/** Route-tree walk, once per appRoot per process — the no-boot-manifest fallback. */
function discoverRoutesOncePerAppRoot(appRoot: string): Promise<RouteManifest> {
  const cached = routeManifestCache.get(appRoot)
  if (cached) return cached
  const loading = discoverRoutes({ appRoot })
  routeManifestCache.set(appRoot, loading)
  loading.catch(() => routeManifestCache.delete(appRoot))
  return loading
}

async function loadSubagentDescription(route: RouteDefinition): Promise<string> {
  const mod = (await import(pathToFileURL(route.entryFile).href)) as {
    default?: unknown
  }
  return isDawnAgent(mod.default) && typeof mod.default.description === "string"
    ? mod.default.description
    : "No description provided."
}

/**
 * Resolves the ThreadsStore for the given appRoot.
 *
 * Uses `config.threadsStore` if the user's `dawn.config.ts` provides one;
 * otherwise falls back to the default SQLite-backed store at
 * `<appRoot>/.dawn/threads.sqlite`. Exported so the HTTP server layer
 * can obtain the same store instance independently of route execution.
 */
export async function resolveThreadsStore(appRoot: string): Promise<ThreadsStore> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.threadsStore) {
      return loaded.config.threadsStore
    }
  } catch {
    // No dawn.config.ts or unreadable — fall through to default.
  }
  return createThreadsStore({
    path: pureJoin(appRoot, ".dawn/threads.sqlite"),
  })
}

/**
 * Resolves the checkpointer for the given appRoot.
 *
 * Uses `config.checkpointer` if the user's `dawn.config.ts` provides one;
 * otherwise falls back to the default SQLite-backed saver at
 * `<appRoot>/.dawn/checkpoints.sqlite`. Exported so the HTTP server layer
 * can obtain a checkpointer independently of route execution (e.g. for the
 * GET /threads/:id/state endpoint).
 */
export async function resolveCheckpointer(appRoot: string): Promise<BaseCheckpointSaver> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.checkpointer) {
      return loaded.config.checkpointer
    }
  } catch {
    // No dawn.config.ts or unreadable — fall through to default.
  }
  return sqliteCheckpointer({
    path: pureJoin(appRoot, ".dawn/checkpoints.sqlite"),
  })
}

/**
 * Resolves a loaded PermissionsStore for the given appRoot: `config.permissions.store`
 * if the user's `dawn.config.ts` provides one, otherwise config-seeded
 * allow/deny + mode (env override wins) over `.dawn/permissions.json`. Either
 * way the returned store has had `load()` called exactly once — THIS resolver
 * owns that call, because a store may be a cache that is empty until hydrated
 * and `match()` is synchronous. Exported so the HTTP server layer can build the
 * store at boot (production) or per request via a factory (dev — keeps HITL
 * "Always" grants written mid-process fresh).
 */
export async function resolvePermissionsStore(appRoot: string): Promise<PermissionsStore> {
  let permissionsConfig: DawnConfig["permissions"] | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    permissionsConfig = loaded.config.permissions
  } catch {
    // No dawn.config.ts or unreadable — fall through to defaults.
  }
  const configStore = permissionsConfig?.store
  if (configStore) {
    // A custom store owns its own mode/allow/deny (supplied to its factory in
    // dawn.config.ts), so neither the env mode override nor the config lists
    // are re-applied here — re-wrapping would silently double-apply them.
    await configStore.load()
    return configStore
  }
  return await buildPermissionsStore(appRoot, permissionsConfig)
}

/**
 * Shared FILE-BACKED permissions-store construction: config + env-mode
 * resolution + one `load()`. Deliberately does NOT consult
 * `config.permissions.store` — it is the default-path primitive exposed on
 * `RuntimeBootFallbacks`, and boot-level resolution (`resolvePermissionsStore`,
 * which the HTTP layer always goes through) is where a custom store is honored.
 */
async function buildPermissionsStore(
  appRoot: string,
  permissionsConfig: DawnConfig["permissions"] | undefined,
): Promise<PermissionsStore> {
  const envMode = process.env.DAWN_PERMISSIONS_MODE
  const mode: PermissionMode =
    envMode === "interactive" || envMode === "non-interactive" || envMode === "bypass"
      ? envMode
      : (permissionsConfig?.mode ?? "interactive")

  const store = createPermissionsStore({
    appRoot,
    config: permissionsConfig
      ? {
          version: 1,
          allow: permissionsConfig.allow ?? {},
          deny: permissionsConfig.deny ?? {},
        }
      : undefined,
    mode,
  })
  await store.load()
  return store
}

/**
 * The one node fallback bag. Handing it to the core reproduces, exactly, the
 * pre-split behavior of every resolution the core no longer performs itself.
 * Exported so the HTTP server layer (and any node embedder) can pass it to
 * `createRuntimeFetchHandler`.
 */
export const nodeBootFallbacks: RuntimeBootFallbacks = {
  buildPermissionsStore,
  defaultCheckpointer: (appRoot) =>
    sqliteCheckpointer({ path: pureJoin(appRoot, ".dawn/checkpoints.sqlite") }),
  defaultExec: getDefaultLocalExec,
  defaultFilesystem: getDefaultLocalFilesystem,
  defaultThreadsStore: (appRoot) =>
    createThreadsStore({ path: pureJoin(appRoot, ".dawn/threads.sqlite") }),
  descriptorRouteIndex: getCachedDescriptorRouteIndex,
  discoverRouteManifest: discoverRoutesOncePerAppRoot,
  hasWorkspaceDir,
  loadConfig: async (appRoot) => (await loadDawnConfig({ appRoot })).config,
  loadMiddleware,
  loadRouteModules: loadPreparedRouteModules,
  loadSubagentDescription,
  loadThreadAccess,
  markerFs: nodeMarkerFs,
  resolveIdentityKeys,
  resolveCheckpointer,
  resolveMemoryStore,
  resolveMemoryWrites,
  resolvePermissionsStore,
  resolveSandboxManager,
  resolveThreadsStore,
}

/**
 * THE single conversion between a host-supplied app root and the
 * POSIX-normalized absolute form `@dawn-ai/core` assumes.
 *
 * Core derives the workspace root from `appRoot` and then decides containment
 * with pure POSIX arithmetic against an explicit "/" — `pureResolve` throws on
 * a relative base rather than rooting it somewhere silently. Normalizing here
 * keeps the previous semantics of the `node:path` jail (a relative root
 * resolved against `process.cwd()`) while giving core exactly one guaranteed
 * input shape. Dawn targets POSIX hosts only, so this is effectively identity;
 * a Windows port would convert here, and only here.
 */
export function toPosixAppRoot(appRoot: string): string {
  return resolve(appRoot)
}

/**
 * Apply the node fallbacks unless the caller already chose their own, and
 * normalize the app root on the way in (see `toPosixAppRoot`).
 */
function withNodeFallbacks<T extends object>(
  options: T,
): T & { readonly bootFallbacks: RuntimeBootFallbacks } {
  const appRoot = (options as { readonly appRoot?: unknown }).appRoot
  return {
    ...options,
    ...(typeof appRoot === "string" ? { appRoot: toPosixAppRoot(appRoot) } : {}),
    bootFallbacks: (options as BootResolvedInstances).bootFallbacks ?? nodeBootFallbacks,
  }
}

/**
 * Test-only: clear the per-route module, per-appRoot manifest, and workspace
 * probe caches so suites that mutate a fixture app mid-process (new tools,
 * changed routes) observe the change on the next load. Mirrors
 * `__clearDawnConfigCacheForTests`.
 */
export function __resetDescriptorRouteMapCacheForTests(): void {
  __resetDescriptorRouteIndexCacheForTests()
  __resetStaticDescriptorMapsForTests()
}

export function __resetRouteLoadCachesForTests(): void {
  __resetPreparedRouteModulesForTests()
  routeManifestCache.clear()
  workspaceDirProbeCache.clear()
}

// ---------------------------------------------------------------------------
// Core surface with the node fallbacks pre-applied
// ---------------------------------------------------------------------------

export async function prepareRouteExecution(
  options: Parameters<typeof prepareRouteExecutionCore>[0],
): Promise<PreparedRoute | PreparedRouteError> {
  return await prepareRouteExecutionCore(withNodeFallbacks(options))
}

export async function executeResolvedRoute(
  options: Parameters<typeof executeResolvedRouteCore>[0],
): Promise<RuntimeExecutionResult> {
  return await executeResolvedRouteCore(withNodeFallbacks(options))
}

export async function invokeResolvedRoute(
  options: Parameters<typeof invokeResolvedRouteCore>[0],
): Promise<RuntimeExecutionResult> {
  return await invokeResolvedRouteCore(withNodeFallbacks(options))
}

export async function materializeResolvedRouteGraph(
  options: MaterializeResolvedRouteGraphOptions,
): Promise<unknown> {
  return await materializeResolvedRouteGraphCore(withNodeFallbacks(options))
}

export async function* streamResolvedRoute(
  options: Parameters<typeof streamResolvedRouteCore>[0],
): AsyncGenerator<StreamChunk> {
  yield* streamResolvedRouteCore(withNodeFallbacks(options))
}

// ---------------------------------------------------------------------------
// Disk-first CLI entry (`dawn run`, `dawn test`)
// ---------------------------------------------------------------------------

export async function executeRoute(options: ExecuteRouteOptions): Promise<RuntimeExecutionResult> {
  const startedAt = Date.now()
  const discoveredApp = await discoverApp(options)

  if (!discoveredApp.ok) {
    return createRuntimeFailureResult({
      appRoot: null,
      executionSource: "in-process",
      kind: "app_discovery_error",
      message: discoveredApp.message,
      routePath: options.routeFile,
      startedAt,
    })
  }

  const appRoot = discoveredApp.appRoot
  const routeFile = resolveRouteFile({
    appRoot,
    routeFile: options.routeFile,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  })

  const identity = deriveRouteIdentity({
    appRoot,
    routeFile,
    routesDir: discoveredApp.routesDir,
  })

  if (!identity.ok) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file is outside the configured appDir: ${routeFile}`,
      routePath: identity.routePath,
      startedAt,
    })
  }

  if (!(await fileExists(routeFile))) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file does not exist: ${routeFile}`,
      routeId: identity.routeId,
      routePath: identity.routePath,
      startedAt,
    })
  }

  const resolved = {
    appRoot,
    input: options.input,
    routeFile,
    routeId: identity.routeId,
    routePath: identity.routePath,
    ...(options.signal ? { signal: options.signal } : {}),
    startedAt,
  }
  const scenarioInvocation =
    options.toolOverrides && options.toolOverrides.length > 0
      ? {
          journal: options.toolCallJournal ?? [],
          overrides: options.toolOverrides,
        }
      : undefined
  return await executeRouteAtResolvedPath(withNodeFallbacks(resolved), scenarioInvocation)
}

function resolveRouteFile(options: {
  readonly appRoot: string
  readonly cwd?: string
  readonly routeFile: string
}): string {
  if (isAbsolute(options.routeFile)) {
    return resolve(options.routeFile)
  }

  if (options.routeFile.startsWith(".") || options.routeFile.startsWith("..")) {
    return resolve(options.cwd ?? process.cwd(), options.routeFile)
  }

  return resolve(options.appRoot, options.routeFile)
}

async function discoverApp(options: ExecuteRouteOptions): Promise<
  | {
      readonly appRoot: string
      readonly ok: true
      readonly routesDir: string
    }
  | {
      readonly message: string
      readonly ok: false
    }
> {
  try {
    const app = await findDawnApp({
      ...(options.appRoot ? { appRoot: options.appRoot } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })

    return {
      appRoot: app.appRoot,
      ok: true,
      routesDir: app.routesDir,
    }
  } catch (error) {
    return {
      message: formatErrorMessage(error),
      ok: false,
    }
  }
}
