---
"@dawn-ai/inspector": patch
---

Make the memory browse honest about what it is showing.

The list is no longer polled through `usePolling`, which documents its own
last-write-wins hole: a new `useMemoryBrowse` hook owns a desired query revision
that any canonical-query change bumps, and **every response is discarded whole
unless its revision is still the desired one**. Aborting the superseded request is
an optimization on top; correctness never depends on winning that race. Stats keep
polling as before.

- One browse request in flight at a time, with the contention cases removed rather
  than handled: a load-more asked for during a poll tick is queued and runs when the
  tick settles, and a tick that comes due while anything is in flight is skipped.
- A poll tick refreshes the head of the window and reconciles: updated rows take the
  server's payload and position, rows that vanished from the refreshed span are
  dropped, and rows beyond the span are retained rather than evicted because inserts
  arrived above them.
- Failures are recorded per request kind, so a succeeding poll tick cannot clear a
  load-more failure and neither can clear a mutation's. A load failure with nothing
  loaded holds the grid's error block and suspends polling until retry succeeds, so
  the failure does not flicker on a two-second cadence.
- Pausing (live off, hidden tab, held error) replaces the freshness claim with an
  as-of stamp; resuming ticks immediately instead of waiting out the interval.
- The grid now receives `dataState` and `resultMeta` from `@pretable/react@0.3.0`,
  so loading, empty and error blocks are real states and the footer says "N loaded
  of M matching" using the server's count.
- The namespace facet sends the exact `namespace` parameter instead of narrowing a
  prefix answer client-side — otherwise the total and the rows would describe
  different sets.
- Keyboard entry into the memory grid is now Tab-only, from `@pretable/react@0.3.0`:
  Down arrow from a column header no longer moves into the body. Once a row has
  focus, arrow keys and Enter/Space behave as before.

Column sorting is off in the browse view for now: sorting a server-selected window
locally presents the wrong sample, not merely the wrong order. It returns with
server-side ordering.
