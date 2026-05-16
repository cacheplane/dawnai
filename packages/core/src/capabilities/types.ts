import type { ResolvedStateField } from "../types.js"

export interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
    },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
}

export interface PromptFragment {
  readonly placement: "after_user_prompt"
  /**
   * Render this fragment given the current state of the agent's channels.
   * Called every model turn so the rendered text can reflect live state
   * (e.g., the current todos list is re-injected each turn).
   */
  readonly render: (state: Readonly<Record<string, unknown>>) => string
}

export interface StreamTransformerInput {
  readonly toolName: string
  readonly toolOutput: unknown
}

export interface StreamTransformerOutput {
  readonly event: string
  readonly data: unknown
}

export interface StreamTransformer {
  readonly observes: "tool_result"
  readonly transform: (
    input: StreamTransformerInput,
  ) => Iterable<StreamTransformerOutput> | AsyncIterable<StreamTransformerOutput>
}

export interface CapabilityContribution {
  readonly tools?: ReadonlyArray<DawnToolDefinition>
  readonly stateFields?: ReadonlyArray<ResolvedStateField>
  readonly promptFragment?: PromptFragment
  readonly streamTransformers?: ReadonlyArray<StreamTransformer>
}

export interface CapabilityMarker {
  readonly name: string
  readonly detect: (routeDir: string) => Promise<boolean>
  readonly load: (routeDir: string) => Promise<CapabilityContribution>
}
