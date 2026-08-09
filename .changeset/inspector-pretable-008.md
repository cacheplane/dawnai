---
"@dawn-ai/inspector": patch
---

Memory Inspector: pick up the pretable 0.0.8 header theme fixes.

Grid header labels were rendering in the body-cell colour, and the header's
column dividers in a fixed colour rather than the grid's own rule token — both
because inline styles on the header button beat the skin regardless of how it is
layered. Headers are dimmer than cell text again, and their dividers match the
body gridlines.
