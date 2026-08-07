---
"@dawn-ai/inspector": patch
---

Memory Inspector: the records list is now a real `@pretable/react` grid, with column sorting.

It shipped as a semantic `<table>` stand-in because `@pretable/react@0.0.2` was uninstallable — it hard-depended on `@pretable/ui@0.0.2`, which had never been published. `@pretable/ui` is on npm now, so the grid goes in behind the same `MemoryGrid` props and sorting arrives with it. Clicking a column header sorts by it; the `updated` column sorts chronologically rather than by its formatted text.

Requires `@pretable/react`/`@pretable/ui` 0.0.3, which carry the fixes this integration prompted upstream: row activation via `onRowActivate`, columns reconciled in place rather than rebuilding the grid (so a sort survives live polling), and the header/cell CSS corrections.
