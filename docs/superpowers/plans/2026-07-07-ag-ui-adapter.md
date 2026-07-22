# `@dawn-ai/ag-ui` Transport-Agnostic Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new leaf package `@dawn-ai/ag-ui` that maps Dawn agent stream events ↔ AG-UI protocol events in both directions, as a pure library with no transport/server commitment.

**Architecture:** A stateful async-generator (`toAguiEvents`) turns a Dawn `AgentStreamChunk` stream (`token | tool_call | tool_result | interrupt | done`) into AG-UI `BaseEvent`s, framing text/tool messages that Dawn emits implicitly. A pure function (`fromRunAgentInput`) maps AG-UI input (messages + interrupt-resume) back to a Dawn run input. A shared `interrupts.ts` module owns the Dawn-interrupt ↔ AG-UI-`Interrupt`/resume translation so the round-trip is lossless. One small additive core change surfaces the upstream tool-call id (LangGraph's per-invocation `run_id`) on the `tool_call`/`tool_result` chunks so AG-UI `toolCallId` correlation is faithful.

**Tech Stack:** TypeScript (ESM, NodeNext), `@ag-ui/core@^0.0.57` (event types + `EventType` enum), vitest, biome. Follows the existing `packages/permissions` leaf-package shape.

---

## Design decisions locked in (read before starting)

These were verified against the installed `@ag-ui/core@0.0.57` `.d.ts` and Dawn's source. Do not re-derive; do not deviate without flagging.

- **The mapper consumes the langchain `AgentStreamChunk` shape** — `{ type: string; data: unknown }` — NOT the flat CLI `StreamChunk`. `token` data is a `string`; `tool_call` data is `{ id?, name, input }`; `tool_result` data is `{ id?, name, output }`; `interrupt` data is the capability envelope `{ interruptId, kind, ... }`; `done` data is the final output. The package declares this shape structurally in `types.ts` and does **not** import `@dawn-ai/langchain`.
- **AG-UI event field shapes** (exact, from `@ag-ui/core`):
  - `RUN_STARTED`: `{ type, threadId, runId }`
  - `RUN_FINISHED`: `{ type, threadId, runId, outcome? }` — **threadId+runId are required**; `outcome` is `{ type: "success" }` or `{ type: "interrupt", interrupts: Interrupt[] }`
  - `RUN_ERROR`: `{ type, message, code? }` — no threadId/runId
  - `TEXT_MESSAGE_START`: `{ type, messageId, role }` (role default exists; we set `"assistant"`)
  - `TEXT_MESSAGE_CONTENT`: `{ type, messageId, delta }`
  - `TEXT_MESSAGE_END`: `{ type, messageId }`
  - `TOOL_CALL_START`: `{ type, toolCallId, toolCallName, parentMessageId? }`
  - `TOOL_CALL_ARGS`: `{ type, toolCallId, delta }`
  - `TOOL_CALL_END`: `{ type, toolCallId }`
  - `TOOL_CALL_RESULT`: `{ type, messageId, toolCallId, content, role? }`
  - `Interrupt`: `{ id, reason, message?, toolCallId?, responseSchema?, expiresAt?, metadata? }`
  - `RunAgentInput`: `{ threadId, runId, parentRunId?, state?, messages: Message[], tools?, context?, resume?, forwardedProps? }`
  - `RunAgentInput.resume`: `{ interruptId, status: "resolved" | "cancelled", payload? }[]`
  - `Message` (discriminated on `role`): user/assistant/system/developer carry `{ id, content }` (+ optional `name`, assistant `toolCalls?`); tool carries `{ id, role:"tool", content, toolCallId }`.
- **`EventType` is a runtime enum** — imported as a value (small runtime dep on `@ag-ui/core`; its transitive `zod@^3` is package-manager-isolated from Dawn's `zod@4` and only used for `@ag-ui/core`'s own schemas, which we never invoke).
- **`IdFactory` has three kinds:** `"message" | "toolCall" | "toolResult"` (the design spec listed two; a third `"toolCall"` kind is needed for the fallback id when a `tool_call` chunk arrives without an upstream id, and `"toolResult"` doubles for the result-message id). `runId`/`threadId` come from `RunContext`, never the factory; `toolCallId` comes from the upstream chunk `id`, falling back to `idFactory("toolCall")`.
- **Inbound resume is vocabulary-agnostic passthrough.** Dawn resumes per-interrupt via a `{ interrupt_id, decision }` POST to `/threads/:id/resume`; there is no single graph-level `Command({resume})` payload at the `RunAgentInput` layer. So `fromRunAgentInput` returns `resume?: DawnResumeRequest[]` preserving `interruptId` (+ `status`, `payload`); translating an entry to Dawn's `decision` vocabulary and hitting the endpoint is the **consumer's** job. The round-trip guarantee we test is: `interruptId` survives outbound→inbound losslessly.
- **Tests live in `test/**/*.test.ts`** (repo convention; the spec's "co-located" note is superseded).
- **No `dawn dev` wiring, no server, no STATE/CUSTOM mapping in v1** (out of scope per spec).

## File Structure

```
packages/ag-ui/
  package.json          # @dawn-ai/ag-ui, mirrors packages/permissions; dep on @ag-ui/core
  tsconfig.json         # extends ../config-typescript/node.json
  vitest.config.ts      # include test/**/*.test.ts
  src/
    index.ts            # public barrel
    types.ts            # RunContext, RawChunk, Dawn*Data, asToolCallData/asToolResultData guards
    ids.ts              # IdFactory, createCounterIdFactory (deterministic), createDefaultIdFactory
    interrupts.ts       # toAguiInterrupt, fromAguiResume, DawnInterruptEnvelope, DawnResumeRequest
    outbound.ts         # toAguiEvents (state machine) + stringify helpers + AguiOutboundEvent union
    inbound.ts          # fromRunAgentInput, DawnMessage, DawnRunInput, toDawnMessage
  test/
    ids.test.ts
    interrupts.test.ts
    outbound.test.ts
    inbound.test.ts
    round-trip.test.ts
```

Plus one modified file outside the package:
- `packages/langchain/src/agent-adapter.ts` — add `id: event.run_id` to `tool_call`/`tool_result` chunk data.
- `packages/langchain/test/agent-adapter-toolcall-id.test.ts` — new test for the above.

---

### Task 1: Scaffold the `@dawn-ai/ag-ui` package

**Files:**
- Create: `packages/ag-ui/package.json`
- Create: `packages/ag-ui/tsconfig.json`
- Create: `packages/ag-ui/vitest.config.ts`
- Create: `packages/ag-ui/src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@dawn-ai/ag-ui",
  "version": "0.8.8",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/cacheplane/dawnai/tree/main/packages/ag-ui#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/cacheplane/dawnai.git",
    "directory": "packages/ag-ui"
  },
  "bugs": {
    "url": "https://github.com/cacheplane/dawnai/issues"
  },
  "engines": {
    "node": ">=22.12.0"
  },
  "files": [
    "dist"
  ],
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ag-ui/core": "^0.0.57"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@types/node": "26.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

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

- [ ] **Step 3: Create `vitest.config.ts`**

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

- [ ] **Step 4: Create a placeholder `src/index.ts`** (replaced in Task 7)

```ts
export {}
```

- [ ] **Step 5: Install the new dependency and wire the workspace**

Run: `pnpm install`
Expected: pnpm adds `@dawn-ai/ag-ui` to the workspace (auto-matched by the `packages/*` glob in `pnpm-workspace.yaml`) and installs `@ag-ui/core@0.0.57`. No error.

- [ ] **Step 6: Verify it builds and typechecks**

Run: `pnpm --filter @dawn-ai/ag-ui build && pnpm --filter @dawn-ai/ag-ui typecheck`
Expected: both succeed with no output errors (empty package compiles).

- [ ] **Step 7: Commit**

```bash
git add packages/ag-ui pnpm-lock.yaml
git commit -m "feat(ag-ui): scaffold @dawn-ai/ag-ui package"
```

---

### Task 2: `ids.ts` — deterministic and default id factories

**Files:**
- Create: `packages/ag-ui/src/ids.ts`
- Test: `packages/ag-ui/test/ids.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest"
import { createCounterIdFactory, createDefaultIdFactory } from "../src/ids.js"

describe("createCounterIdFactory", () => {
  test("produces deterministic, kind-prefixed, monotonically increasing ids", () => {
    const id = createCounterIdFactory()
    expect(id("message")).toBe("msg-1")
    expect(id("message")).toBe("msg-2")
    expect(id("toolCall")).toBe("tc-1")
    expect(id("toolResult")).toBe("tr-1")
    expect(id("toolResult")).toBe("tr-2")
  })
})

describe("createDefaultIdFactory", () => {
  test("produces unique kind-prefixed ids", () => {
    const id = createDefaultIdFactory()
    const a = id("message")
    const b = id("message")
    expect(a).not.toBe(b)
    expect(a.startsWith("msg-")).toBe(true)
    expect(id("toolCall").startsWith("tc-")).toBe(true)
    expect(id("toolResult").startsWith("tr-")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: FAIL — `Cannot find module '../src/ids.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Generates ids for AG-UI events. `runId`/`threadId` never flow through here
 * (the consumer owns run identity via RunContext); a tool call's `toolCallId`
 * normally comes from the upstream chunk and only falls back to `"toolCall"`.
 */
export type IdFactory = (kind: "message" | "toolCall" | "toolResult") => string

const PREFIX: Record<"message" | "toolCall" | "toolResult", string> = {
  message: "msg",
  toolCall: "tc",
  toolResult: "tr",
}

/**
 * Deterministic, monotonically-increasing factory for tests: `msg-1`, `tc-1`,
 * `tr-1`, … Each kind has an independent counter.
 */
export function createCounterIdFactory(): IdFactory {
  const counters = { message: 0, toolCall: 0, toolResult: 0 }
  return (kind) => {
    counters[kind] += 1
    return `${PREFIX[kind]}-${counters[kind]}`
  }
}

/**
 * Default production factory: collision-resistant, non-deterministic ids using
 * the platform crypto UUID.
 */
export function createDefaultIdFactory(): IdFactory {
  return (kind) => `${PREFIX[kind]}-${crypto.randomUUID()}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS (both describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/ids.ts packages/ag-ui/test/ids.test.ts
git commit -m "feat(ag-ui): id factories (deterministic + default)"
```

---

### Task 3: `types.ts` — Dawn chunk input shape and guards

**Files:**
- Create: `packages/ag-ui/src/types.ts`
- Test: covered indirectly by later tasks; add a focused guard test here.
- Test: `packages/ag-ui/test/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest"
import { asToolCallData, asToolResultData } from "../src/types.js"

describe("asToolCallData", () => {
  test("extracts id/name/input when shape is valid", () => {
    expect(asToolCallData({ id: "run-1", name: "greet", input: { x: 1 } })).toEqual({
      id: "run-1",
      name: "greet",
      input: { x: 1 },
    })
  })

  test("returns undefined id when absent", () => {
    expect(asToolCallData({ name: "greet", input: {} })).toEqual({
      id: undefined,
      name: "greet",
      input: {},
    })
  })

  test("returns null when name missing or data not an object", () => {
    expect(asToolCallData({ input: {} })).toBeNull()
    expect(asToolCallData("nope")).toBeNull()
    expect(asToolCallData(null)).toBeNull()
  })
})

describe("asToolResultData", () => {
  test("extracts id/name/output", () => {
    expect(asToolResultData({ id: "run-1", name: "greet", output: "hi" })).toEqual({
      id: "run-1",
      name: "greet",
      output: "hi",
    })
  })

  test("returns null when name missing", () => {
    expect(asToolResultData({ output: "hi" })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: FAIL — `Cannot find module '../src/types.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/** Run identity the consumer supplies; never synthesized by the mapper. */
export interface RunContext {
  readonly threadId: string
  readonly runId: string
}

/**
 * The minimal Dawn stream-chunk shape the mapper consumes. Structurally
 * compatible with `AgentStreamChunk` from `@dawn-ai/langchain` (which is
 * `{ type: string; data: unknown }`), declared here so this package takes no
 * dependency on the langchain package.
 */
export interface RawChunk {
  readonly type: string
  readonly data?: unknown
}

export interface DawnToolCallData {
  readonly id?: string
  readonly name: string
  readonly input: unknown
}

export interface DawnToolResultData {
  readonly id?: string
  readonly name: string
  readonly output: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Validates and narrows a `tool_call` chunk's `data`. Returns null if malformed. */
export function asToolCallData(data: unknown): DawnToolCallData | null {
  if (!isRecord(data) || typeof data.name !== "string") return null
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    name: data.name,
    input: data.input,
  }
}

/** Validates and narrows a `tool_result` chunk's `data`. Returns null if malformed. */
export function asToolResultData(data: unknown): DawnToolResultData | null {
  if (!isRecord(data) || typeof data.name !== "string") return null
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    name: data.name,
    output: data.output,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/types.ts packages/ag-ui/test/types.test.ts
git commit -m "feat(ag-ui): Dawn chunk input types + guards"
```

---

### Task 4: `interrupts.ts` — interrupt/resume translation

**Files:**
- Create: `packages/ag-ui/src/interrupts.ts`
- Test: `packages/ag-ui/test/interrupts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest"
import { fromAguiResume, toAguiInterrupt } from "../src/interrupts.js"

describe("toAguiInterrupt", () => {
  test("maps a Dawn interrupt envelope to an AG-UI Interrupt, preserving the envelope as metadata", () => {
    const envelope = {
      interruptId: "perm-1",
      kind: "command",
      type: "permission-request",
      detail: { command: "ls" },
    }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-1",
      reason: "command",
      metadata: envelope,
    })
  })

  test("carries an optional human message and toolCallId when present", () => {
    const envelope = { interruptId: "perm-2", kind: "tool", message: "Approve?", toolCallId: "tc-9" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-2",
      reason: "tool",
      message: "Approve?",
      toolCallId: "tc-9",
      metadata: envelope,
    })
  })

  test("falls back to empty id and 'interrupt' reason for a malformed envelope", () => {
    expect(toAguiInterrupt(null)).toEqual({ id: "", reason: "interrupt", metadata: {} })
  })
})

describe("fromAguiResume", () => {
  test("maps AG-UI resume entries to Dawn resume requests, preserving interruptId", () => {
    expect(
      fromAguiResume([
        { interruptId: "perm-1", status: "resolved", payload: "once" },
        { interruptId: "perm-2", status: "cancelled" },
      ]),
    ).toEqual([
      { interruptId: "perm-1", status: "resolved", payload: "once" },
      { interruptId: "perm-2", status: "cancelled" },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: FAIL — `Cannot find module '../src/interrupts.js'`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Interrupt } from "@ag-ui/core"

/**
 * The interrupt envelope Dawn's capabilities emit inside an `interrupt` chunk
 * (`entry.value` from LangGraph). Always carries `interruptId`; other keys are
 * capability-specific and preserved verbatim.
 */
export interface DawnInterruptEnvelope {
  readonly interruptId: string
  readonly kind?: string
  readonly message?: string
  readonly toolCallId?: string
  readonly [key: string]: unknown
}

/** A resume instruction addressed to one open Dawn interrupt. */
export interface DawnResumeRequest {
  readonly interruptId: string
  readonly status: "resolved" | "cancelled"
  readonly payload?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Map a Dawn interrupt envelope to an AG-UI `Interrupt`. The full envelope is
 * preserved under `metadata` so no capability-specific information is lost on
 * the way to the client.
 */
export function toAguiInterrupt(data: unknown): Interrupt {
  const env = isRecord(data) ? data : {}
  const interruptId = typeof env.interruptId === "string" ? env.interruptId : ""
  const reason = typeof env.kind === "string" ? env.kind : "interrupt"
  return {
    id: interruptId,
    reason,
    ...(typeof env.message === "string" ? { message: env.message } : {}),
    ...(typeof env.toolCallId === "string" ? { toolCallId: env.toolCallId } : {}),
    metadata: env,
  }
}

/**
 * Map AG-UI resume entries to Dawn resume requests. Vocabulary-agnostic: the
 * consumer decides how a `{ status, payload }` becomes Dawn's per-interrupt
 * decision. We only guarantee `interruptId` survives.
 */
export function fromAguiResume(
  resume: ReadonlyArray<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>,
): DawnResumeRequest[] {
  return resume.map((entry) => ({
    interruptId: entry.interruptId,
    status: entry.status,
    ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/interrupts.ts packages/ag-ui/test/interrupts.test.ts
git commit -m "feat(ag-ui): interrupt/resume translation"
```

---

### Task 5: `outbound.ts` — `toAguiEvents` state machine

**Files:**
- Create: `packages/ag-ui/src/outbound.ts`
- Test: `packages/ag-ui/test/outbound.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { createCounterIdFactory } from "../src/ids.js"
import type { RawChunk } from "../src/types.js"
import { toAguiEvents } from "../src/outbound.js"

const CTX = { threadId: "th-1", runId: "rn-1" }

async function collect(chunks: RawChunk[]) {
  const out = []
  for await (const ev of toAguiEvents(toAsync(chunks), CTX, {
    idFactory: createCounterIdFactory(),
  })) {
    out.push(ev)
  }
  return out
}

async function* toAsync(items: RawChunk[]) {
  for (const item of items) yield item
}

describe("toAguiEvents", () => {
  test("text-only stream: run start, framed message, run finished success", async () => {
    const events = await collect([
      { type: "token", data: "Hel" },
      { type: "token", data: "lo" },
      { type: "done", data: {} },
    ])
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "lo" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" },
      { type: EventType.RUN_FINISHED, threadId: "th-1", runId: "rn-1", outcome: { type: "success" } },
    ])
  })

  test("tool call + result: correlated by upstream id, single args frame", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-abc", name: "greet", input: { name: "World" } } },
      { type: "tool_result", data: { id: "run-abc", name: "greet", output: { greeting: "hi" } } },
      { type: "done", data: {} },
    ])
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
      { type: EventType.TOOL_CALL_START, toolCallId: "run-abc", toolCallName: "greet" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "run-abc", delta: '{"name":"World"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "run-abc" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr-1",
        toolCallId: "run-abc",
        content: '{"greeting":"hi"}',
      },
      { type: EventType.RUN_FINISHED, threadId: "th-1", runId: "rn-1", outcome: { type: "success" } },
    ])
  })

  test("interleaved text then tool: open message is flushed before the tool call", async () => {
    const events = await collect([
      { type: "token", data: "thinking" },
      { type: "tool_call", data: { id: "run-x", name: "noop", input: {} } },
      { type: "done", data: {} },
    ])
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("repeated calls to the same tool get distinct toolCallIds from their upstream ids", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "run-1", name: "t", input: {} } },
      { type: "tool_call", data: { id: "run-2", name: "t", input: {} } },
      { type: "done", data: {} },
    ])
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START)
    expect(starts.map((e) => (e as { toolCallId: string }).toolCallId)).toEqual(["run-1", "run-2"])
  })

  test("interrupt: emits RUN_FINISHED with an interrupt outcome and stops", async () => {
    const events = await collect([
      { type: "token", data: "hi" },
      { type: "interrupt", data: { interruptId: "perm-1", kind: "command" } },
      { type: "done", data: {} }, // must be ignored after interrupt
    ])
    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "th-1",
      runId: "rn-1",
      outcome: { type: "interrupt", interrupts: [{ id: "perm-1", reason: "command", metadata: { interruptId: "perm-1", kind: "command" } }] },
    })
    // exactly one RUN_FINISHED (done after interrupt was ignored)
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(1)
  })

  test("empty stream (done only): run start then success", async () => {
    const events = await collect([{ type: "done", data: {} }])
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" },
      { type: EventType.RUN_FINISHED, threadId: "th-1", runId: "rn-1", outcome: { type: "success" } },
    ])
  })

  test("stream that ends without a done chunk still flushes and finishes success", async () => {
    const events = await collect([{ type: "token", data: "x" }])
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  test("tool_result with a missing upstream id still emits a result with a synthesized toolCallId", async () => {
    const events = await collect([
      { type: "tool_result", data: { name: "greet", output: "hi" } },
      { type: "done", data: {} },
    ])
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as {
      toolCallId: string
      messageId: string
      content: string
    }
    expect(result.content).toBe("hi")
    expect(result.toolCallId).toBe("tc-1") // fallback id
    expect(result.messageId).toBe("tr-1")
  })

  test("upstream throw is emitted as RUN_ERROR, not thrown to the consumer", async () => {
    async function* boom(): AsyncGenerator<RawChunk> {
      yield { type: "token", data: "hi" }
      throw new Error("kaboom")
    }
    const out = []
    for await (const ev of toAguiEvents(boom(), CTX, { idFactory: createCounterIdFactory() })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "kaboom" })
    // the open text message was flushed before the error
    expect(out.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: FAIL — `Cannot find module '../src/outbound.js'`.

- [ ] **Step 3: Write the implementation**

```ts
import { EventType } from "@ag-ui/core"
import type {
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core"
import { createDefaultIdFactory, type IdFactory } from "./ids.js"
import { toAguiInterrupt } from "./interrupts.js"
import { asToolCallData, asToolResultData, type RawChunk, type RunContext } from "./types.js"

/** The AG-UI events this mapper can emit. */
export type AguiOutboundEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent

export interface ToAguiOptions {
  readonly idFactory?: IdFactory
}

function stringifyArgs(input: unknown): string {
  if (input === undefined || input === null) return "{}"
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return "{}"
  }
}

function stringifyContent(output: unknown): string {
  if (typeof output === "string") return output
  if (output === undefined || output === null) return ""
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/**
 * Map a Dawn agent stream (`token | tool_call | tool_result | interrupt |
 * done`) to an AG-UI event stream. Stateful: it frames assistant text and tool
 * calls that Dawn emits implicitly, and it never throws into the consumer — an
 * upstream error becomes a `RUN_ERROR` event and a clean return.
 */
export async function* toAguiEvents(
  chunks: AsyncIterable<RawChunk>,
  ctx: RunContext,
  options: ToAguiOptions = {},
): AsyncGenerator<AguiOutboundEvent> {
  const nextId = options.idFactory ?? createDefaultIdFactory()
  let openMessageId: string | null = null

  function* flushText(): Generator<TextMessageEndEvent> {
    if (openMessageId !== null) {
      yield { type: EventType.TEXT_MESSAGE_END, messageId: openMessageId }
      openMessageId = null
    }
  }

  yield { type: EventType.RUN_STARTED, threadId: ctx.threadId, runId: ctx.runId }

  try {
    for await (const chunk of chunks) {
      switch (chunk.type) {
        case "token": {
          const delta = typeof chunk.data === "string" ? chunk.data : ""
          if (delta.length === 0) break
          if (openMessageId === null) {
            openMessageId = nextId("message")
            yield { type: EventType.TEXT_MESSAGE_START, messageId: openMessageId, role: "assistant" }
          }
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: openMessageId, delta }
          break
        }
        case "tool_call": {
          yield* flushText()
          const tc = asToolCallData(chunk.data)
          if (!tc) break
          const toolCallId = tc.id ?? nextId("toolCall")
          yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: tc.name }
          yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: stringifyArgs(tc.input) }
          yield { type: EventType.TOOL_CALL_END, toolCallId }
          break
        }
        case "tool_result": {
          yield* flushText()
          const tr = asToolResultData(chunk.data)
          if (!tr) break
          const toolCallId = tr.id ?? nextId("toolCall")
          const messageId = nextId("toolResult")
          yield {
            type: EventType.TOOL_CALL_RESULT,
            messageId,
            toolCallId,
            content: stringifyContent(tr.output),
          }
          break
        }
        case "interrupt": {
          yield* flushText()
          yield {
            type: EventType.RUN_FINISHED,
            threadId: ctx.threadId,
            runId: ctx.runId,
            outcome: { type: "interrupt", interrupts: [toAguiInterrupt(chunk.data)] },
          }
          return
        }
        case "done": {
          yield* flushText()
          yield {
            type: EventType.RUN_FINISHED,
            threadId: ctx.threadId,
            runId: ctx.runId,
            outcome: { type: "success" },
          }
          return
        }
        default:
          // Unknown/capability chunk types (e.g. plan_update) have no v1
          // AG-UI mapping — ignore them.
          break
      }
    }
    // Stream ended without an explicit done/interrupt: flush and finish.
    yield* flushText()
    yield {
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: { type: "success" },
    }
  } catch (err) {
    yield* flushText()
    yield { type: EventType.RUN_ERROR, message: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS (all 9 cases green).

> If TypeScript complains that an object literal is not assignable to the event
> type (e.g. an excess-property or enum-literal mismatch), it means the
> constructed shape drifted from `@ag-ui/core`. Re-check the field list in the
> "Design decisions" section — do NOT add `as` casts to silence it.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts
git commit -m "feat(ag-ui): toAguiEvents outbound stream mapper"
```

---

### Task 6: `inbound.ts` — `fromRunAgentInput`

**Files:**
- Create: `packages/ag-ui/src/inbound.ts`
- Test: `packages/ag-ui/test/inbound.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import type { RunAgentInput } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { fromRunAgentInput } from "../src/inbound.js"

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "th-1",
    runId: "rn-1",
    messages: [],
    tools: [],
    context: [],
    ...overrides,
  } as RunAgentInput
}

describe("fromRunAgentInput", () => {
  test("maps user and assistant messages to Dawn messages", () => {
    const input = baseInput({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "hello" },
      ],
    } as Partial<RunAgentInput>)
    const result = fromRunAgentInput(input)
    expect(result.messages).toEqual([
      { role: "user", content: "hi", id: "m1" },
      { role: "assistant", content: "hello", id: "m2" },
    ])
    expect(result.resume).toBeUndefined()
    expect(result.raw).toBe(input)
  })

  test("maps a tool message, preserving toolCallId", () => {
    const input = baseInput({
      messages: [{ id: "m1", role: "tool", content: "42", toolCallId: "tc-9" }],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages).toEqual([
      { role: "tool", content: "42", id: "m1", toolCallId: "tc-9" },
    ])
  })

  test("stringifies non-string content", () => {
    const input = baseInput({
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
    } as unknown as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages[0]?.content).toBe('[{"type":"text","text":"hi"}]')
  })

  test("maps a resume array to Dawn resume requests", () => {
    const input = baseInput({
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).resume).toEqual([
      { interruptId: "perm-1", status: "resolved", payload: "once" },
    ])
  })

  test("raw preserves the original input for tools/state/context access", () => {
    const input = baseInput({ state: { a: 1 } } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).raw).toBe(input)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: FAIL — `Cannot find module '../src/inbound.js'`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Message, RunAgentInput } from "@ag-ui/core"
import { type DawnResumeRequest, fromAguiResume } from "./interrupts.js"

export interface DawnMessage {
  readonly role: "user" | "assistant" | "system" | "developer" | "tool"
  readonly content: string
  readonly id?: string
  readonly toolCallId?: string
}

export interface DawnRunInput {
  readonly messages: DawnMessage[]
  readonly resume?: DawnResumeRequest[]
  /** The untouched AG-UI input, so a consumer can reach tools/state/context. */
  readonly raw: RunAgentInput
}

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function toDawnMessage(message: Message): DawnMessage {
  const content = coerceContent((message as { content?: unknown }).content)
  if (message.role === "tool") {
    return {
      role: "tool",
      content,
      id: message.id,
      toolCallId: (message as { toolCallId: string }).toolCallId,
    }
  }
  return { role: message.role, content, id: message.id }
}

/**
 * Map an AG-UI `RunAgentInput` to a Dawn run input. Messages are translated
 * structurally; a `resume` array becomes vocabulary-agnostic Dawn resume
 * requests (see `fromAguiResume`). `tools`/`state`/`context` are not
 * interpreted in v1 — reach them via `raw`.
 */
export function fromRunAgentInput(input: RunAgentInput): DawnRunInput {
  const messages = input.messages.map(toDawnMessage)
  const resume =
    input.resume && input.resume.length > 0 ? fromAguiResume(input.resume) : undefined
  return { messages, ...(resume ? { resume } : {}), raw: input }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/inbound.ts packages/ag-ui/test/inbound.test.ts
git commit -m "feat(ag-ui): fromRunAgentInput inbound mapper"
```

---

### Task 7: `index.ts` barrel + interrupt round-trip test

**Files:**
- Modify: `packages/ag-ui/src/index.ts`
- Test: `packages/ag-ui/test/round-trip.test.ts`

- [ ] **Step 1: Write the failing round-trip test**

```ts
import { EventType, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { createCounterIdFactory, fromRunAgentInput, toAguiEvents } from "../src/index.js"
import type { RawChunk } from "../src/index.js"

async function* one(chunk: RawChunk) {
  yield chunk
  yield { type: "done", data: {} } as RawChunk
}

describe("interrupt round-trip", () => {
  test("a Dawn interrupt's id survives outbound -> AG-UI -> resume input -> Dawn resume", async () => {
    // 1. Dawn emits an interrupt; map it outbound.
    const events = []
    for await (const ev of toAguiEvents(one({ type: "interrupt", data: { interruptId: "perm-42", kind: "command" } }), { threadId: "th", runId: "rn" }, { idFactory: createCounterIdFactory() })) {
      events.push(ev)
    }
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as {
      outcome: { type: string; interrupts: Array<{ id: string }> }
    }
    expect(finished.outcome.type).toBe("interrupt")
    const interruptId = finished.outcome.interrupts[0]?.id
    expect(interruptId).toBe("perm-42")

    // 2. The client answers with a resume RunAgentInput addressing that id.
    const resumeInput = {
      threadId: "th",
      runId: "rn-2",
      messages: [],
      tools: [],
      context: [],
      resume: [{ interruptId, status: "resolved", payload: "once" }],
    } as unknown as RunAgentInput

    // 3. Map it back to Dawn — the interruptId must survive.
    const dawn = fromRunAgentInput(resumeInput)
    expect(dawn.resume).toEqual([{ interruptId: "perm-42", status: "resolved", payload: "once" }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/ag-ui test`
Expected: FAIL — `../src/index.js` does not export `toAguiEvents` / `fromRunAgentInput` (barrel still `export {}`).

- [ ] **Step 3: Write the barrel**

```ts
export { toAguiEvents, type AguiOutboundEvent, type ToAguiOptions } from "./outbound.js"
export { fromRunAgentInput, type DawnMessage, type DawnRunInput } from "./inbound.js"
export {
  toAguiInterrupt,
  fromAguiResume,
  type DawnInterruptEnvelope,
  type DawnResumeRequest,
} from "./interrupts.js"
export { createCounterIdFactory, createDefaultIdFactory, type IdFactory } from "./ids.js"
export {
  asToolCallData,
  asToolResultData,
  type DawnToolCallData,
  type DawnToolResultData,
  type RawChunk,
  type RunContext,
} from "./types.js"
```

- [ ] **Step 4: Run test + full package suite + typecheck**

Run: `pnpm --filter @dawn-ai/ag-ui test && pnpm --filter @dawn-ai/ag-ui typecheck`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/index.ts packages/ag-ui/test/round-trip.test.ts
git commit -m "feat(ag-ui): public barrel + interrupt round-trip test"
```

---

### Task 8: Core change — surface the tool-call id on stream chunks

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts` (the `on_tool_start` and `on_tool_end` emit sites, ~lines 613–629)
- Test: `packages/langchain/test/agent-adapter-toolcall-id.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"

describe("streamAgent — tool-call id correlation", () => {
  test("tool_call and tool_result chunks carry the invocation run_id as data.id", async () => {
    const mockRunnable = {
      invoke: async () => ({}),
      streamEvents: async function* (_input: unknown, _options: Record<string, unknown>) {
        yield {
          event: "on_tool_start",
          name: "greet",
          run_id: "run-xyz",
          data: { input: { name: "World" } },
        }
        yield {
          event: "on_tool_end",
          name: "greet",
          run_id: "run-xyz",
          data: { output: { greeting: "Hello, World!" } },
        }
        yield { event: "on_chain_end", name: "LangGraph", data: { output: { messages: [] } } }
      },
    }

    const chunks: Array<{ type: string; data: unknown }> = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: mockRunnable,
      input: { messages: [{ role: "user", content: "greet" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push({ type: chunk.type, data: chunk.data })
    }

    const call = chunks.find((c) => c.type === "tool_call")
    const result = chunks.find((c) => c.type === "tool_result")
    expect((call?.data as { id?: string }).id).toBe("run-xyz")
    expect((result?.data as { id?: string }).id).toBe("run-xyz")
    // start and end of the same invocation share the id
    expect((call?.data as { id?: string }).id).toBe((result?.data as { id?: string }).id)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/langchain test -- agent-adapter-toolcall-id`
Expected: FAIL — `expected undefined to be "run-xyz"` (the chunk data has no `id` yet).

- [ ] **Step 3: Edit the `on_tool_start` emit site**

In `packages/langchain/src/agent-adapter.ts`, change the `on_tool_start` case from:

```ts
            case "on_tool_start": {
              hasYielded = true
              yield {
                type: "tool_call" as const,
                data: {
                  name: event.name,
                  input: event.data.input ?? event.data.chunk ?? event.data.output,
                },
              }
              break
            }
```

to:

```ts
            case "on_tool_start": {
              hasYielded = true
              yield {
                type: "tool_call" as const,
                data: {
                  // LangGraph assigns the same run_id to on_tool_start and
                  // on_tool_end of one invocation — a stable correlator that
                  // survives repeated calls to the same tool.
                  id: event.run_id,
                  name: event.name,
                  input: event.data.input ?? event.data.chunk ?? event.data.output,
                },
              }
              break
            }
```

- [ ] **Step 4: Edit the `on_tool_end` emit site**

Change the `on_tool_end` case's yield from:

```ts
            case "on_tool_end": {
              hasYielded = true
              yield {
                type: "tool_result" as const,
                data: { name: event.name, output: event.data.output },
              }
```

to:

```ts
            case "on_tool_end": {
              hasYielded = true
              yield {
                type: "tool_result" as const,
                data: { id: event.run_id, name: event.name, output: event.data.output },
              }
```

(Leave the `streamTransformers` loop that follows this yield unchanged.)

- [ ] **Step 5: Run the new test and the existing adapter suite**

Run: `pnpm --filter @dawn-ai/langchain test -- agent-adapter`
Expected: the new `agent-adapter-toolcall-id` test PASSES, and `agent-adapter.test.ts` / `agent-adapter-interrupt.test.ts` / `agent-adapter-retry.test.ts` remain green (the added optional `id` field does not break existing assertions, which use `toEqual` on `type` only or on interrupt/`data` payloads that don't touch tool_call/tool_result data shape).

> If an existing test asserts a `tool_call`/`tool_result` chunk's `data` with an
> exact `toEqual({ name, input })`, update that single assertion to include
> `id: expect.any(String)` — the field is now always present on these chunks.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/test/agent-adapter-toolcall-id.test.ts
git commit -m "feat(langchain): surface tool invocation run_id on tool_call/tool_result chunks"
```

---

### Task 9: Changeset + package README

**Files:**
- Create: `.changeset/ag-ui-adapter.md`
- Create: `packages/ag-ui/README.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/ag-ui-adapter.md`:

```markdown
---
"@dawn-ai/ag-ui": minor
"@dawn-ai/langchain": patch
---

Add `@dawn-ai/ag-ui`, a transport-agnostic adapter that maps Dawn agent stream
events to and from the AG-UI protocol. `toAguiEvents` turns a Dawn stream
(`token`/`tool_call`/`tool_result`/`interrupt`/`done`) into AG-UI events;
`fromRunAgentInput` maps AG-UI input (messages + interrupt resume) back to a Dawn
run input. No server or transport is bundled — consumers own the transport.

The langchain adapter now surfaces each tool invocation's `run_id` as `id` on its
`tool_call`/`tool_result` stream chunks, so AG-UI `toolCallId` correlation is
faithful even when a tool is called more than once.
```

> **Fixed-group 0.x gotcha (from the release memo):** the repo's changesets are a
> fixed group on 0.x, where a `minor` on any package bumps the whole group to
> `1.0.0`. If the intent is to stay on 0.8.x, change `"@dawn-ai/ag-ui": minor` to
> `patch` before versioning. Confirm the desired bump with the maintainer at
> release time; default to `patch` to hold the 0.x line.

- [ ] **Step 2: Write a short README**

Create `packages/ag-ui/README.md`:

```markdown
# @dawn-ai/ag-ui

Transport-agnostic adapter between Dawn agent stream events and the
[AG-UI protocol](https://docs.ag-ui.com). Pure functions — no HTTP server, no
transport, no LangGraph dependency.

## Outbound: Dawn stream → AG-UI events

```ts
import { toAguiEvents } from "@dawn-ai/ag-ui"

for await (const event of toAguiEvents(dawnChunks, { threadId, runId })) {
  // event is an AG-UI BaseEvent (RUN_STARTED, TEXT_MESSAGE_CONTENT,
  // TOOL_CALL_START, RUN_FINISHED, ...). Serialize it to your transport.
}
```

`dawnChunks` is any `AsyncIterable<{ type, data }>` shaped like the langchain
adapter's `AgentStreamChunk`.

## Inbound: AG-UI input → Dawn run input

```ts
import { fromRunAgentInput } from "@dawn-ai/ag-ui"

const { messages, resume, raw } = fromRunAgentInput(runAgentInput)
```

`resume` (when present) carries AG-UI interrupt answers keyed by `interruptId`;
translate them to your runtime's resume call. `raw` exposes the untouched AG-UI
input for `tools`/`state`/`context`.

## Interrupts

Dawn interrupts map to AG-UI `RUN_FINISHED { outcome: { type: "interrupt" } }`,
and AG-UI resume input maps back — the `interruptId` round-trips losslessly.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/ag-ui-adapter.md packages/ag-ui/README.md
git commit -m "docs(ag-ui): changeset + package README"
```

---

### Task 10: Full workspace verification + final review

**Files:** none (verification only)

- [ ] **Step 1: Build the new package and the modified one**

Run: `pnpm --filter @dawn-ai/ag-ui --filter @dawn-ai/langchain build`
Expected: both build clean.

- [ ] **Step 2: Typecheck both**

Run: `pnpm --filter @dawn-ai/ag-ui --filter @dawn-ai/langchain typecheck`
Expected: no type errors.

- [ ] **Step 3: Lint the new package**

Run: `pnpm --filter @dawn-ai/ag-ui lint`
Expected: biome reports no errors. Fix any formatting/lint findings and re-run.

- [ ] **Step 4: Run both test suites**

Run: `pnpm --filter @dawn-ai/ag-ui --filter @dawn-ai/langchain test`
Expected: all green, including the new `agent-adapter-toolcall-id` test and all pre-existing langchain tests.

- [ ] **Step 5: Sanity-check the whole build graph is not broken**

Run: `pnpm -w build`
Expected: the full workspace build succeeds (confirms the new package didn't break turbo/tsc wiring and nothing that imports langchain regressed).

- [ ] **Step 6: Final review against the spec**

Read `docs/superpowers/specs/2026-07-07-ag-ui-adapter-design.md` and confirm each in-scope item is implemented: outbound mapper (all chunk types + framing + error), inbound mapper (messages + resume + raw), interrupt round-trip, deterministic id injection, the core `run_id` change, graceful degradation (missing id, malformed chunk, upstream throw). Confirm out-of-scope items were NOT built (no server, no dawn dev wiring, no STATE/CUSTOM). Note anything deferred.

- [ ] **Step 7: Open the PR (only when the maintainer asks)**

Do not push or open a PR until the maintainer confirms. When asked:

```bash
git push -u origin blove/ag-ui-adapter
gh pr create --title "feat(ag-ui): transport-agnostic AG-UI adapter" --body "..."
```

---

## Self-review notes (author)

- **Spec coverage:** package/boundary (Task 1), outbound state machine incl. all chunk types + framing + ids + error (Task 5), core `run_id` change (Task 8), inbound incl. resume + raw (Task 6), interrupts module + round-trip (Tasks 4, 7), determinism via injected id factory (Task 2, used throughout), testing matrix (Tasks 3–7), changeset/README (Task 9), verification (Task 10). All spec sections map to a task.
- **Refinements over the spec, applied deliberately:** (1) `IdFactory` has three kinds (`message`/`toolCall`/`toolResult`) not two — needed for the missing-id fallback and the result-message id; (2) inbound `resume` is a vocabulary-agnostic `DawnResumeRequest[]` passthrough rather than a fabricated single `Command({resume})` payload, because Dawn resumes per-interrupt via `{interrupt_id, decision}` and no graph-level resume payload exists at the `RunAgentInput` layer; (3) the core change touches only `agent-adapter.ts` (the `AgentStreamChunk` the mapper actually consumes), not the CLI `stream-types.ts` — the CLI-serializer id is deferred to the future `dawn dev` wiring, which is out of scope; (4) tests live in `test/**/*.test.ts` per repo convention.
- **Type consistency:** `RawChunk`, `RunContext`, `DawnToolCallData`, `DawnToolResultData`, `IdFactory`, `AguiOutboundEvent`, `DawnMessage`, `DawnRunInput`, `DawnResumeRequest`, `DawnInterruptEnvelope`, `toAguiEvents`, `fromRunAgentInput`, `toAguiInterrupt`, `fromAguiResume`, `asToolCallData`, `asToolResultData`, `createCounterIdFactory`, `createDefaultIdFactory` — names are identical across every task and the barrel.
```
