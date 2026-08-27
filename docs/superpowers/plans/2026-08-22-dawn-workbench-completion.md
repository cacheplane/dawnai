# Dawn Workbench Completion Implementation Plan (SP2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Dawn Workbench — one allowlisted server proxy, thread hydration from `GET /threads/:id/state`, a permission prompt that survives a reload, a connect screen, a themed tool card, and the memory panel back on screen.

**Architecture:** Every server read goes through one same-origin allowlisted proxy whose decision is a pure function. Hydration is a pure mapper from the checkpoint payload to the transcript item types SP2a already defines. The permission prompt splits into a presentational card plus two sources — CopilotKit's live `useInterrupt` and a hydrated fetch — because the live hook cannot be fed from outside.

**Tech Stack:** Next 16 App Router, React 19, Tailwind v4, `@copilotkit/react-core/v2`, `@dawn-ai/ag-ui`, Vitest (node by default, jsdom per-file), Node 24, pnpm 10, Biome.

**Approved spec:** `docs/superpowers/specs/2026-08-19-dawn-workbench-design.md` (SP2 of 4). SP2a shipped in PR #487.

**Execution baseline:** Branch `blove/dawn-workbench-sp2b` (already created) off `main` at `239cf18d`.

**Toolchain trap:** Prefix every node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && ` — shell state does not persist and the default shell is Node 22. Never run bare `biome check --write`; pass explicit paths with `--config-path packages/config-biome/biome.json`. The example's own lint script also passes `--css-parse-tailwind-directives=true`; a bare `biome check` over `app/` reports `@theme`/`@utility` in `theme.css` as phantom parse errors.

---

## Research findings that shape this plan

All of the following were verified against real source and, where noted, against a real response body reproduced from `examples/research/server/.dawn/checkpoints.sqlite`. **Do not re-derive these; do check them if something contradicts you.**

### `GET /threads/:id/state` does NOT use the AG-UI wire shapes

This is the single most important finding, and it contradicts knowledge recorded in the example's own `ToolCallCard.tsx`.

| | AG-UI stream (what `ToolCallCard` unwraps) | `GET /threads/:id/state` |
| --- | --- | --- |
| tool args | `parameters = { input: '{"path":"x"}' }` — JSON string under `input` | `kwargs.tool_calls[0].args` is a **real object** |
| tool result | a string containing a serialized `{lc,type,id,kwargs:{content}}` | `kwargs.content` is the tool's **own output string**, no envelope |

Both wire quirks are introduced by the adapter (`packages/langchain/src/agent-adapter.ts:582-591` → `packages/ag-ui/src/outbound.ts:154,172`), not by the checkpointer. **Keep both unwrapping branches in the tool card — the live path still needs them — and do NOT add a third branch that assumes `/state` shapes into the same function.** Hydration converts to the transcript types itself.

Response envelope (`packages/cli/src/lib/dev/runtime-fetch-core.ts:1409-1450`):

```json
{ "config": {...}, "created_at": "...", "metadata": {...}, "next": [],
  "parent_config": {...},
  "values": { "messages": [...], "context": "", "todos": [...], "__pregel_tasks": [] } }
```

`values.messages` entries are LangChain `Serializable.toJSON()` envelopes: `{ lc: 1, type: "constructor", id: ["langchain_core","messages",<ClassName>], kwargs: {...} }`. Observed class names: `HumanMessage`, `AIMessageChunk` (**not** `AIMessage` — the runtime streams), `ToolMessage`.

- `HumanMessage` → `kwargs: { content: string, id: string, additional_kwargs, response_metadata }`
- `AIMessageChunk` → `kwargs: { content: string, id: string, tool_calls: Array<{ name, args: object, id, type: "tool_call" }>, tool_call_chunks, invalid_tool_calls, additional_kwargs, response_metadata, usage_metadata }`
- `ToolMessage` → `kwargs: { content: string, tool_call_id: string, name: string, status: "success" | ..., id: string, metadata, additional_kwargs, response_metadata }`

`values.todos` is `Array<{ content: string; status: "pending" | "in_progress" | "completed" }>` — **structurally identical** to `DawnPlanActivityContent["todos"]` (`packages/core/src/capabilities/built-in/planning.ts:9-12` vs `packages/ag-ui/src/activities.ts:6-11`). No mapping step. But there is **no runtime validation on this path** — `planActivityContentSchema` from `@dawn-ai/ag-ui/react` is what validates it, and a hydrated plan has **no server-supplied activity id** (the stream path mints `dawn:plan:${runId}`), so this plan mints one.

404 for both an unknown thread and a thread with no checkpoint, identical body:
`{"error":{"kind":"request_error","message":"No checkpoint found for thread"}}`.

### `GET /threads/:id/pending_interrupts`

Body: `{ interrupts: Array<{ interruptId: string; resumeKey: string | null; value?: unknown }> }`, header `cache-control: no-store` (`runtime-fetch-core.ts:2443-2456`).

**`interrupts[i].value` IS the Dawn interrupt envelope that `toAguiInterrupt` takes as its argument** (`packages/ag-ui/src/interrupts.ts:39-66`), and it becomes `Interrupt.metadata` — which is exactly the shape `PermissionInterrupt` already reads. So hydrating a parked prompt is `toAguiInterrupt(entry.value)` and nothing else.

Empty is `200 {"interrupts":[]}`, **not** a 404 — "no such thread" and "nothing pending" are deliberately different answers. Error codes land at **`error.details.code`**, not `error.code` (three call sites pass `{code}` as the second argument of a three-argument builder). Write the client against `error.details.code`.

### CopilotKit's `useInterrupt` cannot be fed a hydrated interrupt

Its `pending` state is set only from `onRunFinishedEvent` + `onRunFinalized` inside one `agent.subscribe(...)` effect, and there is no setter on the public surface (verified in `@copilotkit/react-core@1.66.4` dist, `useInterrupt` body). Assigning `agent.pendingInterrupts` does not make it render.

The resume seam is public and is what a hydrated card must use:

```ts
interface CopilotKitCoreRunAgentParams {
  agent: AbstractAgent
  forwardedProps?: Record<string, unknown>
  runId?: string
  resume?: ResumeEntry[]      // { interruptId: string; status: "resolved" | "cancelled"; payload?: any }
}
```

So this plan splits `PermissionInterrupt` into a **presentational `PermissionPrompt`** plus two sources. That is not a workaround — it is the correct factoring, and it also retires the duplication the spec flagged (the current prompt is duplicated byte-for-byte across two examples).

### `isReady` is NOT the connect predicate

> **CORRECTED DURING EXECUTION (Task 5).** The paragraphs below are accurate
> about `isReady` and about how `runtimeConnectionStatus` behaves — but the
> conclusion is wrong for THIS app. The CopilotKit runtime is the Next route
> `/api/copilotkit`, served by the same process as the page; its `/info`
> handler enumerates agents without probing them (`HttpAgent` implements no
> `getCapabilities`, and failures are swallowed), so it answers 200 with the
> Dawn server completely down and the status stays `"connected"`. Proven live.
> The shipped predicate probes the Dawn server itself through the allowlisted
> proxy (`GET /api/dawn/memory/candidates`; the proxy's 502 is the signal),
> which also makes the connect screen self-recovering — the runtime status was
> terminal until remount.

`useAgent`'s `isReady` is a pure derivation — "is this the real registry agent or a provisional stand-in" — and it is `false` for **both** "still connecting" and "runtime is down", with no retry and no way to tell them apart (`react-core/dist/v2/headless.mjs:326-382`).

The trustworthy signal is `useCopilotKit().copilotkit.runtimeConnectionStatus`: `"disconnected" | "connecting" | "connected" | "error"` (`@copilotkit/core/dist/index.mjs:3941-3947`). It is **already reactive** — `useCopilotKit` force-updates on `onRuntimeConnectionStatusChanged` (`react-core/dist/v2/context.mjs:105-123`). `AppShell` already calls `useCopilotKit()`, so the predicate is free.

Also: the `onError` **prop** on `<CopilotKit>` is inert (the wrapper strips it before forwarding). `copilotkit.subscribe({ onError })` — what `AppShell` already does — is the only working path.

### Memory surface: exactly three routes

`runtime-fetch-core.ts:1341-1381`. `GET /memory/candidates` (query strings accepted but **ignored** — it hardcodes all namespaces), `POST /memory/candidates/:id/approve`, `POST /memory/candidates/:id/reject`. That is all of it. The POSTs take **no body**. Reject is a hard delete and returns `{"ok":true}` even for an unknown id. Do not confuse this with `@dawn-ai/inspector`'s much richer `/api/memory/*`, which is served by `dawn inspect` and does not exist here. The dev server sets **no CORS headers**, which is why a proxy is required at all.

### There is no in-repo precedent for unit-testing a Next route handler

Zero tests anywhere import `next/server`, `NextRequest`, or a `route.ts`. The only App Router handlers under test are the Inspector's, over HTTP against a built standalone server behind `DAWN_TEST_INSPECTOR=1` — far too heavy for this example, whose suite runs in under a second.

**So the proxy's decision goes in a pure module** (`app/lib/proxy-allowlist.ts`), tested the way `transcript.ts` and `thread-source.ts` are tested, with `route.ts` as a thin adapter. This matches every existing pattern in the example and avoids an unanswered question (whether `NextRequest` is even constructible under `environment: "node"`).

---

### Task 0: Baseline

- [ ] **Step 1: Confirm the branch and a green starting point**

```bash
git branch --show-current   # blove/dawn-workbench-sp2b
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

Expected: `Tests 44 passed (44)`. Assert the count — a suite that collects zero files also exits 0.

---

### Task 1: The allowlisted proxy

**Files:**
- Create: `examples/research/web/app/lib/proxy-allowlist.ts`
- Create: `examples/research/web/app/lib/proxy-allowlist.test.ts`
- Create: `examples/research/web/app/api/dawn/[...path]/route.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/proxy-allowlist.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { resolveProxyTarget } from "./proxy-allowlist.js"

const BASE = "http://localhost:3002"

describe("proxy allowlist", () => {
  test("forwards the three memory routes", () => {
    expect(resolveProxyTarget("GET", ["memory", "candidates"], BASE)).toBe(
      "http://localhost:3002/memory/candidates",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "abc", "approve"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/abc/approve",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "abc", "reject"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/abc/reject",
    )
  })

  test("forwards the two thread reads", () => {
    expect(resolveProxyTarget("GET", ["threads", "t1", "state"], BASE)).toBe(
      "http://localhost:3002/threads/t1/state",
    )
    expect(resolveProxyTarget("GET", ["threads", "t1", "pending_interrupts"], BASE)).toBe(
      "http://localhost:3002/threads/t1/pending_interrupts",
    )
  })

  test("rejects the right method on an allowed path", () => {
    expect(resolveProxyTarget("POST", ["memory", "candidates"], BASE)).toBeNull()
    expect(resolveProxyTarget("DELETE", ["threads", "t1", "state"], BASE)).toBeNull()
  })

  test("rejects everything not on the list", () => {
    expect(resolveProxyTarget("GET", ["threads"], BASE)).toBeNull()
    expect(resolveProxyTarget("POST", ["threads", "t1", "resume"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["memory", "candidates", "abc"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["agent", "run"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", [], BASE)).toBeNull()
  })

  test("rejects a segment that tries to climb out of the allowed path", () => {
    expect(resolveProxyTarget("GET", ["threads", "..", "state"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["threads", "a/b", "state"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["threads", "", "state"], BASE)).toBeNull()
  })

  test("encodes the id rather than letting it forge a path", () => {
    expect(resolveProxyTarget("GET", ["threads", "a b", "state"], BASE)).toBe(
      "http://localhost:3002/threads/a%20b/state",
    )
  })

  test("does not let a base with a trailing slash double it", () => {
    expect(resolveProxyTarget("GET", ["memory", "candidates"], "http://localhost:3002/")).toBe(
      "http://localhost:3002/memory/candidates",
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

Expected: FAIL — cannot find module `./proxy-allowlist.js`.

- [ ] **Step 3: Implement the allowlist**

Create `app/lib/proxy-allowlist.ts`:

```ts
/**
 * Which Dawn server paths the browser may reach, and nothing else.
 *
 * The dev server sets no CORS headers, so direct reads from the page are
 * impossible and a same-origin proxy is required. An OPEN proxy in a template
 * every Dawn developer copies is a liability — this app would happily forward
 * `POST /threads/:id/resume` or the whole agent surface — so the allowlist is
 * the point of the route, not an optimization over it.
 *
 * The decision lives here, as a pure function, rather than inside the route
 * handler: no test in this repo imports a Next route module, and the one
 * precedent that exists boots a standalone server behind an env gate. A pure
 * module is testable the way `transcript.ts` and `thread-source.ts` are.
 */

/** A single allowed route: an exact method plus a fixed-arity path shape. */
interface AllowedRoute {
  readonly method: "GET" | "POST"
  /** `null` marks a single free segment (an id); strings must match exactly. */
  readonly shape: readonly (string | null)[]
}

const ALLOWED: readonly AllowedRoute[] = [
  // The dev server's entire memory surface — these three and no more.
  { method: "GET", shape: ["memory", "candidates"] },
  { method: "POST", shape: ["memory", "candidates", null, "approve"] },
  { method: "POST", shape: ["memory", "candidates", null, "reject"] },
  // Thread reads the workbench hydrates from. Deliberately read-only: running,
  // resuming and cancelling a thread all go through CopilotKit's own runtime
  // route, which is separately wired.
  { method: "GET", shape: ["threads", null, "state"] },
  { method: "GET", shape: ["threads", null, "pending_interrupts"] },
]

/**
 * A free segment must be one path segment and nothing clever. Rejecting these
 * outright is cheaper to reason about than normalizing them, and every real id
 * (a UUID, or `cand1`) passes.
 */
function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("/")
}

function matches(route: AllowedRoute, method: string, path: readonly string[]): boolean {
  if (route.method !== method) return false
  if (route.shape.length !== path.length) return false
  return route.shape.every((expected, index) => {
    const actual = path[index] ?? ""
    return expected === null ? isSafeSegment(actual) : actual === expected
  })
}

/**
 * The absolute URL to forward to, or `null` to reject.
 *
 * Segments are re-encoded on the way out so a decoded id can never forge extra
 * path structure — Next has already `decodeURIComponent`-ed them by the time a
 * catch-all handler sees them.
 */
export function resolveProxyTarget(
  method: string,
  path: readonly string[],
  serverUrl: string,
): string | null {
  if (!ALLOWED.some((route) => matches(route, method, path))) return null
  const base = serverUrl.replace(/\/+$/, "")
  return `${base}/${path.map(encodeURIComponent).join("/")}`
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

Expected: `Tests 51 passed (51)` (44 + 7).

- [ ] **Step 5: Write the route adapter**

Create `app/api/dawn/[...path]/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server"
import { resolveProxyTarget } from "../../../lib/proxy-allowlist.js"

// Same-origin proxy to the Dawn server. The dev server sets no CORS headers,
// so the browser cannot read it directly. Every routing decision is in
// `lib/proxy-allowlist.ts`, which is where the tests are; this file is the
// adapter and deliberately holds no policy of its own.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SERVER_URL = process.env.DAWN_SERVER_URL ?? "http://localhost:3002"

async function forward(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await context.params
  const target = resolveProxyTarget(request.method, path ?? [], SERVER_URL)
  if (target === null) {
    return NextResponse.json({ error: "Not proxied" }, { status: 404 })
  }
  try {
    const upstream = await fetch(target, { method: request.method })
    // Pass the body and status through untouched: the UI shows the Dawn
    // server's own error messages rather than a re-worded copy of them.
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      status: upstream.status,
    })
  } catch (error) {
    return NextResponse.json(
      { error: `Cannot reach the Dawn server at ${SERVER_URL}: ${String(error)}` },
      { status: 502 },
    )
  }
}

export const GET = forward
export const POST = forward
```

Neither allowed POST takes a request body (both are bare POSTs the handlers ignore), so the forward deliberately does not stream one. If a future allowlisted route needs a body, add it there and say so.

- [ ] **Step 6: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web lint
```

Both must exit 0. The build's route table should list `ƒ /api/dawn/[...path]`.

```bash
git add examples/research/web
git commit -m "feat(example): add one allowlisted proxy to the Dawn server"
```

---

### Task 2: Thread hydration — the pure mapper

**Files:**
- Create: `examples/research/web/app/lib/hydrate.ts`
- Create: `examples/research/web/app/lib/hydrate.test.ts`

Read `app/lib/transcript.ts` first. It already defines the transcript item types and `buildTranscriptItems`; this task produces the **message array** that feeds it, so hydrated and live threads render through exactly one path.

- [ ] **Step 1: Write the failing test**

Create `app/lib/hydrate.test.ts`. The fixture below is a real `/state` body, reproduced from `examples/research/server/.dawn/checkpoints.sqlite`, trimmed to the fields that matter:

```ts
import { describe, expect, test } from "vitest"
import { hydrateThreadState } from "./hydrate.js"

const STATE = {
  values: {
    context: "",
    messages: [
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "HumanMessage"],
        kwargs: { content: "What are common agent architectures?", id: "m1" },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          content: "",
          id: "m2",
          tool_calls: [
            {
              name: "searchCorpus",
              args: { query: "agent architectures" },
              id: "call_searchCorpus_0_0",
              type: "tool_call",
            },
          ],
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          content: '[{"path":"corpus/agent-architectures.md","score":2}]',
          tool_call_id: "call_searchCorpus_0_0",
          name: "searchCorpus",
          id: "m3",
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { content: "ReAct and plan-and-execute are common.", id: "m4", tool_calls: [] },
      },
    ],
    todos: [
      { content: "Search the corpus", status: "completed" },
      { content: "Read the best sources", status: "in_progress" },
    ],
  },
}

describe("hydrateThreadState", () => {
  test("maps each LangChain envelope to its transcript role", () => {
    const { messages } = hydrateThreadState(STATE)
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
  })

  test("stringifies tool-call args, because /state gives an object and the transcript wants a string", () => {
    const { messages } = hydrateThreadState(STATE)
    const assistant = messages[1]
    expect(assistant).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_searchCorpus_0_0",
          type: "function",
          function: { name: "searchCorpus", arguments: '{"query":"agent architectures"}' },
        },
      ],
    })
  })

  test("uses the tool message content directly — there is no second envelope on this path", () => {
    const { messages } = hydrateThreadState(STATE)
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_searchCorpus_0_0",
      content: '[{"path":"corpus/agent-architectures.md","score":2}]',
    })
  })

  test("re-seeds the plan from the checkpointed todos", () => {
    expect(hydrateThreadState(STATE).todos).toEqual([
      { content: "Search the corpus", status: "completed" },
      { content: "Read the best sources", status: "in_progress" },
    ])
  })

  test("gives every message an id, minting one when the envelope has none", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
      },
    })
    expect(messages[0]?.id).toBeTypeOf("string")
    expect(messages[0]?.id).not.toBe("")
  })

  test("drops entries it does not understand instead of throwing", () => {
    const { messages, todos } = hydrateThreadState({
      values: {
        messages: [
          null,
          "nonsense",
          { lc: 1, type: "constructor", id: ["x", "y", "SystemMessage"], kwargs: { content: "s" } },
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
        todos: "not an array",
      },
    })
    expect(messages.map((message) => message.role)).toEqual(["user"])
    expect(todos).toEqual([])
  })

  test("degrades to empty rather than throwing on a malformed payload", () => {
    expect(hydrateThreadState(null)).toEqual({ messages: [], todos: [] })
    expect(hydrateThreadState({})).toEqual({ messages: [], todos: [] })
    expect(hydrateThreadState({ values: {} })).toEqual({ messages: [], todos: [] })
  })

  test("drops a tool call with no id, which nothing could ever pair", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: "",
              id: "a1",
              tool_calls: [{ name: "searchCorpus", args: {} }],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [] })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — cannot find module `./hydrate.js`.

- [ ] **Step 3: Implement**

Create `app/lib/hydrate.ts`:

```ts
import type { TranscriptMessage } from "./transcript.js"

/**
 * Turn `GET /threads/:id/state` into the message shapes the transcript already
 * renders, so a restored thread and a live one go through one path.
 *
 * THE WIRE SHAPES HERE ARE NOT THE AG-UI ONES. The stream delivers tool args as
 * a JSON string nested under `input` and tool results as a serialized
 * `ToolMessage` envelope — both introduced by the adapter on the way out
 * (`packages/langchain/src/agent-adapter.ts` → `packages/ag-ui/src/outbound.ts`).
 * The checkpoint has neither: `tool_calls[].args` is a real object and
 * `ToolMessage.kwargs.content` is the tool's own output string. So this file
 * converts, and `ToolCallCard`'s two unwrapping branches stay untouched for the
 * live path.
 *
 * Everything degrades to empty rather than throwing. A thread whose checkpoint
 * this cannot read should show an empty transcript you can talk to, never a
 * blank screen.
 */

/** The checkpointed plan. Structurally `DawnPlanActivityContent["todos"]`. */
export interface HydratedTodo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
}

export interface HydratedThread {
  readonly messages: readonly TranscriptMessage[]
  readonly todos: readonly HydratedTodo[]
}

const EMPTY: HydratedThread = { messages: [], todos: [] }
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The LangChain class name, which is the only discriminator on the wire. */
function envelopeClass(entry: unknown): string | null {
  if (!isRecord(entry)) return null
  const id = entry.id
  if (!Array.isArray(id)) return null
  const last = id.at(-1)
  return typeof last === "string" ? last : null
}

let mintedIds = 0
function messageId(kwargs: Record<string, unknown>): string {
  const id = kwargs.id
  if (typeof id === "string" && id.length > 0) return id
  mintedIds += 1
  return `hydrated-${mintedIds}`
}

function toToolCalls(kwargs: Record<string, unknown>): TranscriptMessage["toolCalls"] {
  const raw = kwargs.tool_calls
  if (!Array.isArray(raw)) return []
  const calls = []
  for (const call of raw) {
    if (!isRecord(call)) continue
    const id = call.id
    const name = call.name
    // A call with no id can never be paired with its result, so it would render
    // as a permanently-running tool. Dropping it is the honest outcome.
    if (typeof id !== "string" || id.length === 0) continue
    if (typeof name !== "string") continue
    calls.push({
      function: { arguments: JSON.stringify(call.args ?? {}), name },
      id,
      type: "function" as const,
    })
  }
  return calls
}

function toTodos(raw: unknown): readonly HydratedTodo[] {
  if (!Array.isArray(raw)) return []
  const todos: HydratedTodo[] = []
  for (const todo of raw) {
    if (!isRecord(todo)) continue
    const { content, status } = todo
    if (typeof content !== "string" || content.trim().length === 0) continue
    if (typeof status !== "string" || !TODO_STATUSES.has(status)) continue
    todos.push({ content, status: status as HydratedTodo["status"] })
  }
  return todos
}

export function hydrateThreadState(state: unknown): HydratedThread {
  if (!isRecord(state)) return EMPTY
  const values = state.values
  if (!isRecord(values)) return EMPTY

  const messages: TranscriptMessage[] = []
  const rawMessages = Array.isArray(values.messages) ? values.messages : []
  for (const entry of rawMessages) {
    const className = envelopeClass(entry)
    if (className === null || !isRecord(entry)) continue
    const kwargs = entry.kwargs
    if (!isRecord(kwargs)) continue
    const content = typeof kwargs.content === "string" ? kwargs.content : ""

    // `AIMessageChunk`, not `AIMessage`: the runtime streams, so that is the
    // class the checkpoint holds. Matching only `AIMessage` silently hydrates
    // nothing, which is a blank transcript with green tests.
    if (className === "HumanMessage") {
      messages.push({ content, id: messageId(kwargs), role: "user" })
    } else if (className === "AIMessage" || className === "AIMessageChunk") {
      messages.push({
        content,
        id: messageId(kwargs),
        role: "assistant",
        toolCalls: toToolCalls(kwargs),
      })
    } else if (className === "ToolMessage") {
      const toolCallId = kwargs.tool_call_id
      if (typeof toolCallId !== "string") continue
      messages.push({ content, id: messageId(kwargs), role: "tool", toolCallId })
    }
    // System and developer envelopes are prompt plumbing; `transcript.ts` drops
    // them on the live path too.
  }

  return { messages, todos: toTodos(values.todos) }
}
```

**Before writing this, read `app/lib/transcript.ts` and make `TranscriptMessage` line up exactly** — the property names above (`toolCalls`, `toolCallId`, `function.arguments`) are taken from SP2a's transcript types, but if they differ, the transcript's names win and this file adapts. Do not change `transcript.ts` to suit this file.

- [ ] **Step 4: Run to verify it passes**

Expected: `Tests 59 passed (59)` (51 + 8). Count the `test(` calls yourself before trusting this arithmetic — the point of the assertion is the count moving, so a plan-author's miscount must not become a reason to accept a suite that collected nothing.

- [ ] **Step 5: Commit**

```bash
git add examples/research/web/app/lib
git commit -m "feat(example): map a checkpointed thread into transcript messages"
```

---

### Task 3: Wire hydration into the shell

**Files:**
- Modify: `examples/research/web/app/lib/thread-source.ts`
- Modify: `examples/research/web/app/lib/thread-source.test.ts`
- Modify: `examples/research/web/app/components/AppShell.tsx`
- Modify: `examples/research/web/app/components/Transcript.tsx` (only if the plan card needs a new item kind — see Step 3)

**Why the remaining tasks specify rather than dictate.** Tasks 1 and 2 carry complete source because they are pure modules and the wire shapes behind them are fully known. From here on the plan gives structure, exact payloads, hook points and named failure modes instead of literal JSX, for one reason: this plan's author has read the *prop signatures* and the layout tree of `AppShell` and `Transcript` but not their bodies. Writing speculative JSX against unread component internals produces something that looks authoritative and is wrong — worse than an accurate specification. Read the file before you change it, and report any place this specification turns out not to fit.

- [ ] **Step 1: Put hydration on the `ThreadSource` seam**

The spec defines the seam as `list()`, `create()`, `hydrate(id)` — "so the rail, transcript, and hydration logic never learn where threads come from". SP2a shipped `list`/`create`/`touch`; add the third method now rather than letting `AppShell` fetch directly, or the LangGraph Platform implementation has nothing to swap.

```ts
export interface ThreadSource {
  list(): WorkbenchThread[]
  create(): WorkbenchThread
  touch(id: string, firstUserMessage?: string): void
  /**
   * The thread's stored history. Async because it is a network read even for
   * the localStorage source: the rail's list lives in the browser, but the
   * conversation lives in the Dawn server's checkpoint.
   */
  hydrate(id: string): Promise<HydratedThread>
}
```

The localStorage implementation fetches `/api/dawn/threads/${id}/state` and returns `hydrateThreadState(body)`. **A 404 returns an empty `HydratedThread`, not a throw** — both an unknown thread and a never-run thread 404, and a brand-new thread hits it on every create. Any other non-2xx throws so the caller can surface it.

This makes the interface partly async, exactly as `thread-source.ts`'s own header note predicted. Update that note: the prediction has come true for one method, and `list`/`create` are still synchronous.

Extend `thread-source.test.ts` with `global.fetch` stubbed: a 200 returns the mapped thread, a 404 returns `{messages: [], todos: []}`, and a 500 rejects.

- [ ] **Step 2: Fetch on thread switch**

`AppShell` already has an effect keyed on `activeThreadId` (guarded by `renderedThreadIdRef`) that aborts the run, clears `pendingInterrupts`, and calls `agent.setMessages([])`. Extend it: after clearing, call `threadSource.hydrate(activeThreadId)` and `agent.setMessages(hydrated.messages)`. `AppShell` does not fetch — the seam does.

The source is currently created in `page.tsx`'s `useState` initializer and never passed down; thread it through as a new `AppShellProps` field rather than constructing a second one.

Requirements, each of which is a real failure mode:

- **Ignore a response that arrives after another switch.** Capture the thread id at effect start and drop the result if `activeThreadId` has moved on, or abort via an `AbortController` in the effect's cleanup. A fast rail click otherwise paints thread A's history into thread B.
- **An empty result is normal, not an error.** The seam already turns a 404 into an empty `HydratedThread` (Step 1), and a brand-new thread hits that on every create. It must not produce a `RunError` row.
- **Any other failure surfaces through the existing `runError` state**, not `console.error`.
- Do not hydrate when `activeThreadId` is undefined.

- [ ] **Step 3: Re-seed the plan card**

`hydrated.todos` is structurally `DawnPlanActivityContent["todos"]`, so `{ todos }` feeds the registered `dawn.plan` renderer directly. Two things the stream path gives you that this one does not:

- **No activity id.** The stream mints `dawn:plan:${runId}`; mint a stable one here (`hydrated:plan:${threadId}` is stable across re-renders and unique per thread).
- **No validation.** Nothing validates `values.todos` on the wire. Route it through `planActivityContentSchema` from `@dawn-ai/ag-ui/react` exactly as `activity-renderers.tsx` already does, so a malformed plan renders no card rather than arbitrary JSON.

Prepend it as an activity message so the plan sits above the restored conversation. If `TranscriptMessage` cannot express an activity entry, add the todos to `hydrateThreadState`'s output as a separate field and have `AppShell` pass it to `Transcript` as a prop — **do not** widen `buildTranscriptItems`' contract to special-case hydration.

Skip the card entirely when `todos` is empty.

- [ ] **Step 4: Tell the user what did not come back**

Historical **subagent** cards do not rehydrate — they are derived from a live event stream the server does not persist. A restored thread shows prose, tool results and the plan; subagent cards reappear on the next run.

Render one muted line at the top of a hydrated transcript saying so, in the workbench's style. The spec calls for this in-app, not only in the README: a card that silently misses history is worse than a sentence admitting it.

Show it only when hydration actually restored something.

- [ ] **Step 5: Extend the AppShell test**

`app/components/AppShell.test.tsx` already mounts `AppShell` over a fake `useAgent`/`useCopilotKit` under `// @vitest-environment jsdom`. Add cases with `global.fetch` stubbed via `vi.fn()`:

- a successful hydrate calls `setMessages` with the mapped messages
- a 404 leaves the transcript empty and sets **no** run error
- a 500 sets a run error
- a response for a thread the user has already switched away from is ignored

Mutation-test at least the last one — it is the case a green suite most easily hides.

- [ ] **Step 6: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web build
```

```bash
git add examples/research/web/app
git commit -m "feat(example): restore a thread's history when you switch to it"
```

---

### Task 4: A permission prompt that survives a reload

**Files:**
- Create: `examples/research/web/app/components/PermissionPrompt.tsx`
- Create: `examples/research/web/app/components/PermissionPrompt.test.tsx`
- Create: `examples/research/web/app/components/HydratedInterrupts.tsx`
- Modify: `examples/research/web/app/components/PermissionInterrupt.tsx`
- Modify: `examples/research/web/app/components/Transcript.tsx`

**Why this is a split and not a patch.** CopilotKit's `useInterrupt` sets its `pending` state only from `onRunFinishedEvent` + `onRunFinalized` inside one `agent.subscribe(...)` effect. There is no public setter; assigning `agent.pendingInterrupts` does not make it render. A hydrated prompt therefore cannot go through that hook, and the honest structure is one presentational card with two sources.

- [ ] **Step 1: Extract the presentational card**

Move the markup out of `PermissionInterrupt.tsx` into `PermissionPrompt.tsx` as a pure component:

```tsx
export interface PermissionPromptProps {
  /** The Dawn interrupt envelope — `Interrupt.metadata`, or `value` from the endpoint. */
  readonly metadata: PermissionMetadata
  readonly isResolving: boolean
  readonly onDecide: (decision: "once" | "always" | "deny") => void
}
```

Keep both existing branches (`kind === "subagent"` and the permission branch) and their current appearance, `role="alert"`, the focus-on-mount behavior, and the disabled-while-resolving affordance. Move `PermissionMetadata` here and export it.

The card takes a single `onDecide`. Mapping a decision onto CopilotKit's `resolve`/`cancel` is the **caller's** job, because the two sources resume differently — and that is exactly the difference the current file papers over with two spellings of "deny".

- [ ] **Step 2: Rewrite `PermissionInterrupt` as the live source**

It keeps `useInterrupt({ renderInChat: false, render })`, keeps rendering one card per open interrupt with an explicit `interruptId`, and now renders `<PermissionPrompt>` instead of inline markup. Preserve its comment block — the `renderInChat` reasoning and the mount-timing reasoning are both hard-won.

Pick one denial spelling and comment it. Both work today (the dev runtime accepts a resolved `"deny"` payload and maps `{status:"cancelled"}` to deny), but two spellings in one file reads as a bug.

- [ ] **Step 3: Add the hydrated source**

Create `HydratedInterrupts.tsx`. On mount and on thread change, `GET /api/dawn/threads/${threadId}/pending_interrupts`, then render one `PermissionPrompt` per entry using `toAguiInterrupt(entry.value)?.metadata`.

```ts
// The endpoint's `value` IS the Dawn envelope `toAguiInterrupt` consumes, and
// it becomes `Interrupt.metadata` — the exact shape the live prompt reads. So
// hydrating a parked prompt is `toAguiInterrupt(entry.value)` and nothing else.
import { toAguiInterrupt } from "@dawn-ai/ag-ui"
```

Verify `toAguiInterrupt` is exported from the package root before relying on it; if it is not, read `packages/ag-ui/src/interrupts.ts` and use whatever is, or map the envelope locally rather than adding an export to the package.

Resume through the public seam:

```ts
await copilotkit.runAgent({
  agent,
  resume: [{ interruptId, payload: decision, status: decision === "deny" ? "cancelled" : "resolved" }],
})
```

Behavior that matters:

- `200 {"interrupts":[]}` is the normal case and must render nothing. It is deliberately **not** a 404.
- A 404 means the thread row is missing; a 409 means the thread has never run or its route is gone. Neither is a user-facing error here — render nothing.
- **Read error codes at `error.details.code`, not `error.code`.** Three call sites pass `{code}` as the second argument of a three-argument builder, so that is where it lands on the wire.
- Clear the hydrated list once a live run starts, or the user sees the same prompt twice — once hydrated, once live. Deciding on a hydrated prompt starts a run, so `agent.isRunning` is a usable trigger; whatever you choose, make it impossible for both sources to show the same `interruptId`.
- Re-fetch after a decision so a thread parked on two gates shows the second.

- [ ] **Step 4: Test the card and the mapping**

`PermissionPrompt.test.tsx` with `renderToStaticMarkup`, covering both branches, the disabled state, and — from a real endpoint `value` — that a hydrated envelope renders the same card as a live one. Use a real payload shape:

```ts
const PARKED = {
  interruptId: "perm-1",
  type: "permission-request",
  kind: "tool",
  detail: { toolName: "deployProd", argsPreview: "{}", suggestedPattern: "deployProd" },
}
```

- [ ] **Step 5: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

```bash
git add examples/research/web/app/components
git commit -m "feat(example): keep the permission prompt across a reload"
```

---

### Task 5: The connect screen

**Files:**
- Create: `examples/research/web/app/components/ConnectScreen.tsx`
- Create: `examples/research/web/app/components/ConnectScreen.test.tsx`
- Modify: `examples/research/web/app/components/AppShell.tsx`

- [ ] **Step 1: Use the right predicate**

**Do not use `isReady`.** It is `false` for both "still connecting" and "runtime is down", with no retry and no way to tell them apart.

```ts
const { copilotkit } = useCopilotKit() // already re-renders on status change
const status = copilotkit.runtimeConnectionStatus
// "error" → unreachable → ConnectScreen. "connecting"/"disconnected" → wait. "connected" → normal.
```

`AppShell` already calls `useCopilotKit()`, so this costs nothing new. Show the screen only on `"error"`; a flash of "cannot connect" during a normal first paint is worse than a beat of nothing.

- [ ] **Step 2: Build the screen**

`ConnectScreen` is pure props — `{ serverUrl: string }` — so it is testable without CopilotKit. It shows the brand mark and, concretely:

- the expected `DAWN_SERVER_URL` it tried
- the command that starts the server (check `examples/research/README.md` for the real one rather than inventing it)
- the reminder that `.env` needs `OPENAI_API_KEY`, since **the demo requires a key and there is no keyless demo mode**

This is the likeliest first-run state — a developer opens the web app before starting the agent — so it is a real page, not a toast.

`DAWN_SERVER_URL` is a server-side env var. Thread the value in from the server (or a `NEXT_PUBLIC_` twin) rather than reading `process.env` in a client component, and if you cannot get the real value, show the same default the proxy uses and say it is the default.

- [ ] **Step 3: Place it**

Early-return in `AppShell`, **after every hook has run** — the `useEffect`s must not be skipped or the hook order changes between renders and React throws.

- [ ] **Step 4: Test**

`renderToStaticMarkup` of `ConnectScreen` asserting the URL, the command and the key reminder all appear. Add one `AppShell` case (jsdom, fake `useCopilotKit`) asserting the screen renders on `"error"` and does **not** on `"connecting"`.

- [ ] **Step 5: Verify and commit**

```bash
git add examples/research/web/app/components
git commit -m "feat(example): say what to do when the Dawn server is unreachable"
```

---

### Task 6: The themed tool card

**Files:**
- Modify: `examples/research/web/app/components/ToolCallCard.tsx`
- Create: `examples/research/web/app/components/ToolCallCard.test.tsx`

- [ ] **Step 1: Restyle only**

This is the last unthemed surface in the app — raw inline `style` objects with hard-coded greys (`#e5e5e5`, `#f2f2f2`, `#888`) that read poorly in dark mode, on a card one of the three starter suggestions deliberately produces.

Replace the inline styles with the workbench vocabulary: the `--color-wb-*` tokens via `@theme inline` in `theme.css` (so utilities are `bg-wb-surface`, `border-wb-border`, `text-wb-muted`), `wb-focus` for focus rings, and `neutralButton(size)` from `app/components/ui.ts` if it grows a control.

**The unlayered-CSS constraint does NOT apply here.** That rule governs `@dawn-ai/ag-ui`'s `.dawn-activity*` sheet; this card is markup the app owns outright, so ordinary Tailwind utilities work normally. Say so in a comment, because the neighbouring card files say the opposite about themselves and the difference is not obvious.

Match the activity cards' rhythm so a transcript of mixed cards reads as one system — but do not import the package's `.dawn-activity` classes to get there.

- [ ] **Step 2: Keep the unwrapping, and do not extend it**

`parseArgs` and `parseResult` encode Dawn wire-format knowledge — the double-encoded JSON `input` and the LangChain `ToolMessage` envelope — that is **true of the live AG-UI stream** and worth keeping exactly as it is.

It is **not** true of `GET /threads/:id/state`: there, `tool_calls[].args` is a real object and `ToolMessage.kwargs.content` is the tool's own output. Hydration converts in `lib/hydrate.ts`. **Do not add a third branch here that assumes `/state` shapes** — one function guessing between two wire formats is how a silent mis-parse gets shipped. Update the comment to name both formats and say which one this function is for.

- [ ] **Step 3: Test**

There is no test for this card today. Add one with `renderToStaticMarkup`, rendering the wildcard `render` prop directly (see `activity-renderers.test.tsx` for how to call a registered render function outside a provider). Cover:

- a double-encoded `{ input: '{"path":"corpus/x.md"}' }` argument unwraps to the real value
- a LangChain `ToolMessage` envelope result unwraps to its content
- a plain non-JSON result passes through unchanged
- the three statuses (`inProgress`, `executing`, `complete`) each render their own label
- a long result is bounded rather than filling the transcript

- [ ] **Step 4: Verify and commit**

```bash
git add examples/research/web/app/components
git commit -m "feat(example): give the tool card the workbench's design"
```

---

### Task 7: The memory panel

**Files:**
- Create: `examples/research/web/app/components/MemoryPanel.tsx`
- Create: `examples/research/web/app/components/MemoryPanel.test.tsx`
- Delete: `examples/research/web/app/components/MemoryCandidates.tsx`
- Modify: `examples/research/web/app/components/AppShell.tsx`
- Modify: `examples/research/web/app/components/DemoSuggestions.tsx`

- [ ] **Step 1: Rebuild against the new proxy**

`MemoryCandidates.tsx` is on disk, unmounted, and written against the deleted `/api/memory/*` proxy with inline styles. Rebuild it as `MemoryPanel` — the spec calls the old prompt-and-panel code "rebuilt rather than copied" for the same reason.

The endpoints, which are the whole surface:

| Call | Request | Response |
| --- | --- | --- |
| `GET /api/dawn/memory/candidates` | none | `{ candidates: MemoryRecord[] }` |
| `POST /api/dawn/memory/candidates/:id/approve` | **no body** | `{ record, action, superseded }`, `action ∈ "activated" \| "superseded" \| "deduped"` |
| `POST /api/dawn/memory/candidates/:id/reject` | **no body** | `{ ok: true }` |

`MemoryRecord` (`packages/memory/src/types.ts:7-22`) carries `id`, `kind`, `namespace`, `content`, `data`, `source`, `confidence`, `tags`, `status`, `createdAt`, `updatedAt`, and optionally `supersedes`, `effectiveAt`, `expiresAt`.

Behavior worth getting right:

- **Approve can supersede.** When `action === "superseded"`, `superseded` holds the pre-write snapshot of the records this one replaced. Say so — "replaced 1 earlier memory" is the interesting outcome and the panel should not swallow it.
- **Reject is a hard delete** and returns `{"ok":true}` even for an unknown id. Do not present it as reversible.
- Refetch after each decision.
- Empty is the normal state: render nothing, or a single quiet line. This panel must not shout when there is nothing to review.
- Keep the old component's refresh trigger — it subscribed to `onRunFinishedEvent` so a memory proposed during a run appears without a reload. That is good behavior; carry it over.

Split the fetching from the presentation: a pure `MemoryPanelView` taking `{ candidates, onApprove, onReject, isBusy }` is what the tests render, with a thin container doing the fetching. Every other component in this app follows that shape.

- [ ] **Step 2: Mount it**

Put it in the left rail beneath `ThreadRail` (the old component was an `<aside>` written for a left column). `AppShell`'s rail is at `AppShell.tsx:185-197`.

The rail is `w-64` and thread titles already truncate there. If candidate content does not fit legibly, a collapsible section headed with the count is fine — but do not grow the rail's width, and do not introduce a second scroll region that competes with the thread list.

- [ ] **Step 3: Restore the third suggestion**

SP2a reworded the third starter pill away from memory ("Watch it use a tool") because the panel was gone. Put the memory prompt back now that the panel is real, and update its comment. Check `DemoSuggestions.tsx` for the original wording in git history: `git show 239cf18d^:examples/research/web/app/components/DemoSuggestions.tsx`.

- [ ] **Step 4: Test**

`renderToStaticMarkup` over `MemoryPanelView`: a candidate renders its content and namespace, the empty state renders quietly, and a busy state disables both actions. Fetching and refetch logic is not covered by these — say so rather than implying it is.

- [ ] **Step 5: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

```bash
git add examples/research/web/app
git commit -m "feat(example): bring the memory panel back on the allowlisted proxy"
```

---

### Task 8: Verification and handoff

- [ ] **Step 1: Full gates**

Run each and capture its exit code immediately. **Never pipe a gate through `tail`** — it hides the exit code and has previously made a failing gate look green.

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm lint; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web typecheck; echo "EXIT=$?"
```

- [ ] **Step 2: Run it against a real server**

Every one of SP2a's four worst defects passed all of the above while broken. Start the research server and the web app and check, in a browser:

1. A fresh thread, a real question, streamed answer with markdown.
2. Switch away mid-conversation and back — history returns, the plan card is re-seeded, the "subagent cards do not restore" line appears.
3. Trigger the permission gate, **reload the page**, and confirm the prompt is still there and still resolvable.
4. Stop the server, reload — `ConnectScreen`, naming the URL and the command.
5. Ask it to remember a preference; approve the candidate in the panel; confirm it disappears and, if it superseded something, that the panel says so.
6. `curl` the proxy for a path that is not allowlisted (e.g. `POST /api/dawn/threads/x/resume`) and confirm a 404.

Report what you observed for each, not that you "verified" them.

- [ ] **Step 3: Update the docs**

- `examples/research/web/README.md` — thread history now restores (say what does not: subagent cards); the memory panel is back; the connect screen exists; the proxy is allowlisted and where the list lives.
- `apps/web/content/docs/recipes/research-web-ui.mdx` — the memory section currently says the panel and its proxy return in SP2b. They have. Update it, and re-verify every code block still matches the file it names. **Do this mechanically** — extract each block with a `title=` and assert every non-comment line appears in that file — rather than by eye.

- [ ] **Step 4: No changeset**

`@dawn-example/research-web` is private. Confirm nothing under `packages/` changed: `git diff --stat main...HEAD -- packages/` must be empty. If something did, stop and report — a package change needs a changeset and is out of this plan's scope.

- [ ] **Step 5: Review and finish**

superpowers:requesting-code-review on `git diff main...HEAD`, then superpowers:finishing-a-development-branch. PR title: `feat(example): complete the Dawn Workbench`.

In the PR body, carry forward the six SP1 ladder gaps from PR #487 if they are still open, and state whether anything in this slice hit a seventh.

---

## Out of scope

- **SP3** — scaffold integration: npm workspaces, port assignment, generation, a byte-for-byte parity guard between the example and the generated app, and the two-process harness.
- **SP4** — the Playwright activation gate. Real browser behavior is verified there; this slice's bar is "every component renders correctly from fixtures, the proxy is closed, and the example builds".
- **A thread-list endpoint.** Enumeration is a thread-access authorization question and dragging it into a UI slice would be the wrong order. `ThreadSource` stays localStorage-backed; the LangGraph Platform implementation is its own slice and will have to make the interface async.
- **The six `@dawn-ai/ag-ui` ladder gaps** from PR #487. They belong in SP1's package with a changeset, not here.
