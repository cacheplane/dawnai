---
"@dawn-ai/memory": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Smarter recall: long-term-memory `recall` now ranks results by IDF-weighted
relevance blended with recency decay and stored confidence, instead of pure
recency — a six-week-old fact that actually answers the query outranks
yesterday's marginal match. Deterministic (no clock, no network, no new deps;
same store + same query → same order), zero-config (tune via
`DawnConfig.memory.recall` only if needed), and query-less searches (the
injected index, `dawn memory list`) keep their recency order.
