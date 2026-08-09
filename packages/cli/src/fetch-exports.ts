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

/**
 * `seedRuntimeEnv` is for build-emitted edge entry points. On a runtime without
 * `process` (workerd without `nodejs_compat` — what this target emits),
 * `process.env` does not merely come back empty, it throws. Dawn reads env
 * through `readRuntimeEnv`, which prefers `process.env` and falls back to what
 * this seeds, so an edge entry can supply the knobs that are configuration
 * rather than debug output — `OPENAI_BASE_URL` above all, which is how the
 * workerd lane points the model at a local aimock.
 */
/**
 * `readRuntimeEnv` is the other half, and the emitted `stores.mjs` uses it: a
 * generated entry must read its own bindings the way Dawn does — `process.env`
 * first, the seeded map second — so the SAME file serves a Workers deploy (where
 * bindings arrive as `env` and there is no `process`) and a Node or Bun host
 * (where the host's second argument is not a bindings object at all and the
 * values live in the process environment).
 */
export { type RuntimeEnv, readRuntimeEnv, seedDawnConfig, seedRuntimeEnv } from "@dawn-ai/core"
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
