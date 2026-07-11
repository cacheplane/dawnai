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
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
  readonly output?: unknown
}

export interface TranslatorOptions {
  readonly threadId: string
  readonly runId: string
}

/** Run identity the consumer supplies; never synthesized by the mapper. */
export interface RunContext {
  readonly threadId: string
  readonly runId: string
}

/**
 * Structural Dawn agent stream shape consumed by the canonical AG-UI mapper.
 * The final member permits capability-contributed chunks without coupling this
 * package to Dawn core.
 */
export type DawnAgentStreamChunk =
  | { readonly type: "token"; readonly data: string }
  | { readonly type: "tool_call"; readonly data: DawnToolCallData }
  | { readonly type: "tool_result"; readonly data: DawnToolResultData }
  | { readonly type: "interrupt"; readonly data: unknown }
  | { readonly type: "done"; readonly data?: unknown }
  | { readonly type: string; readonly data?: unknown }

/**
 * The minimal Dawn stream-chunk shape the mapper consumes. Structurally
 * compatible with `AgentStreamChunk` from `@dawn-ai/langchain` (which is
 * `{ type: string; data: unknown }`), declared here so this package takes no
 * dependency on the langchain package.
 */
export interface RawChunk {
  readonly type: string
  readonly data?: unknown
}

export interface DawnToolCallData {
  readonly id?: string | undefined
  readonly name: string
  readonly input: unknown
}

export interface DawnToolResultData {
  readonly id?: string | undefined
  readonly name: string
  readonly output: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Validates and narrows a `tool_call` chunk's `data`. Returns null if malformed. */
export function asToolCallData(data: unknown): DawnToolCallData | null {
  if (!isRecord(data) || typeof data.name !== "string") return null
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    name: data.name,
    input: data.input,
  }
}

/** Validates and narrows a `tool_result` chunk's `data`. Returns null if malformed. */
export function asToolResultData(data: unknown): DawnToolResultData | null {
  if (!isRecord(data) || typeof data.name !== "string") return null
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    name: data.name,
    output: data.output,
  }
}
