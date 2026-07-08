import type { BaseEvent } from "@ag-ui/core"

/** An AG-UI protocol event. Alias kept local so consumers import one name. */
export type AgUiEvent = BaseEvent

/**
 * Structural mirror of `@dawn-ai/cli`'s `StreamChunk`. Kept loose (all fields
 * optional beyond `type`) so this package has ZERO dependency on the CLI. The
 * translator inspects fields at runtime by `type`.
 */
export interface DawnStreamChunk {
  readonly type: string
  readonly data?: unknown
  readonly name?: string
  readonly input?: unknown
  readonly output?: unknown
}

export interface TranslatorOptions {
  readonly threadId: string
  readonly runId: string
}
