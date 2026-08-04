# Web-standard request core (B1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `(request: Request) => Promise<Response>` core from the runtime server, and reimplement the Node listener as a thin adapter over it — with zero observable behavior change.

**Architecture:** `createRuntimeFetchHandler(options)` owns the boot assembly, route table, shutdown state, and drain logic, exposing `fetch`. `createRuntimeRequestListener(options)` keeps its exact signature and becomes a Node adapter: `IncomingMessage → Request`, call `fetch`, pipe `Response → ServerResponse`.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥ 22.13 globals (`Request`/`Response`/`ReadableStream`), Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-07-22-web-standard-request-core-design.md`

**Conventions (MUST follow):** `src/` imports use `.js` specifiers, `test/` uses `.ts`. `exactOptionalPropertyTypes: true` → conditional-spread optionals, never `{ x: undefined }`. Never run a bare `biome check --write`; use `pnpm --filter @dawn-ai/cli lint`. Changeset is **patch** (fixed-group 0.x; a `minor` bumps everything to 1.0.0).

---

## The safety invariant (read before starting)

**Every existing test must pass unchanged.** This refactor changes transport shape only. If an existing assertion has to be edited to make the suite green, that is a regression to fix — not a diff to accept. The single permitted exception is a test that reaches into Node-specific internals rather than asserting observable HTTP behavior; any such edit must be called out explicitly in the final report.

Behavior that must survive verbatim:
- Routes, status codes, header names/values, JSON bodies (including `server-errors.ts` shapes and their `DAWN_E` codes).
- SSE framing produced by `toSseEvent(chunk)` and `encodeAgUiSse(event, accept)` — **these encoders are pure string functions and must not be modified**.
- The shutdown contract: 503 `createRequestErrorBody("Server is shutting down")` when not accepting; 503 `"Request canceled during server shutdown"` when the shutdown signal aborted mid-request; otherwise 500 `createExecutionErrorBody("Unexpected runtime server failure", undefined, code ? { code } : undefined)` where `code = dawnErrorCodeOf(error)`.
- `close()` drains in-flight requests **before** `sandboxManager.releaseAll()`.
- Streaming is **incremental** — chunks reach the client as produced, never buffered to completion.

---

## File structure

- Create: `packages/cli/src/lib/dev/node-web-adapter.ts` — pure `IncomingMessage → Request` and `Response → ServerResponse` helpers.
- Create: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` — `createRuntimeFetchHandler`, the transport-agnostic core (boot assembly + route table + fetch + close).
- Modify: `packages/cli/src/lib/dev/runtime-server.ts` — `RouteHandler` signature, all handlers, `dispatch`, the two AP SSE sites; `createRuntimeRequestListener` becomes the adapter.
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` — the AG-UI SSE site.
- Modify: `packages/cli/src/lib/dev/middleware.ts` — add a `Headers`-based header reader alongside `parseHeaders`.
- Create: `packages/cli/test/node-web-adapter.test.ts`, `packages/cli/test/runtime-fetch-handler.test.ts`.
- Modify: `packages/testing/src/http-inject.ts` (confirm the real path by grepping `injectAgentProtocol`) — add a direct fetch path.

---

## Task 1: Node ↔ Web adapter helpers

Pure, dependency-free, fully unit-testable without booting a runtime. This is the keystone — get it exactly right and the rest is mechanical.

**Files:**
- Create: `packages/cli/src/lib/dev/node-web-adapter.ts`
- Test: `packages/cli/test/node-web-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { PassThrough } from "node:stream"
import type { IncomingMessage, ServerResponse } from "node:http"
import { describe, expect, test } from "vitest"
import { toWebRequest, writeNodeResponse } from "../src/lib/dev/node-web-adapter.js"

function fakeReq(init: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const stream = new PassThrough()
  if (init.body !== undefined) stream.end(init.body)
  else stream.end()
  const req = stream as unknown as IncomingMessage
  Object.assign(req, {
    method: init.method ?? "GET",
    url: init.url ?? "/",
    headers: init.headers ?? {},
  })
  return req
}

describe("toWebRequest", () => {
  test("maps method, url, and headers", async () => {
    const request = toWebRequest(fakeReq({ method: "GET", url: "/threads", headers: { accept: "text/event-stream" } }))
    expect(request.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/threads")
    expect(request.headers.get("accept")).toBe("text/event-stream")
  })

  test("carries a POST body", async () => {
    const request = toWebRequest(fakeReq({ method: "POST", url: "/threads", body: '{"a":1}' }))
    expect(await request.text()).toBe('{"a":1}')
  })

  test("aborts the request signal when the socket closes", async () => {
    const req = fakeReq({ method: "GET", url: "/" })
    const request = toWebRequest(req)
    expect(request.signal.aborted).toBe(false)
    req.emit("close")
    expect(request.signal.aborted).toBe(true)
  })
})

describe("writeNodeResponse", () => {
  test("writes status, headers, and a JSON body", async () => {
    const chunks: string[] = []
    let status = 0
    let headers: Record<string, string | string[]> = {}
    const res = {
      writeHead: (s: number, h: Record<string, string | string[]>) => {
        status = s
        headers = h
      },
      write: (c: string | Uint8Array) => {
        chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c))
        return true
      },
      end: () => {},
      on: () => {},
    } as unknown as ServerResponse

    await writeNodeResponse(res, Response.json({ ok: true }, { status: 201 }))
    expect(status).toBe(201)
    expect(String(headers["content-type"])).toContain("application/json")
    expect(JSON.parse(chunks.join(""))).toEqual({ ok: true })
  })

  test("streams a ReadableStream body incrementally", async () => {
    const seen: string[] = []
    let resolveFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((r) => {
      resolveFirst = r
    })
    const res = {
      writeHead: () => {},
      write: (c: string | Uint8Array) => {
        seen.push(typeof c === "string" ? c : new TextDecoder().decode(c))
        resolveFirst?.()
        return true
      },
      end: () => {},
      on: () => {},
    } as unknown as ServerResponse

    let push: ((s: string) => void) | undefined
    let done: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        push = (s) => controller.enqueue(enc.encode(s))
        done = () => controller.close()
      },
    })

    const writing = writeNodeResponse(res, new Response(stream))
    push?.("first\n")
    await firstWrite // the first chunk must arrive BEFORE the stream completes
    expect(seen.join("")).toBe("first\n")
    done?.()
    await writing
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/cli test node-web-adapter`
Expected: FAIL — `node-web-adapter.js` does not exist.

- [ ] **Step 3: Implement**

```ts
import type { IncomingMessage, ServerResponse } from "node:http"

/** Wrap a Node request as a Web `Request`. The socket closing aborts `request.signal`. */
export function toWebRequest(req: IncomingMessage): Request {
  const controller = new AbortController()
  req.on("close", () => controller.abort())

  const host = req.headers.host ?? "localhost"
  const url = new URL(req.url ?? "/", `http://${host}`)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else headers.set(key, value)
  }

  const method = req.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"

  return new Request(url, {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody
      ? { body: req as unknown as ReadableStream<Uint8Array>, duplex: "half" }
      : {}),
  } as RequestInit & { duplex?: "half" })
}

/** Pipe a Web `Response` into a Node response, streaming the body incrementally. */
export async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    // `getSetCookie` preserves multiple Set-Cookie headers, which `Headers`
    // iteration would otherwise join into one comma-separated value.
    if (key.toLowerCase() === "set-cookie") continue
    headers[key] = value
  }
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) headers["set-cookie"] = setCookie

  res.writeHead(response.status, headers)

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(value)
    }
  } finally {
    res.end()
  }
}
```

VERIFY while implementing: Node's `Request` requires `duplex: "half"` when given a stream body — if the installed typings reject the cast, read the body eagerly instead (`await text` via a chunk loop) and pass a string. Prefer the streaming form; fall back only if types/runtime block it, and note the choice.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/cli test node-web-adapter` → PASS.
Then `pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/node-web-adapter.ts packages/cli/test/node-web-adapter.test.ts
git commit -m "feat(cli): Node <-> Web request/response adapter helpers"
```

---

## Task 2: Flip the route table to Web semantics and extract the fetch core

**This task is large and atomic by necessity** — changing `RouteHandler`'s signature breaks every handler at once, so there is no green intermediate state. Work through the steps in order and lean on the existing suite as the guard.

**Files:**
- Create: `packages/cli/src/lib/dev/runtime-fetch-handler.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`, `packages/cli/src/lib/dev/agui-handler.ts`, `packages/cli/src/lib/dev/middleware.ts`

- [ ] **Step 1: Change the handler contract**

In `runtime-server.ts`, replace the `RouteHandler` type (currently at ~:48-52):

```ts
type RouteHandler = (
  request: Request,
  params: Record<string, string>,
) => Promise<Response>
```

`RouteMatcher` (`{ method, pattern, handle }`) is unchanged. Update `dispatch` (~:517) to take `(routes, request: Request, signal: AbortSignal)`, match on `request.method` and `new URL(request.url).pathname`, and **return** the handler's `Response` (or a 404 `Response` built from the same body it produces today).

- [ ] **Step 2: Convert the JSON handlers**

Every handler in `buildRouteTable` (~:256-510) returns a `Response` instead of writing:
- `sendJson(res, status, body)` → `return Response.json(body, { status })`.
- `res.writeHead(204)` + end (`:355`) → `return new Response(null, { status: 204 })`.
- `await readRequestBody(request)` → `await request.text()`.
- `parseHeaders(request)` → a new `headersToRecord(headers: Headers)` in `middleware.ts`: `Object.fromEntries(headers)`. **Keep `parseHeaders` exported** (other callers/tests may use it) and add the new function beside it; `MiddlewareRequest` itself does not change.

Delete `sendJson`/`readRequestBody` only once nothing references them.

- [ ] **Step 3: Convert the three SSE sites**

The sites: AP run stream (~:630-656), resume stream (~:929-956), AG-UI (`agui-handler.ts:184-210`). Each follows this shape — **the encoders stay untouched**:

```ts
const encoder = new TextEncoder()
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    try {
      for await (const chunk of iterator) {
        controller.enqueue(encoder.encode(toSseEvent(chunk)))
      }
    } catch (error) {
      controller.enqueue(encoder.encode(toSseEvent(errorChunkFor(error))))
    } finally {
      controller.close()
    }
  },
  cancel() {
    // Client disconnected — stop the run exactly as the old `res` close did.
    runAbortController.abort()
  },
})

return new Response(stream, {
  status: 200,
  headers: { /* the SAME headers the site sets today, incl. content-type: text/event-stream */ },
})
```

Copy each site's existing headers verbatim — do not "tidy" them. For AG-UI, `request.headers.accept` becomes `request.headers.get("accept") ?? undefined` so `encodeAgUiSse`'s content negotiation is preserved. Preserve each site's existing error-chunk behavior exactly.

- [ ] **Step 4: Extract `createRuntimeFetchHandler`**

Move the boot assembly (registry, middleware, threadsStore, checkpointer, sandboxManager, memoryStore — including the `MemoryStore` cast **and its explanatory comment**), the sandbox reaper interval, `state`, `shutdownController`, `buildRouteTable`, and `close` into `runtime-fetch-handler.ts`:

```ts
export interface RuntimeFetchHandler {
  readonly fetch: (request: Request) => Promise<Response>
  readonly close: () => Promise<void>
  readonly state: { acceptingRequests: boolean; activeRequests: number; closed: boolean }
  readonly shutdownController: AbortController
}

export async function createRuntimeFetchHandler(
  options: StartRuntimeServerOptions,
): Promise<RuntimeFetchHandler>
```

`fetch` reproduces the listener's control flow exactly, returning Responses:
1. `if (!state.acceptingRequests) return Response.json(createRequestErrorBody("Server is shutting down"), { status: 503 })`
2. `state.activeRequests++`; `try { return await dispatch(routes, request, shutdownController.signal) }`
3. `catch`: if `shutdownController.signal.aborted` → 503 `createRequestErrorBody("Request canceled during server shutdown", { error: … })`; else → 500 `createExecutionErrorBody("Unexpected runtime server failure", undefined, code ? { code } : undefined)` with `code = dawnErrorCodeOf(error)`.
4. `finally { state.activeRequests-- }`

`close()` moves over unchanged — including draining to `activeRequests === 0` **before** `sandboxManager.releaseAll()`, and clearing the reaper.

**Caution:** `activeRequests--` must not fire until an SSE response has finished streaming, or `close()` could release sandboxes mid-stream. Since `fetch` returns as soon as the `Response` exists, track stream completion explicitly — decrement in the stream's `close`/`cancel` path for streaming responses rather than in `fetch`'s `finally`. Get this right; it is the subtlest part of the task.

- [ ] **Step 5: Rewire `createRuntimeRequestListener` as the adapter**

Keep the exported signature and returned shape identical (`{ close, listener, shutdownController, state }`):

```ts
export async function createRuntimeRequestListener(
  options: StartRuntimeServerOptions,
): Promise<RuntimeRequestListener> {
  const core = await createRuntimeFetchHandler(options)

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // `toWebRequest` already aborts the request signal when the socket
      // closes, which is what stops an in-flight run on client disconnect.
      const response = await core.fetch(toWebRequest(req))
      await writeNodeResponse(res, response)
    })()
  }

  return { close: core.close, listener, shutdownController: core.shutdownController, state: core.state }
}
```

`startRuntimeServer` and `serveRuntime` are **not** modified.

- [ ] **Step 6: Run the full existing suite — the real gate**

Run: `pnpm --filter @dawn-ai/cli test`
Expected: every test passes **with no edits to existing tests**. If an assertion fails, fix the implementation, not the test (see the safety invariant).

Then: `pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/src/lib/dev/middleware.ts
git commit -m "refactor(cli): (Request) => Response runtime core; node listener becomes an adapter"
```

---

## Task 3: Tests against the fetch core

**Files:**
- Test: `packages/cli/test/runtime-fetch-handler.test.ts`

- [ ] **Step 1: Write the tests**

Build a fixture app the way the existing runtime tests do (read `packages/cli/test/dev-command.test.ts` and reuse its `createFixtureApp` helper pattern — do not invent a new one). Then:

```ts
const core = await createRuntimeFetchHandler({ appRoot })
// 1. JSON route
const created = await core.fetch(new Request("http://localhost/threads", { method: "POST", body: "{}" }))
expect(created.status).toBe(200)
expect(await created.json()).toHaveProperty("thread_id")

// 2. unknown path
expect((await core.fetch(new Request("http://localhost/nope"))).status).toBe(404)

// 3. shutdown guard
await core.close()
expect((await core.fetch(new Request("http://localhost/threads", { method: "POST", body: "{}" }))).status).toBe(503)
```

Add an **incremental streaming** test (the critical one): start a run against an SSE route, read the `Response.body` reader, and assert at least one event arrives **before** the stream closes — proving chunks are not buffered. Add an **abort** test: abort the `Request`'s signal mid-stream and assert the reader ends and the run stops.

Use the deterministic model mock the repo already uses for runtime tests (grep the existing runtime/AP tests for how they avoid a live model) so no API key is needed.

- [ ] **Step 2: Run** → `pnpm --filter @dawn-ai/cli test runtime-fetch-handler` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/runtime-fetch-handler.test.ts
git commit -m "test(cli): fetch-core tests — JSON, 404, shutdown, incremental SSE, abort"
```

---

## Task 4: Simplify the testing harness

**Files:**
- Modify: the `injectAgentProtocol` implementation in `@dawn-ai/testing` (grep `injectAgentProtocol` to find it; the spec expects `packages/testing/src/http-inject.ts`)

- [ ] **Step 1:** Read the current implementation. It drives `createRuntimeRequestListener` through `light-my-request`. Add a path that calls `createRuntimeFetchHandler(...).fetch(request)` directly and adapts the `Response` to whatever shape `injectAgentProtocol` already returns.

- [ ] **Step 2:** **Its public API and observable behavior must not change** — the existing `@dawn-ai/testing` tests and every consumer (the dogfood suites in `packages/testing/test`, `examples/*`) must pass untouched. If `light-my-request` becomes unused, remove the dependency; if anything still needs it, leave it.

- [ ] **Step 3:** Run `pnpm --filter @dawn-ai/testing test` → PASS.

- [ ] **Step 4: Commit**

```bash
git commit -am "refactor(testing): drive the Agent-Protocol harness through the fetch core"
```

---

## Task 5: Full verification, changeset, PR

- [ ] **Step 1: The socket-level gate (required)**

These lanes drive a real server over a real socket and are the strongest proof the adapter preserves wire behavior — including streaming:

```bash
pnpm verify:harness:runtime
pnpm verify:harness:smoke
```
Both must pass. If either fails, the adapter is wrong — fix it.

- [ ] **Step 2: Full local verification**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-docs.mjs && pnpm pack:check
```

- [ ] **Step 3: Manual streaming sanity check**

Start the research example (or any fixture app) with `dawn dev`, open an SSE run, and confirm tokens arrive progressively rather than in one burst at the end. A buffering regression can pass unit tests while ruining the product — look at it with your own eyes.

- [ ] **Step 4: Changeset**

Create `.changeset/web-standard-request-core.md` — **patch** for the touched publishable packages. Confirm the set with:
```bash
git log --oneline origin/main..HEAD --name-only -- packages/ | grep '^packages/' | cut -d/ -f2 | sort -u
```
(expect `cli`, and `testing` if Task 4 touched it). Describe it as an internal refactor with no behavior change, noting it unblocks edge build targets.

- [ ] **Step 5: Rebase, push, PR**

Rebase on `origin/main`, push, open the PR. Watch `validate` plus the sandbox/chart lanes. Address advisory-review and CodeQL findings.

---

## Notes for the executor

- Branch is `feat/web-standard-request-core`; **pin it before dispatching any subagent** (multi-worktree detached-HEAD hazard).
- Do NOT merge the open TypeScript 7 major bump (#348) into this branch — a TS major landing mid-refactor would confuse real regressions with typing churn.
- The encoders (`toSseEvent`, `encodeAgUiSse`) and the error-body builders (`server-errors.ts`) are **not** part of this refactor. If you find yourself editing them, stop and reconsider.
