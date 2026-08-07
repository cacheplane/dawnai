---
"@dawn-ai/inspector": patch
---

Memory Inspector: the records grid now fills its container at any window width.

Column widths were hand-tuned to sum to ~1030px so a row fit beside the facet
rail on a 1280px screen — a number that was wrong on every other screen, leaving
dead space on wide ones and overflowing narrow ones. The `content` column now
takes whatever the other columns leave over, down to a 240px floor below which
the grid scrolls instead of squeezing the text.

Requires `@pretable/react` 0.0.6 for `column.flex`, added upstream for this
(cacheplane/pretable#249) — nothing in the grid could size to its container.
