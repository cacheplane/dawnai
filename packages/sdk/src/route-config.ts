export type RouteKind = "agent" | "chain" | "graph" | "workflow"

/**
 * Optional metadata a route's `index.ts` may export as `config` alongside its
 * entry.
 *
 * **Reserved. Dawn reads none of these fields today.** The shape is accepted,
 * type-checked, normalized onto the route module and carried into the static
 * build manifest — and then nothing branches on it. Exporting a `config` is
 * therefore inert: it will not change how a route builds, deploys, streams, or
 * is displayed.
 *
 * It is kept rather than deleted because removing a published field from a
 * public interface breaks every app that set one, to no one's benefit. Treat it
 * as forward-declared surface: if these gain behavior, it will be additive and
 * announced. Until then, do not reach for them expecting an effect.
 */
export interface RouteConfig {
  /**
   * Reserved; **no effect**. The node/edge split is decided entirely by
   * `build.targets` in `dawn.config.ts` — see the `hono` build target — and
   * never per route. A route marked `"edge"` is not excluded from a node build,
   * and one marked `"node"` is not excluded from an edge build.
   */
  readonly runtime?: "node" | "edge"
  /**
   * Reserved; **no effect**. Whether a run streams is decided by the endpoint
   * the caller hits (`/threads/:id/runs/stream` versus `/threads/:id/runs/wait`)
   * and by AG-UI's own transport, not by route metadata.
   */
  readonly streaming?: boolean
  /** Reserved; **no effect**. Nothing reads or displays these. */
  readonly tags?: readonly string[]
}
