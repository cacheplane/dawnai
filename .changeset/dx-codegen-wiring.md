---
"@dawn-ai/cli": minor
"@dawn-ai/core": minor
"@dawn-ai/devkit": patch
"create-dawn-app": patch
---

Add codegen wiring to dawn dev and build commands

- `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
- `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
- `dawn build` runs typegen as a pre-step after route discovery
- App template includes zod-based state.ts for stateful route scaffolding
