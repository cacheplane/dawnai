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

export function buildSummarizationHook(cfg: ResolvedSummarizationConfig) {
  return async (
    state: PreModelHookState,
    nodeConfig?: { readonly signal?: AbortSignal },
  ): Promise<PreModelHookResult> => {
    const messages = state.messages ?? []
    const total = await countMessagesTokens(messages, cfg.tokenCounter)
    if (total <= cfg.maxTokens) return {}

    const prev = state.runningSummary
    const coveredCount = prev?.coveredCount ?? 0
    const { toSummarize, recent } = splitForSummary(messages, cfg.keepRecentTurns)
    const newlyAged = toSummarize.slice(coveredCount)

    let summary = prev?.summary ?? ""
    if (newlyAged.length > 0) {
      try {
        summary = await cfg.summarize({
          messages: newlyAged,
          model: cfg.model,
          ...(prev?.summary ? { previousSummary: prev.summary } : {}),
          signal: nodeConfig?.signal ?? new AbortController().signal,
        })
      } catch (error) {
        // Summarization failed this turn — fall back to the FULL history.
        // We must explicitly set llmInputMessages to the full messages (not
        // return {}), otherwise a stale condensed view from a prior turn would
        // remain in the channel and the model would answer without the latest
        // turn's messages.
        if (process.env.DAWN_DEBUG_SUMMARIZATION === "1") {
          console.warn(
            "[dawn] summarization failed — falling back to full history this turn:",
            error instanceof Error ? error.message : String(error),
          )
        }
        return { llmInputMessages: messages }
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
