const DAWN_AGENT: unique symbol = Symbol.for("dawn.agent") as unknown as typeof DAWN_AGENT

declare const brand: unique symbol

export interface DawnAgent {
  readonly [brand]: "DawnAgent"
  readonly model: string
  readonly systemPrompt: string
}

import type { KnownModelId } from "./known-model-ids.js"

export interface AgentConfig {
  readonly model: KnownModelId
  readonly systemPrompt: string
}

export function agent(config: AgentConfig): DawnAgent {
  return {
    [DAWN_AGENT]: true,
    model: config.model,
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
