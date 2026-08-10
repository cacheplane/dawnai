---
"@dawn-ai/sdk": patch
---

**`RouteConfig` is documented as reserved — Dawn reads none of its fields.**

`runtime`, `streaming` and `tags` are accepted on a route's exported `config`,
type-checked, normalized onto the route module and carried into the static build
manifest, and then nothing branches on any of them. The API docs described
effects none of them has: `runtime` did not pin a route to an execution
environment (the node/edge split comes from `build.targets` and is never decided
per route), `streaming` did not switch on token streaming (the endpoint the
caller hits decides that), and `tags` were not displayed by the Dev Server UI or
anywhere else.

The fields are kept rather than removed — deleting a published field breaks
every app that set one and buys nothing — but they now carry JSDoc saying they
are reserved and have no effect, and the API reference says the same. If they
gain behavior it will be additive.
