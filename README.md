# Dawn

Dawn is a TypeScript meta-framework for filesystem-based route discovery, route validation, type generation, local route execution, and a local development runtime.

## Status

This repository documents the current behavior only. It is intentionally narrow. Dawn is not a deployment runtime, not a LangSmith trace replacement, and not a hosted platform.

## Quickstart

1. Create a new app.

```bash
pnpm exec create-dawn-app my-dawn-app
cd my-dawn-app
pnpm install
```

2. Run the scaffolded route. The route path must be quoted because it contains `(`, `)`, and `[]`.

```bash
echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]/workflow.ts"
```

3. Optionally start the local runtime and send the same route through `--url`.

```bash
pnpm exec dawn dev --port 3001
echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]/workflow.ts" --url http://127.0.0.1:3001
```

## App Contract

A Dawn app root contains `package.json` and `dawn.config.ts`.

Route discovery starts at `src/app` by default.

`appDir` is the only supported config option today.

Each route directory exposes exactly one primary executable entry:

- `graph.ts`
- `workflow.ts`

The current `basic` scaffold ships `src/app/(public)/hello/[tenant]/workflow.ts`.

## Commands

### `create-dawn-app`

Scaffold a new Dawn app from the available template set.

```bash
pnpm exec create-dawn-app my-dawn-app
```

### `dawn check`

Validate the app structure and configuration for the current workspace.

### `dawn routes`

Discover and print the routes Dawn sees in the current app.

### `dawn typegen`

Generate route types for the current app.

### `dawn run`

Execute one route invocation with JSON stdin/stdout.

```bash
echo '{"tenant":"acme"}' | pnpm exec dawn run "src/app/(public)/hello/[tenant]/workflow.ts"
```

### `dawn test`

Run colocated `run.test.ts` scenarios against route targets.

### `dawn dev`

Start the local development runtime for interactive route execution.

```bash
pnpm exec dawn dev
```

## Packages

- `@dawn/core` owns discovery, config loading, validation, and route types.
- `@dawn/langgraph` owns thin route authoring contracts.
- `@dawn/cli` owns the user-facing commands and local runtime behavior.
- `create-dawn-app` owns scaffolding for new apps.
- `@dawn/devkit` owns shared template and file-generation helpers.
- `@dawn/config-typescript` provides the shared TypeScript workspace configuration.
- `@dawn/config-biome` provides the shared Biome workspace configuration.

## Current Boundaries

Dawn is not a deployment runtime. Local runtime ownership stops at `dawn dev`.

Dawn is not a LangSmith trace replacement.

The starter template surface is intentionally small, and the supported config surface is intentionally narrow.

## Contributing

For repository layout, test lanes, and local verification commands, see [CONTRIBUTORS.md](./CONTRIBUTORS.md).
