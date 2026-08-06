/**
 * The node-flavoured `createRuntimeFetchHandler`: the transport-agnostic core
 * from `runtime-fetch-core.ts` with `nodeBootFallbacks` pre-applied, so every
 * store the caller did not inject resolves from disk exactly as it always
 * has. This is the import site for `dawn dev`, `dawn start`, the testing
 * harness, and anything else running on node.
 *
 * Edge runtimes import the core directly (via `@dawn-ai/cli/fetch`), pass no
 * fallbacks, and inject their stores instead.
 */

import { nodeBootFallbacks } from "../runtime/execute-route.js"
import {
  createRuntimeFetchHandler as createRuntimeFetchHandlerCore,
  type RuntimeFetchHandler,
} from "./runtime-fetch-core.js"

export type { RuntimeFetchHandler } from "./runtime-fetch-core.js"

export async function createRuntimeFetchHandler(
  options: Parameters<typeof createRuntimeFetchHandlerCore>[0],
): Promise<RuntimeFetchHandler> {
  return await createRuntimeFetchHandlerCore({
    ...options,
    bootFallbacks: options.bootFallbacks ?? nodeBootFallbacks,
  })
}
