import type { BaseMessage } from "@langchain/core/messages"

export interface RunningSummary {
  readonly summary: string
  readonly coveredCount: number
}

export type TokenCounter = (text: string) => number | Promise<number>

export type SummarizeFn = (args: {
  readonly messages: readonly BaseMessage[]
  readonly model: string
  readonly previousSummary?: string
  readonly signal: AbortSignal
}) => Promise<string>

export interface ResolvedSummarizationConfig {
  readonly maxTokens: number
  readonly keepRecentTurns: number
  readonly model: string
  readonly tokenCounter: TokenCounter
  readonly summarize: SummarizeFn
}
