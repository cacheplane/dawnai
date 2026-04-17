# @dawn/sdk

TypeScript types and helpers for authoring Dawn routes and tools.

Public surface:
- `RuntimeContext` — context object passed to workflow and graph entry points (tools, abort signal)
- `RuntimeTool`, `ToolRegistry` — tool type primitives
- `RouteConfig`, `RouteKind` — route metadata types
- `defineTool()` — validated tool constructor
- `ToolDefinition`, `ToolContext` — tool authoring types

This package is a pure type/utility layer with no runtime dependencies. Import it in route `index.ts` files and tool definitions.
