# AG-UI Canonical Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Dawn's legacy AG-UI translator API and make `toAguiEvents` / `fromRunAgentInput` the only mapping layer used by library consumers, `dawn dev`, and `dawn start`.

**Architecture:** `@dawn-ai/ag-ui` owns protocol translation and exposes optional SSE encoding through `@dawn-ai/ag-ui/sse`; it has no CLI, LangGraph, or server dependency. `@dawn-ai/cli` owns checkpoint-aware message selection, exact-set interrupt resume validation, middleware, cancellation, and flat-stream normalization. The shared runtime handler serves development and production.

**Tech Stack:** TypeScript 6 ESM/NodeNext, `@ag-ui/core@0.0.57`, `@ag-ui/encoder@0.0.57`, LangGraph 1.4.7, Node HTTP, SQLite checkpointer, Vitest 4, Biome, pnpm, Turbo.

**Spec:** `docs/superpowers/specs/2026-07-10-ag-ui-canonical-adapter-design.md`

**Branch/worktree:** `blove/ag-ui-adapter` at `/Users/blove/repos/dawn/.claude/worktrees/wonderful-tu-a40261`

---

## Locked Decisions

- No backward compatibility. Delete `createAgUiTranslator`, `mapRunInput`, their types, the root SSE export, legacy tests, `CUSTOM on_interrupt`, capability `STATE_SNAPSHOT`, and `forwardedProps.command.resume`. Add no aliases, warnings, flags, or dual modes.
- Root `@dawn-ai/ag-ui` is transport-agnostic. SSE is only `@dawn-ai/ag-ui/sse`.
- Standard `RunAgentInput.resume` is the only AG-UI resume path.
- All open checkpoint interrupts must be addressed together through LangGraph's interrupt-namespace-keyed resume map. New turns are rejected while interrupts remain pending.
- `done.data` is a successful `RUN_FINISHED.result`; only thrown failures become `RUN_ERROR`.
- Unknown capability chunks are ignored and only act as text framing boundaries.
- Middleware runs before thread/checkpoint mutation under both `dawn dev` and `dawn start`.
- Commit after every task. Do not push or open a PR.

## File Structure

- `packages/ag-ui/src/types.ts`: canonical structural stream union and internal guards.
- `packages/ag-ui/src/outbound.ts`: only outbound state machine.
- `packages/ag-ui/src/inbound.ts`: only inbound projection.
- `packages/ag-ui/src/sse.ts`: optional transport subpath.
- `packages/ag-ui/src/index.ts`: exact pure root API.
- `packages/cli/src/lib/dev/pending-interrupts.ts`: checkpoint parsing and exact resume-set resolution.
- `packages/cli/src/lib/dev/request-context.ts`: shared middleware request projection.
- `packages/cli/src/lib/dev/agui-handler.ts`: HTTP orchestration only.
- `packages/cli/src/lib/runtime/execute-route.ts`: thrown preparation failures and scalar/task-map resume support.

---

### Task 1: Complete the Canonical Outbound State Machine

**Files:**
- Modify: `packages/ag-ui/src/types.ts`
- Modify: `packages/ag-ui/src/outbound.ts`
- Modify: `packages/ag-ui/src/interrupts.ts`
- Modify: `packages/ag-ui/test/types.test.ts`
- Modify: `packages/ag-ui/test/outbound.test.ts`
- Modify: `packages/ag-ui/test/interrupts.test.ts`

- [ ] **Step 1: Write failing result and interrupt tests**

Replace `RawChunk` test references with `DawnAgentStreamChunk`. Add:

```ts
test("preserves done data as the successful result", async () => {
  const result = { final: true }
  expect((await collect([{ type: "done", data: result }])).at(-1)).toEqual({
    type: EventType.RUN_FINISHED,
    threadId: "th-1",
    runId: "rn-1",
    result,
    outcome: { type: "success" },
  })
})

test("collects consecutive interrupts", async () => {
  const events = await collect([
    { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
    { type: "interrupt", data: { interruptId: "perm-2", kind: "path" } },
    { type: "done", data: {} },
  ])
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({
    outcome: { type: "interrupt", interrupts: [{ id: "perm-1" }, { id: "perm-2" }] },
  })
})

test("rejects an unaddressable interrupt", async () => {
  expect((await collect([{ type: "interrupt", data: { kind: "command" } }])).at(-1)).toEqual({
    type: EventType.RUN_ERROR,
    message: "Malformed Dawn interrupt: missing interruptId",
  })
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @dawn-ai/ag-ui test -- outbound.test.ts types.test.ts interrupts.test.ts
```

Expected: failures because interrupts terminate immediately, results are discarded, and the canonical type is missing.

- [ ] **Step 3: Define the structural stream type**

Keep translator-only types temporarily so `translate.ts` remains buildable. Add the canonical type alongside them; Task 6 removes the legacy types and modules atomically with the CLI cutover:

```ts
export type DawnAgentStreamChunk =
  | { readonly type: "token"; readonly data: string }
  | { readonly type: "tool_call"; readonly data: DawnToolCallData }
  | { readonly type: "tool_result"; readonly data: DawnToolResultData }
  | { readonly type: "interrupt"; readonly data: unknown }
  | { readonly type: "done"; readonly data?: unknown }
  | { readonly type: string; readonly data?: unknown }
```

- [ ] **Step 4: Implement terminal state handling**

Change `toAguiEvents` to accept `AsyncIterable<DawnAgentStreamChunk>`. Accumulate validated interrupts until `done`/natural end, then emit one interrupt outcome. If a malformed interrupt lacks a non-empty ID, emit `RUN_ERROR` and return. On successful `done`, include `result` iff `data !== undefined`. Never infer failure from `{ error: ... }`.

- [ ] **Step 5: Run GREEN**

```bash
corepack pnpm --filter @dawn-ai/ag-ui test -- outbound.test.ts types.test.ts interrupts.test.ts
corepack pnpm --filter @dawn-ai/ag-ui typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/src packages/ag-ui/test/outbound.test.ts packages/ag-ui/test/types.test.ts packages/ag-ui/test/interrupts.test.ts
git commit -m "feat(ag-ui): complete canonical outbound mapping"
```

---

### Task 2: Add the SSE Subpath and Canonical Conformance Path

**Files:**
- Create: `packages/ag-ui/src/sse.ts`
- Create: `packages/ag-ui/test/sse.test.ts`
- Modify: `packages/ag-ui/package.json`
- Modify: `packages/ag-ui/test/conformance.test.ts`

- [ ] **Step 1: Write the failing SSE module test**

```ts
import { EventType } from "@ag-ui/core"
import { expect, test } from "vitest"
import { encodeAgUiSse } from "../src/sse.js"

test("encodes events from the focused SSE module", () => {
  expect(encodeAgUiSse({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }))
    .toContain('"type":"RUN_STARTED"')
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @dawn-ai/ag-ui test -- sse.test.ts
```

- [ ] **Step 3: Create the subpath without cutting over consumers**

Copy the focused encoder implementation into `sse.ts`. Add package export `./sse` -> `dist/sse.js` / `dist/sse.d.ts`. Keep `encode.ts`, its root export, translator modules, and legacy tests until Task 6 so the CLI remains buildable. This is temporary task sequencing, not a final compatibility surface.

- [ ] **Step 4: Rewire conformance**

Use `toAguiEvents` plus `encodeAgUiSse` from `src/sse.ts` in the canned HTTP server. Convert fixture chunks to nested `data`. Keep `@ag-ui/client` `verifyEvents(false)`. Remove `STATE_SNAPSHOT`/`CUSTOM` expectations and assert those event types are absent.

- [ ] **Step 5: Run GREEN**

```bash
corepack pnpm --filter @dawn-ai/ag-ui build
corepack pnpm --filter @dawn-ai/ag-ui typecheck
corepack pnpm --filter @dawn-ai/ag-ui lint
corepack pnpm --filter @dawn-ai/ag-ui test
```

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui
git commit -m "feat(ag-ui): add focused SSE encoder subpath"
```

---

### Task 3: Extract Checkpoint Interrupt Resolution

**Files:**
- Create: `packages/cli/src/lib/dev/pending-interrupts.ts`
- Create: `packages/cli/test/pending-interrupts.test.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/test/resume-endpoint.test.ts`

- [ ] **Step 1: Write failing table-driven tests**

Cover no pending/no resume -> turn; pending/no resume -> 409; no pending/resume -> 409; resolved -> decision; cancelled -> deny; two entries -> two outer resume keys; missing/unknown/duplicate IDs -> 409; invalid resolved payload -> 400; and malformed or duplicate checkpoint addresses -> 409.

```ts
expect(resolveAgUiResume([
  { interruptId: "perm-1", status: "resolved", payload: "once" },
  { interruptId: "perm-2", status: "cancelled" },
], {
  interrupts: [
    {
      interruptId: "perm-1",
      resumeKey: "11111111111111111111111111111111",
      aliases: ["perm-1", "11111111111111111111111111111111"],
    },
    {
      interruptId: "perm-2",
      resumeKey: "22222222222222222222222222222222",
      aliases: ["perm-2", "22222222222222222222222222222222"],
    },
  ],
  malformed: false,
})).toEqual({
  ok: true,
  mode: "resume",
  resume: {
    "11111111111111111111111111111111": "once",
    "22222222222222222222222222222222": "deny",
  },
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @dawn-ai/cli test -- pending-interrupts.test.ts
```

- [ ] **Step 3: Implement the helper**

```ts
export type PermissionDecision = "once" | "always" | "deny"
export interface PendingInterrupt {
  readonly interruptId: string
  readonly resumeKey: string | null
  readonly aliases: readonly string[]
}
export interface PendingInterruptSnapshot {
  readonly interrupts: readonly PendingInterrupt[]
  readonly malformed: boolean
}
export async function readPendingInterrupts(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<PendingInterruptSnapshot | null>
export function resolveAgUiResume(
  resume: readonly DawnResumeRequest[] | undefined,
  pending: PendingInterruptSnapshot,
): ResumeResolution
```

Read every `__interrupt__` pending write. Use inner `value.value.interruptId` as the client-facing ID with outer `value.id` as fallback, retain both as AP aliases, and use outer `value.id` as the AG-UI resume key only when it is 32 lowercase hexadecimal characters. Tuple element 0 is a hyphenated task UUID, not the resume-map key. Mark malformed or duplicate checkpoint addresses and reject them with a structured 409; never accept resume keys from HTTP input. Return exact 400/409 result objects rather than throwing protocol errors.

- [ ] **Step 4: Reuse it in AP resume**

Replace the inline checkpoint scan in `runtime-server.ts`; preserve AP status behavior and scalar decision semantics.

- [ ] **Step 5: Run GREEN**

```bash
corepack pnpm --filter @dawn-ai/cli test -- pending-interrupts.test.ts resume-endpoint.test.ts
corepack pnpm --filter @dawn-ai/cli typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/pending-interrupts.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/test/pending-interrupts.test.ts packages/cli/test/resume-endpoint.test.ts
git commit -m "refactor(cli): centralize pending interrupt resolution"
```

---

### Task 4: Make Route Streaming Preserve Failures and Resume Maps

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/test/run-command.test.ts`
- Modify: `packages/cli/test/stream-types.test.ts`
- Verify: `packages/langchain/test/agent-adapter-toolcall-id.test.ts`

- [ ] **Step 1: Write a failing preparation-error stream test**

Use an invalid route file/options and consume `streamResolvedRoute`:

```ts
await expect(async () => {
  for await (const _chunk of streamResolvedRoute(invalidOptions)) {
    // consume
  }
}).rejects.toThrow(/route|load|resolve/i)
```

Add an internal-module test for a focused `toAgentInput(input, resume?)` helper. Pass a two-task map and assert the returned value is a LangGraph `Command` whose `.resume` is that exact map. Retain tool-ID assertions for flat call/result chunks.

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @dawn-ai/cli test -- run-command.test.ts stream-types.test.ts
```

Expected: preparation currently yields a successful `done`; resume accepts only a scalar.

- [ ] **Step 3: Implement the stream contract**

Define:

```ts
export type RouteResumePayload =
  | "once"
  | "always"
  | "deny"
  | Readonly<Record<string, "once" | "always" | "deny">>
```

Temporarily broaden the existing internal `resumeDecision` option to `RouteResumePayload`. Extract `toAgentInput(input, resumeDecision)` in `execute-route.ts`; it returns `new Command({ resume })` when provided and the original input otherwise. This keeps the legacy handler buildable and gives the task-map behavior a direct test. Task 6 atomically renames the option to `resume` with the handler cutover. Throw `new Error(prepared.message)` on preparation failure. Do not inspect successful results for an `error` key. Preserve optional tool IDs through the existing langchain -> flat CLI path.

- [ ] **Step 4: Run GREEN**

```bash
corepack pnpm --filter @dawn-ai/cli test -- run-command.test.ts stream-types.test.ts resume-endpoint.test.ts
corepack pnpm --filter @dawn-ai/langchain test -- agent-adapter-toolcall-id.test.ts
corepack pnpm --filter @dawn-ai/cli typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/test/run-command.test.ts packages/cli/test/stream-types.test.ts
git commit -m "fix(cli): support addressed resume maps in route streams"
```

---

### Task 5: Extract Shared Middleware Request Projection

**Files:**
- Create: `packages/cli/src/lib/dev/request-context.ts`
- Create: `packages/cli/test/request-context.test.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`

- [ ] **Step 1: Write failing extraction tests**

Cover string/array headers, omitted undefined headers, and route params:

```ts
expect(extractRouteParams("/users/[userId]", { userId: 42 })).toEqual({ userId: "42" })
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @dawn-ai/cli test -- request-context.test.ts
```

- [ ] **Step 3: Move, do not duplicate, helpers**

Move `parseHeaders` and `extractRouteParams` unchanged from `runtime-server.ts` into the new module. Import them back into `runtime-server.ts`. Do not export them from the CLI package.

- [ ] **Step 4: Verify AP behavior**

```bash
corepack pnpm --filter @dawn-ai/cli test -- request-context.test.ts middleware.test.ts runtime-request-listener.test.ts
corepack pnpm --filter @dawn-ai/cli typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/request-context.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/test/request-context.test.ts
git commit -m "refactor(cli): share middleware request projection"
```

---

### Task 6: Rewrite the AG-UI Handler Around the Canonical Adapter

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `packages/cli/test/agui-endpoint.test.ts`
- Modify: `packages/ag-ui/src/index.ts`
- Modify: `packages/ag-ui/src/types.ts`
- Create: `packages/ag-ui/test/public-api.test.ts`
- Delete: `packages/ag-ui/src/encode.ts`
- Delete: `packages/ag-ui/src/translate.ts`
- Delete: `packages/ag-ui/src/run-input.ts`
- Delete: `packages/ag-ui/test/translate-text-tools.test.ts`
- Delete: `packages/ag-ui/test/translate-capabilities.test.ts`
- Delete: `packages/ag-ui/test/run-input.test.ts`

- [ ] **Step 1: Expand endpoint tests for the canonical contract**

Parse SSE `data:` frames as JSON. Assert lifecycle ordering, successful `result`, absence of `STATE_SNAPSHOT`/`CUSTOM`, and only the latest user message on a second request using the same thread. Add an assertion that tool IDs reach AG-UI unchanged when a fixture produces tool events. Add `public-api.test.ts` asserting the root runtime keys are exactly the two mappers and two ID factories, with no translator, run-input, or SSE function.

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @dawn-ai/ag-ui build
corepack pnpm --filter @dawn-ai/cli test -- agui-endpoint.test.ts
```

Expected: endpoint still emits legacy events and the root public-API assertion fails.

- [ ] **Step 3: Add the internal flat-to-canonical generator**

```ts
async function* normalizeDawnStream(
  chunks: AsyncIterable<StreamChunk>,
): AsyncGenerator<DawnAgentStreamChunk> {
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case "chunk":
        yield { type: "token", data: typeof chunk.data === "string" ? chunk.data : String(chunk.data ?? "") }
        break
      case "tool_call":
        yield { type: "tool_call", data: { ...(chunk.id ? { id: chunk.id } : {}), name: chunk.name, input: chunk.input } }
        break
      case "tool_result":
        yield { type: "tool_result", data: { ...(chunk.id ? { id: chunk.id } : {}), name: chunk.name, output: chunk.output } }
        break
      case "done":
        yield { type: "done", data: chunk.output }
        break
      default:
        yield { type: chunk.type, data: chunk.data }
    }
  }
}
```

- [ ] **Step 4: Implement canonical input/resume policy**

Pass `checkpointer` and `middleware` from the route table. Validate `RunAgentInputSchema`, resolve the route, and call `fromRunAgentInput`. Construct and run middleware immediately after that pure projection and before `readPendingInterrupts`, resume validation, thread reads/writes, or status changes. Only after middleware allows the request, select the newest user message, read pending interrupts, and call `resolveAgUiResume`. Return its 400/409 response before thread mutation. Never inspect `forwardedProps`.

- [ ] **Step 5: Implement middleware and event iteration**

Return middleware rejection unchanged and pass allowed context as `middlewareContext`. Rename `streamResolvedRoute`'s broadened option from `resumeDecision` to `resume` and update AP and AG-UI callers in this same commit. Then create/update the thread, persist route metadata, mark busy, and iterate:

```ts
for await (const event of toAguiEvents(normalizeDawnStream(streamResolvedRoute(routeOptions)), {
  threadId,
  runId: input.runId,
})) {
  response.write(encodeAgUiSse(event, request.headers.accept))
}
```

Import SSE from `@dawn-ai/ag-ui/sse`. Restore idle in `finally`. The adapter emits `RUN_ERROR`; do not emit a duplicate handler error.

- [ ] **Step 6: Delete the superseded package surface**

Now that the CLI imports only canonical functions, delete `translate.ts`, `run-input.ts`, `encode.ts`, and their legacy tests. Make root `index.ts` export exactly the approved canonical functions/types; remove translator-only types from `types.ts`. Add no aliases or deprecated wrappers.

- [ ] **Step 7: Run GREEN**

```bash
corepack pnpm --filter @dawn-ai/ag-ui build
corepack pnpm --filter @dawn-ai/ag-ui typecheck
corepack pnpm --filter @dawn-ai/ag-ui test
corepack pnpm --filter @dawn-ai/cli test -- agui-endpoint.test.ts middleware.test.ts
corepack pnpm --filter @dawn-ai/cli typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/ag-ui packages/cli/src/lib/dev/agui-handler.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/test/agui-endpoint.test.ts
git commit -m "refactor(cli): route AG-UI through canonical adapter"
```

---

### Task 7: Verify Middleware, Resume, and Cancellation End to End

**Files:**
- Create: `packages/cli/src/lib/dev/abortable-iterable.ts`
- Create: `packages/cli/test/abortable-iterable.test.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Modify: `packages/cli/test/agui-endpoint.test.ts`
- Modify: `packages/cli/test/serve-runtime.test.ts`

- [ ] **Step 1: Add failing middleware tests**

Fixture middleware rejects without `x-api-key` and allows with context `{ tenant: "acme" }`. Assert rejection occurs before thread creation. For allowed requests, return `ctx.middleware` from a route and assert it appears in `RUN_FINISHED.result`.

- [ ] **Step 2: Add failing resume tests**

Make `AgUiRequestOptions` accept an optional CLI-internal `streamRoute` dependency whose type is `typeof streamResolvedRoute`, defaulting to the real function. The runtime route table never overrides it. In tests, run `handleAgUiRequest` behind a small Node server with: (a) a synthetic checkpointer returning captured-shape `__interrupt__` pending-write tuples whose first elements are hyphenated task UUIDs and whose outer `value.id` fields are 32-hex interrupt namespace/resume keys, and (b) an injected stream function that records its `resume` option and yields `{ type: "done", output: { resumed: true } }`.

Assert no resume while pending -> 409; incomplete/unknown/duplicate set -> 409; malformed checkpoint addresses -> 409; invalid resolved payload -> 400; resume with no pending interrupts -> 409. For one and two valid entries, assert HTTP success **and** that the captured `resume` is the exact outer interrupt-namespace-keyed map, never a tuple task-UUID-keyed map. Task 4 separately proves that `streamResolvedRoute` turns this option into `Command.resume`, so the two tests cover the complete boundary without a model call. Do not add a `forwardedProps` test.

- [ ] **Step 3: Add a failing disconnect test**

First unit-test `abortableAsyncIterable`: abort while `next()` is pending, expect rejection, and assert the source iterator's `return()`/`finally` ran. Then use a slow chain fixture, abort fetch after streaming begins, poll `GET /threads/:id` until `idle`, and assert the route observed the abort.

- [ ] **Step 4: Run RED**

```bash
corepack pnpm --filter @dawn-ai/cli test -- agui-endpoint.test.ts serve-runtime.test.ts
```

- [ ] **Step 5: Wire request-scoped cancellation**

Implement `abortableAsyncIterable(source, signal)` with an explicit iterator, race each `next()` against an abort promise, and call/await `iterator.return?.()` in `finally`. In the handler, abort on `request.aborted` or premature `response.close`, combine with shutdown using `AbortSignal.any`, wrap the route stream with `abortableAsyncIterable`, remove listeners in `finally`, and pass the combined signal to route execution. Do not abort after normal response completion.

- [ ] **Step 6: Prove production assembly parity**

Boot `serveRuntime({ host: "127.0.0.1", port: 0 })`, POST to `/agui/%2Fchat%23agent`, and assert canonical events. No Docker build is needed because generated production entrypoints call the same `serveRuntime`.

- [ ] **Step 7: Run GREEN**

```bash
corepack pnpm --filter @dawn-ai/cli test -- abortable-iterable.test.ts agui-endpoint.test.ts serve-runtime.test.ts resume-endpoint.test.ts
corepack pnpm --filter @dawn-ai/cli typecheck
corepack pnpm --filter @dawn-ai/cli lint
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/abortable-iterable.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/abortable-iterable.test.ts packages/cli/test/agui-endpoint.test.ts packages/cli/test/serve-runtime.test.ts
git commit -m "fix(cli): enforce AG-UI runtime boundaries"
```

---

### Task 8: Remove Legacy Documentation and Example UI

**Files:**
- Modify: `packages/ag-ui/README.md`
- Modify: `packages/cli/docs/dev-server.md`
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/content/docs/deployment.mdx`
- Modify: `packages/cli/docs/faq.md`
- Modify: `apps/web/content/docs/faq.mdx`
- Modify: `examples/chat/web/README.md`
- Modify: `examples/chat/web/app/api/copilotkit/route.ts`
- Modify: `examples/chat/web/app/page.tsx`
- Modify: `packages/cli/test/docs-bundle.test.ts`
- Delete: `examples/chat/web/app/components/PermissionInterrupt.tsx`
- Delete: `examples/chat/web/app/components/TodosPanel.tsx`

- [ ] **Step 1: Add failing stale-reference checks**

Extend the docs test to scan current docs/examples, excluding changelogs and `docs/superpowers`, and reject:

```ts
const removed = [
  "createAgUiTranslator",
  "mapRunInput",
  'CUSTOM{name:"on_interrupt"}',
  "forwardedProps.command.resume",
  "STATE_SNAPSHOT",
  "dawn.subagent",
  "useInterrupt",
  "PermissionInterrupt",
  "TodosPanel",
]
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @dawn-ai/cli test -- docs-bundle.test.ts
```

- [ ] **Step 3: Rewrite current documentation**

Document root `toAguiEvents` / `fromRunAgentInput`, `@dawn-ai/ag-ui/sse`, standard interrupt outcomes, exact `RunAgentInput.resume`, middleware parity, and both runtime commands. State that v1 ignores planning/subagent capability events. Remove legacy `useInterrupt` comments from the CopilotKit route as well as the removed components/page imports.

Delete the legacy interrupt and todos panels and remove them from `page.tsx`. Keep the basic CopilotKit `HttpAgent` chat. Do not add compatibility UI.

- [ ] **Step 4: Regenerate API docs and verify**

```bash
corepack pnpm --filter @dawn-ai/cli build
corepack pnpm --filter @dawn-ai/cli test -- docs-bundle.test.ts
corepack pnpm --filter @dawn-example/chat-web build
rg -n "createAgUiTranslator|mapRunInput|on_interrupt|forwardedProps\.command\.resume|STATE_SNAPSHOT|dawn\.subagent|useInterrupt|PermissionInterrupt|TodosPanel" packages/ag-ui/README.md packages/cli/docs apps/web/content/docs examples/chat/web
```

Expected: commands pass and `rg` prints no matches.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/README.md packages/cli/docs apps/web/content/docs examples/chat/web packages/cli/test/docs-bundle.test.ts
git commit -m "docs(ag-ui): document canonical adapter API"
```

---

### Task 9: Verify Packed and Published API Surfaces

**Files:**
- Modify: `scripts/lib/pack-check.mjs`
- Modify: `scripts/pack-check.test.mjs`
- Modify: `scripts/lib/published-artifacts.mjs`
- Modify: `scripts/published-artifact-smoke.mjs`
- Modify: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Write failing package-set tests**

```js
assert.deepEqual(packageSets["ag-ui"], ["@dawn-ai/ag-ui"])
assert.deepEqual(expectedFilesForPackage("@dawn-ai/ag-ui"), [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/sse.js",
  "dist/sse.d.ts",
  "README.md",
  "package.json",
])
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm test:published-artifacts
```

- [ ] **Step 3: Extend the new all-public-package pack manifest**

`origin/main` already lists every public package in `scripts/lib/pack-check.mjs`. Update the existing `packages/ag-ui` entry to include `dist/sse.js` and `dist/sse.d.ts`. Add a focused assertion in `scripts/pack-check.test.mjs` that AG-UI expects both files and requires `exports`/`types`. In the pack runner, validate that `exports["./sse"]` targets files present in the extracted tarball; implement this as a generic export-target check rather than an AG-UI-only branch.

- [ ] **Step 4: Add release-time installed probes**

Add the `ag-ui` set and file expectations. When selected, `published-artifact-smoke.mjs` must:

1. run an ESM script importing root and `@dawn-ai/ag-ui/sse`;
2. assert canonical functions exist and removed functions do not;
3. encode a `RUN_STARTED` event;
4. install `typescript@6.0.2` in the temporary consumer;
5. compile a small consumer with `module` and `moduleResolution` `NodeNext`, importing root types and SSE.

Unit-test generated probe sources/commands. The registry smoke itself is release-time only.

- [ ] **Step 5: Run GREEN**

```bash
corepack pnpm test:published-artifacts
corepack pnpm test:pack-check
corepack pnpm pack:check
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/pack-check.mjs scripts/pack-check.mjs scripts/pack-check.test.mjs scripts/lib/published-artifacts.mjs scripts/published-artifact-smoke.mjs scripts/published-artifacts.test.mjs
git commit -m "test(ag-ui): verify published adapter entrypoints"
```

---

### Task 10: Changeset, Full Verification, and Manual Smoke

**Files:**
- Modify: `.changeset/ag-ui-adapter.md`
- Modify only if exact-shape assertions require it: existing CLI/langchain tests

- [ ] **Step 1: Rewrite the changeset**

Keep patch bumps for `@dawn-ai/ag-ui`, `@dawn-ai/cli`, and `@dawn-ai/langchain`. Describe consolidation of the existing package, standard interrupts/resume, middleware parity, SSE subpath, tool IDs, and the `dawn run` thread fix. Remove language claiming the package is newly created or unused by a runtime endpoint.

- [ ] **Step 2: Run package verification**

```bash
corepack pnpm --filter @dawn-ai/ag-ui build
corepack pnpm --filter @dawn-ai/ag-ui typecheck
corepack pnpm --filter @dawn-ai/ag-ui lint
corepack pnpm --filter @dawn-ai/ag-ui test
corepack pnpm --filter @dawn-ai/langchain build
corepack pnpm --filter @dawn-ai/langchain typecheck
corepack pnpm --filter @dawn-ai/langchain test
corepack pnpm --filter @dawn-ai/cli build
corepack pnpm --filter @dawn-ai/cli typecheck
corepack pnpm --filter @dawn-ai/cli lint
corepack pnpm --filter @dawn-ai/cli test
```

Expected: every command exits 0. Pre-existing CLI lint warnings may print but must not become errors.

- [ ] **Step 3: Run artifact/workspace verification**

```bash
corepack pnpm test:published-artifacts
corepack pnpm test:pack-check
corepack pnpm pack:check
corepack pnpm -w build
corepack pnpm changeset status --since=origin/main
git diff --check origin/main...HEAD
```

Expected: all pass and changesets report patch-only bumps.

- [ ] **Step 4: Run manual smoke in `~/tmp/dawn-app`**

Use the same local workspace package linking/install method already used on this branch. Verify `dawn run /chat#agent` succeeds, then start `dawn dev --port 3001`. POST a standard `RunAgentInput` to `/agui/%2Fchat%23agent`; verify canonical events and no custom/state events. Exercise standard `resume` if the app has a permission-gated tool. Stop dev, run `dawn start --host 127.0.0.1 --port 3002`, and repeat one AG-UI request. Stop every server before continuing.

- [ ] **Step 5: Commit**

```bash
git add .changeset/ag-ui-adapter.md
git commit -m "chore(ag-ui): finalize canonical adapter release"
```

- [ ] **Step 6: Final audit**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: clean branch, no push, no PR.
