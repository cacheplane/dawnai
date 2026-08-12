import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { readPendingInterrupts } from "./pending-interrupts.js"
import { assertNoReservedKey } from "./thread-metadata.js"

/**
 * Thread-metadata key holding the route whose turn PARKED the interrupts that
 * are currently pending in the checkpoint.
 *
 * Distinct from `route`, which is the LAST-RUN route: every endpoint that starts
 * a turn overwrites `route` (and `threadRouteMap`) before executing anything, so
 * any caller allowed to run any route on a thread can move that identity onto a
 * route of their choosing. That is harmless while route identity only decides
 * which route to re-invoke on POST /resume, and NOT harmless the moment it also
 * decides who may READ a parked prompt's `interruptId`/`resumeKey` pair — the
 * exact addressing pair POST /resume needs to answer that prompt. Hence a second
 * key: this one is written only by a turn that actually parked, so it cannot be
 * repointed by starting a cheaper run.
 *
 * Lives in its own module rather than beside its main reader in
 * `runtime-fetch-core.ts` because the AG-UI handler has to maintain it too, and
 * that module already imports the AG-UI handler — sharing it the other way would
 * close an import cycle.
 *
 * NOT SECRET. This is thread metadata, and `GET /threads/:id` is ungated and
 * echoes metadata verbatim, so anyone who can name a thread id can read which
 * route parked it. That is deliberate and harmless: the key is an ACCESS-CONTROL
 * INPUT, not a credential — knowing the answer to "which route must you satisfy"
 * does not help satisfy it, because the middleware still runs against that route
 * with the caller's own headers. Do not start storing anything here that would
 * matter if it were read, and do not build a check that relies on this being
 * private.
 *
 * ONE OWNER PER PENDING SET. A single scalar can gate the whole pending list
 * only because that list always belongs to exactly one turn, and therefore one
 * route: `readPendingInterrupts` calls `getTuple` with no `checkpoint_id`, which
 * returns the LATEST checkpoint together with the writes pending against THAT
 * checkpoint — and a checkpoint is produced by a single turn. A later turn on a
 * different route does not merge into the earlier one's pending writes; it
 * advances the checkpoint, and the older writes stop being returned. So the
 * visible set is never a mixture of two routes' interrupts, and claiming all of
 * it on behalf of the turn that parked is not an over-claim.
 *
 * This is LangGraph's checkpoint semantics, not something Dawn enforces — it is
 * stated here rather than defended in code because the alternative (having every
 * parked turn re-read the checkpoint to prove its own interrupts are the whole
 * set) would buy nothing: the comparison can only ever agree, and on the
 * hypothetical disagreement the safe action would be undefined — recording
 * nothing falls back to the attacker-controlled last-run chain, which is worse
 * than recording the parking route.
 */
export const PARKED_ROUTE_KEY = "parked_route"

/** The recorded parking route, or undefined when none is recorded. */
export function readParkedRoute(thread: Thread | undefined): string | undefined {
  const value = thread?.metadata[PARKED_ROUTE_KEY]
  return typeof value === "string" ? value : undefined
}

/** Ids of the interrupts currently parked in the thread's checkpoint. */
export async function readParkedInterruptIds(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<ReadonlySet<string>> {
  const snapshot = await readPendingInterrupts(checkpointer, threadId)
  return new Set((snapshot?.interrupts ?? []).map((interrupt) => interrupt.interruptId))
}

/**
 * Record — or retire — the route that owns this thread's parked interrupts,
 * once a turn has stopped producing output.
 *
 * The clear is the delicate half, and its checkpoint re-read is the single
 * load-bearing line here. A turn that merely finishes is NOT evidence that the
 * thread has nothing parked, and the counterexamples are not exotic: a plain
 * graph route (no agent, no checkpointer) runs to completion on a parked thread
 * without touching its `__interrupt__` writes, and an AGENT route that fails
 * before its graph executes — an unresolvable model id is enough — lands on the
 * failure path with the admin's interrupt still pending. Clearing on completion
 * alone would hand the bypass back in both cases, the second one straight past
 * the `canPark` short-circuit. So the clear happens only when a fresh read finds
 * nothing pending: it can loosen the gate only on a thread whose answer is
 * already the empty list.
 *
 * That read is paid for only when a parking route is recorded AND the route
 * could have touched the checkpoint, so the ordinary thread — one that has never
 * parked — adds no I/O to its turns at all. Errors on the clear path are
 * swallowed for the mirror image of the set path's reason: a clear that does not
 * happen leaves a stale, over-strict gate over an empty list, which is the safe
 * direction to fail in.
 */
export async function settleParkedRoute(options: {
  /**
   * Whether this route can reach the thread's checkpoint at all. Only `agent`
   * routes can: `invokeEntry`/`streamResolvedRoute` hand a checkpointer and a
   * thread id to that kind alone, and every other kind is called with nothing
   * but `(input, context)`. A route that cannot write the checkpoint can neither
   * park interrupts nor answer them, so there is nothing to re-read on its
   * behalf — which is the difference between one extra checkpoint read per agent
   * turn and one on every request the server serves.
   */
  readonly canPark: boolean
  readonly checkpointer: BaseCheckpointSaver
  readonly parked: boolean
  /**
   * The post-turn pending ids, when the caller has already read them. Only
   * /runs/wait does: it cannot detect a park any other way, so re-reading here
   * would be pure waste. The streaming handlers leave it unset and pay for the
   * read only on the rare branch that actually needs it.
   */
  readonly pendingAfter?: ReadonlySet<string>
  readonly previousParkedRoute: string | undefined
  readonly routeKey: string
  readonly threadId: string
  readonly threadsStore: ThreadsStore
}): Promise<void> {
  const { canPark, checkpointer, parked, previousParkedRoute, routeKey, threadId, threadsStore } =
    options
  if (parked) {
    // Unconditional, even when `previousParkedRoute` already reads as this
    // route. Skipping the write would make the gate depend on a value sampled
    // before the run slot was claimed: a run that settled inside that window
    // could have cleared the key, and believing the stale copy would leave the
    // thread parked with nothing recorded. One write per parked turn is cheap
    // enough not to reason about that race at all.
    // Guarded like every other runtime write: the merge is shallow and the
    // access stamp shares this flat object, so no runtime patch may carry the
    // reserved key. `PARKED_ROUTE_KEY` is not that key, which is exactly why
    // this is an assertion and not a branch.
    const parkPatch = { [PARKED_ROUTE_KEY]: routeKey }
    assertNoReservedKey(parkPatch)
    await threadsStore.updateMetadata(threadId, parkPatch)
    return
  }
  // The stale-read direction that survives here is the harmless one: believing
  // a key is unset when it was just set only skips a clear, and believing one
  // is set when it was just cleared still re-checks the checkpoint below.
  if (previousParkedRoute === undefined || !canPark) return
  try {
    const pending = options.pendingAfter ?? (await readParkedInterruptIds(checkpointer, threadId))
    if (pending.size > 0) return
    const clearPatch = { [PARKED_ROUTE_KEY]: null }
    assertNoReservedKey(clearPatch)
    await threadsStore.updateMetadata(threadId, clearPatch)
  } catch {
    // Deliberately silent — see above: keeping the old value over-restricts.
  }
}
