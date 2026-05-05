# Production Readiness: Deployment, Retry, Middleware

## Summary

Three features to make Dawn production-ready for LangGraph Platform deployments:

1. **Deployment Config** — `dawn build` produces valid `langgraph.json` for `langgraph deploy`
2. **Retry/Resilience** — Invisible automatic retry of transient LLM errors with per-agent escape hatch
3. **Middleware** — Global request middleware with context injection for auth and gating

DX is the top priority. All three features should feel zero-config in the common case.

---

## 1. Deployment Config (`dawn build`)

### Goal

`dawn build` produces a valid project layout and `langgraph.json` compatible with `langgraph deploy` (LangSmith Cloud). The architecture supports future build targets (self-hosted Docker, Azure, AWS) without breaking changes.

### Output Structure

```
.dawn/build/
├── langgraph.json
├── package.json
├── src/
│   └── graphs/        # compiled entry points per route
└── ...
```

### `langgraph.json` Schema (corrected)

```json
{
  "node_version": "22",
  "dependencies": ["."],
  "graphs": {
    "hello/[tenant]#agent": "./src/graphs/hello_tenant.ts:default"
  },
  "env": ".env"
}
```

Key points:
- `dependencies`: Array of paths to local directories or tarballs. `["."]` means "install from project root's package.json". NOT `["pkg@version"]` strings.
- `env`: Path to a `.env` file relative to the build output. NOT an array of variable names.
- `graphs`: Maps assistant IDs to `"./path:exportName"` entries that Dawn generates during codegen.

### Build Target Interface (internal)

```ts
interface BuildTarget {
  readonly name: string
  emit(context: BuildContext): Promise<void>
}

interface BuildContext {
  readonly appRoot: string
  readonly outputDir: string
  readonly routes: readonly DiscoveredRoute[]
  readonly packageJson: Record<string, unknown>
}
```

Only `LangSmithTarget` ships today. The interface exists for future extensibility, not as user-facing API.

### What Changes From Current Implementation

| Current | Corrected |
|---------|-----------|
| `dependencies: ["pkg@version", ...]` | `dependencies: ["."]` |
| `env: ["OPENAI_API_KEY", ...]` | `env: ".env"` |
| Generates standalone Dockerfile | Generates `langgraph.json` (LangGraph CLI handles Docker) |
| No build target abstraction | Internal `BuildTarget` interface |

### User Workflow

```bash
dawn build                    # produces .dawn/build/ with langgraph.json
cd .dawn/build
langgraph deploy              # deploys to LangSmith Cloud
# or
langgraph build               # builds Docker image for self-hosting
```

---

## 2. Retry/Resilience

### Goal

Dawn automatically retries transient LLM errors with sensible defaults. Zero configuration required. Per-agent escape hatch for edge cases.

### Default Behavior (zero-config)

| Setting | Default |
|---------|---------|
| Max attempts | 3 |
| Base delay | 1000ms |
| Backoff | Exponential with jitter |
| Max delay | 10000ms |

### Retryable Errors

**Retried:**
- 429 Too Many Requests / rate limit
- 500, 502, 503 server errors
- Network errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT
- OpenAI transient: "server is overloaded", "server_error"

**NOT retried:**
- 400 Bad Request
- 401 Unauthorized, 403 Forbidden
- Model not found, invalid API key
- Validation errors

### Streaming Behavior

- If no chunks have been yielded to the client, retry the entire stream (up to max attempts)
- Once any chunk has been yielded, do NOT retry (client has partial data — throw immediately)

### Per-Agent Escape Hatch

```ts
// src/app/summarize/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "Summarize the input.",
  retry: { maxAttempts: 5, baseDelay: 2000 }
})
```

`retry` is an optional field on `AgentConfig`:

```ts
interface RetryConfig {
  readonly maxAttempts?: number   // default: 3
  readonly baseDelay?: number    // default: 1000 (ms)
}
```

### What Changes From Current Implementation

The existing `retry.ts` and agent-adapter streaming retry logic are correct in behavior. Changes needed:

- Add `retry?: RetryConfig` to `AgentConfig` in `@dawn-ai/sdk`
- Wire per-agent config through `materializeAgent` → retry calls
- No global config, no per-route config

---

## 3. Middleware

### Goal

Single global middleware file for request gating and context injection. Auth is the primary use case. Zero overhead when no middleware file exists.

### Authoring Contract

```ts
// src/middleware.ts
import { defineMiddleware, reject, allow } from "@dawn-ai/sdk"

export default defineMiddleware(async (req) => {
  const token = req.headers.authorization?.split(" ")[1]
  if (!token) return reject(401, { error: "Unauthorized" })

  const user = await verifyToken(token)
  return allow({ userId: user.id, orgId: user.orgId })
})
```

### Request Object

```ts
interface MiddlewareRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly routeId: string        // e.g. "/hello/[tenant]"
  readonly assistantId: string    // e.g. "/hello/[tenant]#agent"
  readonly params: Readonly<Record<string, string>>  // parsed route params
  readonly method: string
  readonly url: string
}
```

### Result Types

```ts
type MiddlewareResult = ContinueResult | RejectResult

interface ContinueResult {
  readonly action: "continue"
  readonly context?: Record<string, unknown>
}

interface RejectResult {
  readonly action: "reject"
  readonly status: number
  readonly body?: unknown
}
```

### SDK Exports

From `@dawn-ai/sdk`:

- `defineMiddleware(fn: (req: MiddlewareRequest) => Promise<MiddlewareResult> | MiddlewareResult)` — type-safe wrapper
- `reject(status: number, body?: unknown): RejectResult` — helper
- `allow(context?: Record<string, unknown>): ContinueResult` — helper (avoids `continue` reserved word)

### Context Flow

Middleware-injected context merges into the tool execution `context` parameter:

```ts
// src/app/hello/tools/get-profile.ts
import { tool } from "@dawn-ai/sdk"
import { z } from "zod"

export const getProfile = tool({
  name: "get_profile",
  schema: z.object({}),
  run: async (input, context) => {
    // context.userId — injected by middleware
    // context.tenant — from route params [tenant]
    return db.getProfile(context.userId)
  }
})
```

### Runtime Behavior

- Middleware loaded once at server start via dynamic import of `src/middleware.ts`
- Runs before route matching — rejection skips all route code
- If no `src/middleware.ts` exists, middleware step is skipped (no overhead)
- Middleware context merged with route params into tool context

### What Changes From Current Implementation

| Current | Corrected |
|---------|-----------|
| `DawnMiddleware` type in CLI package | `defineMiddleware` + helpers in SDK package |
| Receives raw `IncomingMessage` | Receives parsed `MiddlewareRequest` |
| `MiddlewareContext` has `request` field | No raw request exposure |
| Array of middleware functions | Single middleware function |
| `runMiddleware` chains array | Direct invocation of single function |
| No context flow to tools | Context merges into tool `context` param |

---

## What We're NOT Doing

- No per-route middleware (use `req.routeId` to branch internally)
- No middleware chaining/composition (single function)
- No request body parsing in middleware (runs pre-route)
- No rewrite/redirect semantics
- No global retry config in `dawn.config.ts`
- No standalone Dockerfile generation (LangGraph CLI handles Docker)
- No `dawn deploy` command (users run `langgraph deploy` directly)

---

## Migration From Current Implementation

The existing code in `packages/langchain/src/retry.ts` and `packages/langchain/src/agent-adapter.ts` (retry logic) is mostly correct and can be kept. The following will be rewritten:

1. `packages/cli/src/lib/build/deployment-config.ts` — rewrite to produce correct `langgraph.json`
2. `packages/cli/src/commands/build.ts` — rewrite build command output
3. `packages/cli/src/lib/dev/middleware.ts` — rewrite to single-function model with parsed request
4. `packages/cli/src/lib/dev/runtime-server.ts` — update middleware integration
5. `packages/sdk/src/agent.ts` — add `retry` field to `AgentConfig`
6. `packages/sdk/src/index.ts` — export `defineMiddleware`, `reject`, `continue_`
