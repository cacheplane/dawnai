---
"@dawn/cli": patch
"@dawn/config-biome": patch
"@dawn/config-typescript": patch
"@dawn/core": patch
"@dawn/devkit": patch
"@dawn/langchain": patch
"@dawn/langgraph": patch
"@dawn/sdk": patch
"@dawn/vite-plugin": patch
"create-dawn-app": patch
---

Normalize the public Dawn packages for publishing, including release metadata,
packed artifact validation, and packaged template assets for `@dawn/devkit`.

Make `create-dawn-app` standalone by default so external scaffolds use release
channel package specifiers, while keeping explicit internal monorepo scaffolding
behind a guarded `--mode internal` path.
