# @dawnai.org/sdk

TypeScript types for authoring Dawn routes and tools.

Public surface:
- `RuntimeContext` — context object passed to workflow and graph entry points (tools, abort signal)
- `RuntimeTool`, `ToolRegistry` — tool type primitives
- `RouteConfig`, `RouteKind` — route metadata types

This package is a pure type layer with no runtime dependencies. Import it in route `index.ts` files for type annotations.
