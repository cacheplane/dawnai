<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/postgres-storage

Supported Postgres persistence for Dawn checkpoints, Agent Protocol threads, and permission grants across application instances.

## Install

```bash
pnpm add @dawn-ai/postgres-storage pg
```

```ts
import { createPostgresThreadsStore } from "@dawn-ai/postgres-storage"
```

## Runtime and stability

- `@dawn-ai/postgres-storage` is a supported edge-safe application surface that requires an injected structural pool. The tested edge path is local workerd with a Neon WebSocket pool; this is not a claim about every edge host.
- `@dawn-ai/postgres-storage/node` is a supported node-only application surface that can create a `pg` pool from a connection string.

Migrations are memoized per store instance. An injected pool remains caller-owned unless `ownsPool: true`; a pool created by the Node entry is store-owned. Close stores and caller-owned pools during application shutdown.

Use the [Postgres Storage API reference](https://dawnai.org/docs/api/postgres-storage) for exact options and lifecycle. See [Persistence and Tenancy](https://dawnai.org/docs/persistence) for application configuration and deployment guidance.

## License

MIT
