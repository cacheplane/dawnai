/**
 * The NODE-only surface of `@dawn-ai/core`. Split out of the `.` barrel so a
 * runtime that only needs the request-path exports never drags `node:fs`,
 * `node:path`, `node:url`, `tsx` or `typescript` into its module graph —
 * nothing here is called on the fetch path, but a barrel re-export is an
 * import edge regardless of whether the symbol is used.
 *
 * Route discovery walks the filesystem; tool typegen loads the TypeScript
 * compiler. Both are build/dev-time concerns, so they live here rather than
 * getting a subpath each — same shape as `@dawn-ai/workspace/node` and
 * `@dawn-ai/permissions/node`.
 *
 * The PURE members of `discovery/` and `typegen/` (route-segment parsing and
 * the `.d.ts` renderers) deliberately stay on the `.` barrel: the fetch path
 * calls `toRouteSegments` when it builds a registry from a static manifest.
 *
 * Importing this barrel also REGISTERS the disk config loader (`config-node.js`
 * self-registers on import), so `loadDawnConfig` reads `dawn.config.ts` exactly
 * as it did before the split for anything on the node lane.
 */

export {
  loadDawnConfigUncached,
  registerNodeConfigLoader,
  registerTsxLoader,
} from "./config-node.js"
export { discoverRoutes } from "./discovery/discover-routes.js"
export { assertDawnRoutesDir, findDawnApp } from "./discovery/find-dawn-app.js"
export { nodeMarkerFs } from "./node-marker-fs.js"
export { nodeLoadRouteDescription } from "./node-route-description.js"
export type { ExtractToolSchemasOptions } from "./typegen/extract-tool-schema.js"
export { extractToolSchemasForRoute } from "./typegen/extract-tool-schema.js"
export type { ExtractToolTypesOptions } from "./typegen/extract-tool-types.js"
export { extractToolTypesForRoute } from "./typegen/extract-tool-types.js"
