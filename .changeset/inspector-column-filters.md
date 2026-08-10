---
"@dawn-ai/inspector": patch
---

Memory Inspector: filter status and kind from the grid's column funnels.

The two header selects are gone. Each funnel is a checklist of that column's
values, so you can ask for "candidate or superseded" — which the selects, being
single-choice, could not express.

Filtering stays server-side: the funnels only decide the query, which sends the
filter repeated (`?status=candidate&status=superseded`). Narrowing only the rows
already loaded would quietly answer a different question, since the list is one
page of a larger store. For the same reason only status and kind carry funnels —
the other columns are not translated into the query, and a control that filtered
the current page would mislead. Content is what search is for; namespace is what
the facet rail scopes, with real counts.

`is none of` is resolved against the column's options rather than needing
negation downstream, and a filter that matches nothing now says "No memories
match these filters" instead of claiming nothing has been stored yet.
