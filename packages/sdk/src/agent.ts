import type { KnownModelId } from "./known-model-ids.js"
import type { ModelProviderId } from "./model-provider.js"

const DAWN_AGENT: unique symbol = Symbol.for("dawn.agent") as unknown as typeof DAWN_AGENT

declare const brand: unique symbol

export interface RetryConfig {
  readonly maxAttempts?: number
  readonly baseDelay?: number
}

/**
 * Reasoning model tuning. Currently maps to OpenAI's `reasoningEffort`
 * parameter; non-reasoning models silently ignore it.
 *
 * Supported effort values (per OpenAI docs):
 *   - "none"    — disable reasoning entirely (gpt-5.1+ only)
 *   - "minimal" — fastest, smallest reasoning budget
 *   - "low"     — light reasoning
 *   - "medium"  — default for models before gpt-5.1
 *   - "high"    — deeper reasoning; recommended for tool-use-heavy agents
 *   - "xhigh"   — gpt-5.1-codex-max and later only
 */
export interface ReasoningConfig {
  readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
}

export interface DawnAgent {
  readonly [brand]: "DawnAgent"
  readonly description?: string
  readonly model: string
  readonly provider?: ModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly retry?: RetryConfig
  readonly subagents?: readonly DawnAgent[]
  readonly systemPrompt: string
}

export interface AgentConfig {
  readonly description?: string
  readonly model: KnownModelId
  readonly provider?: ModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly retry?: RetryConfig
  readonly subagents?: readonly DawnAgent[]
  readonly systemPrompt: string
}

export function agent(config: AgentConfig): DawnAgent {
  return {
    [DAWN_AGENT]: true,
    model: config.model,
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.subagents !== undefined ? { subagents: config.subagents } : {}),
    systemPrompt: config.systemPrompt,
  } as unknown as DawnAgent
}

export function isDawnAgent(value: unknown): value is DawnAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    DAWN_AGENT in value &&
    (value as Record<symbol, unknown>)[DAWN_AGENT] === true
  )
}
