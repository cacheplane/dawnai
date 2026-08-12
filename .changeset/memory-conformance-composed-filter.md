---
"@dawn-ai/testing": patch
---

`runMemoryStoreConformance` now asserts that a composed browse filter (exact namespace +
`status in` + `kind in` + `content contains`, ordered by `updatedAt desc`) returns a
byte-exact ordered id list on every backend. The case covers rows that share an
`updatedAt` stamp, so a store whose sort omits the id tie-break now fails conformance
instead of passing on a window where the ambiguity happens not to surface.
