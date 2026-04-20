import type { RouteKind } from "./route-config.js"

export interface BackendAdapter {
  readonly kind: RouteKind
  execute(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown>
  stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): AsyncIterable<unknown>
}
