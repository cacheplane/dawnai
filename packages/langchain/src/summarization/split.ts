import type { BaseMessage } from "@langchain/core/messages"

function isHuman(m: BaseMessage): boolean {
  const getType = (m as { getType?: () => string }).getType
  if (typeof getType === "function") return getType.call(m) === "human"
  const legacy = (m as { _getType?: () => string })._getType
  return typeof legacy === "function" ? legacy.call(m) === "human" : false
}

/**
 * Split into { toSummarize, recent }, keeping the last `keepRecentTurns` turns
 * verbatim. A turn begins at a HumanMessage; slicing on a HumanMessage boundary
 * keeps every tool round (AIMessage-with-tool_calls + its ToolMessages) intact,
 * so `recent` never starts mid-round. Fewer turns than requested -> all recent.
 */
export function splitForSummary(
  messages: readonly BaseMessage[],
  keepRecentTurns: number,
): { toSummarize: BaseMessage[]; recent: BaseMessage[] } {
  if (keepRecentTurns <= 0) return { toSummarize: [...messages], recent: [] }
  const humanIdx: number[] = []
  messages.forEach((m, i) => {
    if (isHuman(m)) humanIdx.push(i)
  })
  if (humanIdx.length <= keepRecentTurns) {
    return { toSummarize: [], recent: [...messages] }
  }
  const cut = humanIdx[humanIdx.length - keepRecentTurns] as number
  return { toSummarize: messages.slice(0, cut), recent: messages.slice(cut) }
}
