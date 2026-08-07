---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
"@dawn-ai/langchain": patch
"@dawn-ai/sdk": patch
---

**New `hono` build target — a Dawn app that deploys to Cloudflare Workers.**

`build: { targets: ["node", "hono"] }` makes `dawn build` emit an edge deploy
alongside the usual ones: `.dawn/build/app.mjs` (a Hono app whose single
catch-all hands every request to Dawn's web-standard fetch handler,
`export default`ed — the shape Workers, Vercel and Bun all accept),
`modules.edge.mjs` (the static module manifest, free of node builtins),
`stores.mjs` (a per-request Postgres store factory), and a `wrangler.toml`
scaffold at the app root. `wrangler deploy` and the app serves Agent Protocol
and AG-UI with durable state in Postgres.

The scaffold carries a bare `name` / `main` / `compatibility_date` and **no
`nodejs_compat`**: the bundle links zero `node:` specifiers, so the flag would
buy nothing, and setting it would mask a regression in the work that made the
bundle node-free. A gated `edge-workerd` CI lane boots the emitted artifacts
under real workerd — the same binary Cloudflare runs — with that `wrangler.toml`
untouched, and drives four sequential AG-UI turns against Postgres over a
`@neondatabase/serverless` WebSocket pool.

The target is **opt-in and never a default**, because the edge serves a subset
of Dawn rather than all of it.

- **The stores are built per request, and that is not stylistic.** A pool held at
  module scope hands request N+1 an idle WebSocket bound to request N's dead I/O
  context; the request then hangs until workerd cancels it, in an alternating
  pattern that fails about half of all requests with nothing thrown. So
  `stores.mjs` builds the pool and all three stores inside the factory and ends
  the pool on dispose, with a module-scope flag recording that this isolate has
  already migrated so per-request instances do not re-run three migration
  transactions each time.
- **`requestStores`**, a new option on `createRuntimeFetchHandler`, is the seam
  that makes that possible: a `(request) => RequestStores` factory whose every
  field is optional and falls through to the boot-resolved store when omitted.
  `RequestStores` is exported from `@dawn-ai/cli/fetch`.
- **The build fails, by name, on anything the edge cannot serve** — with the new
  `DAWN_E1005`, and reporting every offending feature at once rather than one
  build at a time: `sandbox`, `backends.filesystem`/`backends.exec`, a
  config-supplied `checkpointer` / `threadsStore` / `permissions.store` /
  `memory.store`, a `workspace/` directory, route skills, and route-level
  long-term memory. The store cases matter most: those handles cannot cross a
  build boundary, so before the gate the generated Postgres store quietly took
  their place. `dawn check` applies the identical gate whenever `hono` is a
  configured target.
- **The provider import map is exhaustive or the build fails.** A bundler cannot
  follow a variable import specifier, so `app.mjs` emits a static `switch` over
  the model packages the app can reach; whatever is missing from it is missing
  from the bundle. A route that will not import, or an agent whose provider
  cannot be inferred, is therefore an error rather than a silently narrower map,
  and `summarization.model` is included.
- **`dawn build` warns on stderr** when `@dawn-ai/cli`, `@dawn-ai/postgres-storage`,
  `@neondatabase/serverless` or `hono` is missing from the app's `package.json`.
  None of them is a dependency of `@dawn-ai/cli`, deliberately: the CLI does not
  import them, the app it generates does.
- **Your config is inlined into `app.mjs` at build time**, minus every field that
  cannot survive a build boundary, rather than loaded from `dawn.config.ts` at
  runtime as the `node` target does. Keep secrets in bindings, not in config.

Also new, both in service of the emitted entry: `seedModelImporter` and
`providerPackages` from `@dawn-ai/langchain` (re-exported from
`@dawn-ai/cli/fetch`), and `DAWN_E5301` on a runtime that reaches a store no
layer supplied.

Full walkthrough, the supported subset, and an explicit list of what the CI lane
does **not** settle — Hyperdrive, production connection limits, per-query
latency, cross-isolate cold starts — are in the Deployment docs under Edge
runtimes.
