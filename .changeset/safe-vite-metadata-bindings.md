---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
"@dawn-ai/devkit": patch
"@dawn-ai/inspector": patch
"@dawn-ai/vite-plugin": patch
---

Support TypeScript 7 workspaces and generated apps, and move Dawn's Next.js applications
to Next 16.3's experimental CLI type checker with `experimental.useTypeScriptCli`.

Consolidate tool analysis in Core behind one compiler boundary and program, with shared
projections for declarations, JSON Schema, and Vite Zod metadata. Core internally pins
the exact TypeScript 6 compatibility wrapper and implementation until the native compiler
API can be revisited for TypeScript 7.1. Generated JSON schemas now preserve mapped-type
optionality and use a compiler-neutral fallback for collection intersections.

Generate collision-safe Vite metadata bindings and remove the unsupported `extractJsDoc`
and `extractParameterType` exports. Their removal is an intentional breaking change.

Add permanent packed-consumer and exact-version post-publish verification for the
TypeScript tooling packages.
