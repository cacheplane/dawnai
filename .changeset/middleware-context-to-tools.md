---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
---

Middleware context now flows through to tools.

A tool's second argument is now `{ middleware?: Readonly<Record<string, unknown>>, signal: AbortSignal }`. Whatever the global middleware passes via `allow({ ... })` is available to every tool invocation as `ctx.middleware` — for both `/runs/wait` and `/runs/stream` paths.

Example:

```ts
// src/middleware.ts
export default defineMiddleware(async (req) => {
  const userId = await verifyToken(req.headers.authorization)
  return allow({ userId })
})

// src/app/.../tools/lookup.ts
export default async (input, { middleware }) => {
  const userId = middleware?.userId
  return await db.lookup(userId, input)
}
```
