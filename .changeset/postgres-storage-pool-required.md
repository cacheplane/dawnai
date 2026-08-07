---
"@dawn-ai/postgres-storage": patch
---

**Breaking (shipped as a patch): `pool` is now required on
`@dawn-ai/postgres-storage`'s main entry, and `connectionString` has moved to
`@dawn-ai/postgres-storage/node`.**

In `0.8.19` the main entry accepted either, and built its own `pg` pool from a
`connectionString` when you passed one. It no longer does: the main entry
imports `pg` for *types only*, so it links on a runtime where a raw TCP driver
cannot be bundled at all — which is what makes Cloudflare Workers possible.
`connectionString` is no longer part of the main entry's option type, so passing
it there is a type error, and the factory throws at construction naming the
missing pool and pointing at the `/node` subpath. It does not fail silently or
later.

Two ways to migrate, both mechanical:

```ts
// 1. Change the import. Same three factories, connectionString still works,
//    the store still builds and owns its pool.
import {
  createPostgresPermissionsStore,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@dawn-ai/postgres-storage/node"

// 2. Or build the pool yourself and keep the main entry — which is what you
//    want anyway if you are sharing one pool across all three stores.
import { Pool } from "pg"
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
postgresCheckpointer({ pool })
```

The `/node` entry is the same three factories with the `connectionString`
convenience layered on, and it re-exports everything the main entry does, so
option 1 is usually a one-line change. Pool ownership is unchanged in both
shapes: a pool the store built is ended by `close()`, an injected pool is left
alone (`ownsPool`, default `false`).

This is a breaking change against a published version, and it is going out as a
**patch** deliberately: the packages are in a fixed `0.x` group, where a minor
bump would move the entire group to `1.0.0`.
