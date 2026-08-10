---
"@dawn-ai/memory": patch
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/testing": patch
"@dawn-ai/inspector": patch
---

`BrowseQuery.status` and `.kind` now accept a set, not just one value.

`browse({ status: ["candidate", "superseded"] })` matches any of them. A bare
value behaves exactly as before, so every existing caller is unaffected.

An **empty** set matches nothing rather than everything: "any of none" is false,
and reading it as "unfiltered" would show every row to a caller that had just
narrowed its filter to zero. Both backends implement it — sqlite via `IN (…)`,
Postgres via `= ANY($n::text[])`, where an empty array is already false — and
five new contract tests in `runMemoryStoreConformance` hold them to the same
reading, including that `total` counts the whole matching set.

The Inspector's list route accepts the filter repeated (`?status=a&status=b`).
One bad value rejects the request rather than being silently dropped. A param
that appears zero times is absent, not an empty set, so the empty-set rule is
unreachable over HTTP.
