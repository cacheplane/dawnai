<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/postgres-storage

Supported Postgres persistence for Dawn checkpoints, Agent Protocol threads, and permission grants across application instances.

**Use this when:** You are replacing Dawn's local durable stores with shared Postgres persistence.

## Install

```bash
pnpm add @dawn-ai/postgres-storage pg
```

## Example

```ts
import { Pool } from "pg"
import { createPostgresThreadsStore } from "@dawn-ai/postgres-storage"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const threadsStore = createPostgresThreadsStore({ pool })

await threadsStore.ready()

// During application shutdown:
await threadsStore.close()
await pool.end()
```

## Runtime and stability

- `@dawn-ai/postgres-storage` is a supported edge-safe application surface that requires an injected structural pool. The tested edge path is local workerd with a Neon WebSocket pool; this is not a claim about every edge host.
- `@dawn-ai/postgres-storage/node` is a supported node-only application surface that can create a `pg` pool from a connection string.

Migrations are memoized per store instance. An injected pool remains caller-owned unless `ownsPool: true`; a pool created by the Node entry is store-owned. Close stores and caller-owned pools during application shutdown.

## Related

- [Postgres Storage API reference](https://dawnai.org/docs/api/postgres-storage) — exact options, stores, and lifecycle.
- [Persistence and Tenancy](https://dawnai.org/docs/persistence) — application configuration and deployment guidance.
- [`@dawn-ai/sqlite-storage`](https://www.npmjs.com/package/@dawn-ai/sqlite-storage) — local SQLite persistence.
- [`@dawn-ai/permissions`](https://www.npmjs.com/package/@dawn-ai/permissions) — permission-store contracts.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/postgres-storage` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/postgres-storage/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
