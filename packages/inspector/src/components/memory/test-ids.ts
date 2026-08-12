/**
 * The DOM hooks the verification lane depends on. One module so a rename is one edit
 * in `src` and a missing hook is one red test rather than fourteen mysterious spec
 * failures.
 *
 * Every entry has an owner that renders it. A key with no owner is worse than no key
 * at all: the lane believes it, and the failure arrives as a locator timeout in a
 * scenario written days later. `test-id-contract.test.tsx` holds each entry to that —
 * either it is asserted against a rendered `ListPage`, or the condition that renders
 * it is named there — and its coverage map is keyed on this object, so a key added
 * here without a decision fails typecheck.
 *
 * Pretable's own hooks (`data-pretable-data-phase`, `data-pretable-row-id`,
 * `data-pretable-live-region`, `data-pretable-body-state`,
 * `data-pretable-scroll-viewport`, `data-pretable-hydrated`) are NOT listed here:
 * they are public API of @pretable/react and are pinned by that package's tests.
 */

/** The banner line for one failing source. `BrowseErrorBanners` keys its lines by
 *  source and the set of sources is open — `stats`, `search`, `browse` and the two
 *  browse REQUEST kinds today — so the DERIVATION lives here rather than a constant
 *  per source, and the two the lane targets are spelled out below through it. */
export function errorBannerId<S extends string>(source: S): `error-${S}` {
  return `error-${source}`
}

export const TEST_IDS = {
  /** The browse subtree. Load-bearing as a SCOPE, not just a hook: the subtree stays
   *  mounted-and-`hidden` across view switches and a search renders more grids beside
   *  it, all carrying `aria-label="Memories"` — so an unscoped grid locator resolves to
   *  more than one element whenever a search is active. */
  browseRegion: "browse-region",
  /** Wraps the count/total/as-of chrome that sits above the grid. */
  status: "browse-status",
  /** The exact matching total, rendered as text. */
  total: "browse-total",
  /** "updated 14:32:07" — shown only while polling is paused or suspended. */
  asOf: "browse-as-of",
  /** The footer control, OUTSIDE the grid viewport (design §9.2). */
  loadMore: "load-more",
  /** Retry inside the error body block, supplied through `renderBodyState`. */
  retryInitial: "browse-retry-initial",
  /** Per-kind banner slots for the two browse REQUEST kinds — one kind's success can
   *  never clear another's failure. A MUTATION's failures are not banners: they stay
   *  in the bulk bar beside the ids that failed (`bulkError`). */
  bannerRefresh: errorBannerId("refresh"),
  bannerLoadMore: errorBannerId("load-more"),
  /** ONE retry for the banners, not one per kind. `retry()` is a single intent and the
   *  reducer chooses which kind to re-attempt (a load-more failure before a refresh
   *  one), so per-kind controls would be two buttons dispatching the same action. */
  bannerRetry: "browse-banner-retry",
  /** The live/paused polling toggle. */
  liveToggle: "live-toggle",
  /** The bulk bar, and the per-id failures it holds on screen. */
  bulkBar: "bulk-bar",
  bulkError: "bulk-error",
  /** Search-view controls that are disabled-with-reason (design §8.2). */
  searchScopeNote: "search-scope-note",
} as const
