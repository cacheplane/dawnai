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
 * append. It is also never unmounted and never natively `disabled` — a
 * `disabled` attribute removes it from the tab order, which drops keyboard
 * focus to `<body>` at the exact moment the user finished paging, and hides the
 * reason it is inactive. `aria-disabled` keeps it reachable and readable.
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
  const inactive = Boolean(browseOnlyReason) || state !== "available"

  const label =
    browseOnlyReason !== undefined
      ? "Load more"
      : state === "loading"
        ? "Loading more…"
        : state === "exhausted"
          ? `All ${NUMBER.format(loaded)} loaded`
          : state === "at-cap"
            ? `First ${NUMBER.format(loaded)}${population ? ` of ${population}` : ""} loaded`
            : state === "unavailable"
              ? "Load more"
              : `Load more — ${NUMBER.format(loaded)}${population ? ` of ${population}` : ""} loaded`

  const reason =
    browseOnlyReason ??
    (state === "at-cap"
      ? `The Inspector holds ${NUMBER.format(BROWSE_RESIDENT_CAP)} records at a time — narrow the filters to reach the rest.`
      : undefined)

  return (
    <div data-testid="load-more-footer" className="mt-2 flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
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
