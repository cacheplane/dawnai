# @dawn-ai/sqlite-storage

SQLite persistence for Dawn checkpoints and Agent Protocol threads.

**Use this when:** You need to use Dawn's local checkpoint or thread persistence directly.

## Install

```bash
pnpm add @dawn-ai/sqlite-storage
```

## Example

```ts
import { createThreadsStore, sqliteCheckpointer } from "@dawn-ai/sqlite-storage"

export const checkpointer = sqliteCheckpointer({ path: ".dawn/checkpoints.sqlite" })
export const threadsStore = createThreadsStore({ path: ".dawn/threads.sqlite" })
```

## Runtime and stability

`@dawn-ai/sqlite-storage` is a node-only, supported application surface.

SQLite is a local process-oriented default. Use shared persistence when multiple application instances must observe the same checkpoints or threads.

## Related

- [SQLite Storage API reference](https://dawnai.org/docs/api/sqlite-storage) — exact checkpoint and thread-store contracts.
- [Persistence and Tenancy](https://dawnai.org/docs/persistence) — application configuration and storage boundaries.
- [`@dawn-ai/postgres-storage`](https://www.npmjs.com/package/@dawn-ai/postgres-storage) — shared Postgres persistence.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/sqlite-storage` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/sqlite-storage/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
