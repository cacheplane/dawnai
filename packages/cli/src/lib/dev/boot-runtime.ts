import { discoverRoutes } from "@dawn-ai/core"

import { runTypegen } from "../typegen/run-typegen.js"
import type { StartRuntimeServerOptions } from "./runtime-server.js"

/**
 * The once-at-boot assembly shared by `dawn dev` and `serveRuntime()`.
 *
 * `startRuntimeServer` (runtime-server.ts) already builds the runtime
 * registry, threads store, checkpointer, and sandbox manager on every call —
 * that part needs no extraction, it is already the single shared assembly
 * point. What both boot paths perform once, ahead of starting the HTTP
 * listener, is refreshing the generated route types so `dawn.generated.d.ts`
 * reflects the current route tree. This function is that shared step; both
 * `dev-session.ts` (dawn dev's initial boot) and `serve-runtime.ts`
 * (serveRuntime) call it instead of duplicating discoverRoutes+runTypegen.
 */
export async function buildRuntimeServerOptions(params: {
  readonly appRoot: string
}): Promise<StartRuntimeServerOptions> {
  const manifest = await discoverRoutes({ appRoot: params.appRoot })
  await runTypegen({ appRoot: params.appRoot, manifest })

  return { appRoot: params.appRoot }
}
