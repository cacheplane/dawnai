/**
 * Programmatic runtime surface for tooling (e.g. @dawn-ai/testing).
 * Kept separate from the `dawn` CLI bin entry (src/index.ts) so importing
 * the runtime never triggers the commander program. Exposed as the
 * `@dawn-ai/cli/runtime` subpath.
 */

export { createRuntimeRegistry, type RuntimeRegistry } from "./lib/dev/runtime-registry.js"
export {
  createRuntimeRequestListener,
  type RuntimeRequestListener,
  startRuntimeServer,
} from "./lib/dev/runtime-server.js"
export {
  executeResolvedRoute,
  invokeResolvedRoute,
  resolveCheckpointer,
  resolveThreadsStore,
  streamResolvedRoute,
} from "./lib/runtime/execute-route.js"
export type { StreamChunk } from "./lib/runtime/stream-types.js"
export { runTypegen } from "./lib/typegen/run-typegen.js"
