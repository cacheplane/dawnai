/**
 * Module-level registry of parked LangGraph interrupts, keyed by thread_id.
 *
 * When the agent-adapter yields a `{type: "interrupt"}` chunk, the streaming
 * route handler records a `PendingInterrupt` here so the
 * `POST /threads/:thread_id/resume` endpoint can hand the decision back to
 * the parked run.
 *
 * NOTE (sub-project 7 follow-up): completing the resume round-trip requires
 * a LangGraph checkpointer + thread_id wired through `createReactAgent` so
 * `graph.invoke(new Command({resume}), {configurable: {thread_id}})` can
 * replay from the parked state. That plumbing arrives with the Agent
 * Protocol work. Until then, `resolve()` only acknowledges the decision —
 * it cannot actually unblock the parked tool call.
 */

import type { PermissionDecision } from "@dawn-ai/permissions"

export interface PendingInterrupt {
  readonly interruptId: string
  /**
   * Called by the resume endpoint when the client submits a decision.
   * Implementation provided by the route streamer (see execute-route.ts).
   */
  resolve(decision: PermissionDecision): void
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
 * Test-only: reset all entries. Internal — not exported via the package
 * barrel.
 */
export function __resetPendingForTests(): void {
  pendingByThread.clear()
}
