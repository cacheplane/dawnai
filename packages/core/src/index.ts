export { loadDawnConfig } from "./config.js"
export { discoverRoutes, validateRouteEntries } from "./discovery/discover-routes.js"
export { assertDawnRoutesDir, findDawnApp } from "./discovery/find-dawn-app.js"
export {
  loadAuthoringRouteDefinition,
  type ResolvedAuthoringRouteDefinition,
} from "./discovery/load-authoring-route-definition.js"
export {
  isPrivateSegment,
  isRouteGroupSegment,
  toRouteSegments,
} from "./discovery/route-segments.js"
export { renderRouteTypes } from "./typegen/render-route-types.js"
export type {
  DawnConfig,
  DiscoveredDawnApp,
  DiscoverRoutesOptions,
  FindDawnAppOptions,
  LoadDawnConfigOptions,
  LoadedDawnConfig,
  RouteDefinition,
  RouteEntryKind,
  RouteManifest,
  RouteSegment,
} from "./types.js"
