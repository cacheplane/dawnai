import type { KnownModelId } from "./known-model-ids.js"
import type { ModelProviderId } from "./model-provider.js"

const DAWN_AGENT: unique symbol = Symbol.for("dawn.agent") as unknown as typeof DAWN_AGENT

declare const brand: unique symbol

export interface RetryConfig {
  readonly maxAttempts?: number
  readonly baseDelay?: number
}

export interface ConstraintContext {
  readonly toolName: string
  readonly routeId: string
  readonly threadId?: string
  readonly signal: AbortSignal
  /** Route params in scope (e.g. tenant) when the route is parameterized. */
  readonly params?: Readonly<Record<string, string>>
}

export type ConstraintVerdict = true | string | { readonly approve: true; readonly reason?: string }

export type ConstraintPredicate = (
  args: unknown,
  ctx: ConstraintContext,
) => ConstraintVerdict | Promise<ConstraintVerdict>

export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  /**
   * Tools that require human approval per call (HITL interrupt) unless
   * pre-approved via permissions allow.tool or a persisted "always" decision.
   * Name-level: the prompt shows the call's args, but the decision covers the
   * tool name. See docs/permissions.
   */
  readonly approve?: readonly string[]
  /**
   * Per-call argument constraints: a predicate per tool name, run at call time
   * against the model's arguments. Return `true` to allow, a string to deny
   * (returned as the tool result), or `{ approve: true }` to escalate to a HITL
   * approval prompt. Predicate bodies are not statically validated — only the
   * tool names are. See docs/permissions.
   */
  readonly constrain?: Readonly<Record<string, ConstraintPredicate>>
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
  readonly recursionLimit?: number
  readonly subagents?: readonly DawnAgent[]
  readonly tools?: ToolScope
  readonly systemPrompt: string
}

export interface AgentConfig {
  readonly description?: string
  readonly model: KnownModelId
  readonly provider?: ModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly retry?: RetryConfig
  /**
   * Maximum number of LangGraph super-steps for one run before it aborts with a
   * recursion error. Defaults to LangGraph's own limit (25). Raise it for deep
   * agents — e.g. a coordinator that dispatches subagents and makes many tool
   * calls — that legitimately need more steps to reach a stop condition.
   */
  readonly recursionLimit?: number
  readonly subagents?: readonly DawnAgent[]
  readonly tools?: ToolScope
  readonly systemPrompt: string
}

export function agent(config: AgentConfig): DawnAgent {
  return {
    [DAWN_AGENT]: true,
    model: config.model,
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
    ...(config.recursionLimit !== undefined ? { recursionLimit: config.recursionLimit } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.subagents !== undefined ? { subagents: config.subagents } : {}),
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
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
