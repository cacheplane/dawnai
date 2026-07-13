---
description: How to merge researcher sub-answers into one cited report.
---

# Synthesize findings

After the researcher subagents return, combine their answers into a single
report:

1. Open with a two-sentence direct answer to the user's question.
2. Group supporting points by sub-question, each ending with its citation.
3. Drop duplicate points; when sources disagree, note the disagreement.
4. End with a short "Sources" list of every cited document path.

Write the report to `reports/<slug>.md` with `writeFile`.
