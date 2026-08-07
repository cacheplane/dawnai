# Agent Protocol Run Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Dawn's Agent Protocol surface an explicit way to stop an in-flight run, and turn its accidental client-disconnect behaviour into a documented decision.

**Architecture:** A process-local `Map<threadId, AbortController>` scoped to the `buildRouteTable` closure becomes the single source of truth for "a run is in flight here, now". It enables three things at once: a 409 concurrency gate (fixing today's silent checkpoint interleaving), a per-run `AbortSignal` the AP endpoints have never had, and a `POST /threads/:thread_id/cancel` endpoint. Client-disconnect behaviour is deliberately left as-is — AP continues, AG-UI aborts — and both sides get the rationale written down.

**Tech Stack:** TypeScript, Node 24, vitest, web-standard `Request`/`Response`, `AbortSignal.any`, LangGraph checkpointing, SQLite (`@dawn-ai/sqlite-storage`).

**Spec:** `docs/superpowers/specs/2026-08-06-ap-run-cancellation.md`

---

## Background the implementer needs

Read these before starting. They are the non-obvious facts this plan depends on:

1. **`runtime-fetch-handler.ts` is the only place to implement this.** `runtime-server.ts` is a 162-line Node adapter that calls `createRuntimeFetchHandler` and converts `IncomingMessage` → `Request`. `dawn dev`, `dawn start`, `dawn build --target node`, and the future edge targets all funnel through the fetch handler. Do not add logic to `runtime-server.ts`.

2. **Nothing reads `thread.status` today.** `"busy"` is written at six sites and read only when serializing `GET /threads/:id`. Two concurrent runs on one thread are both admitted today and interleave checkpoint writes against the same LangGraph thread. That is the bug Task 2's 409 fixes.

3. **Gate on the in-memory registry, never on the persisted `status` column.** If you gate on the DB flag, a process that crashes mid-run leaves `"busy"` in SQLite and permanently bricks that thread — every later run 409s forever. A fresh process has an empty registry, so a crash self-heals. Task 2 Step 1 tests exactly this.

4. **`"interrupted"` already exists** in `ThreadStatus` (`packages/sqlite-storage/src/threads/store.ts:4`) and is written by no production code. Use it for cancelled runs. No migration needed.

5. **AG-UI is the reference implementation.** `packages/cli/src/lib/dev/agui-handler.ts:119-126` (controller + `AbortSignal.any`) and `:211` (`abortableAsyncIterable`) show the exact shape to copy. The `abortableAsyncIterable` wrapper matters: without it, a route that ignores its `ctx.signal` keeps running even after abort.

6. **File paths are relative to the repo root**, and all test commands run from `packages/cli`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/lib/dev/run-registry.ts` | **Create.** Owns in-flight run tracking, signal composition, and cancellation. Pure, no I/O, no HTTP. |
| `packages/cli/test/run-registry.test.ts` | **Create.** Unit tests for the registry in isolation. |
| `packages/cli/src/lib/dev/runtime-fetch-handler.ts` | **Modify.** Instantiate the registry; wire the three run endpoints; add the cancel route. |
| `packages/cli/test/run-cancellation.test.ts` | **Create.** HTTP-level tests: 409 gate, cancel endpoint, registry cleanup, wire format. |
| `packages/cli/test/runtime-fetch-parity.test.ts` | **Modify.** Recomment the disconnect pin as deliberate. |
| `apps/web/content/docs/dev-server.mdx` | **Modify.** Document `/cancel` and the disconnect split. |
| `charts/dawn-app/README.md` | **Modify.** Single-replica caveat. |
| `.changeset/ap-run-cancellation.md` | **Create.** Release note flagging the 409 behaviour change. |

Keeping the registry in its own file (rather than inline in the 1134-line handler) means Task 1 is fully testable without HTTP, and the handler diff stays reviewable.

---

## Task 1: Run registry

**Files:**
- Create: `packages/cli/src/lib/dev/run-registry.ts`
- Test: `packages/cli/test/run-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/run-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createRunRegistry } from "../src/lib/dev/run-registry.js"

const shutdown = () => new AbortController().signal

describe("createRunRegistry", () => {
  it("admits the first run for a thread", () => {
    const registry = createRunRegistry()
    expect(registry.begin("t1", shutdown())).toBeDefined()
    expect(registry.has("t1")).toBe(true)
  })

  it("refuses a second concurrent run on the same thread", () => {
    const registry = createRunRegistry()
    registry.begin("t1", shutdown())
    expect(registry.begin("t1", shutdown())).toBeUndefined()
  })

  it("admits concurrent runs on different threads", () => {
    const registry = createRunRegistry()
    expect(registry.begin("t1", shutdown())).toBeDefined()
    expect(registry.begin("t2", shutdown())).toBeDefined()
  })

  it("admits a new run after the previous one is released", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    run?.release()
    expect(registry.has("t1")).toBe(false)
    expect(registry.begin("t1", shutdown())).toBeDefined()
  })

  it("release is idempotent and does not clear a later run's slot", () => {
    const registry = createRunRegistry()
    const first = registry.begin("t1", shutdown())
    first?.release()
    const second = registry.begin("t1", shutdown())
    first?.release() // stale release from the finished run
    expect(registry.has("t1")).toBe(true)
    expect(second).toBeDefined()
  })

  it("cancel aborts the run signal and reports success", () => {
    const registry = createRunRegistry()
    const run = registry.begin("t1", shutdown())
    expect(registry.cancel("t1")).toBe(true)
    expect(run?.signal.aborted).toBe(true)
    expect(run?.cancelled).toBe(true)
  })

  it("cancel returns false when no run is in flight", () => {
    const registry = createRunRegistry()
    expect(registry.cancel("nope")).toBe(false)
  })

  it("server shutdown aborts the run signal but is not a cancellation", () => {
    const registry = createRunRegistry()
    const shutdownController = new AbortController()
    const run = registry.begin("t1", shutdownController.signal)
    shutdownController.abort()
    expect(run?.signal.aborted).toBe(true)
    expect(run?.cancelled).toBe(false)
  })

  it("begin on an already-aborted shutdown signal yields an aborted run signal", () => {
    const registry = createRunRegistry()
    const shutdownController = new AbortController()
    shutdownController.abort()
    const run = registry.begin("t1", shutdownController.signal)
    expect(run?.signal.aborted).toBe(true)
    expect(run?.cancelled).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/cli`:

```bash
pnpm vitest --run test/run-registry.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/lib/dev/run-registry.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/lib/dev/run-registry.ts`:

```ts
/**
 * Process-local registry of in-flight runs, keyed by thread id.
 *
 * Dawn has no `run_id`. A thread runs at most one run at a time — enforced by
 * `begin` refusing an already-running thread — so the thread id *is* the run
 * identity. Without that guarantee a second run would overwrite the first's
 * entry and orphan its controller, producing exactly the unkillable run this
 * registry exists to prevent.
 *
 * Deliberately in-memory and handler-scoped rather than persisted on
 * `ThreadsStore`: an AbortController is not serializable, and gating on the
 * persisted `status` column would let a process that crashes mid-run brick the
 * thread forever (the stale "busy" would reject every later run). A fresh
 * process starts with an empty registry, so a crash self-heals.
 *
 * Single-replica only; see docs/superpowers/specs/2026-08-06-ap-run-cancellation.md.
 */

export interface RunHandle {
  /** Composed shutdown-or-cancel signal. Hand this to the route, not the raw shutdown signal. */
  readonly signal: AbortSignal
  /** True only when cancelled through the registry — server shutdown does not set this. */
  readonly cancelled: boolean
  /** Idempotent, and safe to call from a `finally` block. */
  release(): void
}

export interface RunRegistry {
  /** Claims the thread's run slot. Returns undefined when a run is already in flight. */
  begin(threadId: string, shutdownSignal: AbortSignal): RunHandle | undefined
  /** Aborts the in-flight run. Returns false when there is nothing to cancel. */
  cancel(threadId: string, reason?: string): boolean
  has(threadId: string): boolean
}

export function createRunRegistry(): RunRegistry {
  const entries = new Map<string, AbortController>()

  return {
    begin(threadId, shutdownSignal) {
      // Synchronous check-and-set: two concurrent requests that both reach
      // this point can never both win, because nothing awaits in between.
      if (entries.has(threadId)) return undefined
      const controller = new AbortController()
      entries.set(threadId, controller)
      let released = false
      return {
        signal: AbortSignal.any([shutdownSignal, controller.signal]),
        get cancelled() {
          return controller.signal.aborted
        },
        release() {
          if (released) return
          released = true
          // Identity guard: never clear a slot a later run has claimed.
          if (entries.get(threadId) === controller) entries.delete(threadId)
        },
      }
    },
    cancel(threadId, reason = "Run cancelled") {
      const controller = entries.get(threadId)
      if (!controller) return false
      if (!controller.signal.aborted) controller.abort(new Error(reason))
      return true
    },
    has(threadId) {
      return entries.has(threadId)
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest --run test/run-registry.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/run-registry.ts packages/cli/test/run-registry.test.ts
git commit -m "feat(cli): add process-local run registry for AP cancellation"
```

---

## Task 2: Gate concurrent runs on `/runs/stream` (409)

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (registry construction ~line 314; stream handler ~lines 659-709)
- Test: `packages/cli/test/run-cancellation.test.ts` (create)

**Important:** this task needs a test fixture app with a route that blocks until released, so a run can be held in flight while a second request arrives. Copy the fixture-building approach from `packages/cli/test/runtime-fetch-parity.test.ts:100-175` (it writes a temp app dir with a route file and a probe file). Reuse its `cleanup` array pattern so temp dirs are removed in `afterEach`.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/run-cancellation.test.ts`. Build on the existing fixture helpers in `runtime-fetch-parity.test.ts` — read that file first and mirror its `createRuntimeFetchHandler` setup, temp-app scaffolding, and `waitForFile` helper.

```ts
import { afterEach, describe, expect, it } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// Use the same temp-app fixture shape as runtime-fetch-parity.test.ts.
// The route must block until a sentinel file appears so the run stays in flight.

describe("AP concurrency gate", () => {
  it("returns 409 for a second concurrent run on the same thread", async () => {
    const { handler, releaseRoute, threadId } = await setupBlockingRoute()

    const first = handler.fetch(runStreamRequest(threadId))
    await waitUntilRunStarted()

    const second = await handler.fetch(runStreamRequest(threadId))
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({
      error: expect.stringContaining("already in flight"),
    })

    await releaseRoute()
    await first
  })

  it("allows concurrent runs on different threads", async () => {
    const { handler, releaseRoute } = await setupBlockingRoute()
    const a = handler.fetch(runStreamRequest("thread-a"))
    await waitUntilRunStarted()
    const b = await handler.fetch(runStreamRequest("thread-b"))
    expect(b.status).toBe(200)
    await releaseRoute()
    await a
  })

  it("allows a new run after the previous one completes", async () => {
    const { handler, releaseRoute, threadId } = await setupBlockingRoute()
    const first = handler.fetch(runStreamRequest(threadId))
    await waitUntilRunStarted()
    await releaseRoute()
    await drain(await first)

    const second = await handler.fetch(runStreamRequest(threadId))
    expect(second.status).toBe(200)
    await drain(second)
  })

  it("does not 409 when the thread is stale-busy in SQLite but no run is in flight", async () => {
    // Simulates a process that crashed mid-run: "busy" persisted, registry empty.
    const { handler, threadsStore, threadId } = await setupBlockingRoute()
    await threadsStore.createThread({ thread_id: threadId })
    await threadsStore.updateStatus(threadId, "busy")

    const response = await handler.fetch(runStreamRequest(threadId))
    expect(response.status).not.toBe(409)
  })
})
```

Implement `setupBlockingRoute`, `runStreamRequest`, `waitUntilRunStarted`, `releaseRoute`, and `drain` as local helpers in this file, modelled on the fixture code in `runtime-fetch-parity.test.ts`. `runStreamRequest(threadId)` builds:

```ts
new Request(`http://localhost/threads/${threadId}/runs/stream`, {
  body: JSON.stringify({ input: { message: "hi" }, route: "/blocking#agent" }),
  headers: { "content-type": "application/json" },
  method: "POST",
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest --run test/run-cancellation.test.ts -t "409"
```

Expected: FAIL — the second request returns 200, not 409.

- [ ] **Step 3: Construct the registry in the route table**

In `packages/cli/src/lib/dev/runtime-fetch-handler.ts`, add the import near the other `./` imports:

```ts
import { createRunRegistry } from "./run-registry.js"
```

Immediately after the `threadRouteMap` declaration (~line 314), add:

```ts
  // Process-local in-flight run tracking: enables the concurrency gate, the
  // per-run abort signal, and POST /threads/:id/cancel. Scoped to this route
  // table (not module-level) so multiple handler instances in one process —
  // which the (Request) => Response core exists to allow — stay isolated.
  const runRegistry = createRunRegistry()
```

Thread `runRegistry` through to `handleApStreamRequest` in the `/runs/stream` route entry (~line 396), adding it alongside `threadRouteMap`:

```ts
          runRegistry,
```

Add it to the `handleApStreamRequest` options type and destructuring (~lines 580-610), typed as `RunRegistry`:

```ts
  readonly runRegistry: RunRegistry
```

with the type imported:

```ts
import { createRunRegistry, type RunRegistry } from "./run-registry.js"
```

- [ ] **Step 4: Replace the busy-marking with the gate**

Replace lines 659-660:

```ts
  // Mark thread busy
  await threadsStore.updateStatus(threadId, "busy")
```

with:

```ts
  // Claim the thread's run slot. Dawn has no run_id, so one run per thread is
  // what makes "cancel this thread's run" well-defined — and it stops two runs
  // from interleaving checkpoint writes against the same LangGraph thread.
  // Gated on the in-memory registry, never the persisted status column, so a
  // process that crashed mid-run does not brick the thread with a stale "busy".
  const run = runRegistry.begin(threadId, signal)
  if (!run) {
    return Response.json(
      createRequestErrorBody(`A run is already in flight for thread "${threadId}"`),
      { status: 409 },
    )
  }

  await threadsStore.updateStatus(threadId, "busy")
```

- [ ] **Step 5: Release the slot when the run settles**

In the same handler, change the stream's `finally` (line 699-701) from:

```ts
      } finally {
        safeClose(controller)
      }
```

to:

```ts
      } finally {
        run.release()
        safeClose(controller)
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm vitest --run test/run-cancellation.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Run the full CLI suite for regressions**

```bash
pnpm vitest --run
```

Expected: PASS. If `runtime-fetch-parity.test.ts` fails here, stop and read the failure — it should still pass at this point, because nothing about disconnect behaviour has changed yet.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/test/run-cancellation.test.ts
git commit -m "fix(cli): reject concurrent runs on one thread with 409"
```

---

## Task 3: Per-run abort signal on `/runs/stream`

Until now the run still receives the shutdown signal. This task hands it the composed signal so cancellation can actually reach the graph.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (~lines 667-709)
- Test: `packages/cli/test/run-cancellation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/run-cancellation.test.ts`. The fixture route for this test must **ignore** its `ctx.signal` and loop forever, proving `abortableAsyncIterable` (not route cooperation) is what stops it:

```ts
describe("AP per-run abort", () => {
  it("stops a route that ignores ctx.signal", async () => {
    const { handler, registryCancel, threadId } = await setupInfiniteRoute()
    const response = await handler.fetch(runStreamRequest(threadId))
    const events = readEvents(response)
    await events.waitForFirst()

    registryCancel(threadId)

    // Must terminate; without abortableAsyncIterable this hangs until timeout.
    const all = await events.rest()
    expect(all.at(-1)).toMatchObject({ event: "done" })
  }, 10_000)
})
```

Implement `setupInfiniteRoute` with a route that yields a chunk every 10ms forever and never checks `ctx.signal`. Implement `readEvents` as a small SSE line parser over `response.body`. `registryCancel` is exposed for this test by calling the cancel endpoint added in Task 5 — until then, drive it by holding a reference to the handler's registry is not possible, so **write this test to call `POST /threads/:id/cancel`** and mark it `it.skip` with a comment until Task 5 lands, then unskip in Task 5 Step 6.

- [ ] **Step 2: Run the test to verify it is skipped/failing**

```bash
pnpm vitest --run test/run-cancellation.test.ts -t "ignores ctx.signal"
```

Expected: SKIPPED (the endpoint does not exist yet).

- [ ] **Step 3: Pass the composed signal into the route**

Add the import:

```ts
import { abortableAsyncIterable } from "./abortable-iterable.js"
```

In the stream body, change the iteration (lines 672-689) from a direct `for await` over `streamResolvedRoute(...)` to a wrapped one. Replace:

```ts
          for await (const chunk of streamResolvedRoute({
            appRoot,
            checkpointer,
            input,
            memoryStore: getMemoryStore,
            ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
            permissionsStore,
            routeFile: route.routeFile,
            routeId: route.routeId,
            ...(registry.manifest ? { routeManifest: registry.manifest } : {}),
            routePath: route.routePath,
            ...(sandboxManager ? { sandboxManager } : {}),
            signal,
            threadId,
            threadsStore,
          })) {
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
          await threadsStore.updateStatus(threadId, "idle")
```

with:

```ts
          const routeStream = streamResolvedRoute({
            appRoot,
            checkpointer,
            input,
            memoryStore: getMemoryStore,
            ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
            permissionsStore,
            routeFile: route.routeFile,
            routeId: route.routeId,
            ...(registry.manifest ? { routeManifest: registry.manifest } : {}),
            routePath: route.routePath,
            ...(sandboxManager ? { sandboxManager } : {}),
            signal: run.signal,
            threadId,
            threadsStore,
          })
          // Belt-and-braces, mirroring the AG-UI handler: pass the signal to
          // the route *and* wrap the iterator, so a route that ignores its
          // ctx.signal still stops when the run is cancelled.
          for await (const chunk of abortableAsyncIterable(routeStream, run.signal)) {
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
          await threadsStore.updateStatus(threadId, "idle")
```

- [ ] **Step 4: Distinguish a cancelled run on the wire**

Replace the `catch` block (lines 691-698):

```ts
        } catch (error) {
          const errorChunk: StreamChunk = {
            output: { error: error instanceof Error ? error.message : String(error) },
            type: "done",
          }
          safeEnqueue(controller, encoder.encode(toSseEvent(errorChunk)))
          await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
        }
```

with:

```ts
        } catch (error) {
          // A cancelled run is not a failure: clients must be able to tell the
          // two apart without inferring it from a truncated stream.
          const terminalChunk: StreamChunk = run.cancelled
            ? { output: { cancelled: true }, type: "done" }
            : {
                output: { error: error instanceof Error ? error.message : String(error) },
                type: "done",
              }
          safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
          await threadsStore
            .updateStatus(threadId, run.cancelled ? "interrupted" : "idle")
            .catch(() => undefined)
        }
```

- [ ] **Step 5: Run the full suite**

```bash
pnpm vitest --run
```

Expected: PASS. `runtime-fetch-parity.test.ts:212-234` must still pass — the run still receives no abort on client disconnect, because `cancel()` on the stream remains a no-op.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-handler.ts
git commit -m "feat(cli): give AP runs a per-run abort signal"
```

---

## Task 4: Apply the same wiring to `/runs/wait` and `/resume`

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (~line 798 for wait; ~lines 975-1020 for resume)
- Test: `packages/cli/test/run-cancellation.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("AP concurrency gate — other run endpoints", () => {
  it("returns 409 on /runs/wait when a run is already in flight", async () => {
    const { handler, releaseRoute, threadId } = await setupBlockingRoute()
    const first = handler.fetch(runStreamRequest(threadId))
    await waitUntilRunStarted()

    const second = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/runs/wait`, {
        body: JSON.stringify({ input: { message: "hi" }, route: "/blocking#agent" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(second.status).toBe(409)

    await releaseRoute()
    await first
  })

  it("returns 409 on /resume when a run is already in flight", async () => {
    const { handler, releaseRoute, threadId } = await setupBlockingRoute()
    const first = handler.fetch(runStreamRequest(threadId))
    await waitUntilRunStarted()

    const second = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/resume`, {
        body: JSON.stringify({ decision: "approve" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(second.status).toBe(409)

    await releaseRoute()
    await first
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest --run test/run-cancellation.test.ts -t "other run endpoints"
```

Expected: FAIL — both return non-409.

- [ ] **Step 3: Wire `/runs/wait`**

Thread `runRegistry` into the wait handler's options exactly as Task 2 Step 3 did for the stream handler. Replace its `await threadsStore.updateStatus(threadId, "busy")` (~line 798) with:

```ts
  const run = runRegistry.begin(threadId, signal)
  if (!run) {
    return Response.json(
      createRequestErrorBody(`A run is already in flight for thread "${threadId}"`),
      { status: 409 },
    )
  }

  await threadsStore.updateStatus(threadId, "busy")
```

Pass `signal: run.signal` instead of `signal` into `invokeResolvedRoute`, and release the slot in a `finally` wrapping the invocation so it is freed on both success and failure. If the existing code has no `try/finally` around the invocation, add one:

```ts
  try {
    // ...existing invocation and response construction...
  } finally {
    run.release()
  }
```

- [ ] **Step 4: Wire `/resume`**

Apply the identical three changes to the resume handler (~lines 975-1020): the `begin`/409 gate replacing its `updateStatus(threadId, "busy")`, `signal: run.signal` plus the `abortableAsyncIterable` wrapper on its stream, `run.release()` in the stream's `finally`, and the cancelled-vs-error terminal chunk from Task 3 Step 4.

- [ ] **Step 5: Run the full suite**

```bash
pnpm vitest --run
```

Expected: PASS, including `resume-endpoint.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/test/run-cancellation.test.ts
git commit -m "feat(cli): gate and abort-wire /runs/wait and /resume"
```

---

## Task 5: `POST /threads/:thread_id/cancel`

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (route table)
- Test: `packages/cli/test/run-cancellation.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("POST /threads/:id/cancel", () => {
  it("404s for an unknown thread", async () => {
    const { handler } = await setupBlockingRoute()
    const response = await handler.fetch(cancelRequest("no-such-thread"))
    expect(response.status).toBe(404)
  })

  it("409s when the thread exists but no run is in flight", async () => {
    const { handler, threadsStore } = await setupBlockingRoute()
    await threadsStore.createThread({ thread_id: "idle-thread" })
    const response = await handler.fetch(cancelRequest("idle-thread"))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("No run in flight"),
    })
  })

  it("cancels an in-flight run and reports interrupted", async () => {
    const { handler, threadId } = await setupBlockingRoute()
    const run = handler.fetch(runStreamRequest(threadId))
    await waitUntilRunStarted()

    const response = await handler.fetch(cancelRequest(threadId))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "interrupted",
      thread_id: threadId,
    })

    await drain(await run)
  })

  it("frees the run slot so a new run is admitted after cancelling", async () => {
    const { handler, threadId } = await setupBlockingRoute()
    const run = handler.fetch(runStreamRequest(threadId))
    await waitUntilRunStarted()
    await handler.fetch(cancelRequest(threadId))
    await drain(await run)

    const next = await handler.fetch(runStreamRequest(threadId))
    expect(next.status).toBe(200)
  })
})
```

with:

```ts
const cancelRequest = (threadId: string) =>
  new Request(`http://localhost/threads/${threadId}/cancel`, { method: "POST" })
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest --run test/run-cancellation.test.ts -t "cancel"
```

Expected: FAIL — 404 for every case, since the route does not exist.

- [ ] **Step 3: Add the route**

In `buildRouteTable`, immediately after the `DELETE /threads/:thread_id` entry (~line 390), add:

```ts
    // ------------------------------------------------------------------
    // POST /threads/:thread_id/cancel — stop the in-flight run
    // ------------------------------------------------------------------
    // Thread-scoped rather than LangGraph's runs/:run_id/cancel: Dawn has no
    // run identity, and the one-run-per-thread gate makes the thread id an
    // unambiguous stand-in. Semantics match LangGraph's action=interrupt —
    // stop the run, keep checkpointed state. Rollback is not supported.
    {
      handle: async (_request, params) => {
        const threadId = params.thread_id ?? ""
        const thread = await threadsStore.getThread(threadId)
        if (!thread) {
          return Response.json(createRequestErrorBody("Thread not found"), { status: 404 })
        }
        if (!runRegistry.cancel(threadId)) {
          // Deliberately not an idempotent 200: a silent success would hide
          // the fact that this process is not the one running the thread.
          return Response.json(
            createRequestErrorBody(`No run in flight for thread "${threadId}"`),
            { status: 409 },
          )
        }
        return Response.json({ status: "interrupted", thread_id: threadId }, { status: 200 })
      },
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/cancel(?:\?.*)?$/,
    },
```

The existing `/^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/` patterns cannot swallow this path — `[^/?#]+` stops at the slash and the pattern is anchored with `$` — so ordering relative to them is not load-bearing.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest --run test/run-cancellation.test.ts -t "cancel"
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Unskip the Task 3 abort test**

Remove the `.skip` from the "stops a route that ignores ctx.signal" test and replace its `registryCancel(threadId)` call with:

```ts
    await handler.fetch(cancelRequest(threadId))
```

- [ ] **Step 6: Run the full suite**

```bash
pnpm vitest --run
```

Expected: PASS, with the previously skipped abort test now green.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/test/run-cancellation.test.ts
git commit -m "feat(cli): add POST /threads/:id/cancel"
```

---

## Task 6: Document the disconnect split

No behaviour changes here — this task replaces "we never decided" comments with "we decided, and here is why".

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (~lines 662-666, ~703-708, and the matching resume comment ~980-987)
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (above the `cancel()` at ~line 229)
- Modify: `packages/cli/test/runtime-fetch-parity.test.ts` (~line 212)

- [ ] **Step 1: Replace the AP stream comment**

Replace lines 662-666:

```ts
  // Deliberate old-behavior parity: the pre-refactor server wired NO
  // response-close abort for this endpoint (only AG-UI aborted on client
  // disconnect). A disconnect leaves the run going to completion — writes
  // simply become no-ops — and only server shutdown (`signal`) aborts it.
  // Whether AP streams *should* abort on disconnect is a follow-up question.
```

with:

```ts
  // A client disconnect deliberately does NOT stop the run.
  //
  // Agent Protocol is Dawn's durable surface: runs are checkpointed and a
  // thread can be resumed, so a dropped socket is a lost viewer, not a lost
  // intent — and a deliberate stop and a network drop are indistinguishable
  // on the wire. LangGraph Platform, the reference AP server, defaults to
  // on_disconnect: "continue" for exactly this pair of endpoints. Aborting
  // instead would discard streamed-but-not-yet-checkpointed state and leave
  // the thread behind what the user already saw (LangGraph issue #5672).
  //
  // Cancellation is therefore explicit: POST /threads/:id/cancel. AG-UI takes
  // the opposite default because it is ephemeral with nothing to reattach to.
  // Rationale: docs/superpowers/specs/2026-08-06-ap-run-cancellation.md
```

- [ ] **Step 2: Replace the stream `cancel()` comment**

Replace lines 703-708's body with:

```ts
    cancel() {
      // Intentionally empty — see the disconnect note above. Further enqueues
      // no-op via safeEnqueue, and the fetch wrapper settles the in-flight
      // slot. To actually stop the run, call POST /threads/:id/cancel.
    },
```

- [ ] **Step 3: Update the resume comment**

Apply the same replacement to the near-identical comment above the resume stream (~lines 980-987), keeping its wording about resumed runs.

- [ ] **Step 4: Add the counterpart note to AG-UI**

Above `cancel()` in `agui-handler.ts` (~line 229), extend the existing comment:

```ts
    cancel() {
      // Client disconnected — stop the run exactly as the old response-close
      // handler did. AG-UI is the ephemeral surface: there is no reattach and
      // no run to resume, so a dropped socket really does end the work. The
      // Agent Protocol endpoints deliberately take the opposite default.
      abortRequest("AG-UI response closed")
    },
```

- [ ] **Step 5: Recomment the parity test**

In `packages/cli/test/runtime-fetch-parity.test.ts`, rename the test at line 212 and add a note. Change:

```ts
  it("AP stream: client disconnect does not abort the run (old-behavior parity)", async () => {
```

to:

```ts
  // Not merely legacy parity: continuing on disconnect is the documented
  // decision for the durable AP surface. Explicit stop is POST /threads/:id/cancel.
  // See docs/superpowers/specs/2026-08-06-ap-run-cancellation.md
  it("AP stream: client disconnect does not abort the run (deliberate)", async () => {
```

- [ ] **Step 6: Run the full suite**

```bash
pnpm vitest --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/runtime-fetch-parity.test.ts
git commit -m "docs(cli): record the AP-continues/AG-UI-aborts disconnect decision"
```

---

## Task 7: User-facing docs and the replica caveat

**Files:**
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: `charts/dawn-app/README.md:78`

- [ ] **Step 1: Add the `/cancel` endpoint tab**

In `apps/web/content/docs/dev-server.mdx`, add a new `<Tab label="/cancel">` to the endpoint `Tabs` block (after the `POST /threads/:thread_id/resume` tab at ~line 165), matching the surrounding tabs' formatting:

````mdx
  <Tab label="/cancel">
    Stop the run currently in flight on a thread. Checkpointed state is kept, so the thread can be inspected or resumed afterwards; there is no rollback.

    ```http
    POST /threads/:thread_id/cancel
    ```

    | Status | Meaning |
    | --- | --- |
    | `200` | Cancelled — returns `{ "thread_id": "...", "status": "interrupted" }` |
    | `404` | No such thread |
    | `409` | The thread exists but no run is in flight |

    The cancelled run's SSE stream terminates with `event: done` and `data: {"output":{"cancelled":true}}`, which is how clients tell cancellation apart from failure.
  </Tab>
````

- [ ] **Step 2: Add a disconnect-semantics section**

After the endpoint tabs and before `## AG-UI endpoint` (~line 183), add:

```mdx
### Client disconnect

Agent Protocol runs **keep going** when the client disconnects. Runs are checkpointed and threads are resumable, so a dropped connection is treated as a lost viewer rather than a lost intent — and on the wire a deliberate stop is indistinguishable from a flaky network. This matches LangGraph Platform, which defaults to `on_disconnect: "continue"` for the same endpoints.

To actually stop a run, call `POST /threads/:thread_id/cancel`.

The AG-UI endpoint takes the opposite default and aborts on disconnect, because it is an ephemeral surface with no reattach and nothing to resume.

One run at a time per thread: starting a second run on a thread that is already running returns `409`. Cancellation is tracked in memory by the process serving the request, so both the gate and `/cancel` assume a single replica — see the deployment notes before scaling out.
```

- [ ] **Step 3: Add the chart caveat**

In `charts/dawn-app/README.md`, replace the `replicaCount` row at line 78:

```md
| `replicaCount` | `1` | Ignored (omitted) when `autoscaling.enabled=true`. |
```

with:

```md
| `replicaCount` | `1` | Ignored (omitted) when `autoscaling.enabled=true`. **Keep at 1** — see below. |
```

and add immediately after that table:

```md
> **Single replica only.** Dawn's Agent Protocol surface keeps per-thread state on the pod's
> local filesystem — the threads database and LangGraph checkpoints both live under
> `<appRoot>/.dawn/`, and in-flight run tracking (the one-run-per-thread gate and
> `POST /threads/:id/cancel`) is in-memory and process-local. With more than one replica,
> threads diverge across pods and a cancel request only lands on the right pod by chance.
> `autoscaling.maxReplicas` is therefore effectively capped at 1 until a shared threads and
> checkpoint backend ships.
```

- [ ] **Step 4: Verify the docs build**

```bash
pnpm --filter @dawn-ai/web build
```

Expected: builds clean. If `check-docs.mjs` runs in this repo's validate step, also run:

```bash
node scripts/check-docs.mjs
```

Expected: no stale-reference or nav errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/content/docs/dev-server.mdx charts/dawn-app/README.md
git commit -m "docs: document /cancel, disconnect semantics, and the single-replica constraint"
```

---

## Task 8: Changeset and full validation

**Files:**
- Create: `.changeset/ap-run-cancellation.md`

- [ ] **Step 1: Write the changeset**

The 409 is a behaviour change and must be called out. Create `.changeset/ap-run-cancellation.md`:

```md
---
"@dawn-ai/cli": patch
---

Add `POST /threads/:thread_id/cancel` to stop an in-flight Agent Protocol run, and enforce one run per thread.

Runs previously had no way to be stopped short of killing the process — the only `AbortSignal` reaching a route was the server shutdown signal. Cancellation keeps checkpointed state (LangGraph's `action=interrupt` semantics); a cancelled run's SSE stream ends with `done` carrying `{"cancelled":true}`, distinguishing it from a failure.

**Behaviour change:** a second concurrent run on a thread that is already running now returns `409` instead of being admitted. Concurrent runs previously interleaved checkpoint writes against the same LangGraph thread last-writer-wins, silently corrupting thread state, so this converts data loss into a clear error. The gate is keyed on in-memory state, not the persisted thread status, so a process that crashes mid-run does not leave the thread permanently unusable.

Client-disconnect behaviour is unchanged and now documented: Agent Protocol runs continue (matching LangGraph Platform's `on_disconnect: "continue"` default for a durable, resumable surface), while AG-UI keeps aborting because it is ephemeral. Run tracking is process-local, so these features assume a single replica — a constraint that already applied to Dawn's pod-local threads database and checkpoints, and is now documented in the chart README.
```

- [ ] **Step 2: Run the full validation pipeline**

```bash
pnpm ci:validate
```

Expected: PASS. This is the same gate the Release workflow runs; do not skip it.

- [ ] **Step 3: Commit**

```bash
git add .changeset/ap-run-cancellation.md
git commit -m "chore: changeset for AP run cancellation"
```

---

## Manual verification

Automated tests do not prove the endpoint behaves under a real server and a real model. After Task 8, verify by hand:

- [ ] Start the research example: `pnpm --filter @dawn-ai/example-research dev`
- [ ] Start a long run via `POST /threads/$T/runs/stream` with `curl -N` and watch events arrive
- [ ] From a second terminal, `curl -X POST http://127.0.0.1:3001/threads/$T/cancel` — expect `200` and `{"status":"interrupted"}`
- [ ] Confirm the `curl -N` stream terminates promptly with `event: done` / `{"output":{"cancelled":true}}`
- [ ] `curl http://127.0.0.1:3001/threads/$T` — expect `"status": "interrupted"`
- [ ] Start a new run on the same thread — expect `200`, proving the slot was freed
- [ ] While that run is live, start another on the same thread — expect `409`
- [ ] Cancel a thread with no run in flight — expect `409`
- [ ] Kill the server mid-run, restart it, and start a run on that same thread — expect `200`, **not** `409` (the stale-busy self-heal)

---

## Self-review notes

Checked against the spec:

- Registry (spec §1) → Task 1; scoped in the closure per Task 2 Step 3.
- Concurrency gate on the registry rather than the DB (spec §2) → Task 2, with the stale-busy case tested explicitly in Task 2 Step 1 and again by hand.
- Cancel endpoint with 404/409/200 (spec §3) → Task 5; `"interrupted"` written in Task 3 Step 4; `abortableAsyncIterable` enforcement in Task 3 Step 3; wire-distinguishable terminal event in Task 3 Step 4 and documented in Task 7 Step 1.
- Documented split (spec §4) → Task 6 (code) and Task 7 Step 2 (docs).
- Single-replica constraint (spec, Known constraint) → Task 7 Step 3.
- Non-goals (`on_disconnect`, `run_id`, cross-replica, keepalives) → no tasks, as intended.
- Test-strategy pins → `runtime-fetch-parity.test.ts` in Task 6 Step 5; `resume-endpoint.test.ts` exercised in Task 4 Step 5; `agui-endpoint.test.ts` guarded by the full-suite runs.

Naming is consistent across tasks: `createRunRegistry`, `RunRegistry`, `RunHandle`, `begin`/`cancel`/`has`, `run.signal`, `run.cancelled`, `run.release()`.
