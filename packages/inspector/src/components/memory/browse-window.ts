import type { PretableDataState } from "@pretable/react"
import { BROWSE_RESIDENT_CAP } from "../../browse/browse-machine"

/**
 * What the load-more control can offer right now.
 *
 * `"unavailable"` covers every phase where extending the window would extend the
 * wrong dataset: `stale` (a new query is in flight), `loading` (nothing is
 * fulfilled yet) and `error` (the desired revision has no fulfilled answer).
 * `refreshing` is NOT one of those — same query, and the machine queues a load-more
 * asked for mid-tick rather than dropping it.
 */
export type LoadMoreState = "available" | "loading" | "exhausted" | "at-cap" | "unavailable"

/**
 * `"available"` must agree with `browseCanLoadMore` plus the machine's single-flight
 * rule: past either one `browseReduce` drops a `load-more-requested` without a state
 * change, an error slot or a phase change, so a control offered here that the machine
 * refuses is a click that vanishes with nothing on screen to say so. The agreement is
 * pinned in browse-window.test.ts — nothing else crosses between the two gates.
 *
 * A queued load-more is deliberately not distinguishable: the input carries no queue
 * signal, so `refreshing` reads `"available"` whether or not the user has already
 * clicked. Acknowledging the queue means publishing `queuedLoadMore` out of
 * `useMemoryBrowse` first, and widening this union to match.
 */
export function loadMoreState(input: {
  readonly phase: PretableDataState["phase"]
  readonly loaded: number
  /** The POPULATION fact (`browseHasMore`), never `browseCanLoadMore`: that one already
   *  folds the cap in, so a capped window would read `"exhausted"` and the control would
   *  call a set complete thousands of rows early. */
  readonly hasMore: boolean
}): LoadMoreState {
  // Switched over the whole phase union with no `default`, so a phase added upstream
  // fails to compile rather than falling through to `"unavailable"` — which would
  // deaden the control permanently and silently.
  switch (input.phase) {
    case "loading-more":
      return "loading"
    case "idle":
    case "refreshing":
      if (!input.hasMore) return "exhausted"
      if (input.loaded >= BROWSE_RESIDENT_CAP) return "at-cap"
      return "available"
    case "loading":
    case "stale":
    case "error":
      return "unavailable"
  }
}
