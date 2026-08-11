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

- One browse request in flight at a time, with the contention case removed rather
  than handled: a tick that comes due while a request is in flight is skipped
  instead of racing it.
- A poll tick refreshes the head of the window and reconciles: updated rows take the
  server's payload and position, rows that vanished from the refreshed span are
  dropped, and rows beyond the span are retained rather than evicted because inserts
  arrived above them.
- A refresh failure does not blank the answer already on screen: those rows stay and
  the failure arrives as its own banner with a retry. A failure that leaves the
  desired query with nothing fulfilled — the first load, or a query change whose
  fetch fails while the previous question's rows are still up — holds the error
  state and suspends polling until a retry succeeds, so the failure does not flicker
  on a two-second cadence.
- Pausing (live off, hidden tab, held error) replaces the freshness claim with an
  as-of stamp; resuming ticks immediately instead of waiting out the interval.
- The list grid now receives `dataState` and `resultMeta` from
  `@pretable/react@0.3.0`, so loading, empty and error are body states of the grid
  rather than a table that happens to have no rows, and the server's count reaches
  the screen reader through the results announcement. A status line above both views
  reads "N loaded of M matching".
- The timeline view no longer answers "No episodes in this window." while the window
  is still loading, or after loading it failed.
- The namespace facet sends the exact `namespace` parameter instead of narrowing a
  prefix answer client-side — otherwise the total and the rows would describe
  different sets.

Column sorting is off in the browse view for now: sorting a server-selected window
locally presents the wrong sample, not merely the wrong order. It returns with
server-side ordering.

`useMemoryBrowse` also arbitrates load-more against the poll cadence and keeps a
separate failure slot for it, but nothing in this release asks for one — the
control arrives with server-side paging.
