/**
 * Programmatic runtime surface for tooling (e.g. @dawn-ai/testing).
 * Kept separate from the `dawn` CLI bin entry (src/index.ts) so importing
 * the runtime never triggers the commander program. Exposed as the
 * `@dawn-ai/cli/runtime` subpath.
 */

export { __resetMaterializedAgentsForTests } from "@dawn-ai/langchain"
// Exported only to support @dawn-ai/testing's live-smoke memory tests; not a
// stable public surface — safe to gate (NODE_ENV) or relocate if it grows.
export { runMemoryCommand } from "./commands/memory.js"
export {
  type DawnResumeEntry,
  type PendingInterrupt,
  type PendingInterruptSnapshot,
  type PermissionDecision,
  type ResumeResolution,
  readPendingInterrupts,
  resolvePendingResume,
} from "./lib/dev/pending-interrupts.js"
export {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "./lib/dev/runtime-fetch-handler.js"
export { createRuntimeRegistry, type RuntimeRegistry } from "./lib/dev/runtime-registry.js"
export {
  createRuntimeRequestListener,
  type RuntimeRequestListener,
  type StartRuntimeServerOptions,
  startRuntimeServer,
} from "./lib/dev/runtime-server.js"
export {
  type ServeRuntimeHandle,
  type ServeRuntimeOptions,
  serveRuntime,
} from "./lib/dev/serve-runtime.js"
export { normalizeThreadAccessResult } from "./lib/dev/thread-access.js"
export {
  __resetRouteLoadCachesForTests,
  executeResolvedRoute,
  invokeResolvedRoute,
  type MaterializeResolvedRouteGraphOptions,
  materializeResolvedRouteGraph,
  type PreparedRouteModules,
  resolveCheckpointer,
  resolveThreadsStore,
  seedPreparedRouteModules,
  streamResolvedRoute,
} from "./lib/runtime/execute-route.js"
// Exposed so wiring tests (and any out-of-band driver) can build the same
// per-server SandboxManager the runtime HTTP server builds, then thread it
// (+ threadId) into streamResolvedRoute — exactly what createRuntimeRequestListener
// does internally.
export { resolveSandboxManager } from "./lib/runtime/resolve-sandbox.js"
export type { SandboxManager } from "./lib/runtime/sandbox-manager.js"
export {
  buildStaticRouteModule,
  type DawnStaticModules,
  loadStaticModules,
  normalizeMiddlewareModule,
  normalizeThreadAccessModule,
  type StaticRouteModule,
  type StaticRouteModuleInput,
  type StaticToolModuleInput,
} from "./lib/runtime/static-modules.js"
export type { StreamChunk } from "./lib/runtime/stream-types.js"
export { runTypegen } from "./lib/typegen/run-typegen.js"
