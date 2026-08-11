"use client"
import { useId } from "react"
import { BROWSE_RESIDENT_CAP } from "../../browse/browse-machine"
import { Button } from "../ui/button"
import type { LoadMoreState } from "./browse-window"

const NUMBER = new Intl.NumberFormat()

/**
 * The load-more control.
 *
 * It lives OUTSIDE the scroll viewport because the viewport is the
 * `role="grid"` element: a loose button among its children corrupts the grid's
 * owned-children structure for assistive technology, virtualization can unmount
 * a focused in-viewport node, and a windowed control would move on every
 * append. Callers must also keep it MOUNTED in every phase, and it is never
 * natively `disabled` — a `disabled` attribute removes it from the tab order,
 * which drops keyboard focus to `<body>` at the exact moment the user finished
 * paging, and hides the reason it is inactive. `aria-disabled` keeps it
 * reachable and readable.
 */
export function LoadMoreFooter({
  state,
  loaded,
  total,
  onLoadMore,
  browseOnlyReason,
}: {
  state: LoadMoreState
  loaded: number
  /** The exact matching total, when one is fulfilled. */
  total: number | undefined
  onLoadMore: () => void
  /** Set while this control does not apply to what is on screen (a search is
   *  running). Rendered as visible text AND associated through
   *  `aria-describedby`, so a keyboard or screen-reader user can discover why. */
  browseOnlyReason: string | undefined
}) {
  const reasonId = useId()
  const population = total === undefined ? undefined : NUMBER.format(total)
  // Normalized ONCE, and every branch below reads THIS rather than the raw prop.
  // Guarded two ways — `Boolean(x)` in one place, `x !== undefined` in another — a
  // caller's `""` reads as a reason in one branch and as none in the other, which
  // strips the counts off the label while leaving the control active and unexplained.
  const browseOnly = browseOnlyReason ? browseOnlyReason : undefined
  const inactive = browseOnly !== undefined || state !== "available"

  // `"exhausted"` is a statement about the WALK — the server issued no continuation, so
  // nothing follows the last record loaded. It is not a statement about the population,
  // and the two can disagree: rows added ABOVE the walk (approve hoists to the head of
  // the default order) are counted by `total` and are unreachable by walking further.
  // Saying "All N loaded" over a larger total would be the grid asserting a completeness
  // its own numbers contradict, so the claim is dropped and the counts are quoted
  // instead. Under the default order a live poll closes the gap within a tick or two;
  // under a user sort a row that sorts past the resident span can sit there until the
  // query changes, which is why the word is dropped rather than the number hidden.
  const shortOfTotal = state === "exhausted" && total !== undefined && loaded < total

  const label =
    browseOnly !== undefined
      ? "Load more"
      : state === "loading"
        ? "Loading more…"
        : state === "exhausted"
          ? shortOfTotal
            ? `${NUMBER.format(loaded)} of ${population} loaded`
            : `All ${NUMBER.format(loaded)} loaded`
          : state === "at-cap"
            ? `First ${NUMBER.format(loaded)}${population ? ` of ${population}` : ""} loaded`
            : state === "unavailable"
              ? "Load more"
              : `Load more — ${NUMBER.format(loaded)}${population ? ` of ${population}` : ""} loaded`

  // Every inactive state says why. `"unavailable"` is the one the user reaches
  // without doing anything — a filter, sort or namespace change puts it there with
  // rows still on screen — and its label is the ACTIVE label, so an unexplained
  // inactive control here reads as one that is simply ignoring the click.
  const reason =
    browseOnly ??
    (state === "at-cap"
      ? `The Inspector holds ${NUMBER.format(BROWSE_RESIDENT_CAP)} records at a time — narrow the filters to reach the rest.`
      : state === "unavailable"
        ? "Not available until this view has an answer to extend."
        : shortOfTotal
          ? // Only what the continuation actually said. The rest match and are not
            // here, but WHERE they are is not something this control knows: under the
            // default order they are above these rows, under a user sort they need not
            // be — so no remedy is promised.
            "Nothing further follows the records loaded here."
          : undefined)

  return (
    <div data-testid="load-more-footer" className="mt-2 flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        // `Button`'s base class dims and blocks pointer events on `disabled:` only.
        // This control is deliberately never natively `disabled`, so without an
        // `aria-disabled`-keyed rule every inactive state renders identically to the
        // active one and still answers hover — a control that looks live and
        // silently drops the click.
        className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
        aria-disabled={inactive ? "true" : undefined}
        {...(reason ? { "aria-describedby": reasonId } : {})}
        onClick={() => {
          if (inactive) return
          onLoadMore()
        }}
      >
        {label}
      </Button>
      {reason ? (
        <span id={reasonId} className="text-xs text-zinc-500">
          {reason}
        </span>
      ) : null}
    </div>
  )
}
