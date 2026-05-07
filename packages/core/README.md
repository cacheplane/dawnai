<p>
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/core

Shared Dawn app discovery, config loading, route validation, and route type generation primitives.

Public surface:
- `loadDawnConfig()`
- `findDawnApp()`
- `discoverRoutes()`
- `renderRouteTypes()`

This package owns Dawn's filesystem and metadata conventions. It does not provide a graph runtime.
