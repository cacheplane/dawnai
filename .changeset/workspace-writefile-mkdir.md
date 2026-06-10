---
"@dawn-ai/workspace": patch
---

`localFilesystem` `writeFile` now creates missing parent directories before
writing. Previously, an agent writing to a nested workspace path (e.g.
`reports/result.md`) failed with `ENOENT` unless the directory already existed.
