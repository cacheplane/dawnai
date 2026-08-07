/**
 * The edge-safe runtime surface: everything needed to serve a Dawn app from a
 * web-standard runtime. Excludes the CLI bin, the node HTTP server, the
 * dynamic discovery/loaders, tsx, and sqlite — callers supply `modules` (the
 * build-time manifest), `config`, and store instances instead, and anything
 * they leave out fails loudly rather than reaching for a filesystem that is
 * not there.
 *
 * `test/fetch-entry-purity.test.ts` bundles this entry and gates its module
 * graph: no `node:` import from any `@dawn-ai/cli` source, no sqlite, no tsx,
 * no commander, and a pinned inventory of the `node:` specifiers still
 * reachable through upstream Dawn packages.
 *
 * Exposed as `@dawn-ai/cli/fetch`.
 */

export { seedDawnConfig } from "@dawn-ai/core"
/**
 * Re-exported for build-emitted edge entry points: an edge bundle cannot keep
 * `createChatModel`'s default `import(specifier)` (a bundler cannot follow a
 * variable specifier), so the generated `app.mjs` seeds a map of static ones.
 * Adds no weight to this graph — `execute-route-core.ts` already imports
 * `@dawn-ai/langchain`.
 */
export { seedModelImporter } from "@dawn-ai/langchain"
export {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "./lib/dev/runtime-fetch-core.js"
export type { RequestStores, StartRuntimeServerOptions } from "./lib/dev/runtime-server.js"
export type {
  BootResolvedInstances,
  RuntimeBootFallbacks,
} from "./lib/runtime/execute-route-core.js"
export {
  buildStaticRouteModule,
  type DawnStaticModules,
  normalizeMiddlewareModule,
  type StaticRouteModule,
  type StaticRouteModuleInput,
  type StaticToolModuleInput,
} from "./lib/runtime/static-modules-core.js"
export type { StreamChunk } from "./lib/runtime/stream-types.js"
