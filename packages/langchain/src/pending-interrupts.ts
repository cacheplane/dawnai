/**
 * Module-level registry of parked LangGraph interrupts, keyed by thread_id.
 *
 * Lives in `@dawn-ai/langchain` so that the agent-adapter (which detects
 * the interrupt and parks the stream) and the CLI's resume endpoint (which
 * dispatches the user's decision) both reference the same map. Putting it
 * here avoids a circular dep cli <-> langchain.
 *
 * The decision string ("once" | "always" | "deny") is the value passed to
 * `new Command({resume})` when the agent-adapter re-invokes the graph.
 * The langchain package intentionally does not depend on
 * `@dawn-ai/permissions`; the resume endpoint validates the decision shape
 * before calling `resolve()`.
 */

export type ResumeDecision = "once" | "always" | "deny"

export interface PendingInterrupt {
  readonly interruptId: string
  /** Settles the Promise awaited by the parked agent-adapter generator. */
  resolve(decision: ResumeDecision): void
}

const pendingByThread = new Map<string, PendingInterrupt>()

export function getPending(threadId: string): PendingInterrupt | undefined {
  return pendingByThread.get(threadId)
}

export function setPending(threadId: string, entry: PendingInterrupt): void {
  pendingByThread.set(threadId, entry)
}

export function clearPending(threadId: string): void {
  pendingByThread.delete(threadId)
}

/**
 * Test-only: reset all entries.
 */
export function __resetPendingForTests(): void {
  pendingByThread.clear()
}
