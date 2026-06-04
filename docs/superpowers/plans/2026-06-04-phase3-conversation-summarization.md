# Conversation Summarization (Phase 3 / 6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in, non-destructive conversation summarization — a `preModelHook` feeds the model a condensed view (running summary + recent turns) once history crosses a token threshold, while full history stays in the checkpoint.

**Architecture:** `createReactAgent`'s `preModelHook` returns `{ llmInputMessages }` (used as LLM input, does NOT mutate saved `messages`). A pairing-safe split keeps recent turns verbatim and folds older turns into a cached running summary, refreshed incrementally. Token counting defaults to a lazily-loaded `gpt-tokenizer`; both the counter and summarizer are swappable via `dawn.config.ts`.

**Tech Stack:** TypeScript, `@langchain/langgraph@1.3.0` (`createReactAgent` + `preModelHook` + `llmInputMessages`), `@langchain/core` messages, `gpt-tokenizer`, vitest, `@copilotkit/aimock` (e2e). Packages: `@dawn-ai/core`, `@dawn-ai/langchain`, `@dawn-ai/cli`, root `test/`.

**Spec:** `docs/superpowers/specs/2026-06-04-phase3-conversation-summarization-design.md`
**Worktree:** `/Users/blove/repos/dawn-6b`, branch `feat/phase3-summarization`.

---

## File map

**Modify (prerequisite refactor — Task 1):**
- `packages/langchain/src/agent-adapter.ts` — `materializeAgent(...)` positional tail → single `opts` object; update 2 call sites.

**Create (summarization units — `packages/langchain/src/summarization/`):**
- `token-counter.ts` — `defaultTokenCounter`, `countMessagesTokens`.
- `split.ts` — `splitForSummary` (pairing-safe).
- `summarize.ts` — `defaultSummarize` (LLM call) + the summarization prompt.
- `hook.ts` — `buildSummarizationHook`, `ResolvedSummarizationConfig`, `RunningSummary`.
- `index.ts` — re-exports.

**Modify (config + wiring):**
- `packages/core/src/types.ts` — `DawnConfig.summarization?`.
- `packages/langchain/src/agent-adapter.ts` — accept `summarization` in `opts`; pass `preModelHook` + add `runningSummary` state field when enabled.
- `packages/langchain/src/index.ts` — export summarization public surface.
- `packages/cli/src/lib/runtime/execute-route.ts` — resolve `config.summarization` + route model, thread to the adapter.
- `packages/langchain/package.json` — add `gpt-tokenizer` dependency.

**Tests:**
- `packages/langchain/test/summarization-*.test.ts` (unit).
- `test/runtime/run-summarization-e2e.test.ts` + `test/runtime/fixtures/aimock/summarization.json` (aimock e2e).

---

## Task 1: Refactor `materializeAgent` to an options object (prerequisite)

**Context:** `materializeAgent` has 8 positional params; we're about to add a 9th (summarization). Collapse the optional tail into one `opts` object first. Private function — no public API change.

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`

- [ ] **Step 1: Read the current signature + both call sites**

Run: `grep -n "materializeAgent(" packages/langchain/src/agent-adapter.ts`
The signature is `materializeAgent(descriptor, tools, checkpointer, stateFields?, middlewareContext?, promptFragments?, options?, offload?)`. Call sites: `materializeAgentGraph` (~line 138) and the streaming path (~line 377).

- [ ] **Step 2: Change the signature to an options bag**

Keep the 3 required positionals; collapse the rest:

```ts
async function materializeAgent(
  descriptor: DawnAgent,
  tools: readonly DawnToolDefinition[],
  checkpointer: BaseCheckpointSaver,
  opts: {
    readonly stateFields?: readonly ResolvedStateField[]
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly promptFragments?: readonly PromptFragment[]
    readonly bypassCache?: boolean
    readonly offload?: OffloadFn
  } = {},
): Promise<AgentLike> {
```

In the body, replace `options?.bypassCache` → `opts.bypassCache`; `stateFields` → `opts.stateFields`; `middlewareContext` → `opts.middlewareContext`; `promptFragments` → `opts.promptFragments`; `offload` → `opts.offload`. (The `convertToolToLangChain(tool, middlewareContext, offload)` call becomes `convertToolToLangChain(tool, opts.middlewareContext, opts.offload)`; the `fragments = promptFragments ?? []` becomes `opts.promptFragments ?? []`; the `if (stateFields && stateFields.length > 0)` becomes `opts.stateFields`.)

- [ ] **Step 3: Update call site 1 (`materializeAgentGraph`, ~line 138)**

```ts
  return materializeAgent(options.descriptor, options.tools ?? [], options.checkpointer, {
    ...(options.stateFields ? { stateFields: options.stateFields } : {}),
    ...(options.promptFragments ? { promptFragments: options.promptFragments } : {}),
  })
```

- [ ] **Step 4: Update call site 2 (streaming path, ~line 377)**

```ts
    const materializedAgent = await materializeAgent(options.entry, effectiveTools, options.checkpointer, {
      ...(options.stateFields ? { stateFields: options.stateFields } : {}),
      ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
      ...(options.promptFragments ? { promptFragments: options.promptFragments } : {}),
      ...(resolver && hasTaskTool ? { bypassCache: true } : {}),
      ...(options.offload ? { offload: options.offload } : {}),
    })
```

- [ ] **Step 5: Build, typecheck, test**

Run: `pnpm --filter @dawn-ai/core --filter @dawn-ai/sdk --filter @dawn-ai/workspace --filter @dawn-ai/permissions --filter @dawn-ai/sqlite-storage --filter @dawn-ai/langchain build`
Run: `pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain test`
Expected: all green (pure refactor, behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts
git commit -m "refactor(langchain): collapse materializeAgent optional params into an options object"
```

---

## Task 2: `DawnConfig.summarization` config type + langchain ResolvedSummarizationConfig

**Files:**
- Modify: `packages/core/src/types.ts`
- Create: `packages/langchain/src/summarization/hook.ts` (types only in this task)

- [ ] **Step 1: Add `summarization` to `DawnConfig`**

In `packages/core/src/types.ts`, inside `DawnConfig` (sibling to `toolOutput`), add (place the import for `BaseMessage` if not present: `import type { BaseMessage } from "@langchain/core/messages"`):

```ts
  readonly summarization?: {
    /** Enable conversation summarization. Default false. */
    readonly enabled?: boolean
    /** Token threshold over which older history is summarized. Default 12000. */
    readonly maxTokens?: number
    /** Most-recent turns kept verbatim (a turn starts at a HumanMessage). Default 6. */
    readonly keepRecentTurns?: number
    /** Model id for the summary LLM call. Defaults to the route's model. */
    readonly model?: string
    /** Token counter. Default: a lazy gpt-tokenizer (o200k_base) counter. */
    readonly tokenCounter?: (text: string) => number
    /** Summary generator. Default: a built-in single-LLM-call summarizer. */
    readonly summarize?: (args: {
      readonly messages: readonly BaseMessage[]
      readonly model: string
      readonly previousSummary?: string
      readonly signal: AbortSignal
    }) => Promise<string>
  }
```

If `@langchain/core` is not already a dependency of `@dawn-ai/core`, prefer a structural type instead of importing `BaseMessage` to avoid a new dep: declare `readonly messages: readonly unknown[]` in the `summarize` arg. CHECK `packages/core/package.json` first; if `@langchain/core` is absent, use `unknown[]` and note it.

- [ ] **Step 2: Define the resolved config + RunningSummary types**

Create `packages/langchain/src/summarization/hook.ts` with just the types for now:

```ts
import type { BaseMessage } from "@langchain/core/messages"

export interface RunningSummary {
  readonly summary: string
  readonly coveredCount: number
}

export type TokenCounter = (text: string) => number

export type SummarizeFn = (args: {
  readonly messages: readonly BaseMessage[]
  readonly model: string
  readonly previousSummary?: string
  readonly signal: AbortSignal
}) => Promise<string>

export interface ResolvedSummarizationConfig {
  readonly maxTokens: number
  readonly keepRecentTurns: number
  readonly model: string
  readonly tokenCounter: TokenCounter
  readonly summarize: SummarizeFn
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @dawn-ai/core --filter @dawn-ai/langchain typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts packages/langchain/src/summarization/hook.ts
git commit -m "feat(core,langchain): add summarization config types"
```

---

## Task 3: Token counter (lazy gpt-tokenizer)

**Files:**
- Modify: `packages/langchain/package.json` (add `gpt-tokenizer`)
- Create: `packages/langchain/src/summarization/token-counter.ts`
- Test: `packages/langchain/test/summarization-token-counter.test.ts`

- [ ] **Step 1: Add the dependency**

Edit `packages/langchain/package.json` `dependencies`: add `"gpt-tokenizer": "^3.0.1"` (run `pnpm view gpt-tokenizer version` to pin the latest if 3.0.1 is stale; note which). Then `cd /Users/blove/repos/dawn-6b && pnpm install`.

- [ ] **Step 2: Write the failing test**

Create `packages/langchain/test/summarization-token-counter.test.ts`:

```ts
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { countMessagesTokens, defaultTokenCounter } from "../src/summarization/token-counter.js"

describe("defaultTokenCounter", () => {
  it("counts tokens for a plain string (close to word count for simple text)", async () => {
    const n = await defaultTokenCounter("hello world this is a test")
    expect(n).toBeGreaterThan(3)
    expect(n).toBeLessThan(15)
  })
})

describe("countMessagesTokens", () => {
  it("sums a synchronous counter across message contents incl. tool calls", async () => {
    // injected fake counter = char length, so totals are deterministic
    const counter = (t: string) => t.length
    const messages = [
      new HumanMessage("abc"),
      new AIMessage({ content: "", tool_calls: [{ id: "1", name: "t", args: { k: "v" } }] }),
      new ToolMessage({ content: "result", tool_call_id: "1" }),
    ]
    const total = await countMessagesTokens(messages, counter)
    // "abc"(3) + serialized tool_call (contains "t" and "v") + "result"(6) > 9
    expect(total).toBeGreaterThan(9)
  })
})
```

Note `defaultTokenCounter` is async (it lazy-imports). `countMessagesTokens` accepts a sync `TokenCounter` and awaits nothing for the fake; but since the default counter is async, define `countMessagesTokens` to accept `(text) => number | Promise<number>` and await each. Adjust the test's `await` accordingly.

- [ ] **Step 3: Run — expect FAIL**

Run: `pnpm --filter @dawn-ai/langchain test summarization-token-counter`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement**

Create `packages/langchain/src/summarization/token-counter.ts`:

```ts
import type { BaseMessage } from "@langchain/core/messages"

let encodeFn: ((text: string) => number[]) | undefined

/**
 * Default token counter. Lazily imports a single gpt-tokenizer encoding
 * (o200k_base — current OpenAI models) so apps that don't enable
 * summarization never load the ~1-2 MB tables. Async because of the lazy import.
 */
export async function defaultTokenCounter(text: string): Promise<number> {
  if (!encodeFn) {
    const mod = (await import("gpt-tokenizer/encoding/o200k_base")) as {
      encode: (t: string) => number[]
    }
    encodeFn = mod.encode
  }
  return encodeFn(text).length
}

function messageToText(m: BaseMessage): string {
  const parts: string[] = []
  if (typeof m.content === "string") parts.push(m.content)
  else parts.push(JSON.stringify(m.content))
  const toolCalls = (m as { tool_calls?: unknown }).tool_calls
  if (toolCalls) parts.push(JSON.stringify(toolCalls))
  return parts.join("\n")
}

/** Sum a (possibly async) token counter across a message list. */
export async function countMessagesTokens(
  messages: readonly BaseMessage[],
  counter: (text: string) => number | Promise<number>,
): Promise<number> {
  let total = 0
  for (const m of messages) {
    total += await counter(messageToText(m))
  }
  return total
}
```

- [ ] **Step 5: Run — expect PASS; typecheck + lint**

Run: `pnpm --filter @dawn-ai/langchain test summarization-token-counter && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint`
Expected: clean. (If `gpt-tokenizer/encoding/o200k_base` subpath doesn't resolve, check the package's exports map — the import may be `gpt-tokenizer/esm/encoding/o200k_base` or the default `gpt-tokenizer` with `encode`. Use the working subpath.)

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/package.json pnpm-lock.yaml packages/langchain/src/summarization/token-counter.ts packages/langchain/test/summarization-token-counter.test.ts
git commit -m "feat(langchain): default gpt-tokenizer token counter (lazy, single encoding)"
```

---

## Task 4: Pairing-safe `splitForSummary`

**Context:** Split the message list into `{ toSummarize, recent }`. `recent` = the last `keepRecentTurns` turns where a turn boundary is a `HumanMessage`. The boundary must never fall between an `AIMessage` with `tool_calls` and its `ToolMessage`s — since turns start at HumanMessages and tool rounds occur within a turn, slicing at a HumanMessage boundary is inherently pairing-safe. Handle the case where there are fewer than `keepRecentTurns` HumanMessages (keep everything as `recent`).

**Files:**
- Create: `packages/langchain/src/summarization/split.ts`
- Test: `packages/langchain/test/summarization-split.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { splitForSummary } from "../src/summarization/split.js"

const H = (c: string) => new HumanMessage(c)
const A = (c: string) => new AIMessage(c)
const AT = (id: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "t", args: {} }] })
const T = (id: string) => new ToolMessage({ content: "r", tool_call_id: id })

describe("splitForSummary", () => {
  it("keeps the last N turns verbatim and summarizes the rest", () => {
    const msgs = [H("u1"), A("a1"), H("u2"), A("a2"), H("u3"), A("a3")]
    const { toSummarize, recent } = splitForSummary(msgs, 2)
    // last 2 turns = [H(u2),A(a2),H(u3),A(a3)]; rest summarized
    expect(recent.map((m) => (m.content as string))).toEqual(["u2", "a2", "u3", "a3"])
    expect(toSummarize.map((m) => (m.content as string))).toEqual(["u1", "a1"])
  })

  it("never splits a tool round (recent starts on a HumanMessage)", () => {
    // turn 2 contains a tool round; keeping 1 turn must include the whole round
    const msgs = [H("u1"), A("a1"), H("u2"), AT("c1"), T("c1"), A("done")]
    const { toSummarize, recent } = splitForSummary(msgs, 1)
    expect((recent[0] as HumanMessage).content).toBe("u2")
    expect(recent).toHaveLength(4) // H,AT,T,A — the whole turn, tool round intact
    expect(toSummarize.map((m) => m.content as string)).toEqual(["u1", "a1"])
  })

  it("keeps everything as recent when fewer turns than keepRecentTurns", () => {
    const msgs = [H("u1"), A("a1")]
    const { toSummarize, recent } = splitForSummary(msgs, 5)
    expect(toSummarize).toEqual([])
    expect(recent).toEqual(msgs)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @dawn-ai/langchain test summarization-split`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/langchain/src/summarization/split.ts`:

```ts
import type { BaseMessage } from "@langchain/core/messages"

function isHuman(m: BaseMessage): boolean {
  // getType() is the stable accessor across @langchain/core versions.
  return typeof (m as { getType?: () => string }).getType === "function"
    ? (m as { getType: () => string }).getType() === "human"
    : (m as { _getType?: () => string })._getType?.() === "human"
}

/**
 * Split into { toSummarize, recent } keeping the last `keepRecentTurns` turns
 * verbatim. A turn begins at a HumanMessage; slicing on a HumanMessage boundary
 * keeps every tool round (AIMessage-with-tool_calls + its ToolMessages) intact,
 * so `recent` never starts mid-round. Fewer turns than requested → all recent.
 */
export function splitForSummary(
  messages: readonly BaseMessage[],
  keepRecentTurns: number,
): { toSummarize: BaseMessage[]; recent: BaseMessage[] } {
  if (keepRecentTurns <= 0) return { toSummarize: [...messages], recent: [] }
  // Indices of HumanMessages = turn starts.
  const humanIdx: number[] = []
  messages.forEach((m, i) => {
    if (isHuman(m)) humanIdx.push(i)
  })
  if (humanIdx.length <= keepRecentTurns) {
    return { toSummarize: [], recent: [...messages] }
  }
  const cut = humanIdx[humanIdx.length - keepRecentTurns] as number
  return { toSummarize: messages.slice(0, cut), recent: messages.slice(cut) }
}
```

- [ ] **Step 4: Run — expect PASS; lint + typecheck**

Run: `pnpm --filter @dawn-ai/langchain test summarization-split && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint`
Expected: clean. (If `getType`/`_getType` detection misbehaves, inspect a real `HumanMessage` instance — `new HumanMessage("x").getType()` returns `"human"` in @langchain/core 1.x. Use whichever the installed version exposes.)

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/summarization/split.ts packages/langchain/test/summarization-split.test.ts
git commit -m "feat(langchain): pairing-safe splitForSummary (turn-boundary slicing)"
```

---

## Task 5: Default summarizer (`defaultSummarize`)

**Files:**
- Create: `packages/langchain/src/summarization/summarize.ts`
- Test: `packages/langchain/test/summarization-summarize.test.ts`

- [ ] **Step 1: Write the failing test (inject a fake model via importer-style seam)**

`defaultSummarize` builds a chat model via `createChatModel` and calls it. To test without a network, accept an optional `invokeModel` override in the args (defaulting to the real path), so the test injects a fake. Test:

```ts
import { HumanMessage, AIMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { defaultSummarize } from "../src/summarization/summarize.js"

describe("defaultSummarize", () => {
  it("builds a prompt including previousSummary + messages and returns the model text", async () => {
    let seenPrompt = ""
    const result = await defaultSummarize({
      messages: [new HumanMessage("user asked about X"), new AIMessage("assistant answered Y")],
      model: "gpt-4o-mini",
      previousSummary: "Earlier: greeted.",
      signal: new AbortController().signal,
      invokeModel: async (prompt: string) => {
        seenPrompt = prompt
        return "Updated summary: greeted, discussed X→Y."
      },
    })
    expect(seenPrompt).toContain("Earlier: greeted.")     // folds previous summary
    expect(seenPrompt).toContain("user asked about X")     // includes new messages
    expect(result).toBe("Updated summary: greeted, discussed X→Y.")
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @dawn-ai/langchain test summarization-summarize`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/langchain/src/summarization/summarize.ts`:

```ts
import type { BaseMessage } from "@langchain/core/messages"
import { createChatModel } from "../chat-model-factory.js"
import { resolveProvider } from "../model-provider-resolver.js"

function renderMessages(messages: readonly BaseMessage[]): string {
  return messages
    .map((m) => {
      const role =
        typeof (m as { getType?: () => string }).getType === "function"
          ? (m as { getType: () => string }).getType()
          : "message"
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      const toolCalls = (m as { tool_calls?: unknown[] }).tool_calls
      const tc = toolCalls && toolCalls.length > 0 ? `\n[tool_calls: ${JSON.stringify(toolCalls)}]` : ""
      return `${role}: ${content}${tc}`
    })
    .join("\n")
}

function buildPrompt(messages: readonly BaseMessage[], previousSummary?: string): string {
  const prior = previousSummary
    ? `Existing running summary so far:\n${previousSummary}\n\n`
    : ""
  return (
    `${prior}New conversation messages to fold into the summary:\n${renderMessages(messages)}\n\n` +
    `Write an updated, concise running summary of the ENTIRE conversation so far. ` +
    `Preserve concrete facts, decisions, user goals, tool results, identifiers, and open questions. ` +
    `Do not invent information. Output only the summary text.`
  )
}

export async function defaultSummarize(args: {
  readonly messages: readonly BaseMessage[]
  readonly model: string
  readonly previousSummary?: string
  readonly signal: AbortSignal
  /** Test seam: override the model invocation. */
  readonly invokeModel?: (prompt: string) => Promise<string>
}): Promise<string> {
  const prompt = buildPrompt(args.messages, args.previousSummary)
  if (args.invokeModel) return args.invokeModel(prompt)

  const provider = resolveProvider({ model: args.model })
  const llm = (await createChatModel({ model: args.model, provider })) as {
    invoke: (input: unknown, options?: unknown) => Promise<{ content: unknown }>
  }
  const res = await llm.invoke([{ role: "user", content: prompt }], { signal: args.signal })
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content)
}
```

(Verify `resolveProvider`'s real signature in `packages/langchain/src/model-provider-resolver.ts` and adapt the call. Verify `createChatModel`'s return has `.invoke`.)

- [ ] **Step 4: Run — expect PASS; typecheck + lint**

Run: `pnpm --filter @dawn-ai/langchain test summarization-summarize && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/summarization/summarize.ts packages/langchain/test/summarization-summarize.test.ts
git commit -m "feat(langchain): default LLM summarizer with running-summary prompt"
```

---

## Task 6: `buildSummarizationHook` (the preModelHook)

**Files:**
- Modify: `packages/langchain/src/summarization/hook.ts`
- Create: `packages/langchain/src/summarization/index.ts`
- Test: `packages/langchain/test/summarization-hook.test.ts`

- [ ] **Step 1: Write the failing test (fakes for counter + summarize, no LLM)**

```ts
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"
import { buildSummarizationHook } from "../src/summarization/hook.js"

const H = (c: string) => new HumanMessage(c)
const A = (c: string) => new AIMessage(c)

function cfg(over: Partial<Parameters<typeof buildSummarizationHook>[0]> = {}) {
  return buildSummarizationHook({
    maxTokens: 100,
    keepRecentTurns: 1,
    model: "fake",
    tokenCounter: (t) => t.length, // chars as tokens
    summarize: async () => "SUMMARY",
    ...over,
  })
}

describe("buildSummarizationHook", () => {
  it("returns {} (no condensation) when under threshold", async () => {
    const hook = cfg({ maxTokens: 10_000 })
    const out = await hook({ messages: [H("hi"), A("yo")] })
    expect(out).toEqual({})
  })

  it("returns condensed llmInputMessages + runningSummary when over threshold", async () => {
    const hook = cfg({ maxTokens: 5, keepRecentTurns: 1 })
    const msgs = [H("u1"), A("a1"), H("u2"), A("a2")]
    const out = await hook({ messages: msgs })
    expect(Array.isArray(out.llmInputMessages)).toBe(true)
    // [summaryMessage, ...recent(last turn = H(u2),A(a2))]
    const texts = (out.llmInputMessages as Array<{ content: string }>).map((m) => m.content)
    expect(texts[0]).toContain("SUMMARY")
    expect(texts.slice(1)).toEqual(["u2", "a2"])
    expect(out.runningSummary).toMatchObject({ summary: "SUMMARY" })
  })

  it("incrementally folds only newly-aged messages (passes previousSummary + delta)", async () => {
    const summarize = vi.fn(async () => "S2")
    const hook = cfg({ maxTokens: 5, keepRecentTurns: 1, summarize })
    const msgs = [H("u1"), A("a1"), H("u2"), A("a2"), H("u3"), A("a3")]
    await hook({ messages: msgs, runningSummary: { summary: "S1", coveredCount: 2 } })
    // already covered first 2 (u1,a1); toSummarize delta = messages[2..cut)
    const callArg = summarize.mock.calls[0]![0] as { previousSummary?: string; messages: unknown[] }
    expect(callArg.previousSummary).toBe("S1")
    // delta should be u2,a2 (covered=2, cut keeps last turn u3,a3)
    expect((callArg.messages as Array<{ content: string }>).map((m) => m.content)).toEqual(["u2", "a2"])
  })

  it("falls back to {} when the summarizer throws", async () => {
    const hook = cfg({ maxTokens: 5, summarize: async () => { throw new Error("boom") } })
    const out = await hook({ messages: [H("u1"), A("a1"), H("u2"), A("a2")] })
    expect(out).toEqual({})
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @dawn-ai/langchain test summarization-hook`
Expected: FAIL — `buildSummarizationHook` not implemented.

- [ ] **Step 3: Implement**

Append to `packages/langchain/src/summarization/hook.ts` (keep the types from Task 2):

```ts
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { countMessagesTokens } from "./token-counter.js"
import { splitForSummary } from "./split.js"

export interface PreModelHookState {
  readonly messages: BaseMessage[]
  readonly runningSummary?: RunningSummary
}

export interface PreModelHookResult {
  llmInputMessages?: BaseMessage[]
  runningSummary?: RunningSummary
}

export function buildSummarizationHook(config: ResolvedSummarizationConfig) {
  return async (state: PreModelHookState): Promise<PreModelHookResult> => {
    const messages = state.messages ?? []
    const total = await countMessagesTokens(messages, config.tokenCounter)
    if (total <= config.maxTokens) return {}

    const prev = state.runningSummary
    const coveredCount = prev?.coveredCount ?? 0
    const { toSummarize, recent } = splitForSummary(messages, config.keepRecentTurns)
    // Only fold the messages that aged since last summary (between coveredCount and the cut).
    const newlyAged = toSummarize.slice(coveredCount)

    let summary = prev?.summary ?? ""
    if (newlyAged.length > 0) {
      try {
        summary = await config.summarize({
          messages: newlyAged,
          model: config.model,
          ...(prev?.summary ? { previousSummary: prev.summary } : {}),
          signal: new AbortController().signal,
        })
      } catch {
        // Summarization failed — fall back to full history this turn rather than break the run.
        return {}
      }
    }
    if (!summary) return {}

    const summaryMessage = new HumanMessage(`Summary of earlier conversation:\n${summary}`)
    return {
      llmInputMessages: [summaryMessage, ...recent],
      runningSummary: { summary, coveredCount: toSummarize.length },
    }
  }
}
```

Create `packages/langchain/src/summarization/index.ts`:

```ts
export { defaultTokenCounter, countMessagesTokens } from "./token-counter.js"
export { splitForSummary } from "./split.js"
export { defaultSummarize } from "./summarize.js"
export {
  buildSummarizationHook,
  type ResolvedSummarizationConfig,
  type RunningSummary,
  type TokenCounter,
  type SummarizeFn,
} from "./hook.js"
```

- [ ] **Step 4: Run — expect PASS; typecheck + lint**

Run: `pnpm --filter @dawn-ai/langchain test summarization-hook && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint`
Expected: clean. (The signal in the test is unused by the fake; fine.)

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/summarization/hook.ts packages/langchain/src/summarization/index.ts packages/langchain/test/summarization-hook.test.ts
git commit -m "feat(langchain): buildSummarizationHook (non-destructive preModelHook, incremental cache)"
```

---

## Task 7: Wire summarization into the agent adapter

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/src/index.ts`

- [ ] **Step 1: Accept summarization in `materializeAgent` opts + thread from the streaming path**

Add to the `opts` object type in `materializeAgent` (from Task 1):

```ts
    readonly summarization?: import("./summarization/hook.js").ResolvedSummarizationConfig
```

In the body, after `agentOptions` is built and before `createReactAgent`, when summarization is present, add the preModelHook and ensure a `runningSummary` state channel exists:

```ts
  if (opts.summarization) {
    const { buildSummarizationHook } = await import("./summarization/hook.js")
    agentOptions.preModelHook = buildSummarizationHook(opts.summarization)
    // Ensure runningSummary is a persisted state channel (replace reducer, default undefined).
    const summaryField: ResolvedStateField = {
      name: "runningSummary",
      reducer: "replace",
      default: undefined,
    }
    const fields = [...(opts.stateFields ?? []), summaryField]
    agentOptions.stateSchema = materializeStateSchema(fields)
  }
```

(Note: this must compose with the existing `if (opts.stateFields?.length) agentOptions.stateSchema = materializeStateSchema(opts.stateFields)` — restructure so that when summarization is on, the merged `fields` list is used; when off, the existing behavior is unchanged. Verify `ResolvedStateField` supports `reducer: "replace"` + `default: undefined` against `materializeStateSchema` in `state-adapter.ts`; if `default` must be non-undefined, use `null`.)

- [ ] **Step 2: Thread `summarization` from the `streamAgent` options through to `materializeAgent`**

Find the `streamAgent` options interface (it has `offload?`, `checkpointer`, etc.) and add `readonly summarization?: ResolvedSummarizationConfig`. In the `materializeAgent(options.entry, effectiveTools, options.checkpointer, { ... })` call (Task 1, call site 2), add `...(options.summarization ? { summarization: options.summarization } : {})`.

- [ ] **Step 3: Export the public summarization surface**

In `packages/langchain/src/index.ts`, add: `export * from "./summarization/index.js"`.

- [ ] **Step 4: Build, typecheck, lint, test**

Run: `pnpm --filter @dawn-ai/langchain build && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain test`
Expected: clean; existing agent tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/src/index.ts
git commit -m "feat(langchain): wire summarization preModelHook + runningSummary state field"
```

---

## Task 8: Resolve config + thread from execute-route

**Context:** Mirror how `offload` is built (`buildOffload`) and threaded into `streamResolvedRoute`/`streamAgent`. Build a `ResolvedSummarizationConfig` from `config.summarization` + the route's model when `enabled`.

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Add a `buildSummarization` resolver**

Read how `buildOffload(config, filesystem, signal)` is defined + called in `execute-route.ts`. Add an analogous resolver:

```ts
import {
  buildSummarizationHook, // not needed here; the adapter builds the hook. Import the types/defaults instead:
} from "@dawn-ai/langchain"
import { defaultTokenCounter, defaultSummarize, type ResolvedSummarizationConfig } from "@dawn-ai/langchain"

function buildSummarization(
  config: DawnConfig | undefined,
  routeModel: string,
): ResolvedSummarizationConfig | undefined {
  const s = config?.summarization
  if (!s?.enabled) return undefined
  return {
    maxTokens: s.maxTokens ?? 12_000,
    keepRecentTurns: s.keepRecentTurns ?? 6,
    model: s.model ?? routeModel,
    tokenCounter: s.tokenCounter ?? defaultTokenCounter,
    summarize: s.summarize ?? defaultSummarize,
  }
}
```

(`defaultTokenCounter` is async `(text) => Promise<number>`; `ResolvedSummarizationConfig.tokenCounter` is typed `(text) => number`. Widen `TokenCounter` to `(text: string) => number | Promise<number>` in `hook.ts` so the async default fits — update Task 2's type accordingly and re-run that package's typecheck. The hook already awaits the counter via `countMessagesTokens`.)

- [ ] **Step 2: Resolve it where `offload` is resolved, using the route's model**

Where `prepareRouteExecution` resolves `offload` and has the normalized descriptor/agent, also compute `const summarization = buildSummarization(config, normalized.entry.model)` (use the actual descriptor model accessor — for an agent route the model is on the descriptor; verify the field name). Add `...(summarization ? { summarization } : {})` to the prepared result object and to the `streamAgent`/`streamResolvedRoute` options where `offload` is passed.

- [ ] **Step 3: Build + typecheck + lint**

Run: `pnpm --filter @dawn-ai/core --filter @dawn-ai/langchain build && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): resolve summarization config + thread to agent (opt-in, route-model default)"
```

---

## Task 9: aimock e2e — summarization across the threshold

**Context:** Reuse the PR #190 aimock harness (`startAimock`, packed probe app, `startDevServer` with `OPENAI_BASE_URL`). Build a probe app whose `dawn.config.ts` enables summarization with a tiny `maxTokens`, drive a scripted multi-turn conversation, and assert the non-destructive contract.

**Files:**
- Create: `test/runtime/fixtures/aimock/summarization.json`
- Create: `test/runtime/run-summarization-e2e.test.ts`
- Modify: `test/runtime/vitest.config.ts` (include)

- [ ] **Step 1: Study the existing aimock harness**

Read `test/runtime/run-aimock-e2e.test.ts` (its `buildProbeApp`, fixture shape, `startDevServer` env wiring) and reuse the helpers identically. Note the fixture `match` keys (`userMessage`, `turnIndex`, `hasToolResult`) and `response.content`.

- [ ] **Step 2: Author the fixture (several text turns to grow history)**

Create `test/runtime/fixtures/aimock/summarization.json` — a sequence of assistant text replies keyed by `turnIndex`, enough turns that the accumulated history crosses a low `maxTokens` set in the probe app config:

```json
{
  "fixtures": [
    { "match": { "turnIndex": 0 }, "response": { "content": "Turn 0: noted your first point in detail. xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } },
    { "match": { "turnIndex": 1 }, "response": { "content": "Turn 1: noted your second point in detail. xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } },
    { "match": { "turnIndex": 2 }, "response": { "content": "Turn 2: final answer; the magic word is PINEAPPLE." } }
  ]
}
```

- [ ] **Step 3: Probe app with summarization enabled**

In the test, build a probe app (reuse `buildProbeApp` or a local variant) whose `dawn.config.ts` is:

```ts
export default {
  appDir: "src/app",
  summarization: { enabled: true, maxTokens: 50, keepRecentTurns: 1 },
}
```

(`maxTokens: 50` so 2–3 turns trigger it.) The route `src/app/chat/index.ts` is the same minimal `agent({ model: "gpt-4o-mini", systemPrompt: "..." })`. No tools needed for this scenario (or keep them; irrelevant). Drive three sequential `runs/wait` calls on the SAME thread with three user messages so history grows across turns.

- [ ] **Step 4: Write the test**

```ts
it("summarizes across the token threshold without losing saved history", async () => {
  const { appRoot } = await buildSummarizationProbeApp() // local helper, mirrors buildProbeApp + the config above
  const aimock = await startAimock({ fixturePath: join(import.meta.dirname, "fixtures/aimock/summarization.json") })
  const port = await allocatePort()
  const server = await startDevServer({ cwd: appRoot, port, env: { OPENAI_BASE_URL: aimock.baseUrl, OPENAI_API_KEY: "test-not-used" } })
  try {
    const url = await server.waitForReady(30_000)
    const tid = ((await (await fetch(new URL("/threads", url), { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json()) as { thread_id: string }).thread_id
    const say = async (content: string) => {
      const r = await fetch(new URL(`/threads/${tid}/runs/wait`, url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "/chat#agent", input: { messages: [{ role: "user", content }] } }),
      })
      expect(r.status).toBe(200)
      return r.json() as Promise<{ messages: Array<Record<string, unknown>> }>
    }
    await say("First message with a lot of detail to grow the history.")
    await say("Second message, also detailed, pushing past the token threshold.")
    await say("Third message — please give the final answer.")

    // Saved state retains the FULL history (non-destructive).
    const state = (await (await fetch(new URL(`/threads/${tid}/state`, url))).json()) as { values: { messages: unknown[]; runningSummary?: { summary?: string } } }
    const humanCount = state.values.messages.filter((m) => Array.isArray((m as { id?: string[] }).id) && (m as { id: string[] }).id[2] === "HumanMessage").length
    expect(humanCount).toBe(3) // all three user turns persisted, nothing destroyed
    expect(state.values.runningSummary?.summary, "running summary populated after crossing threshold").toBeTruthy()
  } finally {
    await server.stop()
    await aimock.stop()
  }
}, 180_000)
```

(Confirm `GET /state` returns `{ values: { messages, runningSummary } }` — check how the AP `state` endpoint serializes channels in `runtime-server.ts`; adjust the accessor to the real shape. The two invariants that matter: full history persisted + `runningSummary` populated.)

- [ ] **Step 5: Add to include + run**

Add `"test/runtime/run-summarization-e2e.test.ts"` to `test/runtime/vitest.config.ts` `include`. Run:
Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/run-summarization-e2e.test.ts 2>&1 | tail -25`
Expected: PASS — three turns complete, state has 3 HumanMessages + a populated `runningSummary`, no orphaned-tool-call errors. Debug against the real `/state` shape if the accessor is off.

- [ ] **Step 6: Lint + commit**

```bash
git add test/runtime/run-summarization-e2e.test.ts test/runtime/fixtures/aimock/summarization.json test/runtime/vitest.config.ts
git commit -m "test(runtime): aimock e2e — summarization across token threshold, history preserved"
```

---

## Task 10: Full validation, changeset, chat-example seed, memory, PR

**Files:**
- Create: `.changeset/phase3-summarization.md`
- Optionally modify: `examples/chat/server/dawn.config.ts` (demo seed — off by default, commented)

- [ ] **Step 1: Full lane**

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/run-summarization-e2e.test.ts
```
Expected: green. (The pre-existing macOS-only `/private/tmp` `run-command.test.ts` artifact may fail locally — confirm it's that and unrelated; passes on Linux CI.)

- [ ] **Step 2: Changeset**

Create `.changeset/phase3-summarization.md`:

```md
---
"@dawn-ai/core": minor
"@dawn-ai/langchain": minor
"@dawn-ai/cli": minor
---

Add opt-in conversation summarization (phase-3 sub-project 6b). When a thread's history exceeds a token threshold, a non-destructive `preModelHook` feeds the model a running summary plus recent turns (via `llmInputMessages`) while full history stays in the checkpoint — no destructive message removal, so no tool-call/result pairing hazard and `GET /state`/resume still see everything. Enable via `dawn.config.ts` `summarization: { enabled: true, maxTokens?, keepRecentTurns?, model?, tokenCounter?, summarize? }`. Token counting defaults to a lazily-loaded `gpt-tokenizer`; both the counter and the summarizer are swappable.
```

Run: `BASE_REF=origin/main HEAD_REF=feat/phase3-summarization node scripts/check-changesets.mjs` → passes.

- [ ] **Step 3: Push + PR**

```bash
git add .changeset/phase3-summarization.md
git commit -m "chore: changeset for conversation summarization"
git push -u origin feat/phase3-summarization
gh pr create --title "feat: phase3 6b — opt-in conversation summarization (non-destructive)" --body "$(cat <<'EOF'
## Summary
Final Phase-3 feature. Opt-in, non-destructive conversation summarization via a `createReactAgent` `preModelHook` returning `llmInputMessages` — condenses old turns into a cached running summary + recent verbatim turns while full history stays in the checkpoint. No destructive message removal → no tool-call/result pairing hazard; `GET /state`, resume, restart all see full history.

- Token-threshold trigger; default counter = lazily-loaded `gpt-tokenizer` (single encoding, only loaded when enabled); both counter and summarizer swappable via `dawn.config.ts`.
- Pairing-safe `splitForSummary` (turn-boundary slicing keeps tool rounds intact).
- Incremental running summary cached in a `runningSummary` state field (bounded cost).
- Also: collapsed `materializeAgent`'s 8 positional params into an options object.

## Test plan
- [x] Unit: token counter, pairing-safe split (incl. tool rounds), default summarizer, hook (under/over threshold, incremental fold, failure fallback)
- [x] aimock e2e (no key): history crosses threshold → full history preserved in state + runningSummary populated
- [x] Full build/lint/typecheck/test green

Spec: docs/superpowers/specs/2026-06-04-phase3-conversation-summarization-design.md
Plan: docs/superpowers/plans/2026-06-04-phase3-conversation-summarization.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Update phase memory**

In `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md`: mark 6b shipped (PR link); note Phase 3 fully complete (all sub-projects incl. 6a+6b); record the non-destructive `preModelHook`/`llmInputMessages` architecture + the deferred destructive-compaction storage follow-up.

---

## Self-Review

**Spec coverage:**
- Non-destructive preModelHook + llmInputMessages → Tasks 6, 7. ✓
- Opt-in config (enabled/maxTokens/keepRecentTurns/model/tokenCounter/summarize) → Task 2 (type), Task 8 (resolve+defaults). ✓
- Default lazy gpt-tokenizer counter, swappable → Task 3, Task 8. ✓
- Pairing-safe split → Task 4. ✓
- Default summarizer, swappable → Task 5, Task 8. ✓
- Incremental running-summary cache in state field → Task 6 (hook), Task 7 (state channel). ✓
- Reuse route model default → Task 8. ✓
- Failure fallback to full history → Task 6 (try/catch → {}). ✓
- Composes with checkpointer (full history in state) → verified by Task 9 e2e (3 HumanMessages persist). ✓
- Unit + aimock e2e tests → Tasks 3-6 (unit), Task 9 (e2e). ✓
- materializeAgent options-object follow-up folded in → Task 1. ✓
- Out-of-scope (destructive compaction, %-window) → not implemented. ✓

**Placeholder scan:** Tasks 5/8/9 instruct verifying real signatures (`resolveProvider`, the descriptor model field, `GET /state` channel shape, the gpt-tokenizer subpath) against the actual code rather than hardcoding possibly-wrong names — deliberate, each gives the file to check + the semantic requirement. No TBD/vague steps.

**Type consistency:** `ResolvedSummarizationConfig` fields used identically in Task 2 (def), Task 6 (consumer), Task 8 (builder). `RunningSummary { summary, coveredCount }` consistent across Task 6 hook + Task 7 state field. `TokenCounter` widened to `number | Promise<number>` noted in both Task 2 and Task 3/8 (the async default). `buildSummarizationHook(config)` single-arg consistent in Task 6 + Task 7. `runningSummary` channel name matches between hook return (Task 6) and state field (Task 7) and e2e assertion (Task 9).
