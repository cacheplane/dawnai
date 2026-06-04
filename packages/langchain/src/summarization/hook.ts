import { type BaseMessage, SystemMessage } from "@langchain/core/messages"
import { splitForSummary } from "./split.js"
import { countMessagesTokens } from "./token-counter.js"

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

export interface PreModelHookState {
  readonly messages: BaseMessage[]
  readonly runningSummary?: RunningSummary
}

export interface PreModelHookResult {
  llmInputMessages?: BaseMessage[]
  runningSummary?: RunningSummary
}

export function buildSummarizationHook(config: ResolvedSummarizationConfig) {
  return async (state: PreModelHookState): Promise<PreModelHookResult> => {
    const messages = state.messages ?? []
    const total = await countMessagesTokens(messages, config.tokenCounter)
    if (total <= config.maxTokens) return {}

    const prev = state.runningSummary
    const coveredCount = prev?.coveredCount ?? 0
    const { toSummarize, recent } = splitForSummary(messages, config.keepRecentTurns)
    const newlyAged = toSummarize.slice(coveredCount)

    let summary = prev?.summary ?? ""
    if (newlyAged.length > 0) {
      try {
        summary = await config.summarize({
          messages: newlyAged,
          model: config.model,
          ...(prev?.summary ? { previousSummary: prev.summary } : {}),
          signal: new AbortController().signal,
        })
      } catch {
        return {}
      }
    }
    if (!summary) return {}

    const summaryMessage = new SystemMessage(`Summary of earlier conversation:\n${summary}`)
    return {
      llmInputMessages: [summaryMessage, ...recent],
      runningSummary: { summary, coveredCount: toSummarize.length },
    }
  }
}
