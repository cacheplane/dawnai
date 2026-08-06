// The canonical node MarkerFs implementation moved to @dawn-ai/core/node (an
// explicitly node-only subpath) so all node-side consumers share one copy.
// This re-export keeps cli import sites stable; the edge fetch entry never
// imports this module.
export { nodeMarkerFs } from "@dawn-ai/core/node"
