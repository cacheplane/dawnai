---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
"@dawn-ai/devkit": patch
"@dawn-ai/langchain": patch
"@dawn-ai/sdk": patch
"@dawn-ai/vite-plugin": patch
---

**Breaking:** scenario files must default export `scenarios("<route>")` from
`@dawn-ai/sdk/testing`. A plain default-exported array now throws
`RunScenarioLoadError` at load; wrap the array in `scenarios("/route")` to
migrate.

Add route-scoped fluent `dawn test` scenarios with generated application-tool
types, invocation-local in-process tool mocks, and declarative mock call
assertions. Scenario files now use `scenarios("/route")`; plain default-exported
arrays are no longer supported.
