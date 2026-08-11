---
"@dawn-ai/inspector": patch
---

The Memory Inspector's browse grid is server-authoritative.

Filtering and sorting now reach the store instead of rearranging the loaded window.
`content`, `namespace`, `confidence` and `updated` gain funnels — they had none,
because a funnel over one page of a larger store answers a different question than
the one it appears to ask — and every funnel declares a type and an operator list
pruned to exactly what `BrowseQuery` honors: `status`/`kind` (`is any of` / `is none
of`), `namespace` (`equals` / `starts with`), `content` (the six substring and
equality operators), `confidence` (comparisons and an inclusive range) and `updated`
(UTC day operators). `is empty` / `is not empty` leave the `status` and `kind` menus,
where they had been offered: no `BrowseFilter` arm expresses them and every browse
field is NOT NULL, so they were controls the server ignored.

Sorting comes back with them. Every browse column was non-sortable, because ordering
a server-selected window locally re-ranks the wrong sample under a truthful-looking
`aria-sort`; five columns are now sortable against the store's own ordering.
`content` stays unsortable — the store's sort whitelist has no content field — and
because the store accepts three sort keys, a fourth is declined with a notice rather
than drawn as an active sort the server never applied.

A funnel value the mapping cannot express is refused the same way: the query mapping
rejects rather than silently dropping a clause, so the intent is declined and named
in a notice, and the rows keep answering the question the server was actually asked.
The notice names the control in the words on screen — "That confidence value is out
of range, so the filter was not applied." — while the mapping's own message, which
quotes the value it was handed, goes to the console for whoever is debugging.

Also in this release:

- The SEARCH grid no longer offers funnels. Search results are a ranked sample the
  store chose and carry no server authority to filter against, but the `status` and
  `kind` funnels were live there and narrowed that sample engine-side, under a header
  that looked exactly like the browse grid's.
- Load-more is a control that sits outside the `role="grid"` element and stays
  focusable in every state, asking for the window that starts after the rows already
  resident. Residency is capped at 1 000 records — deliberately equal to the maximum
  request limit, so one head refresh always re-derives the whole resident span.
- The facet rail's counts are labelled as global, because they come from the stats
  endpoint and describe every memory rather than the current query. Before that
  response lands, the total reads `—` rather than `0`.
- The grid is no longer remounted to clear a selection; a `datasetKey` pivot clears
  selection, focus and group expansion in the same emit that lands the new rows.
- The bulk action bar is withheld whenever the rows on screen answer a previous
  query — while the new one loads, and equally while it is failing and those rows
  are all that survived. Approving or forgetting a selection formed under a
  question the grid has stopped answering is the ambiguity this release exists to
  remove; the bar returns once the rows are the answer to what was asked.
- While a search is running, browse-only controls are marked `aria-disabled` and stay
  focusable with an `aria-describedby` explanation, rather than staying active and
  being silently ignored.
- The timeline's episodic default now stands beside an *excluding* `kind` funnel. It
  stands down only for a narrowing one, where leaving it on would AND two narrowings
  into the empty set; standing down for an exclusion instead widened the timeline to
  every kind the funnel had not excluded, while each row still read as an episode.
