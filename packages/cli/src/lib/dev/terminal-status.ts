import type { ThreadStatus } from "@dawn-ai/sqlite-storage"

/**
 * The status a turn's thread is left in once it stops producing chunks.
 *
 * What the call sites cannot show: a parked turn takes the NORMAL completion
 * path — the agent adapter yields the interrupt chunk and then `done` — so a
 * drained stream is not evidence that the turn finished; and a turn that parked
 * before failing is still parked, its pending interrupt intact in the
 * checkpoint. A thread that reads "idle" while a human is being waited on tells
 * a reconnecting client the agent is done, and the prompt is never answered.
 *
 * Its own module rather than living beside one of its callers: every streaming
 * surface has to end turns by this rule and they must not drift apart, and
 * `runtime-fetch-core.ts` — the obvious alternative home — already imports the
 * AG-UI handler, so putting it there would make the handler import back into
 * its own composition root.
 *
 * `cancelled` is per-surface. Agent Protocol is durable and has an explicit
 * `POST /threads/:id/cancel`, so a cancelled run there is a turn a client may
 * still come back to. AG-UI is ephemeral and ends its run on client disconnect,
 * which leaves nothing to resume — so it passes `false` and keys on the park
 * alone. Note "interrupted" is deliberately overloaded across the two meanings;
 * `GET /threads/:id/pending_interrupts` is what tells them apart.
 */
export function terminalStatus(options: {
  readonly cancelled: boolean
  readonly sawInterrupt: boolean
}): ThreadStatus {
  return options.cancelled || options.sawInterrupt ? "interrupted" : "idle"
}
