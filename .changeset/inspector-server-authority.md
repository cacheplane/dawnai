---
"@dawn-ai/inspector": patch
---

The Memory Inspector's browse grid is server-authoritative.

Every visible column now declares a real type and an operator list pruned to exactly
what `BrowseQuery` honors — `status`/`kind` (`is any of` / `is none of`), `namespace`
(`equals` / `starts with`), `content` (the six substring and equality operators),
`confidence` (comparisons and an inclusive range) and `updated` (UTC day operators).
`is empty` / `is not empty` are gone from every menu: no `BrowseFilter` arm expresses
them and every browse field is NOT NULL, so they were controls the server ignored.
`content` is no longer sortable — the store's sort whitelist has no content field.

The grid runs with `processing: { filter: "external", sort: "external" }`, so the
funnels and header sort are intent editors: they emit a query and never re-process the
loaded window. That removes the double-application hazard between a filter tick and
its response, and it removes the sort lie — until now all six columns sorted the 200
loaded rows while presenting as a sort of the whole store.

Also in this release:

- Selecting a namespace facet sends the EXACT `namespace` parameter. The client-side
  equality narrowing that followed a prefix fetch is deleted, so the rows on screen and
  the total beside them no longer answer different questions. The rail's counts are
  labelled as global, because that is what they are.
- Paging is keyset load-more through `BrowsePage.continuation`, driven by a control
  that sits outside the `role="grid"` element and stays focusable in every state.
  Residency is capped at 1 000 records — deliberately equal to the maximum request
  limit, so one head refresh always re-derives the whole resident span.
- The grid is no longer remounted to clear a selection; a `datasetKey` pivot clears
  selection, focus and group expansion in the same emit that lands the new rows.
- While a search is running, browse-only controls are marked `aria-disabled` and stay
  focusable with an `aria-describedby` explanation, rather than staying active and
  being silently ignored.
