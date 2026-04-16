export { loadDawnConfig } from "./config.js"
export { discoverRoutes, validateRouteEntries } from "./discovery/discover-routes.js"
export { assertDawnRoutesDir, findDawnApp } from "./discovery/find-dawn-app.js"
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
  RouteKind,
  RouteManifest,
  RouteSegment,
} from "./types.js"
