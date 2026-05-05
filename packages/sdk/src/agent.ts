const DAWN_AGENT: unique symbol = Symbol.for("dawn.agent") as unknown as typeof DAWN_AGENT

declare const brand: unique symbol

export interface RetryConfig {
  readonly maxAttempts?: number
  readonly baseDelay?: number
}

export interface DawnAgent {
  readonly [brand]: "DawnAgent"
  readonly model: string
  readonly retry?: RetryConfig
  readonly systemPrompt: string
}

import type { KnownModelId } from "./known-model-ids.js"

export interface AgentConfig {
  readonly model: KnownModelId
  readonly retry?: RetryConfig
  readonly systemPrompt: string
}

export function agent(config: AgentConfig): DawnAgent {
  return {
    [DAWN_AGENT]: true,
    model: config.model,
    ...(config.retry ? { retry: config.retry } : {}),
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
