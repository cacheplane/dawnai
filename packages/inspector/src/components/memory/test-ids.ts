/**
 * The DOM hooks the verification lane depends on. One module so a rename is one edit
 * and a missing hook is one red test rather than fourteen mysterious spec failures.
 *
 * Pretable's own hooks (`data-pretable-data-phase`, `data-pretable-row-id`,
 * `data-pretable-live-region`, `data-pretable-body-state`,
 * `data-pretable-scroll-viewport`, `data-pretable-hydrated`) are NOT listed here:
 * they are public API of @pretable/react and are pinned by that package's tests.
 */
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
  /** Per-kind banner slots — one kind's success can never clear another's failure. */
  bannerRefresh: "browse-banner-refresh",
  bannerLoadMore: "browse-banner-load-more",
  bannerMutation: "browse-banner-mutation",
  retryRefresh: "browse-retry-refresh",
  retryLoadMore: "browse-retry-load-more",
  /** The live/paused polling toggle. */
  liveToggle: "live-toggle",
  /** Bulk chrome (pre-existing ids, restated here so the lane has one import). */
  bulkBar: "bulk-bar",
  bulkError: "bulk-error",
  /** Search-view controls that are disabled-with-reason (design §8.2). */
  searchScopeNote: "search-scope-note",
} as const
