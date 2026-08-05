# Web-standard request core — design

**Date:** 2026-07-22
**Status:** approved (brainstorm)
**Epic:** Deploy-anywhere. This is **sub-project B1** of three:
- **B1 (this doc)** — a `(Request) => Promise<Response>` core + thin Node adapter.
- **B2** — build-time static wiring (routes/tools/config/middleware become generated static imports; kill per-request `readdir`).
- **B3** — the Cloudflare Workers / Vercel / Hono build targets, with per-target capability gating.

## Problem

Dawn's served runtime is welded to `node:http`. `createRuntimeRequestListener` builds a route table whose handlers are typed
`(req: IncomingMessage, res: ServerResponse, params) => Promise<void>` (`packages/cli/src/lib/dev/runtime-server.ts:48-52`), and every
response is written through Node sinks (`res.writeHead`, `res.write`, `res.end`).

That blocks the edge targets in B3, which require a Web-standard `fetch` handler. It also makes the runtime harder to test than it
needs to be: `@dawn-ai/testing`'s `http-inject` drives the listener through `light-my-request` precisely because there is no way to
hand the runtime a plain request and get a plain response back.

## Goal

Extract a transport-agnostic **`(request: Request) => Promise<Response>`** core, and reimplement the existing Node listener as a thin
adapter over it. **Zero behavior change** for `dawn dev`, `dawn start`, and `serveRuntime`.

This sub-project changes the **transport shape only**. Module loading, route/tool discovery, and storage stay exactly as they are —
those are B2's problem.

## Non-goals

- **No edge target.** No `worker.mjs`, no `wrangler.toml`, no bundler hook. That is B3.
- **No static-wiring inversion.** The tsx loader, `pathToFileURL` dynamic imports, and `discoverRoutes`/`discoverToolDefinitions`
  `readdir` calls are untouched here. That is B2, and it is the larger piece.
- **No capability gating.** Deciding that a route using `runBash` may not ship to Workers is B3.
- **No new dependency.** The core uses the runtime's built-in `Request`/`Response`/`ReadableStream` (Node ≥ 22.13, already the floor
  enforced by `dawn verify`). No Hono, no undici shim.

## Architecture

Two units with a clean seam between them.

### 1. `createRuntimeFetchHandler(options) → (request: Request) => Promise<Response>`

The new core, living beside the existing server module. It performs the same once-at-boot assembly the listener does today (runtime
registry, middleware, threads store, checkpointer, sandbox manager, memory store) and returns a fetch handler closed over it.

The refactor is mechanical because the existing structure is already close:

- **Routing is data.** `RouteMatcher` is `{ method, pattern: RegExp, handle }` and `dispatch` only reads `request.method` and
  `request.url` — both present on `Request`. `buildRouteTable({...})` is already a parameterized function, so the table construction
  needs no structural change; only `RouteHandler`'s signature changes to
  `(request: Request, params: Record<string, string>) => Promise<Response>`.
- **JSON replies** become `Response.json(body, { status })`, replacing the `sendJson(res, status, body)` helper. The bodies
  themselves — including the `server-errors.ts` shapes and their `DAWN_E` codes — are unchanged.
- **Body reading** becomes `await request.text()` (then `JSON.parse`), replacing the `for await (const chunk of req)` +
  `Buffer.concat` loop.
- **Headers** become `Object.fromEntries(request.headers)`, replacing `parseHeaders(IncomingMessage)`. `MiddlewareRequest` is already
  a transport-agnostic record (`{ headers, method, url, params, routeId, assistantId }`), so **the middleware contract does not
  change** — which matters because `#354` made AP and AG-UI share this path.
- **Streaming.** There are exactly three SSE sites: the AP run stream (`runtime-server.ts:630-656`), the resume stream
  (`:929-956`), and the AG-UI stream (`agui-handler.ts:184-210`). Each becomes a `new ReadableStream({ start/pull })` whose body is
  the existing `for await` loop with `controller.enqueue(encoder.encode(...))` in place of `response.write(...)`, returned as
  `new Response(stream, { status: 200, headers })` with the same headers as today.
  **The chunk encoders are already pure string functions — `toSseEvent(chunk)` and `encodeAgUiSse(event, accept)` are untouched.**
  The AG-UI site's `request.headers.accept` becomes `request.headers.get("accept") ?? undefined`, preserving `#360`'s content
  negotiation.
- **Cancellation.** `request.signal` drives the run's `AbortController`, replacing the Node `res`-close listener. The stream's
  `cancel()` aborts the same controller, so a client disconnect still stops the run.

### 2. The Node adapter

`createRuntimeRequestListener` keeps its exported signature and becomes a wrapper: build a `Request` from
`(IncomingMessage, ServerResponse)`, call the fetch handler, then pipe the `Response` back — status, headers, and body (streaming
incrementally for SSE, so first-token latency is unchanged). A `ServerResponse` `close` event aborts the `Request`'s signal so
client-disconnect semantics survive the round trip.

`startRuntimeServer`, `serveRuntime`, `dawn dev`, and `dawn start` are **not modified** and keep their exact signatures. The
exported surface that must be preserved verbatim: `RuntimeServer`, `StartRuntimeServerOptions`, `RuntimeRequestListener`,
`createRuntimeRequestListener`, `startRuntimeServer`.

## The safety invariant

**Responses must be indistinguishable on the wire from today's** — same routes, status codes, header names and values, JSON error
bodies, and SSE framing. Every existing runtime, Agent-Protocol, AG-UI, permissions, and memory-endpoint test must pass **unchanged**. If an
existing assertion has to be edited to make the suite green, that is a regression to fix, not a diff to accept. The one permitted
exception is a test that reaches into Node-specific internals rather than asserting on observable HTTP behavior; any such edit must
be called out explicitly in review.

## Testing

- **Regression (the primary gate):** the full `@dawn-ai/cli` suite plus the runtime-contract and Agent-Protocol harness lanes, all
  unchanged. `pnpm verify:harness:runtime` and `verify:harness:smoke` exercise the real server over a socket and are the strongest
  proof the adapter preserves wire behavior.
- **New, against the core directly:** drive `createRuntimeFetchHandler` with a plain `Request` and assert — a JSON route's status
  and parsed body; an SSE route's **incremental** chunks (read the `ReadableStream` and assert events arrive before completion, not
  just in the final buffer); a 404 for an unknown path; and that aborting the `Request`'s signal mid-stream stops the run.
- **Harness simplification:** `@dawn-ai/testing`'s `injectAgentProtocol` gains a direct fetch-handler path. Its public API and
  existing behavior stay the same; this is an internal simplification, not a contract change.

## Risks

- **Streaming regressions are the real risk** — buffering instead of streaming would still pass a naive "collect the body" test
  while destroying first-token latency. This is why the new tests assert incremental arrival, and why the socket-level harness lanes
  are a required gate.
- **Header fidelity.** `Headers` normalizes casing and joins duplicates (notably `set-cookie`). The adapter must not silently drop or
  merge headers the Node path sets today.
- **Node ≥ 22.13** is required for a global `Request`/`Response`; that is already the enforced floor, so no new constraint.

## Sequencing

B1 is self-contained and ships on its own. B2 (static wiring) and B3 (edge targets) build on it, but nothing in B2/B3 needs to land
first — and B1's testing simplification pays for itself even if the epic stopped here.
