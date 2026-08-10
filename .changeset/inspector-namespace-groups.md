---
"@dawn-ai/inspector": patch
---

Group the Memory Inspector list by namespace when viewing all namespaces.

Namespace-scoped views stay flat — every row would sit under one header — and so
do truncated pages. Group headers count the rows the grid holds, so on a page
capped below the store's size that number is an artifact of where the cap fell:
it read "route=/notes (197)" beside a facet rail saying 250. The rail remains
the honest navigator for anything larger than a page.
