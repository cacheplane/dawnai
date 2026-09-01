# @dawn-ai/permissions

Permission matching and approval-store contracts for Dawn agents.

**Use this when:** You are building permission matching or approval-store integrations for a Dawn agent.

## Install

```bash
pnpm add @dawn-ai/permissions
```

## Example

```ts
import { matchPermission } from "@dawn-ai/permissions"

const decision = matchPermission(
  "bash",
  "pnpm test",
  { bash: ["pnpm"] },
  { bash: ["pnpm publish"] },
)
```

## Runtime and stability

- `@dawn-ai/permissions` is an edge-safe, supported integration surface.
- `@dawn-ai/permissions/node` is a node-only, supported integration surface.

The root entry owns matching and portable contracts. Use the Node entry only for filesystem-backed approval-store integration.

## Related

- [Permissions API reference](https://dawnai.org/docs/api/permissions) — exact matching and store contracts.
- [Permissions guide](https://dawnai.org/docs/permissions) — application policy and approval workflows.
- [`@dawn-ai/postgres-storage`](https://www.npmjs.com/package/@dawn-ai/postgres-storage) — shared Postgres-backed permission decisions.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/permissions` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/permissions/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
