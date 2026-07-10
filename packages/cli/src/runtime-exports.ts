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
export { createRuntimeRegistry, type RuntimeRegistry } from "./lib/dev/runtime-registry.js"
export {
  createRuntimeRequestListener,
  type RuntimeRequestListener,
  startRuntimeServer,
} from "./lib/dev/runtime-server.js"
export {
  type ServeRuntimeHandle,
  type ServeRuntimeOptions,
  serveRuntime,
} from "./lib/dev/serve-runtime.js"
export {
  executeResolvedRoute,
  invokeResolvedRoute,
  resolveCheckpointer,
  resolveThreadsStore,
  streamResolvedRoute,
} from "./lib/runtime/execute-route.js"
// Exposed so wiring tests (and any out-of-band driver) can build the same
// per-server SandboxManager the runtime HTTP server builds, then thread it
// (+ threadId) into streamResolvedRoute — exactly what createRuntimeRequestListener
// does internally.
export { resolveSandboxManager } from "./lib/runtime/resolve-sandbox.js"
export type { SandboxManager } from "./lib/runtime/sandbox-manager.js"
export type { StreamChunk } from "./lib/runtime/stream-types.js"
export { runTypegen } from "./lib/typegen/run-typegen.js"
