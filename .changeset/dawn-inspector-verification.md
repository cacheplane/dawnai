---
"@dawn-ai/inspector": patch
---

Bulk actions now prune succeeded ids from the selection, so a retry after a partial
failure re-sends only the failures and can never repeat a completed delete. Polling
pauses for the duration of a bulk run.
