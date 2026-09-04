---
"@dawn-ai/cli": patch
---

Re-cut the release so the repaired release automation runs end to end.

There are no functional changes to any package in this version: the published
0.8.24 packages and these are built from the same sources. 0.8.24 published
correctly, but its release ceremony could not finish because two defects in
that candidate's own smoke lanes made them fail on every attempt, and every
release job outside the controller runs from the frozen candidate commit, so
the fixes could not reach it.

This version is the first candidate to carry the repaired publish retry and
smoke lanes, which is what proves them.
