/**
 * Re-exports the pending-interrupts registry from `@dawn-ai/langchain`.
 *
 * The map itself lives in the langchain package so the agent-adapter (which
 * parks the stream on interrupt) and the CLI's resume endpoint (which
 * dispatches the user's decision) share the same module-level state without
 * introducing a circular dep cli <-> langchain.
 */

export type { PendingInterrupt, ResumeDecision } from "@dawn-ai/langchain"
export {
  __resetPendingForTests,
  clearPending,
  getPending,
  setPending,
} from "@dawn-ai/langchain"
