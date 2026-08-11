import type { PretableDataState } from "@pretable/react"
// `export ... from` re-exports without binding the name locally, and `loadMoreState`
// below reads the cap.
import { BROWSE_RESIDENT_CAP } from "../../browse/browse-machine"

// Re-exported, NOT re-declared. The reducer in `src/browse/browse-machine.ts` already
// enforces the cap in `withinCap` and sizes every refresh and load-more window from
// these two, and `dedupeById` is already the reducer's append path. A second copy here
// would be a constant the enforcement does not read.
export { BROWSE_PAGE_SIZE, BROWSE_RESIDENT_CAP } from "../../browse/browse-machine"
export { dedupeById } from "../../browse/browse-reconcile"

/**
 * What the load-more control can offer right now.
 *
 * `"unavailable"` covers every phase where extending the window would extend the
 * wrong dataset: `stale` (a new query is in flight), `loading` (nothing is
 * fulfilled yet) and `error` (the desired revision has no fulfilled answer).
 * `refreshing` is NOT one of those — same query, and the hook queues a
 * load-more requested mid-tick rather than dropping it.
 */
export type LoadMoreState = "available" | "loading" | "exhausted" | "at-cap" | "unavailable"

export function loadMoreState(input: {
  readonly phase: PretableDataState["phase"]
  readonly loaded: number
  readonly hasMore: boolean
}): LoadMoreState {
  if (input.phase === "loading-more") return "loading"
  if (input.phase !== "idle" && input.phase !== "refreshing") return "unavailable"
  // `hasMore` is the POPULATION fact (`browseHasMore`), never `browseCanLoadMore` —
  // that one already folds the cap in, which would report a capped window as
  // exhausted and claim a set is complete thousands of rows early.
  if (!input.hasMore) return "exhausted"
  if (input.loaded >= BROWSE_RESIDENT_CAP) return "at-cap"
  return "available"
}
