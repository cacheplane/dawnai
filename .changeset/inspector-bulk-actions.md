---
"@dawn-ai/inspector": patch
---

Memory Inspector: bulk approve, reject, and forget from the grid.

Curating memory meant opening each candidate's detail sheet and approving it one
at a time. The grid now has a checkbox column; ticking rows raises an action bar
with the same verbs the sheet exposes. Approve and reject apply to the
candidates in the selection — approving anything else is not a thing the store
can do — while forget applies to everything ticked.

Actions run one at a time, because approve reconciles against the other actives
in its namespace and overlapping approvals would race each other into avoidable
conflicts. If any fail, the bar says how many and why, and keeps the selection
so the failures can be read and retried rather than silently disappearing.

Requires `@pretable/react` 0.0.5 for `onRowSelectionChange`, added upstream for
this (cacheplane/pretable#230) — the checkbox column already existed, but
nothing could read what it had checked.
