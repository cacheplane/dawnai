# @dawn-ai/ag-ui Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dawn a first-class AG-UI agent by adding a new `@dawn-ai/ag-ui` package that translates Dawn's runtime event stream into the AG-UI protocol, plus a new additive `POST /agui/{routeId}` endpoint on the dev server — without touching the existing Agent-Protocol endpoints or Dawn's core streaming.

**Architecture:** A **pure, isolated translator** (`@dawn-ai/ag-ui`, deps only on `@ag-ui/core` + `@ag-ui/encoder`) maps `DawnStreamChunk`s → AG-UI events, ported from the canonical `@ag-ui/langgraph` mapping (snapshot-only state, IDs synthesized in-adapter). A thin **HTTP handler in `@dawn-ai/cli`** wires the translator to the existing `streamResolvedRoute` + thread/checkpoint machinery and mounts `/agui/{routeId}`. Conformance is proven against the real `@ag-ui/client` (`verifyEvents` + `HttpAgent`).

**Tech Stack:** TypeScript (ESM, `tsc -b` composite build), Vitest, `@ag-ui/core`/`@ag-ui/encoder`/`@ag-ui/client` (pinned `0.0.57`), pnpm workspaces, Turbo.

**Scope:** Sub-project 1 of the AG-UI + CopilotKit design (`docs/superpowers/specs/2026-07-07-ag-ui-copilotkit-ui-design.md`). This plan builds the framework capability only — no UI. The chat/research CopilotKit UIs are separate plans.

**Working directory:** worktree `.claude/worktrees/zealous-goldberg-ab9dfc`, branch `blove/zealous-goldberg-ab9dfc`. All paths are repo-root-relative.

---

## Reference — exact signatures (verified against the tree / local checkouts)

**Dawn runtime (from `@dawn-ai/cli`):**
```ts
// packages/cli/src/lib/runtime/stream-types.ts
export type StreamChunk =
  | { readonly type: "chunk"; readonly data: unknown }
  | { readonly type: "tool_call"; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly name: string; readonly output: unknown }
  | { readonly type: "done"; readonly output: unknown }
  | { readonly type: string; readonly data: unknown }   // capability events: token, plan_update, interrupt, subagent.*

// packages/cli/src/lib/runtime/execute-route.ts  (exported via "@dawn-ai/cli/runtime")
export async function* streamResolvedRoute(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly resumeDecision?: "once" | "always" | "deny"
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly sandboxManager?: SandboxManager
  readonly signal?: AbortSignal
  readonly threadId?: string
}): AsyncGenerator<StreamChunk>
```
Dawn capability chunk payloads (the `{type, data}` variant): `token` → `data` is the token string; `plan_update` → `data` is `{ todos: {content,status}[] }`; `interrupt` → `data` is `{ interruptId, type:"permission-request", kind, detail }`; `subagent.start|message|tool_call|tool_result|end` → `data` is `{ call_id, ... }`. `done` uses the named `output` field (`{ ...state }` or `{ error }`).

**Runtime server seams (`packages/cli/src/lib/dev/runtime-server.ts`):** route entries are `{ method, pattern: RegExp, handle: (req,res,params)=>Promise<void> }` in `buildRouteTable`; helpers `readRequestBody(req): Promise<string>`, `sendJson(res, code, body)`; registry `registry.lookup(assistantId) => { routeId, routeFile, routePath, mode } | null`; idempotent thread `await threadsStore.getThread(id) ?? await threadsStore.createThread({ thread_id: id })`; in-process test entry `createRuntimeRequestListener({ appRoot }) => { listener, close }`.

**AG-UI SDK (`@ag-ui/core` / `@ag-ui/encoder` / `@ag-ui/client`, all exported at package root):**
```ts
enum EventType { RUN_STARTED, RUN_FINISHED, RUN_ERROR, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TOOL_CALL_RESULT,
  STATE_SNAPSHOT, CUSTOM, ... }  // string enum, values === member names
type BaseEvent = { type: EventType; timestamp?: number; rawEvent?: any }
// event fields: RUN_STARTED{threadId,runId}; RUN_FINISHED{threadId,runId,result?}; RUN_ERROR{message,code?}
// TEXT_MESSAGE_START{messageId,role?}; TEXT_MESSAGE_CONTENT{messageId,delta /* NON-EMPTY */}; TEXT_MESSAGE_END{messageId}
// TOOL_CALL_START{toolCallId,toolCallName,parentMessageId?}; TOOL_CALL_ARGS{toolCallId,delta}; TOOL_CALL_END{toolCallId}
// TOOL_CALL_RESULT{messageId,toolCallId,content,role?:"tool"}; STATE_SNAPSHOT{snapshot}; CUSTOM{name,value}
type RunAgentInput = { threadId:string; runId:string; state:any; messages:Message[]; tools:Tool[]; context:Context[]; forwardedProps:any }
// @ag-ui/core also exports the zod schemas: RunAgentInputSchema, TextMessageStartEventSchema, ... (use for validation)
class EventEncoder { constructor(p?:{accept?:string}); getContentType():string; encode(e:BaseEvent):string /* `data: ${JSON}\n\n` */ }
class HttpAgent { constructor(c:{url:string; headers?:Record<string,string>; initialMessages?:Message[]}); run(input:RunAgentInput):Observable<BaseEvent>; runAgent(...):Promise<{result:any;newMessages:Message[]}> }
const verifyEvents: (debug:boolean) => (src:Observable<BaseEvent>)=>Observable<BaseEvent>  // throws on ordering violations
```
NOTE: the local `~/repos/ag-ui` checkout is `0.0.47`; npm latest is `0.0.57`. Pin `0.0.57`. If any field differs in the installed types, trust the installed `.d.ts` and adjust — the TDD tests will surface mismatches.

---

## File Structure

```
packages/ag-ui/
  package.json                # @dawn-ai/ag-ui; deps @ag-ui/core,@ag-ui/encoder; dev @ag-ui/client,rxjs
  tsconfig.json               # extends ../config-typescript/node.json; composite; no references
  vitest.config.ts            # node env, test/**/*.test.ts
  src/
    index.ts                  # public exports
    types.ts                  # DawnStreamChunk (structural), AgUiEvent, TranslatorOptions
    translate.ts              # createAgUiTranslator — the ported mapping (the risk, isolated)
    run-input.ts              # mapRunInput: RunAgentInput -> { dawnInput, resumeDecision? }
    encode.ts                 # encodeAgUiSse wrapper over EventEncoder
  test/
    translate-text-tools.test.ts   # text + tool-call mapping, schema-validated
    translate-capabilities.test.ts # plan_update/subagent/interrupt/done mapping
    run-input.test.ts
    conformance.test.ts            # real @ag-ui/client HttpAgent + verifyEvents oracle

packages/cli/
  src/lib/dev/agui-handler.ts # NEW: handleAgUiRequest — wires translator to streamResolvedRoute
  src/lib/dev/runtime-server.ts  # MODIFY: mount POST /agui/{routeId}
  package.json                # MODIFY: add "@dawn-ai/ag-ui": "workspace:*"
  tsconfig.build.json         # MODIFY: add { "path": "../ag-ui" } reference
  test/agui-endpoint.test.ts  # NEW: in-process listener e2e (aimock, no key)

Root:
  vitest.workspace.ts         # MODIFY: add ./packages/ag-ui/vitest.config.ts
  .changeset/config.json      # MODIFY: add @dawn-ai/ag-ui to fixed group
  .changeset/ag-ui-capability.md  # NEW: changeset
```

---

## Task 1: Scaffold `@dawn-ai/ag-ui` package + register it

**Files:** Create `packages/ag-ui/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`; Modify `vitest.workspace.ts`, `.changeset/config.json`.

- [ ] **Step 1: Create `packages/ag-ui/package.json`** (modeled on `packages/sandbox/package.json`; the `0.8.7` version matches the current release cohort):

```json
{
  "name": "@dawn-ai/ag-ui",
  "version": "0.8.7",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/cacheplane/dawnai/tree/main/packages/ag-ui#readme",
  "repository": { "type": "git", "url": "git+https://github.com/cacheplane/dawnai.git", "directory": "packages/ag-ui" },
  "bugs": { "url": "https://github.com/cacheplane/dawnai/issues" },
  "engines": { "node": ">=22.13.0" },
  "files": ["dist"],
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ag-ui/core": "0.0.57",
    "@ag-ui/encoder": "0.0.57"
  },
  "devDependencies": {
    "@ag-ui/client": "0.0.57",
    "@dawn-ai/config-typescript": "workspace:*",
    "@types/node": "26.1.0",
    "rxjs": "7.8.1"
  }
}
```

- [ ] **Step 2: Create `packages/ag-ui/tsconfig.json`** (no `references` — this package depends on no other `@dawn-ai` package):

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../config-typescript/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/ag-ui/vitest.config.ts`:**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
})
```

- [ ] **Step 4: Create a stub `packages/ag-ui/src/index.ts`** so the package builds:

```ts
export {}
```

- [ ] **Step 5: Register in the root vitest workspace.** In `vitest.workspace.ts`, add the line after `"./examples/chat/server/vitest.config.ts",` and before/after research to keep the packages grouped — insert immediately after the `"./apps/web/vitest.config.ts",` group in alphabetical position, i.e. add:

```ts
      "./packages/ag-ui/vitest.config.ts",
```
as the FIRST entry of the `./packages/*` block (before `"./packages/cli/vitest.config.ts",`).

- [ ] **Step 6: Add to the changeset fixed group.** In `.changeset/config.json`, add `"@dawn-ai/ag-ui"` as the FIRST element of the `fixed[0]` array (before `"@dawn-ai/cli"`), keeping the array otherwise unchanged.

- [ ] **Step 7: Install + build + typecheck**

Run: `pnpm install`
Then: `pnpm --filter @dawn-ai/ag-ui build && pnpm --filter @dawn-ai/ag-ui typecheck`
Expected: `pnpm install` resolves `@ag-ui/core@0.0.57`, `@ag-ui/encoder@0.0.57`, `@ag-ui/client@0.0.57`, `rxjs@7.8.1`; build + typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/ag-ui vitest.workspace.ts .changeset/config.json pnpm-lock.yaml
git commit -m "feat(ag-ui): scaffold @dawn-ai/ag-ui package

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Structural types (`types.ts`)

**Files:** Create `packages/ag-ui/src/types.ts`; Test: none (types only, exercised by later tasks).

- [ ] **Step 1: Write `packages/ag-ui/src/types.ts`.** This defines the loose structural shape of a Dawn stream chunk (so the package never imports `@dawn-ai/cli`) and re-exports the AG-UI event union alias:

```ts
import type { BaseEvent } from "@ag-ui/core"

/** An AG-UI protocol event. Alias kept local so consumers import one name. */
export type AgUiEvent = BaseEvent

/**
 * Structural mirror of `@dawn-ai/cli`'s `StreamChunk`. Kept loose (all fields
 * optional beyond `type`) so this package has ZERO dependency on the CLI. The
 * translator inspects fields at runtime by `type`.
 */
export interface DawnStreamChunk {
  readonly type: string
  readonly data?: unknown
  readonly name?: string
  readonly input?: unknown
  readonly output?: unknown
}

export interface TranslatorOptions {
  readonly threadId: string
  readonly runId: string
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dawn-ai/ag-ui typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/ag-ui/src/types.ts
git commit -m "feat(ag-ui): structural DawnStreamChunk + AgUiEvent types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Translator — text + tool calls + lifecycle (`translate.ts`)

Ported from `~/repos/ag-ui/integrations/langgraph/typescript/src/agent.ts` `handleSingleEvent` (non-streaming branch). The translator is a stateful factory: `begin()` emits `RUN_STARTED`; `translate(chunk)` emits events per chunk; it synthesizes message/tool IDs and pairs tool results FIFO-by-name. **Rule: flush any open text message (`TEXT_MESSAGE_END`) before emitting any non-text event** (keeps the stream `verifyEvents`-clean).

**Files:** Create `packages/ag-ui/src/translate.ts`; Test: `packages/ag-ui/test/translate-text-tools.test.ts`.

- [ ] **Step 1: Write the failing test** `packages/ag-ui/test/translate-text-tools.test.ts`:

```ts
import { EventType } from "@ag-ui/core"
import {
  RunStartedEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  RunFinishedEventSchema,
} from "@ag-ui/core"
import { describe, expect, it } from "vitest"
import { createAgUiTranslator } from "../src/translate.js"
import type { AgUiEvent } from "../src/types.js"

const opts = { threadId: "t1", runId: "r1" }
const types = (evs: AgUiEvent[]) => evs.map((e) => e.type)

describe("translator: lifecycle + text + tools", () => {
  it("begin() emits a valid RUN_STARTED", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.begin()
    expect(types(evs)).toEqual([EventType.RUN_STARTED])
    expect(() => RunStartedEventSchema.parse(evs[0])).not.toThrow()
  })

  it("maps a token run to START/CONTENT+/END and validates each event", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "token", data: "Hello" }),
      ...t.translate({ type: "token", data: " world" }),
      ...t.translate({ type: "done", output: { messages: [] } }),
    ]
    expect(types(evs)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    TextMessageStartEventSchema.parse(evs[0])
    TextMessageContentEventSchema.parse(evs[1])
    TextMessageContentEventSchema.parse(evs[2])
    TextMessageEndEventSchema.parse(evs[3])
    RunFinishedEventSchema.parse(evs[4])
    // same synthesized messageId across the message
    const mid = (evs[0] as { messageId: string }).messageId
    expect((evs[1] as { messageId: string }).messageId).toBe(mid)
    expect((evs[3] as { messageId: string }).messageId).toBe(mid)
  })

  it("skips empty token deltas (schema forbids empty content)", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.translate({ type: "token", data: "" })
    expect(evs).toEqual([])
  })

  it("maps tool_call to START/ARGS/END and pairs tool_result by FIFO", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "tool_call", name: "searchCorpus", input: { query: "x" } }),
      ...t.translate({ type: "tool_result", name: "searchCorpus", output: [{ path: "corpus/a.md" }] }),
    ]
    expect(types(evs)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ])
    ToolCallStartEventSchema.parse(evs[0])
    ToolCallArgsEventSchema.parse(evs[1])
    ToolCallEndEventSchema.parse(evs[2])
    ToolCallResultEventSchema.parse(evs[3])
    const id = (evs[0] as { toolCallId: string }).toolCallId
    expect((evs[1] as { toolCallId: string }).toolCallId).toBe(id)
    expect((evs[3] as { toolCallId: string }).toolCallId).toBe(id)
    expect((evs[1] as { delta: string }).delta).toBe(JSON.stringify({ query: "x" }))
  })

  it("flushes an open text message before a tool_call", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "token", data: "thinking" }),
      ...t.translate({ type: "tool_call", name: "readDoc", input: { path: "corpus/a.md" } }),
    ]
    expect(types(evs)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ])
  })

  it("maps a done error to RUN_ERROR", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.translate({ type: "done", output: { error: "boom" } })
    expect(types(evs)).toEqual([EventType.RUN_ERROR])
    expect((evs[0] as { message: string }).message).toBe("boom")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: FAIL — `createAgUiTranslator` not found.

- [ ] **Step 3: Write `packages/ag-ui/src/translate.ts`:**

```ts
import { EventType } from "@ag-ui/core"
import type { AgUiEvent, DawnStreamChunk, TranslatorOptions } from "./types.js"

let counter = 0
/** Deterministic-per-process id (no Math.random/Date — safe for tests). */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}_${counter}`
}

export interface AgUiTranslator {
  /** Emit RUN_STARTED. Call once before feeding chunks. */
  begin(): AgUiEvent[]
  /** Translate one Dawn chunk into zero or more AG-UI events. */
  translate(chunk: DawnStreamChunk): AgUiEvent[]
  /** Emit a terminal RUN_FINISHED if the stream ended without a `done` chunk. */
  end(): AgUiEvent[]
}

export function createAgUiTranslator(options: TranslatorOptions): AgUiTranslator {
  const { threadId, runId } = options
  let activeTextId: string | null = null
  // FIFO of synthesized tool-call ids per tool name, to pair results to calls.
  const pendingToolCalls = new Map<string, string[]>()
  let finished = false

  function flushText(): AgUiEvent[] {
    if (activeTextId === null) return []
    const id = activeTextId
    activeTextId = null
    return [{ type: EventType.TEXT_MESSAGE_END, messageId: id }]
  }

  function toText(chunk: DawnStreamChunk): AgUiEvent[] {
    const text = typeof chunk.data === "string" ? chunk.data : String(chunk.data ?? "")
    if (text.length === 0) return []
    const out: AgUiEvent[] = []
    if (activeTextId === null) {
      activeTextId = nextId("msg")
      out.push({ type: EventType.TEXT_MESSAGE_START, messageId: activeTextId, role: "assistant" })
    }
    out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: activeTextId, delta: text })
    return out
  }

  function toToolCall(chunk: DawnStreamChunk): AgUiEvent[] {
    const name = chunk.name ?? "tool"
    const toolCallId = nextId("call")
    const queue = pendingToolCalls.get(name) ?? []
    queue.push(toolCallId)
    pendingToolCalls.set(name, queue)
    return [
      ...flushText(),
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name },
      { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(chunk.input ?? {}) },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ]
  }

  function toToolResult(chunk: DawnStreamChunk): AgUiEvent[] {
    const name = chunk.name ?? "tool"
    const queue = pendingToolCalls.get(name) ?? []
    const toolCallId = queue.shift() ?? nextId("call")
    pendingToolCalls.set(name, queue)
    const content =
      typeof chunk.output === "string" ? chunk.output : JSON.stringify(chunk.output ?? null)
    return [
      ...flushText(),
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: nextId("msg"),
        toolCallId,
        content,
        role: "tool",
      },
    ]
  }

  function toDone(chunk: DawnStreamChunk): AgUiEvent[] {
    finished = true
    const out = flushText()
    const output = chunk.output
    if (output && typeof output === "object" && "error" in output) {
      out.push({
        type: EventType.RUN_ERROR,
        message: String((output as { error: unknown }).error),
      })
      return out
    }
    out.push({ type: EventType.RUN_FINISHED, threadId, runId, result: output })
    return out
  }

  return {
    begin() {
      return [{ type: EventType.RUN_STARTED, threadId, runId }]
    },
    translate(chunk) {
      switch (chunk.type) {
        case "token":
        case "chunk":
          return toText(chunk)
        case "tool_call":
          return toToolCall(chunk)
        case "tool_result":
          return toToolResult(chunk)
        case "done":
          return toDone(chunk)
        default:
          // Capability events (plan_update / subagent.* / interrupt) — Task 4.
          return flushText()
      }
    },
    end() {
      if (finished) return []
      finished = true
      return [...flushText(), { type: EventType.RUN_FINISHED, threadId, runId }]
    },
  }
}
```

- [ ] **Step 4: Export it.** In `packages/ag-ui/src/index.ts`:

```ts
export { createAgUiTranslator, type AgUiTranslator } from "./translate.js"
export type { AgUiEvent, DawnStreamChunk, TranslatorOptions } from "./types.js"
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS — all cases in `translate-text-tools.test.ts` green.

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/src/translate.ts packages/ag-ui/src/index.ts packages/ag-ui/test/translate-text-tools.test.ts
git commit -m "feat(ag-ui): translator for text, tool calls, and run lifecycle

Ported from @ag-ui/langgraph handleSingleEvent (non-streaming branch).
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Translator — capability events (state, subagents, interrupts)

Extends the `default` branch: `plan_update` → accumulated `STATE_SNAPSHOT`; `subagent.*` → `CUSTOM{name:"dawn.<type>"}`; `interrupt` → `CUSTOM{name:"on_interrupt"}` (matches the reference + shipping CopilotKit `useLangGraphInterrupt`/`useInterrupt`).

**Files:** Modify `packages/ag-ui/src/translate.ts`; Test: `packages/ag-ui/test/translate-capabilities.test.ts`.

- [ ] **Step 1: Write the failing test** `packages/ag-ui/test/translate-capabilities.test.ts`:

```ts
import { EventType, StateSnapshotEventSchema, CustomEventSchema } from "@ag-ui/core"
import { describe, expect, it } from "vitest"
import { createAgUiTranslator } from "../src/translate.js"
import type { AgUiEvent } from "../src/types.js"

const opts = { threadId: "t1", runId: "r1" }
const type1 = (evs: AgUiEvent[]) => evs[0]?.type

describe("translator: capability events", () => {
  it("maps plan_update to a STATE_SNAPSHOT carrying todos", () => {
    const t = createAgUiTranslator(opts)
    const todos = [{ content: "search", status: "pending" }]
    const evs = t.translate({ type: "plan_update", data: { todos } })
    expect(type1(evs)).toBe(EventType.STATE_SNAPSHOT)
    const parsed = StateSnapshotEventSchema.parse(evs[0])
    expect((parsed.snapshot as { todos: unknown }).todos).toEqual(todos)
  })

  it("accumulates state across snapshots", () => {
    const t = createAgUiTranslator(opts)
    t.translate({ type: "plan_update", data: { todos: [{ content: "a", status: "pending" }] } })
    const evs = t.translate({ type: "report_update", data: { report: "hello" } })
    // unknown capability with a `data` object is merged into state as well
    const snap = (evs.find((e) => e.type === EventType.STATE_SNAPSHOT) as { snapshot: Record<string, unknown> } | undefined)
    expect(snap?.snapshot.todos).toBeDefined()
    expect(snap?.snapshot.report).toBe("hello")
  })

  it("maps subagent events to CUSTOM dawn.<type>", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.translate({ type: "subagent.start", data: { call_id: "c1", subagent: "researcher" } })
    expect(type1(evs)).toBe(EventType.CUSTOM)
    const parsed = CustomEventSchema.parse(evs[0])
    expect(parsed.name).toBe("dawn.subagent.start")
    expect((parsed.value as { call_id: string }).call_id).toBe("c1")
  })

  it("maps interrupt to CUSTOM on_interrupt", () => {
    const t = createAgUiTranslator(opts)
    const detail = { command: "node scripts/fetch-source.mjs x", suggestedPattern: "node scripts" }
    const evs = t.translate({
      type: "interrupt",
      data: { interruptId: "perm-1", type: "permission-request", kind: "command", detail },
    })
    expect(type1(evs)).toBe(EventType.CUSTOM)
    const parsed = CustomEventSchema.parse(evs[0])
    expect(parsed.name).toBe("on_interrupt")
    expect((parsed.value as { interruptId: string }).interruptId).toBe("perm-1")
    expect((parsed.value as { kind: string }).kind).toBe("command")
  })

  it("flushes open text before a capability event", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "token", data: "hi" }),
      ...t.translate({ type: "subagent.start", data: { call_id: "c1" } }),
    ]
    expect(evs.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.CUSTOM,
    ])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test test/translate-capabilities.test.ts`
Expected: FAIL — capability events currently only flush text (no STATE_SNAPSHOT/CUSTOM).

- [ ] **Step 3: Implement.** In `packages/ag-ui/src/translate.ts`, add an accumulated-state field and replace the `default` branch. Add near the other `let` declarations:

```ts
  let state: Record<string, unknown> = {}
```

Replace the `default:` case in `translate` with:

```ts
        case "plan_update": {
          const flushed = flushText()
          const data = (chunk.data ?? {}) as Record<string, unknown>
          state = { ...state, ...data }
          return [...flushed, { type: EventType.STATE_SNAPSHOT, snapshot: state }]
        }
        case "interrupt": {
          return [
            ...flushText(),
            { type: EventType.CUSTOM, name: "on_interrupt", value: chunk.data ?? {} },
          ]
        }
        default: {
          const flushed = flushText()
          if (chunk.type.startsWith("subagent.")) {
            return [
              ...flushed,
              { type: EventType.CUSTOM, name: `dawn.${chunk.type}`, value: chunk.data ?? {} },
            ]
          }
          // Other capability events with an object `data` merge into state.
          if (chunk.data && typeof chunk.data === "object") {
            state = { ...state, ...(chunk.data as Record<string, unknown>) }
            return [...flushed, { type: EventType.STATE_SNAPSHOT, snapshot: state }]
          }
          return flushed
        }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS — both translate test files green.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/translate.ts packages/ag-ui/test/translate-capabilities.test.ts
git commit -m "feat(ag-ui): map plan_update/subagent/interrupt capability events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: RunAgentInput → Dawn run mapping (`run-input.ts`)

**Files:** Create `packages/ag-ui/src/run-input.ts`; Test: `packages/ag-ui/test/run-input.test.ts`.

- [ ] **Step 1: Write the failing test** `packages/ag-ui/test/run-input.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { mapRunInput } from "../src/run-input.js"

const base = { threadId: "t", runId: "r", state: {}, messages: [], tools: [], context: [], forwardedProps: {} }

describe("mapRunInput", () => {
  it("extracts the last user message as the Dawn input", () => {
    const result = mapRunInput({
      ...base,
      messages: [
        { id: "1", role: "user", content: "old" },
        { id: "2", role: "assistant", content: "hi" },
        { id: "3", role: "user", content: "new question" },
      ],
    } as never)
    expect(result.resumeDecision).toBeUndefined()
    expect(result.dawnInput).toEqual({ messages: [{ role: "user", content: "new question" }] })
  })

  it("decodes a resume decision from forwardedProps.command.resume", () => {
    const result = mapRunInput({
      ...base,
      forwardedProps: { command: { resume: { interruptId: "perm-1", decision: "once" } } },
    } as never)
    expect(result.resumeDecision).toBe("once")
    expect(result.interruptId).toBe("perm-1")
  })

  it("accepts a bare string decision", () => {
    const result = mapRunInput({
      ...base,
      forwardedProps: { command: { resume: "deny" } },
    } as never)
    expect(result.resumeDecision).toBe("deny")
  })

  it("falls back to empty messages when no user message exists", () => {
    const result = mapRunInput(base as never)
    expect(result.dawnInput).toEqual({ messages: [] })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test test/run-input.test.ts`
Expected: FAIL — `mapRunInput` not found.

- [ ] **Step 3: Write `packages/ag-ui/src/run-input.ts`:**

```ts
import type { RunAgentInput } from "@ag-ui/core"

export type ResumeDecision = "once" | "always" | "deny"

export interface MappedRunInput {
  readonly dawnInput: { readonly messages: ReadonlyArray<{ role: string; content: string }> }
  readonly resumeDecision?: ResumeDecision
  readonly interruptId?: string
}

function coerceDecision(value: unknown): ResumeDecision | undefined {
  if (value === "once" || value === "always" || value === "deny") return value
  return undefined
}

/**
 * Map an AG-UI RunAgentInput onto a Dawn run. HITL resume rides on
 * forwardedProps.command.resume (the @ag-ui/langgraph convention); otherwise
 * the newest user message becomes the turn's input (Dawn keeps history in its
 * checkpoint keyed by threadId).
 */
export function mapRunInput(input: RunAgentInput): MappedRunInput {
  const resume = (input.forwardedProps as { command?: { resume?: unknown } } | undefined)?.command
    ?.resume
  if (resume !== undefined) {
    if (typeof resume === "string") {
      const decision = coerceDecision(resume)
      return decision ? { dawnInput: { messages: [] }, resumeDecision: decision } : { dawnInput: { messages: [] } }
    }
    if (resume && typeof resume === "object") {
      const r = resume as { decision?: unknown; interruptId?: unknown }
      const decision = coerceDecision(r.decision)
      const interruptId = typeof r.interruptId === "string" ? r.interruptId : undefined
      return {
        dawnInput: { messages: [] },
        ...(decision ? { resumeDecision: decision } : {}),
        ...(interruptId ? { interruptId } : {}),
      }
    }
  }

  const lastUser = [...input.messages].reverse().find((m) => m.role === "user")
  const content =
    lastUser && typeof lastUser.content === "string" ? lastUser.content : lastUser ? "" : undefined
  return {
    dawnInput: { messages: content === undefined ? [] : [{ role: "user", content }] },
  }
}
```

- [ ] **Step 4: Export it.** Append to `packages/ag-ui/src/index.ts`:

```ts
export { mapRunInput, type MappedRunInput, type ResumeDecision } from "./run-input.js"
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/src/run-input.ts packages/ag-ui/src/index.ts packages/ag-ui/test/run-input.test.ts
git commit -m "feat(ag-ui): map RunAgentInput to a Dawn run (+ resume decoding)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: SSE encode helper + conformance test against `@ag-ui/client`

The big de-risker: stand up a real `node:http` server that serves translated **canned** Dawn chunks, drive it with `@ag-ui/client`'s `HttpAgent`, and run the stream through the exported `verifyEvents` oracle. No model, no CLI — proves translate + encode + client-parse + ordering end to end.

**Files:** Create `packages/ag-ui/src/encode.ts`; Test: `packages/ag-ui/test/conformance.test.ts`.

- [ ] **Step 1: Write `packages/ag-ui/src/encode.ts`:**

```ts
import { EventEncoder } from "@ag-ui/encoder"
import type { AgUiEvent } from "./types.js"

/** Encode one AG-UI event as an SSE frame (`data: <json>\n\n`). */
export function encodeAgUiSse(event: AgUiEvent, accept?: string): string {
  const encoder = new EventEncoder(accept ? { accept } : {})
  return encoder.encode(event)
}
```

Append to `packages/ag-ui/src/index.ts`:

```ts
export { encodeAgUiSse } from "./encode.js"
```

- [ ] **Step 2: Write the failing conformance test** `packages/ag-ui/test/conformance.test.ts`:

```ts
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { EventType } from "@ag-ui/core"
import { HttpAgent } from "@ag-ui/client"
import { verifyEvents } from "@ag-ui/client"
import { lastValueFrom, toArray } from "rxjs"
import { afterEach, expect, it } from "vitest"
import { createAgUiTranslator } from "../src/translate.js"
import { encodeAgUiSse } from "../src/encode.js"
import type { DawnStreamChunk } from "../src/types.js"

let server: Server | undefined
afterEach(() => server?.close())

// A canned Dawn run exercising every mapping branch.
const CANNED: DawnStreamChunk[] = [
  { type: "token", data: "Researching" },
  { type: "tool_call", name: "searchCorpus", input: { query: "agents" } },
  { type: "tool_result", name: "searchCorpus", output: [{ path: "corpus/a.md" }] },
  { type: "plan_update", data: { todos: [{ content: "search", status: "completed" }] } },
  { type: "subagent.start", data: { call_id: "c1", subagent: "researcher" } },
  { type: "token", data: " done. [corpus/a.md]" },
  { type: "done", output: { messages: [] } },
]

async function startCannedServer(): Promise<string> {
  server = createServer((req, res) => {
    // Consume the RunAgentInput body (required by HttpAgent POST).
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const t = createAgUiTranslator({ threadId: "t1", runId: "r1" })
    for (const e of t.begin()) res.write(encodeAgUiSse(e))
    for (const chunk of CANNED) for (const e of t.translate(chunk)) res.write(encodeAgUiSse(e))
    for (const e of t.end()) res.write(encodeAgUiSse(e))
    res.end()
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

it("produces an AG-UI stream that @ag-ui/client parses and verifyEvents accepts", async () => {
  const url = await startCannedServer()
  const agent = new HttpAgent({ url })
  const input = {
    threadId: "t1",
    runId: "r1",
    state: {},
    messages: [{ id: "1", role: "user", content: "research agents" }],
    tools: [],
    context: [],
    forwardedProps: {},
  }
  // verifyEvents throws on any ordering/schema violation — the oracle.
  const events = await lastValueFrom(agent.run(input as never).pipe(verifyEvents(false), toArray()))
  const kinds = events.map((e) => e.type)
  expect(kinds[0]).toBe(EventType.RUN_STARTED)
  expect(kinds).toContain(EventType.TOOL_CALL_START)
  expect(kinds).toContain(EventType.TOOL_CALL_RESULT)
  expect(kinds).toContain(EventType.STATE_SNAPSHOT)
  expect(kinds).toContain(EventType.CUSTOM)
  expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test test/conformance.test.ts`
Expected: FAIL first because `encode.ts` is new / imports unresolved, then (once compiling) it must PASS. If `agent.run(...)` has a different signature in the installed `@ag-ui/client@0.0.57`, adapt the call to the installed `.d.ts` (e.g. `agent.runAgent()` returning `{ newMessages }`), keeping the intent: consume the stream through `verifyEvents` and assert the event kinds. Document any adaptation in the commit body.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS — all four test files green, including the `verifyEvents` conformance oracle.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/encode.ts packages/ag-ui/src/index.ts packages/ag-ui/test/conformance.test.ts
git commit -m "test(ag-ui): conformance via real @ag-ui/client HttpAgent + verifyEvents

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: CLI — the `/agui/{routeId}` handler

**Files:** Modify `packages/cli/package.json`, `packages/cli/tsconfig.build.json`; Create `packages/cli/src/lib/dev/agui-handler.ts`; Modify `packages/cli/src/lib/dev/runtime-server.ts`.

- [ ] **Step 1: Add the dependency + project reference.**

In `packages/cli/package.json`, add to `dependencies` (alphabetically): `"@dawn-ai/ag-ui": "workspace:*"`.
In `packages/cli/tsconfig.build.json`, add `{ "path": "../ag-ui" }` to the `references` array.
Run: `pnpm install`
Expected: links `@dawn-ai/ag-ui` into the CLI.

- [ ] **Step 2: Create `packages/cli/src/lib/dev/agui-handler.ts`.** This mirrors `handleApStreamRequest`'s thread/stream shape but emits AG-UI. It reuses the closure deps the route table already has.

```ts
import type { IncomingMessage, ServerResponse } from "node:http"
import { RunAgentInputSchema } from "@ag-ui/core"
import { createAgUiTranslator, encodeAgUiSse, mapRunInput } from "@dawn-ai/ag-ui"
import { streamResolvedRoute } from "../runtime/execute-route.js"
import type { RuntimeRegistry } from "./runtime-registry.js"
import type { SandboxManager } from "../sandbox/sandbox-manager.js"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"

interface AgUiRequestOptions {
  readonly appRoot: string
  readonly registry: RuntimeRegistry
  readonly threadsStore: ThreadsStore
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly routeKey: string
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString("utf8")
}

export async function handleAgUiRequest(options: AgUiRequestOptions): Promise<void> {
  const { appRoot, registry, threadsStore, sandboxManager, signal, request, response, routeKey } =
    options

  const raw = await readBody(request)
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    response.statusCode = 400
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ error: { kind: "request_error", message: "Malformed body" } }))
    return
  }
  const parsed = RunAgentInputSchema.safeParse(parsedJson)
  if (!parsed.success) {
    response.statusCode = 400
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ error: { kind: "request_error", message: "Invalid RunAgentInput" } }))
    return
  }
  const input = parsed.data

  const route = registry.lookup(routeKey)
  if (!route) {
    response.statusCode = 404
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ error: { kind: "request_error", message: `Unknown route: ${routeKey}` } }))
    return
  }

  const threadId = input.threadId
  const existing = await threadsStore.getThread(threadId)
  if (!existing) await threadsStore.createThread({ thread_id: threadId })

  const { dawnInput, resumeDecision } = mapRunInput(input)
  const translator = createAgUiTranslator({ threadId, runId: input.runId })

  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })
  for (const e of translator.begin()) response.write(encodeAgUiSse(e))

  try {
    for await (const chunk of streamResolvedRoute({
      appRoot,
      input: dawnInput,
      ...(resumeDecision ? { resumeDecision } : {}),
      routeFile: route.routeFile,
      routeId: route.routeId,
      routePath: route.routePath,
      ...(sandboxManager ? { sandboxManager } : {}),
      signal,
      threadId,
    })) {
      for (const e of translator.translate(chunk)) response.write(encodeAgUiSse(e))
    }
    for (const e of translator.end()) response.write(encodeAgUiSse(e))
  } catch (error) {
    response.write(
      encodeAgUiSse({
        type: "RUN_ERROR" as never,
        message: error instanceof Error ? error.message : String(error),
      } as never),
    )
  }
  response.end()
}
```

Note: verify the exact import paths of `RuntimeRegistry`, `SandboxManager`, `ThreadsStore`, and `streamResolvedRoute` against the tree (the seam report cites `./runtime-registry.js`, `../sandbox/sandbox-manager.js`, `@dawn-ai/sqlite-storage`, `../runtime/execute-route.js`); adjust to the real module paths if they differ. Prefer importing `streamResolvedRoute` from the same relative path `runtime-server.ts` uses.

- [ ] **Step 3: Mount the route.** In `packages/cli/src/lib/dev/runtime-server.ts`, import the handler at the top:

```ts
import { handleAgUiRequest } from "./agui-handler.js"
```

Add a route entry inside `buildRouteTable`'s routes array (next to the `runs/stream` entry):

```ts
{
  handle: async (req, res, params) => {
    await handleAgUiRequest({
      appRoot,
      registry,
      threadsStore,
      ...(sandboxManager ? { sandboxManager } : {}),
      signal,
      request: req,
      response: res,
      routeKey: params.routeId ?? "",
    })
  },
  method: "POST",
  pattern: /^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/,
},
```

- [ ] **Step 4: Build + typecheck the CLI**

Run: `pnpm exec turbo run build typecheck --filter=@dawn-ai/cli...`
Expected: `@dawn-ai/ag-ui` and `@dawn-ai/cli` build and typecheck clean. (The `...` includes dependencies.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.build.json packages/cli/src/lib/dev/agui-handler.ts packages/cli/src/lib/dev/runtime-server.ts pnpm-lock.yaml
git commit -m "feat(cli): mount POST /agui/{routeId} AG-UI endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: CLI — in-process endpoint e2e (deterministic, no key)

Boot the runtime listener in-process against a tiny agent fixture with aimock, POST a `RunAgentInput` to `/agui/<route>`, and assert an AG-UI SSE stream comes back. Mirrors the existing `packages/cli/test/runtime-request-listener.test.ts` pattern.

**Files:** Create `packages/cli/test/agui-endpoint.test.ts`.

- [ ] **Step 1: Write the test.** It calls the listener with a mock `req`/`res` (no port) and parses the SSE text. Use the aimock helper the CLI tests already use for a deterministic model. Model the fixture app + aimock wiring on an existing CLI runtime test that boots an agent route (search `packages/cli/test` for a test that streams an agent with aimock — reuse its `createAimock`/fixture setup verbatim).

```ts
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createRuntimeRequestListener } from "../src/lib/dev/runtime-server.js"
// Reuse the CLI test suite's aimock helper (adjust the import to the real path
// used by other packages/cli runtime tests, e.g. "./support/aimock" or
// "@dawn-ai/testing"). It must set process.env.OPENAI_BASE_URL to the mock.
import { createAimock, script } from "@dawn-ai/testing"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-agui-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default { appDir: 'src/app' }\n",
    "package.json": '{ "name": "agui-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      "import { agent } from '@dawn-ai/sdk'\nexport default agent({ model: 'gpt-5-mini', systemPrompt: 'You are helpful.' })\n",
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(appRoot, rel)
    await mkdir(join(p, ".."), { recursive: true })
    await writeFile(p, body, "utf8")
  }
  return appRoot
}

it("streams AG-UI events from POST /agui/<route>", async () => {
  const aimock = await createAimock({ fixtures: [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  cleanup.push(() => aimock.close())
  aimock.addFixtures(script().user("hello").replies("Hi there!").build())

  const appRoot = await fixtureApp()
  const { listener, close } = await createRuntimeRequestListener({ appRoot })
  cleanup.push(() => close())

  // Bind the pure listener to an ephemeral port so we can POST with fetch.
  const server: Server = createServer(listener)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
  const { port } = server.address() as AddressInfo

  const routeKey = encodeURIComponent("/chat#agent")
  const res = await fetch(`http://127.0.0.1:${port}/agui/${routeKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      threadId: "th1",
      runId: "rn1",
      state: {},
      messages: [{ id: "1", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  })
  const text = await res.text()
  expect(res.status).toBe(200)
  expect(text).toContain('"type":"RUN_STARTED"')
  expect(text).toContain('"type":"TEXT_MESSAGE_CONTENT"')
  expect(text).toContain("Hi there!")
  expect(text).toContain('"type":"RUN_FINISHED"')
}, 60_000)
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @dawn-ai/cli test test/agui-endpoint.test.ts`
Expected: PASS. If `createAimock`/`script` are imported from a different module in the CLI's test suite, fix the import to match a sibling CLI runtime test (they already do exactly this). If the agent input shape needs wrapping (`{ input: { messages } }` vs `{ messages }`), align `mapRunInput`/the fixture so the model receives the user message — the fixture's `.user("hello")` must match. Verify no `OPENAI_API_KEY` is required.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/agui-endpoint.test.ts
git commit -m "test(cli): in-process AG-UI endpoint e2e (aimock, no key)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Changeset + final gate

**Files:** Create `.changeset/ag-ui-capability.md`.

- [ ] **Step 1: Write the changeset.** Because `@dawn-ai/ag-ui` is now in the fixed group, a single `minor` entry versions the whole cohort together. Per the release runbook, a **minor** on a fixed 0.x group triggers a `1.0.0` bump — to keep it a patch cohort, use `patch`.

Create `.changeset/ag-ui-capability.md`:

```markdown
---
"@dawn-ai/ag-ui": patch
"@dawn-ai/cli": patch
---

Add `@dawn-ai/ag-ui`: translate Dawn's runtime stream to the AG-UI protocol and
serve it at `POST /agui/{routeId}`, so CopilotKit and other AG-UI clients can
drive Dawn agents. Additive — existing Agent-Protocol endpoints are unchanged.
```

- [ ] **Step 2: Run the affected-package gate**

Run:
```bash
pnpm --filter @dawn-ai/ag-ui test
pnpm exec turbo run build typecheck --filter=@dawn-ai/ag-ui --filter=@dawn-ai/cli
pnpm exec vitest --run --config vitest.workspace.ts packages/ag-ui
```
Expected: all green; the ag-ui project runs under the root vitest workspace.

- [ ] **Step 3: Commit**

```bash
git add .changeset/ag-ui-capability.md
git commit -m "chore(ag-ui): changeset for the AG-UI capability

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Release note (no code).** The first publish of `@dawn-ai/ag-ui` needs the one-time manual OIDC bootstrap before the Version PR merges (pack + `npm publish --access public` once, per the npm-release runbook and the `@dawn-ai/sandbox`/`@dawn-ai/memory` precedent). Record this in the PR description; do not attempt to publish from this plan.

---

## Self-Review

**Spec coverage (against `2026-07-07-ag-ui-copilotkit-ui-design.md`):**
- Additive `@dawn-ai/ag-ui` package → Tasks 1–6. ✓
- `/agui/{routeId}` endpoint, AP endpoints untouched → Task 7 (new route only). ✓
- Translator ported from `@ag-ui/langgraph`, tap Dawn's assembled stream, synthesize IDs, FIFO tool pairing → Task 3. ✓
- Snapshot-only state; `subagent.*`→CUSTOM; `interrupt`→CUSTOM `on_interrupt`; resume via `command.resume`→Dawn `resumeDecision` → Tasks 4, 5, 7. ✓
- Schema-validate every emitted event → Tasks 3–4 (parse through `@ag-ui/core` schemas). ✓
- `@ag-ui/client` `verifyEvents` conformance oracle → Task 6. ✓
- Pin `@ag-ui/*` → Task 1 (exact `0.0.57`). ✓
- Registration (changeset fixed group, vitest.workspace, OIDC note) → Tasks 1, 9. ✓
- Deterministic, no key → Tasks 6 (canned), 8 (aimock). ✓

**Placeholder scan:** No TBD/TODO; each code step has complete code; each command has an expected result. The two "verify the installed `.d.ts` / import path and adapt" notes (Tasks 6, 7, 8) are explicit fallbacks for the pre-1.0 SDK surface + CLI internal paths, not missing content.

**Type consistency:** `createAgUiTranslator(TranslatorOptions)` → `{begin,translate,end}` used identically in Tasks 3/4/6/7. `mapRunInput → {dawnInput, resumeDecision?, interruptId?}` consumed in Task 7. `encodeAgUiSse(event)` defined Task 6, used Task 7. `DawnStreamChunk` fields (`type/data/name/input/output`) consistent across translator + tests. `EventType`/schema names match the verified `@ag-ui/core` surface.

**Known adaptation points (pre-1.0 surface, flagged in-task):** exact `@ag-ui/client` run/consume method (Task 6), CLI internal import paths for `streamResolvedRoute`/`RuntimeRegistry`/`ThreadsStore`/`SandboxManager` (Task 7), and the CLI test's aimock helper import + agent input wrapping (Task 8). Each task tells the implementer to trust the installed types / sibling tests and adapt.
