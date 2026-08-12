# Agent Protocol Stream Reattachment — PR3 (client and docs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: PROVISIONAL — re-verify before executing.** Drafted before PR2 landed, so every assertion about the attach wire is unverified against a running server. A verification pass found two blockers (a race in the live-attach integration test that fires the GET before the POST creates the thread, and a changeset gate run before the changeset is committed — `check-changesets.mjs` diffs commits, not the working tree), a docs gate that cannot fail as predicted because `check-docs.mjs` reads the *built* `packages/cli/dist/index.js`, and five spec-coverage gaps: documenting `event: state` as a Dawn extension to the AP wire, the `apAttachDigestMaxBytes` / `apAttachMaxViewers` knobs, the empty-`interrupts`-during-resume rule, the `examples/research` digest-cap gate, and the `run_started_at` client rule. Re-run the plan-writing and verification pass against the post-PR2 tree before executing.

**Goal:** Ship the first first-party Agent Protocol (AP) attach client — `dawn threads tail <thread-id>` — plus the user-facing documentation for reattachment, so that the wire contract designed in `docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md` has a real consumer that proves the client-side reducer contract, and so that reload-recovery, the `"interrupted"` cancelled-vs-parked overload, and the workerd/multi-replica honesty are documented rather than folklore.

**Architecture:** **This plan assumes PR1 and PR2 have already landed.** Concretely, it assumes the running server already provides: `GET /threads/{thread_id}/pending_interrupts` returning `{interrupts:[{interruptId,resumeKey,value}]}`; parked turns writing thread status `"interrupted"` on both the stream and resume handlers; `LiveTurnHub`; and `GET /threads/{thread_id}/runs/stream` responding `200 text/event-stream` with exactly one `event: state` frame followed by either live AP frames terminated by `done` (when `live: true`) or an immediate `done {"output":null}` plus a `retry:` hint (when `live: false`). PR3 adds no server code. The client is deliberately **structural**: it parses the wire JSON defensively and never imports PR2's internal frame types, so the CLI is a real third-party consumer of the documented contract rather than a compile-time-coupled sibling. It decomposes into four small pure modules under `packages/cli/src/lib/threads/` — an incremental SSE frame parser, a defensive state-frame parser plus the `StreamChunk → (event, data)` projection that mirrors the server's `toSseEvent` split, a line-oriented transcript reducer, and a stream consumer that drives both — behind a thin commander command that does option validation, `fetch`, and HTTP error mapping. The **same reducer instance** renders `turn[]` and the live tail, which is what makes "snapshot + tail concatenate cleanly" observable rather than asserted.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes: true`), Node 24, commander 15, Vitest 4, Biome 2.4 (line width 100, double quotes, no semicolons), MDX docs in `apps/web/content/docs` with Next.js page wrappers, changesets (fixed 0.x group — **patch only**).

---

## File Structure

| File | Create/Modify | Single responsibility |
|---|---|---|
| `packages/cli/src/lib/threads/sse-frames.ts` | Create | Incremental SSE text → `{event, data}` frames; drops `: ping` comments; tracks the latest `retry:` hint. |
| `packages/cli/src/lib/threads/attach-frames.ts` | Create | Defensive parse of the `event: state` payload, and the `StreamChunk → (event, data)` projection that mirrors the server's `toSseEvent` data-only split. |
| `packages/cli/src/lib/threads/tail-reducer.ts` | Create | The client reducer contract: render `values.messages`, then `input` (only when `resume` is false), then `turn[]` through the same code path live frames use. |
| `packages/cli/src/lib/threads/consume-attach-stream.ts` | Create | Drive a response body through parser + reducer; stop at `done`; map `detached` and truncated streams to non-zero exits. |
| `packages/cli/src/lib/threads/resolve-tail-request.ts` | Create | Pure option validation: `--url` → attach URL, `--header` → header map, `--connect-timeout` → ms, `--json` → boolean. |
| `packages/cli/src/commands/threads.ts` | Create | Commander registration for `dawn threads tail <threadId>`, `fetch`, HTTP error mapping, exit codes. |
| `packages/cli/src/index.ts` | Modify | Register `registerThreadsCommand` alongside the other commands. |
| `packages/cli/test/threads-sse-frames.test.ts` | Create (Test) | SSE parser unit suite. |
| `packages/cli/test/threads-attach-frames.test.ts` | Create (Test) | State-frame parse + turn-chunk projection unit suite. |
| `packages/cli/test/threads-tail-reducer.test.ts` | Create (Test) | Reducer contract unit suite (including the resume-does-not-apply-input rule). |
| `packages/cli/test/threads-consume-attach-stream.test.ts` | Create (Test) | Stream consumption over canned `ReadableStream`s. |
| `packages/cli/test/threads-resolve-tail-request.test.ts` | Create (Test) | Option-validation unit suite. |
| `packages/cli/test/threads-command-parsing.test.ts` | Create (Test) | Drives the real `createProgram` so every declared flag survives commander. |
| `packages/cli/test/threads-tail-command.test.ts` | Create (Test) | Integration against a real bound `startRuntimeServer` — live path, durable path, unknown thread, middleware gating via `--header`, `--json`, transport failure. |
| `apps/web/content/docs/stream-reattach.mdx` | Create | The attach-endpoint reference: wire contract, reducer contract, do-not-mix-`/state` caveat, `"interrupted"` disambiguation, workerd/multi-replica honesty. |
| `apps/web/app/docs/stream-reattach/page.tsx` | Create | Next.js wrapper required by the docs topology check. |
| `apps/web/app/components/docs/nav.ts` | Modify | Add the `Stream Reattachment` nav entry (Tooling, after Dev Server). |
| `apps/web/content/docs/dev-server.mdx` | Modify | Add the two new GET endpoints, fix the middleware-coverage sentence, drop the stale endpoint count, link the new page. |
| `apps/web/content/docs/cli.mdx` | Modify | Document `dawn threads tail` and its flags; update the command count/list. |
| `docs/superpowers/specs/2026-08-06-ap-run-cancellation.md` | Modify | Point the deferred-reattach non-goal at the shipped endpoint. |
| `.changeset/ap-threads-tail.md` | Create | Patch changeset for `@dawn-ai/cli`. |

---

## Task 1: Environment preflight and PR2 baseline

**Files:** none (no commit in this task)

- [ ] **Step 1: Select Node 24.** Node 22 makes roughly eight `dawn verify` tests fail spuriously and the failures look pre-existing. From the repo root run:
  ```bash
  nvm use 24 && node --version
  ```
  Expect `v24.x`. If `nvm` is unavailable, install/select Node 24 by whatever means — do not proceed on Node 22.

- [ ] **Step 2: Install and build.** `packages/cli` tests import built artifacts from `../../testing/dist/*`, so a build must precede any test run.
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm install && pnpm build
  ```

- [ ] **Step 3: Confirm the PR2 attach endpoint exists.** This plan is a client for it; if it is missing, stop and land PR2 first.
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && grep -n 'method: "GET"' -B 2 packages/cli/src/lib/dev/runtime-fetch-core.ts | grep -n 'runs\\\\/stream\|pending_interrupts'
  ```
  Expect at least one hit for `runs\/stream` and one for `pending_interrupts`. If both are absent, the assumption at the top of this plan is violated.

- [ ] **Step 4: Confirm the PR2 test suite is green.** Baseline before adding anything:
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-cancellation.test.ts test/runtime-fetch-parity.test.ts test/resume-endpoint.test.ts test/pending-interrupts.test.ts
  ```
  All four files must pass. Anything red here is a pre-existing problem to fix before starting.

---

## Task 2: Incremental SSE frame parser

**Files:**
- Create: `packages/cli/src/lib/threads/sse-frames.ts`
- Test: `packages/cli/test/threads-sse-frames.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/cli/test/threads-sse-frames.test.ts` with exactly:

```ts
import { describe, expect, it } from "vitest"

import { createSseFrameParser } from "../src/lib/threads/sse-frames.js"

describe("createSseFrameParser", () => {
  it("emits one frame per complete block", () => {
    const parser = createSseFrameParser()

    const frames = parser.push('event: state\ndata: {"live":true}\n\nevent: chunk\ndata: "hi"\n\n')

    expect(frames).toEqual([
      { data: '{"live":true}', event: "state" },
      { data: '"hi"', event: "chunk" },
    ])
  })

  it("joins a block split across reads", () => {
    const parser = createSseFrameParser()

    expect(parser.push("event: chu")).toEqual([])
    expect(parser.push('nk\ndata: "he')).toEqual([])
    expect(parser.push('llo"\n\n')).toEqual([{ data: '"hello"', event: "chunk" }])
  })

  it("drops comment keepalives without emitting a frame", () => {
    const parser = createSseFrameParser()

    expect(parser.push(": ping\n\n")).toEqual([])
    expect(parser.push('event: done\ndata: {"output":null}\n\n')).toEqual([
      { data: '{"output":null}', event: "done" },
    ])
  })

  it("defaults the event name to message and joins multi-line data", () => {
    const parser = createSseFrameParser()

    expect(parser.push("data: one\ndata: two\n\n")).toEqual([{ data: "one\ntwo", event: "message" }])
  })

  it("records retry hints without emitting a frame for them", () => {
    const parser = createSseFrameParser()

    expect(parser.retryMs).toBeUndefined()
    expect(parser.push("retry: 2137\n\n")).toEqual([])
    expect(parser.retryMs).toBe(2137)
  })

  it("normalizes CRLF separators", () => {
    const parser = createSseFrameParser()

    expect(parser.push('event: done\r\ndata: {"output":null}\r\n\r\n')).toEqual([
      { data: '{"output":null}', event: "done" },
    ])
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-sse-frames.test.ts
  ```
  Expected failure: the file fails to collect with `Error: Failed to load url ../src/lib/threads/sse-frames.js` (Vitest may phrase it `Cannot find module '.../packages/cli/src/lib/threads/sse-frames.ts'`). Zero tests run.

- [ ] **Step 3: Create the parser.** Create `packages/cli/src/lib/threads/sse-frames.ts` with exactly:

```ts
/**
 * Incremental Server-Sent Events frame parser.
 *
 * Hand-rolled rather than reusing `EventSource`: the Agent Protocol attach
 * stream is consumed from Node with `fetch`, and frames arrive split across
 * arbitrary read boundaries. Dawn's keepalive comment frames (`: ping`) are
 * dropped, and — matching the SSE dispatch rules — a block with no `data:`
 * line dispatches nothing, so a lone `retry:` hint updates `retryMs` without
 * producing a frame.
 */
export interface SseFrame {
  /** The `data:` payload, joined across lines and still unparsed. */
  readonly data: string
  /** The `event:` name; `"message"` when the block omitted one. */
  readonly event: string
}

export interface SseFrameParser {
  /** Feed decoded text; returns every frame this chunk completed. */
  push(text: string): SseFrame[]
  /** Most recent `retry:` value in ms, or undefined until the server sends one. */
  readonly retryMs: number | undefined
}

export function createSseFrameParser(): SseFrameParser {
  let buffer = ""
  let retryMs: number | undefined

  return {
    push(text: string): SseFrame[] {
      buffer += text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
      const frames: SseFrame[] = []
      let separator = buffer.indexOf("\n\n")
      while (separator !== -1) {
        const block = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        separator = buffer.indexOf("\n\n")

        let event = "message"
        const data: string[] = []
        let sawData = false
        for (const line of block.split("\n")) {
          // An empty line cannot occur inside a block, and a leading colon is a
          // comment — Dawn's SSE keepalive is exactly that.
          if (line.length === 0 || line.startsWith(":")) continue
          const colon = line.indexOf(":")
          const field = colon === -1 ? line : line.slice(0, colon)
          const rawValue = colon === -1 ? "" : line.slice(colon + 1)
          const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue
          if (field === "event") {
            event = value
          } else if (field === "data") {
            data.push(value)
            sawData = true
          } else if (field === "retry") {
            const parsed = Number.parseInt(value, 10)
            if (Number.isFinite(parsed)) retryMs = parsed
          }
        }
        if (sawData) frames.push({ data: data.join("\n"), event })
      }
      return frames
    },
    get retryMs() {
      return retryMs
    },
  }
}
```

- [ ] **Step 4: Run the test and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-sse-frames.test.ts
  ```
  Expect `Test Files 1 passed`, `Tests 6 passed`.

- [ ] **Step 5: Format and lint the package.** Biome's formatter runs as part of `biome check`, so an unformatted line (over 100 columns, wrong quote style) reds CI. Use the package-scoped form — **never** a bare `biome check --write` at the repo root, which mass-reformats everything.
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test && pnpm --filter @dawn-ai/cli lint
  ```
  Expect the lint run to report no diagnostics. Re-wrapped lines are expected — the formatter owns the final layout.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add packages/cli/src/lib/threads/sse-frames.ts packages/cli/test/threads-sse-frames.test.ts && git commit -m "$(cat <<'EOF'
feat(cli): add an incremental SSE frame parser

The Agent Protocol attach stream is consumed from Node with fetch, so frames
arrive split across arbitrary read boundaries and EventSource is unavailable.
Comment keepalives are dropped and a lone retry hint updates the parser's
retry value without dispatching a frame, matching the SSE dispatch rules.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 3: Attach state-frame parsing and turn projection

**Files:**
- Create: `packages/cli/src/lib/threads/attach-frames.ts`
- Test: `packages/cli/test/threads-attach-frames.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/cli/test/threads-attach-frames.test.ts` with exactly:

```ts
import { describe, expect, it } from "vitest"

import { parseAttachStateFrame, turnChunkToFrame } from "../src/lib/threads/attach-frames.js"

describe("parseAttachStateFrame", () => {
  it("reads a live state frame", () => {
    const frame = parseAttachStateFrame({
      anchor: "ckpt-1",
      input: { messages: [{ content: "hello", role: "user" }] },
      interrupts: [],
      live: true,
      resume: false,
      run_started_at: "2026-08-09T00:00:00.000Z",
      status: "busy",
      turn: [{ data: "partial", type: "chunk" }],
      values: { messages: [] },
    })

    expect(frame).toEqual({
      anchor: "ckpt-1",
      input: { messages: [{ content: "hello", role: "user" }] },
      interrupts: [],
      live: true,
      resume: false,
      run_started_at: "2026-08-09T00:00:00.000Z",
      status: "busy",
      turn: [{ data: "partial", type: "chunk" }],
      turn_truncated: false,
      values: { messages: [] },
    })
  })

  it("pins the durable-path defaults", () => {
    const frame = parseAttachStateFrame({
      anchor: null,
      input: null,
      interrupts: [
        { interruptId: "perm-1", resumeKey: "3336d0e0a2d4f198ef9aecd09cd7ac27", value: { kind: "tool" } },
      ],
      live: false,
      resume: false,
      run_started_at: null,
      status: "interrupted",
      turn: null,
      values: null,
    })

    expect(frame.live).toBe(false)
    expect(frame.turn).toBeNull()
    expect(frame.turn_truncated).toBe(false)
    expect(frame.interrupts).toEqual([
      { interruptId: "perm-1", resumeKey: "3336d0e0a2d4f198ef9aecd09cd7ac27", value: { kind: "tool" } },
    ])
  })

  it("surfaces the overflow flag", () => {
    const frame = parseAttachStateFrame({
      live: true,
      status: "busy",
      turn: null,
      turn_truncated: true,
    })

    expect(frame.turn_truncated).toBe(true)
    expect(frame.turn).toBeNull()
  })

  it("drops interrupt entries without a string id", () => {
    const frame = parseAttachStateFrame({
      interrupts: [{ value: 1 }, { interruptId: "perm-2", value: 2 }],
      live: false,
      status: "idle",
    })

    expect(frame.interrupts).toEqual([{ interruptId: "perm-2", resumeKey: null, value: 2 }])
  })

  it("rejects a non-object payload", () => {
    expect(() => parseAttachStateFrame("nope")).toThrow("Attach state frame must be a JSON object")
    expect(() => parseAttachStateFrame([])).toThrow("Attach state frame must be a JSON object")
  })
})

describe("turnChunkToFrame", () => {
  it("unwraps a data-only chunk the way the server serializes it", () => {
    expect(turnChunkToFrame({ data: "hello", type: "chunk" })).toEqual({
      data: "hello",
      event: "chunk",
    })
  })

  it("unwraps a capability chunk", () => {
    expect(
      turnChunkToFrame({ data: { call_id: "c1", chunk: "tok", subagent: "reader" }, type: "subagent.message" }),
    ).toEqual({
      data: { call_id: "c1", chunk: "tok", subagent: "reader" },
      event: "subagent.message",
    })
  })

  it("keeps named fields as an object for multi-field chunks", () => {
    expect(turnChunkToFrame({ input: { q: "x" }, name: "search", type: "tool_call" })).toEqual({
      data: { input: { q: "x" }, name: "search" },
      event: "tool_call",
    })
  })

  it("emits an empty payload object for a bare chunk", () => {
    expect(turnChunkToFrame({ type: "subagent.end" })).toEqual({ data: {}, event: "subagent.end" })
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-attach-frames.test.ts
  ```
  Expected failure: `Error: Failed to load url ../src/lib/threads/attach-frames.js`. Zero tests run.

- [ ] **Step 3: Create the module.** Create `packages/cli/src/lib/threads/attach-frames.ts` with exactly:

```ts
/**
 * Client-side view of the Agent Protocol attach wire contract
 * (docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md §1).
 *
 * Deliberately parsed structurally rather than imported from the server
 * modules: `dawn threads tail` is a real consumer of the documented contract,
 * so a server refactor that quietly changes the wire has to break a test here,
 * not silently keep compiling.
 */

/** One `StreamChunk` as it appears inside the state frame's `turn` array. */
export interface TurnChunk {
  readonly type: string
  readonly [key: string]: unknown
}

/** An `(event, data)` pair — the shape a live SSE frame delivers. */
export interface TailFrame {
  readonly data: unknown
  readonly event: string
}

export interface AttachInterrupt {
  readonly interruptId: string
  readonly resumeKey: string | null
  readonly value: unknown
}

export interface AttachStateFrame {
  readonly anchor: string | null
  readonly input: unknown
  readonly interrupts: readonly AttachInterrupt[]
  readonly live: boolean
  readonly resume: boolean
  readonly run_started_at: string | null
  readonly status: string
  readonly turn: readonly TurnChunk[] | null
  readonly turn_truncated: boolean
  readonly values: Record<string, unknown> | null
}

export function parseAttachStateFrame(data: unknown): AttachStateFrame {
  if (!isPlainObject(data)) {
    throw new Error("Attach state frame must be a JSON object")
  }
  return {
    anchor: typeof data.anchor === "string" ? data.anchor : null,
    input: data.input ?? null,
    interrupts: Array.isArray(data.interrupts) ? data.interrupts.flatMap(toInterrupt) : [],
    live: data.live === true,
    resume: data.resume === true,
    run_started_at: typeof data.run_started_at === "string" ? data.run_started_at : null,
    status: typeof data.status === "string" ? data.status : "unknown",
    turn: Array.isArray(data.turn) ? data.turn.flatMap(toTurnChunk) : null,
    turn_truncated: data.turn_truncated === true,
    values: isPlainObject(data.values) ? data.values : null,
  }
}

/**
 * Project a `turn[]` entry onto the same `(event, data)` pair the live stream
 * would have delivered. Mirrors the server's `toSseEvent` split: a chunk whose
 * only non-`type` key is `data` carries that value directly, and every other
 * chunk carries its remaining named fields as an object.
 */
export function turnChunkToFrame(chunk: TurnChunk): TailFrame {
  const { type, ...rest } = chunk
  const keys = Object.keys(rest)
  if (keys.length === 1 && keys[0] === "data") {
    return { data: rest.data, event: type }
  }
  return { data: rest, event: type }
}

function toInterrupt(value: unknown): AttachInterrupt[] {
  if (!isPlainObject(value) || typeof value.interruptId !== "string") return []
  return [
    {
      interruptId: value.interruptId,
      resumeKey: typeof value.resumeKey === "string" ? value.resumeKey : null,
      value: value.value ?? null,
    },
  ]
}

function toTurnChunk(value: unknown): TurnChunk[] {
  if (!isPlainObject(value) || typeof value.type !== "string") return []
  return [value as TurnChunk]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
```

- [ ] **Step 4: Run the test and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-attach-frames.test.ts
  ```
  Expect `Tests 9 passed`.

- [ ] **Step 5: Format and lint the package.** (Package-scoped only — never a bare repo-root `biome check --write`.)
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test && pnpm --filter @dawn-ai/cli lint
  ```
  Expect no diagnostics. Several of the object literals above exceed 100 columns and will be re-wrapped — that is the formatter doing its job.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add packages/cli/src/lib/threads/attach-frames.ts packages/cli/test/threads-attach-frames.test.ts && git commit -m "$(cat <<'EOF'
feat(cli): parse the attach state frame structurally

The tail client reads the attach wire contract defensively instead of
importing the server's frame types, so a server-side wire change breaks a
test rather than silently type-checking. Includes the turn-chunk projection
that mirrors how toSseEvent splits data-only chunks from named-field chunks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 4: The tail reducer

**Files:**
- Create: `packages/cli/src/lib/threads/tail-reducer.ts`
- Test: `packages/cli/test/threads-tail-reducer.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/cli/test/threads-tail-reducer.test.ts` with exactly:

```ts
import { describe, expect, it } from "vitest"

import { parseAttachStateFrame } from "../src/lib/threads/attach-frames.js"
import { createTailReducer, type TailWriter } from "../src/lib/threads/tail-reducer.js"

function createCapture(): { readonly out: string[]; readonly writer: TailWriter } {
  const out: string[] = []
  return {
    out,
    writer: {
      line: (message) => {
        out.push(`${message}\n`)
      },
      text: (fragment) => {
        out.push(fragment)
      },
    },
  }
}

describe("createTailReducer", () => {
  it("streams consecutive chunk frames onto one assistant line", () => {
    const { out, writer } = createCapture()
    const reducer = createTailReducer(writer)

    reducer.applyFrame({ data: "Hi ", event: "chunk" })
    reducer.applyFrame({ data: "there", event: "chunk" })
    reducer.applyFrame({ data: { output: { ok: true } }, event: "done" })

    expect(out.join("")).toBe('assistant: Hi there\ndone {"ok":true}\n')
  })

  it("renders tool and capability frames", () => {
    const { out, writer } = createCapture()
    const reducer = createTailReducer(writer)

    reducer.applyFrame({ data: { input: { q: "x" }, name: "search" }, event: "tool_call" })
    reducer.applyFrame({ data: { name: "search", output: "found" }, event: "tool_result" })
    reducer.applyFrame({ data: { todos: ["a"] }, event: "plan_update" })

    expect(out.join("")).toBe(
      'tool_call search {"q":"x"}\ntool_result search "found"\nplan_update {"todos":["a"]}\n',
    )
  })

  it("applies input as a user message on a fresh turn", () => {
    const { out, writer } = createCapture()
    const reducer = createTailReducer(writer)

    reducer.applyStateFrame(
      parseAttachStateFrame({
        anchor: "ckpt-1",
        input: { messages: [{ content: "Summarize", role: "user" }] },
        interrupts: [],
        live: true,
        resume: false,
        run_started_at: "2026-08-09T00:00:00.000Z",
        status: "busy",
        turn: [{ data: "Sum", type: "chunk" }],
        values: { messages: [{ content: "earlier", role: "assistant" }] },
      }),
    )
    reducer.applyFrame({ data: "mary", event: "chunk" })
    reducer.flush()

    expect(out.join("")).toBe(
      "state status=busy live=true resume=false anchor=ckpt-1 run_started_at=2026-08-09T00:00:00.000Z\n" +
        "assistant: earlier\n" +
        "user: Summarize\n" +
        "assistant: Summary\n",
    )
  })

  it("never applies input to the transcript on a resume turn", () => {
    const { out, writer } = createCapture()
    const reducer = createTailReducer(writer)

    reducer.applyStateFrame(
      parseAttachStateFrame({
        anchor: "ckpt-parked",
        input: { resume: [{ interruptId: "perm-1", payload: "once", status: "resolved" }] },
        interrupts: [],
        live: true,
        resume: true,
        run_started_at: "2026-08-09T00:01:00.000Z",
        status: "busy",
        turn: [],
        values: { messages: [{ content: "before park", role: "assistant" }] },
      }),
    )

    expect(out.join("")).toBe(
      "state status=busy live=true resume=true anchor=ckpt-parked run_started_at=2026-08-09T00:01:00.000Z\n" +
        "assistant: before park\n",
    )
    expect(out.join("")).not.toContain("perm-1")
  })

  it("renders durable-path interrupts so a parked prompt can be re-rendered", () => {
    const { out, writer } = createCapture()
    const reducer = createTailReducer(writer)

    reducer.applyStateFrame(
      parseAttachStateFrame({
        anchor: null,
        input: null,
        interrupts: [
          {
            interruptId: "perm-1",
            resumeKey: "3336d0e0a2d4f198ef9aecd09cd7ac27",
            value: { detail: { command: "curl example.com" }, kind: "tool" },
          },
        ],
        live: false,
        resume: false,
        run_started_at: null,
        status: "interrupted",
        turn: null,
        values: { messages: [] },
      }),
    )

    expect(out.join("")).toBe(
      "state status=interrupted live=false resume=false anchor=none run_started_at=none\n" +
        'interrupt perm-1 {"detail":{"command":"curl example.com"},"kind":"tool"}\n',
    )
  })

  it("warns when the live digest overflowed", () => {
    const { out, writer } = createCapture()
    const reducer = createTailReducer(writer)

    reducer.applyStateFrame(
      parseAttachStateFrame({
        anchor: "ckpt-2",
        input: {},
        interrupts: [],
        live: true,
        resume: false,
        run_started_at: null,
        status: "busy",
        turn: null,
        turn_truncated: true,
        values: { messages: [] },
      }),
    )

    expect(out.join("")).toContain(
      "turn_truncated: the live digest overflowed; replaying from the checkpoint only",
    )
  })

  it("feeds turn[] through the same path as live frames", () => {
    const { out: snapshotOut, writer: snapshotWriter } = createCapture()
    const snapshotReducer = createTailReducer(snapshotWriter)
    snapshotReducer.applyStateFrame(
      parseAttachStateFrame({
        input: null,
        interrupts: [],
        live: true,
        resume: false,
        status: "busy",
        turn: [
          { data: "par", type: "chunk" },
          { input: { q: "x" }, name: "search", type: "tool_call" },
          { data: "tial", type: "chunk" },
        ],
        values: { messages: [] },
      }),
    )
    snapshotReducer.flush()

    const { out: liveOut, writer: liveWriter } = createCapture()
    const liveReducer = createTailReducer(liveWriter)
    liveReducer.applyFrame({ data: "par", event: "chunk" })
    liveReducer.applyFrame({ data: { input: { q: "x" }, name: "search" }, event: "tool_call" })
    liveReducer.applyFrame({ data: "tial", event: "chunk" })
    liveReducer.flush()

    // The state header is the only difference: turn[] replay and the live tail
    // are literally the same reducer path.
    expect(snapshotOut.join("").split("\n").slice(1).join("\n")).toBe(liveOut.join(""))
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-tail-reducer.test.ts
  ```
  Expected failure: `Error: Failed to load url ../src/lib/threads/tail-reducer.js`. Zero tests run.

- [ ] **Step 3: Create the reducer.** Create `packages/cli/src/lib/threads/tail-reducer.ts` with exactly:

```ts
import { type AttachStateFrame, type TailFrame, turnChunkToFrame } from "./attach-frames.js"

export interface TailWriter {
  /** A complete line of structured output. */
  line(message: string): void
  /** A fragment of streamed assistant text — no trailing newline. */
  text(fragment: string): void
}

export interface TailReducer {
  /** Render one live frame. `turn[]` entries go through this too, by design. */
  applyFrame(frame: TailFrame): void
  /**
   * Render the attach snapshot: the checkpoint transcript, then the turn input
   * (only on a fresh turn), then the digest replay.
   */
  applyStateFrame(frame: AttachStateFrame): void
  /** Terminate a partially streamed assistant line. */
  flush(): void
}

export function createTailReducer(writer: TailWriter): TailReducer {
  let streaming = false

  const flush = (): void => {
    if (!streaming) return
    streaming = false
    writer.line("")
  }

  const applyFrame = (frame: TailFrame): void => {
    if (frame.event === "chunk" && typeof frame.data === "string") {
      if (!streaming) {
        streaming = true
        writer.text("assistant: ")
      }
      writer.text(frame.data)
      return
    }

    flush()
    switch (frame.event) {
      case "done": {
        writer.line(`done ${JSON.stringify(asRecord(frame.data).output ?? null)}`)
        break
      }
      case "interrupt": {
        const interrupt = asRecord(frame.data)
        writer.line(`interrupt ${stringOf(interrupt.interruptId)} ${JSON.stringify(frame.data)}`)
        break
      }
      case "tool_call": {
        const call = asRecord(frame.data)
        writer.line(`tool_call ${stringOf(call.name)} ${JSON.stringify(call.input ?? null)}`)
        break
      }
      case "tool_result": {
        const result = asRecord(frame.data)
        writer.line(`tool_result ${stringOf(result.name)} ${JSON.stringify(result.output ?? null)}`)
        break
      }
      default: {
        writer.line(`${frame.event} ${JSON.stringify(frame.data ?? null)}`)
      }
    }
  }

  return {
    applyFrame,
    applyStateFrame(frame) {
      writer.line(
        `state status=${frame.status} live=${frame.live} resume=${frame.resume} ` +
          `anchor=${frame.anchor ?? "none"} run_started_at=${frame.run_started_at ?? "none"}`,
      )

      const history = frame.values?.messages
      if (Array.isArray(history)) {
        for (const message of history) writer.line(renderMessage(message))
      }

      // `input` is whatever started this turn. On a resume turn it is the resume
      // payload — echoed for correlation only — so applying it would inject the
      // human's answer into the transcript as a user message.
      if (!frame.resume) {
        const turnMessages = inputMessages(frame.input)
        if (turnMessages.length > 0) {
          for (const message of turnMessages) writer.line(renderMessage(message))
        } else if (frame.input !== null && frame.input !== undefined) {
          writer.line(`input: ${JSON.stringify(frame.input)}`)
        }
      }

      if (frame.turn_truncated) {
        writer.line(
          "turn_truncated: the live digest overflowed; replaying from the checkpoint only",
        )
      }

      // The same path live frames take. This is the contract the docs promise
      // and the reason the snapshot and the live tail concatenate cleanly.
      for (const chunk of frame.turn ?? []) applyFrame(turnChunkToFrame(chunk))

      for (const interrupt of frame.interrupts) {
        writer.line(
          `interrupt ${interrupt.interruptId} ${JSON.stringify(interrupt.value ?? null)}`,
        )
      }
    },
    flush,
  }
}

function renderMessage(message: unknown): string {
  const record = asRecord(message)
  const role = typeof record.role === "string" ? record.role : "message"
  const content = record.content
  return `${role}: ${typeof content === "string" ? content : JSON.stringify(content ?? null)}`
}

function inputMessages(input: unknown): readonly unknown[] {
  const record = asRecord(input)
  return Array.isArray(record.messages) ? record.messages : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "<unknown>"
}
```

- [ ] **Step 4: Run the test and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-tail-reducer.test.ts
  ```
  Expect `Tests 7 passed`. If the `input: {}` case in the overflow test writes an `input: {}` line, that is expected — the assertion is a `toContain`, not an equality.

- [ ] **Step 5: Format and lint the package.** (Package-scoped only — never a bare repo-root `biome check --write`.)
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test && pnpm --filter @dawn-ai/cli lint
  ```
  Expect no diagnostics.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add packages/cli/src/lib/threads/tail-reducer.ts packages/cli/test/threads-tail-reducer.test.ts && git commit -m "$(cat <<'EOF'
feat(cli): add the attach transcript reducer

Renders the attach snapshot then the live tail through one code path, which
is what makes the documented client contract real: turn[] replay and live
frames are literally the same reducer calls. A resume turn's input is never
applied to the transcript — it is the human's answer, not a user message.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 5: Stream consumption and terminal handling

**Files:**
- Create: `packages/cli/src/lib/threads/consume-attach-stream.ts`
- Test: `packages/cli/test/threads-consume-attach-stream.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/cli/test/threads-consume-attach-stream.test.ts` with exactly:

```ts
import { describe, expect, it } from "vitest"

import { CliError, type CommandIo } from "../src/lib/output.js"
import { consumeAttachStream } from "../src/lib/threads/consume-attach-stream.js"

function sseStream(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

function createIo(): { readonly io: CommandIo; readonly stdout: string[] } {
  const stdout: string[] = []
  return {
    io: {
      stderr: () => {},
      stdout: (message: string) => {
        stdout.push(message)
      },
    },
    stdout,
  }
}

const LIVE_STATE =
  "event: state\n" +
  'data: {"status":"busy","live":true,"anchor":"ckpt-1","run_started_at":"2026-08-09T00:00:00.000Z",' +
  '"resume":false,"values":{"messages":[]},"input":{"messages":[{"role":"user","content":"hi"}]},' +
  '"turn":[{"type":"chunk","data":"He"}],"interrupts":[]}\n\n'

describe("consumeAttachStream", () => {
  it("renders the snapshot, tails live frames, and stops on done", async () => {
    const { io, stdout } = createIo()

    await consumeAttachStream(
      sseStream(LIVE_STATE, ": ping\n\n", 'event: chunk\ndata: "llo"\n\n', 'event: done\ndata: {"output":{"ok":true}}\n\n'),
      { json: false },
      io,
    )

    expect(stdout.join("")).toBe(
      "state status=busy live=true resume=false anchor=ckpt-1 run_started_at=2026-08-09T00:00:00.000Z\n" +
        "user: hi\n" +
        "assistant: Hello\n" +
        'done {"ok":true}\n',
    )
  })

  it("prints a reconnect hint on the durable path", async () => {
    const { io, stdout } = createIo()

    // The server sends the retry hint WITH the terminal done, not with the
    // state frame, so the hint can only be printed at the end.
    await consumeAttachStream(
      sseStream(
        "event: state\n" +
          'data: {"status":"idle","live":false,"anchor":null,"run_started_at":null,"resume":false,' +
          '"values":{"messages":[{"role":"assistant","content":"done earlier"}]},"input":null,' +
          '"turn":null,"interrupts":[]}\n\n',
        'retry: 2000\nevent: done\ndata: {"output":null}\n\n',
      ),
      { json: false },
      io,
    )

    expect(stdout.join("")).toBe(
      "state status=idle live=false resume=false anchor=none run_started_at=none\n" +
        "assistant: done earlier\n" +
        "done null\n" +
        "hint: no live turn here; reconnect in 2000ms for a fresh snapshot\n",
    )
  })

  it("emits raw NDJSON frames in json mode", async () => {
    const { io, stdout } = createIo()

    await consumeAttachStream(
      sseStream(LIVE_STATE, 'event: done\ndata: {"output":null}\n\n'),
      { json: true },
      io,
    )

    const lines = stdout.join("").trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "state" })
    expect(JSON.parse(lines[1] ?? "")).toEqual({ data: { output: null }, event: "done" })
  })

  it("exits non-zero when the server detaches the viewer", async () => {
    const { io } = createIo()

    const error = await consumeAttachStream(
      sseStream('event: detached\ndata: {"reason":"capacity"}\n\n'),
      { json: false },
      io,
    ).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(1)
    expect((error as CliError).message).toContain("capacity")
  })

  it("exits non-zero when the stream ends without a done frame", async () => {
    const { io } = createIo()

    const error = await consumeAttachStream(sseStream(LIVE_STATE), { json: false }, io).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(2)
    expect((error as CliError).message).toBe("Attach stream ended without a done frame.")
  })

  it("exits non-zero when the state frame never arrives", async () => {
    const { io } = createIo()

    const error = await consumeAttachStream(
      sseStream('event: chunk\ndata: "orphan"\n\n'),
      { json: false },
      io,
    ).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toBe("Attach stream ended before the state frame.")
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-consume-attach-stream.test.ts
  ```
  Expected failure: `Error: Failed to load url ../src/lib/threads/consume-attach-stream.js`. Zero tests run.

- [ ] **Step 3: Create the consumer.** Create `packages/cli/src/lib/threads/consume-attach-stream.ts` with exactly:

```ts
import { CliError, type CommandIo, writeLine } from "../output.js"
import { parseAttachStateFrame } from "./attach-frames.js"
import { createSseFrameParser } from "./sse-frames.js"
import { createTailReducer, type TailWriter } from "./tail-reducer.js"

export interface ConsumeAttachStreamOptions {
  /** Print raw `{event, data}` NDJSON instead of rendered transcript lines. */
  readonly json: boolean
}

/**
 * Drive one attach response body to its terminator.
 *
 * `done` is a MANDATORY end-of-stream for every attach client: the server
 * closes right after it, and on the durable path the whole response is
 * `state` + `done`. A client that keeps reading turns a finished run into a
 * hung process, so this stops reading the moment it sees one.
 */
export async function consumeAttachStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeAttachStreamOptions,
  io: CommandIo,
): Promise<void> {
  const parser = createSseFrameParser()
  const writer: TailWriter = {
    line: (message) => {
      writeLine(io.stdout, message)
    },
    text: (fragment) => {
      io.stdout(fragment)
    },
  }
  const reducer = createTailReducer(writer)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let sawState = false
  let durable = false
  let detachedReason: string | undefined

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        const data = parseFrameData(frame.data)

        if (options.json) {
          writeLine(io.stdout, JSON.stringify({ data, event: frame.event }))
        } else if (frame.event === "state") {
          const state = parseAttachStateFrame(data)
          durable = !state.live
          reducer.applyStateFrame(state)
        } else {
          reducer.applyFrame({ data, event: frame.event })
        }

        if (frame.event === "state") sawState = true
        if (frame.event === "detached") detachedReason = reasonOf(data)
        if (frame.event === "done") {
          reducer.flush()
          // The retry hint rides WITH the terminal done on the durable path, so
          // it is only known here — not back when the state frame was rendered.
          if (!options.json && durable && parser.retryMs !== undefined) {
            writeLine(
              io.stdout,
              `hint: no live turn here; reconnect in ${parser.retryMs}ms for a fresh snapshot`,
            )
          }
          await reader.cancel()
          return
        }
      }
    }
  } finally {
    reducer.flush()
    reader.releaseLock()
  }

  if (detachedReason !== undefined) {
    throw new CliError(
      `Detached by the server (${detachedReason}). Re-run \`dawn threads tail\` for a fresh snapshot.`,
      1,
    )
  }
  throw new CliError(
    sawState
      ? "Attach stream ended without a done frame."
      : "Attach stream ended before the state frame.",
    2,
  )
}

function parseFrameData(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function reasonOf(data: unknown): string {
  if (typeof data !== "object" || data === null) return "unknown"
  const reason = (data as Record<string, unknown>).reason
  return typeof reason === "string" ? reason : "unknown"
}
```

- [ ] **Step 4: Run the test and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-consume-attach-stream.test.ts
  ```
  Expect `Tests 6 passed`.

- [ ] **Step 5: Format and lint the package.** (Package-scoped only — never a bare repo-root `biome check --write`.)
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test && pnpm --filter @dawn-ai/cli lint
  ```
  Expect no diagnostics.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add packages/cli/src/lib/threads/consume-attach-stream.ts packages/cli/test/threads-consume-attach-stream.test.ts && git commit -m "$(cat <<'EOF'
feat(cli): consume an Agent Protocol attach stream

Stops reading at the terminal done frame, which is the mandatory client
contract on this endpoint — the durable path is state plus done and nothing
more. Detached viewers and truncated streams surface as non-zero exits so a
degraded attach is never mistaken for a completed run.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 6: Option validation for `dawn threads tail`

**Files:**
- Create: `packages/cli/src/lib/threads/resolve-tail-request.ts`
- Test: `packages/cli/test/threads-resolve-tail-request.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/cli/test/threads-resolve-tail-request.test.ts` with exactly:

```ts
import { describe, expect, it } from "vitest"

import { CliError } from "../src/lib/output.js"
import { resolveTailRequest } from "../src/lib/threads/resolve-tail-request.js"

describe("resolveTailRequest", () => {
  it("builds the attach URL from the base URL", () => {
    const resolved = resolveTailRequest("t-1", { url: "http://127.0.0.1:3001" })

    expect(resolved.url).toBe("http://127.0.0.1:3001/threads/t-1/runs/stream")
    expect(resolved.headers).toEqual({ accept: "text/event-stream" })
    expect(resolved.connectTimeoutMs).toBe(30_000)
    expect(resolved.json).toBe(false)
  })

  it("preserves a base path and tolerates a trailing slash", () => {
    const resolved = resolveTailRequest("t-2", { url: "https://example.test/dawn/" })

    expect(resolved.url).toBe("https://example.test/dawn/threads/t-2/runs/stream")
  })

  it("encodes thread ids with URL-significant characters", () => {
    const resolved = resolveTailRequest("t/1?x", { url: "http://127.0.0.1:3001" })

    expect(resolved.url).toBe("http://127.0.0.1:3001/threads/t%2F1%3Fx/runs/stream")
  })

  it("collects repeated headers", () => {
    const resolved = resolveTailRequest("t-3", {
      header: ["x-api-key: secret", "x-tenant:acme"],
      url: "http://127.0.0.1:3001",
    })

    expect(resolved.headers).toEqual({
      accept: "text/event-stream",
      "x-api-key": "secret",
      "x-tenant": "acme",
    })
  })

  it("honours --json and --connect-timeout", () => {
    const resolved = resolveTailRequest("t-4", {
      connectTimeout: "1500",
      json: true,
      url: "http://127.0.0.1:3001",
    })

    expect(resolved.json).toBe(true)
    expect(resolved.connectTimeoutMs).toBe(1500)
  })

  it("requires --url", () => {
    const error = (() => {
      try {
        resolveTailRequest("t-5", {})
      } catch (thrown) {
        return thrown
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(2)
    expect((error as CliError).message).toContain("--url")
  })

  it("rejects a malformed base URL", () => {
    expect(() => resolveTailRequest("t-6", { url: "127.0.0.1:3001" })).toThrow(
      'Invalid --url "127.0.0.1:3001"',
    )
  })

  it("rejects a malformed header", () => {
    expect(() =>
      resolveTailRequest("t-7", { header: ["nope"], url: "http://127.0.0.1:3001" }),
    ).toThrow('Invalid --header "nope"')
  })

  it("rejects a non-positive connect timeout", () => {
    expect(() =>
      resolveTailRequest("t-8", { connectTimeout: "0", url: "http://127.0.0.1:3001" }),
    ).toThrow('Invalid --connect-timeout "0"')
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-resolve-tail-request.test.ts
  ```
  Expected failure: `Error: Failed to load url ../src/lib/threads/resolve-tail-request.js`. Zero tests run.

- [ ] **Step 3: Create the resolver.** Create `packages/cli/src/lib/threads/resolve-tail-request.ts` with exactly:

```ts
import { CliError } from "../output.js"

export interface ThreadsTailOptions {
  readonly connectTimeout?: string
  readonly header?: readonly string[]
  readonly json?: boolean
  readonly url?: string
}

export interface ResolvedTailRequest {
  readonly connectTimeoutMs: number
  readonly headers: Record<string, string>
  readonly json: boolean
  readonly url: string
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export function resolveTailRequest(
  threadId: string,
  options: ThreadsTailOptions,
): ResolvedTailRequest {
  if (!options.url) {
    throw new CliError(
      "dawn threads tail requires --url <baseUrl> — the attach stream is served by a running Dawn server (for example --url http://127.0.0.1:3001).",
      2,
    )
  }

  let base: URL
  try {
    base = new URL(options.url)
  } catch {
    throw new CliError(
      `Invalid --url "${options.url}" — expected an absolute URL such as http://127.0.0.1:3001.`,
      2,
    )
  }
  const prefix = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname
  base.pathname = `${prefix}/threads/${encodeURIComponent(threadId)}/runs/stream`

  const headers: Record<string, string> = { accept: "text/event-stream" }
  for (const entry of options.header ?? []) {
    const separator = entry.indexOf(":")
    if (separator <= 0) {
      throw new CliError(`Invalid --header "${entry}" — expected "name:value".`, 2)
    }
    headers[entry.slice(0, separator).trim().toLowerCase()] = entry.slice(separator + 1).trim()
  }

  const connectTimeoutMs =
    options.connectTimeout === undefined
      ? DEFAULT_CONNECT_TIMEOUT_MS
      : Number.parseInt(options.connectTimeout, 10)
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new CliError(
      `Invalid --connect-timeout "${options.connectTimeout}" — expected a positive number of milliseconds.`,
      2,
    )
  }

  return {
    connectTimeoutMs,
    headers,
    json: options.json === true,
    url: base.toString(),
  }
}
```

- [ ] **Step 4: Run the test and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-resolve-tail-request.test.ts
  ```
  Expect `Tests 9 passed`.

- [ ] **Step 5: Format and lint the package.** (Package-scoped only — never a bare repo-root `biome check --write`.)
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test && pnpm --filter @dawn-ai/cli lint
  ```
  Expect no diagnostics.

- [ ] **Step 6: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add packages/cli/src/lib/threads/resolve-tail-request.ts packages/cli/test/threads-resolve-tail-request.test.ts && git commit -m "$(cat <<'EOF'
feat(cli): validate dawn threads tail options

Turns the four command flags into one resolved request up front, so the URL
shape, repeated headers, and the connect timeout are pinned by pure tests
rather than discovered against a live server.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 7: Register `dawn threads tail`

**Files:**
- Create: `packages/cli/src/commands/threads.ts`
- Modify: `packages/cli/src/index.ts` (import block around lines 22–35; `createProgram` body around lines 65–80)
- Test: `packages/cli/test/threads-command-parsing.test.ts`

> **Repo gotcha this task exists to defend against:** `dawn memory` shipped with every documented subcommand flag rejected by commander before the handler ran. That bug was invisible to handler-level tests. The test below drives the real `createProgram`, so every flag `dawn threads tail` declares is proven to survive commander's own parsing.

- [ ] **Step 1: Write the failing parsing test.** Create `packages/cli/test/threads-command-parsing.test.ts` with exactly:

```ts
import type { Command } from "commander"
import { describe, expect, it } from "vitest"

import { createProgram } from "../src/index.js"
import type { CommandIo } from "../src/lib/output.js"

/**
 * `dawn threads tail` is a nested subcommand under a parent that the program
 * parses with positional options. Handler-level tests skip commander entirely,
 * which is exactly how `dawn memory` shipped with every documented subcommand
 * flag rejected by the real CLI. These tests drive the actual program.
 */
interface Captured {
  readonly options: Record<string, unknown>
  readonly threadId: string
}

function findTailCommand(program: Command): Command {
  const threads = program.commands.find((command) => command.name() === "threads")
  if (!threads) throw new Error("threads command is not registered")
  const tail = threads.commands.find((command) => command.name() === "tail")
  if (!tail) throw new Error("threads tail subcommand is not registered")
  return tail
}

async function parse(
  argv: string[],
): Promise<{ captured: Captured[]; error?: unknown; stderr: string[] }> {
  const stderr: string[] = []
  const io: CommandIo = {
    stderr: (message: string) => {
      stderr.push(message)
    },
    stdout: () => {},
  }
  const program = createProgram(io)
  const captured: Captured[] = []
  // Stop before doing any work: this asserts ARG PARSING, not behavior.
  findTailCommand(program).action(async (threadId: string, options: Record<string, unknown>) => {
    captured.push({ options, threadId })
  })

  try {
    await program.parseAsync(["node", "dawn", ...argv])
  } catch (error) {
    return { captured, error, stderr }
  }
  return { captured, stderr }
}

describe("dawn threads tail flag parsing", () => {
  it("accepts every documented flag together", async () => {
    const { captured, error, stderr } = await parse([
      "threads",
      "tail",
      "t-1",
      "--url",
      "http://127.0.0.1:3001",
      "--json",
      "--header",
      "x-api-key: secret",
      "--header",
      "x-tenant: acme",
      "--connect-timeout",
      "1500",
    ])

    expect(stderr.join("")).not.toMatch(/unknown option/)
    expect(error).toBeUndefined()
    expect(captured).toHaveLength(1)
    expect(captured[0]?.threadId).toBe("t-1")
    expect(captured[0]?.options).toMatchObject({
      connectTimeout: "1500",
      header: ["x-api-key: secret", "x-tenant: acme"],
      json: true,
      url: "http://127.0.0.1:3001",
    })
  })

  it.each([
    ["--url", ["--url", "http://127.0.0.1:3001"]],
    ["--json", ["--json"]],
    ["--header", ["--header", "x-api-key: secret"]],
    ["--connect-timeout", ["--connect-timeout", "5000"]],
  ])("accepts %s on its own", async (_flag, argv) => {
    const { error, stderr } = await parse(["threads", "tail", "t-1", ...argv])

    expect(stderr.join("")).not.toMatch(/unknown option/)
    expect(error).toBeUndefined()
  })

  it("defaults header to an empty list", async () => {
    const { captured } = await parse([
      "threads",
      "tail",
      "t-1",
      "--url",
      "http://127.0.0.1:3001",
    ])

    expect(captured[0]?.options.header).toEqual([])
  })
})

describe("dawn threads help", () => {
  it("lists the tail subcommand", async () => {
    const stdout: string[] = []
    const io: CommandIo = { stderr: () => {}, stdout: (message) => stdout.push(message) }
    const program = createProgram(io)

    // exitOverride turns --help into a thrown CommanderError AFTER the help text
    // has already been written.
    await expect(program.parseAsync(["node", "dawn", "threads", "--help"])).rejects.toThrow()

    expect(stdout.join("")).toContain("tail")
  })

  it("lists every tail flag", async () => {
    const stdout: string[] = []
    const io: CommandIo = { stderr: () => {}, stdout: (message) => stdout.push(message) }
    const program = createProgram(io)

    await expect(
      program.parseAsync(["node", "dawn", "threads", "tail", "--help"]),
    ).rejects.toThrow()

    const help = stdout.join("")
    for (const expected of ["--url", "--json", "--header", "--connect-timeout"]) {
      expect(help).toContain(expected)
    }
  })
})
```

- [ ] **Step 2: Run it and see it fail.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-command-parsing.test.ts
  ```
  Expected failure: every test fails with `Error: threads command is not registered` (the help tests fail because `parseAsync` rejects with commander's `unknown command 'threads'` rather than after printing help).

- [ ] **Step 3: Create the command.** Create `packages/cli/src/commands/threads.ts` with exactly:

```ts
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage } from "../lib/output.js"
import { consumeAttachStream } from "../lib/threads/consume-attach-stream.js"
import {
  resolveTailRequest,
  type ThreadsTailOptions,
} from "../lib/threads/resolve-tail-request.js"

export function registerThreadsCommand(program: Command, io: CommandIo): void {
  const threads = program
    .command("threads")
    .description("Inspect Agent Protocol threads on a running Dawn server")

  threads
    .command("tail <threadId>")
    .description("Attach to a thread's run stream and print it until the run ends")
    .option("--url <baseUrl>", "Base URL of the running Dawn server (e.g. http://127.0.0.1:3001)")
    .option("--json", "Print raw SSE frames as NDJSON instead of rendered transcript lines")
    .option(
      "--header <name:value>",
      "Extra request header; repeat the flag for more than one",
      collectHeader,
      [] as string[],
    )
    .option(
      "--connect-timeout <ms>",
      "Milliseconds to wait for the attach response headers",
      "30000",
    )
    .action(async (threadId: string, options: ThreadsTailOptions) => {
      await runThreadsTailCommand(threadId, options, io)
    })
}

export async function runThreadsTailCommand(
  threadId: string,
  options: ThreadsTailOptions,
  io: CommandIo,
): Promise<void> {
  const request = resolveTailRequest(threadId, options)

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(`Timed out after ${request.connectTimeoutMs}ms waiting for the attach response`),
    )
  }, request.connectTimeoutMs)

  let response: Response
  try {
    response = await fetch(request.url, {
      headers: request.headers,
      method: "GET",
      signal: controller.signal,
    })
  } catch (error) {
    throw new CliError(
      `Could not attach to ${request.url}: ${formatErrorMessage(error)}`,
      2,
      error instanceof Error ? { cause: error } : undefined,
    )
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new CliError(`Attach failed (${response.status}).`, 2)
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "text/event-stream") {
    throw new CliError(
      `Attach failed: expected text/event-stream, got ${contentType ?? "no content-type"}.`,
      2,
    )
  }
  if (!response.body) {
    throw new CliError("Attach failed: the attach response had no body.", 2)
  }

  await consumeAttachStream(response.body, { json: request.json }, io)
}

function collectHeader(value: string, previous: string[]): string[] {
  return [...previous, value]
}
```

- [ ] **Step 4: Register it in the program.** In `packages/cli/src/index.ts`, add the import immediately after the `registerTestCommand` import line (imports are sorted by module path, so `./commands/threads.js` sorts after `./commands/test.js`):

```ts
import { registerThreadsCommand } from "./commands/threads.js"
```

and add the registration call in `createProgram` immediately after `registerTestCommand(program, io)`:

```ts
  registerThreadsCommand(program, io)
```

- [ ] **Step 5: Run the parsing test and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-command-parsing.test.ts
  ```
  Expect `Tests 8 passed`. If any case reports `error: unknown option '--…'`, the commander shape is wrong — do not "fix" it by removing the flag; fix the registration.

- [ ] **Step 6: Typecheck the package.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli typecheck
  ```
  Expect no output and exit 0.

- [ ] **Step 7: Format and lint the package.** (Package-scoped only — never a bare repo-root `biome check --write`.)
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test && pnpm --filter @dawn-ai/cli lint
  ```
  Expect no diagnostics. Confirm the formatter did not reorder the `import { registerThreadsCommand }` line out of its sorted position in `src/index.ts`.

- [ ] **Step 8: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add packages/cli/src/commands/threads.ts packages/cli/src/index.ts packages/cli/test/threads-command-parsing.test.ts && git commit -m "$(cat <<'EOF'
feat(cli): add dawn threads tail

The first first-party Agent Protocol attach client: it renders the state
frame, tails live frames through the same reducer, and exits on done. The
parsing test drives the real program so every declared flag is proven to
survive commander, the way dawn memory's flags were not.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 8: Integration against the real attach endpoint

**Files:**
- Test: `packages/cli/test/threads-tail-command.test.ts` (Create)
- Modify: `packages/cli/src/commands/threads.ts` (the `!response.ok` branch added in Task 7)

- [ ] **Step 1: Write the failing integration test.** Create `packages/cli/test/threads-tail-command.test.ts` with exactly:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { runThreadsTailCommand } from "../src/commands/threads.js"
import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"
import { CliError, type CommandIo } from "../src/lib/output.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, maxRetries: 5, recursive: true })),
  )
})

/**
 * A route that blocks until a release file appears, so a run can be held live
 * across an attach. Written as source text because the fixture app has no
 * node_modules — only inline-transpilable JS is safe here.
 */
const BLOCKING_ROUTE = [
  'import { readFile, writeFile } from "node:fs/promises"',
  "export const graph = async (",
  "  input: { startedFile?: string; releaseFile?: string } | undefined,",
  ") => {",
  "  if (input?.startedFile) await writeFile(input.startedFile, 'started')",
  "  const deadline = Date.now() + 20000",
  "  while (Date.now() < deadline) {",
  "    if (!input?.releaseFile) break",
  "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
  "    await new Promise((r) => setTimeout(r, 25))",
  "  }",
  "  return { ok: true }",
  "}",
  "",
].join("\n")

const GATING_MIDDLEWARE = [
  "export default (request) =>",
  '  request.headers["x-dawn-test"] === "ok"',
  '    ? { action: "continue" }',
  '    : { action: "reject", status: 401, body: { error: "missing x-dawn-test" } }',
  "",
].join("\n")

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-threads-tail-"))
  tempDirs.push(appRoot)
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "threads-tail-fixture", "type": "module" }\n',
    "src/app/blocking/index.ts": BLOCKING_ROUTE,
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

function createIo(): { readonly io: CommandIo; readonly stdout: string[] } {
  const stdout: string[] = []
  return {
    io: {
      stderr: () => {},
      stdout: (message: string) => {
        stdout.push(message)
      },
    },
    stdout,
  }
}

/** Fire the primary POST run and keep draining it in the background. */
function startRun(
  baseUrl: string,
  threadId: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<void> {
  return fetch(new URL(`/threads/${threadId}/runs/stream`, baseUrl), {
    body: JSON.stringify({ input, route: "/blocking#graph" }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  }).then(async (response) => {
    await response.text()
  })
}

async function waitForOutput(stdout: string[], needle: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (stdout.join("").includes(needle)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`stdout never contained ${JSON.stringify(needle)}: ${stdout.join("")}`)
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe("dawn threads tail", () => {
  it("attaches to a live run and exits on done", async () => {
    const appRoot = await fixtureApp()
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = "t-live"
    const startedFile = join(appRoot, "started.txt")
    const releaseFile = join(appRoot, "release.txt")

    const primary = startRun(server.url, threadId, { releaseFile, startedFile })
    const { io, stdout } = createIo()
    const tail = runThreadsTailCommand(threadId, { url: server.url }, io)

    await waitForOutput(stdout, "state status=busy live=true")
    await writeFile(releaseFile, "go", "utf8")

    await tail
    await primary

    const text = stdout.join("")
    expect(text).toContain("state status=busy live=true resume=false anchor=")
    expect(text.trimEnd().endsWith('done {"ok":true}')).toBe(true)
  }, 60_000)

  it("serves the durable path after the run finished", async () => {
    const appRoot = await fixtureApp()
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = "t-durable"

    await startRun(server.url, threadId, {})

    const { io, stdout } = createIo()
    await runThreadsTailCommand(threadId, { url: server.url }, io)

    const text = stdout.join("")
    expect(text).toContain("state status=idle live=false")
    expect(text).toContain("hint: no live turn here; reconnect in")
    expect(text).toContain("done null")
  }, 60_000)

  it("reports thread_not_found for an unknown thread", async () => {
    const appRoot = await fixtureApp()
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const { io } = createIo()

    const error = await caught(runThreadsTailCommand("t-missing", { url: server.url }, io))

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(2)
    expect((error as CliError).message).toContain("404")
    expect((error as CliError).message).toContain("thread_not_found")
  }, 60_000)

  it("passes --header through so middleware can gate the attach", async () => {
    const appRoot = await fixtureApp({ "src/middleware.ts": GATING_MIDDLEWARE })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = "t-gated"

    await startRun(server.url, threadId, {}, { "x-dawn-test": "ok" })

    const rejected = await caught(
      runThreadsTailCommand(threadId, { url: server.url }, createIo().io),
    )
    expect(rejected).toBeInstanceOf(CliError)
    expect((rejected as CliError).message).toContain("401")

    const { io, stdout } = createIo()
    await runThreadsTailCommand(
      threadId,
      { header: ["x-dawn-test: ok"], url: server.url },
      io,
    )
    expect(stdout.join("")).toContain("state status=idle live=false")
  }, 60_000)

  it("emits NDJSON frames with --json", async () => {
    const appRoot = await fixtureApp()
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = "t-json"

    await startRun(server.url, threadId, {})

    const { io, stdout } = createIo()
    await runThreadsTailCommand(threadId, { json: true, url: server.url }, io)

    const lines = stdout.join("").trimEnd().split("\n").map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ event: "state" })
    expect(lines.at(-1)).toMatchObject({ event: "done" })
  }, 60_000)

  it("exits non-zero when the server is unreachable", async () => {
    const { io } = createIo()

    const error = await caught(
      runThreadsTailCommand("t-1", { connectTimeout: "2000", url: "http://127.0.0.1:1" }, io),
    )

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(2)
    expect((error as CliError).message).toContain("Could not attach to")
  }, 60_000)
})
```

- [ ] **Step 2: Run it and see the error-body case fail.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-tail-command.test.ts
  ```
  Expected failure: `reports thread_not_found for an unknown thread` fails with `AssertionError: expected 'Attach failed (404).' to contain 'thread_not_found'`. The other five cases should pass — if any of them fails, that is a real wiring bug in `packages/cli/src/commands/threads.ts` and must be fixed before continuing.

- [ ] **Step 3: Decode the AP error body.** In `packages/cli/src/commands/threads.ts`, replace the whole `!response.ok` branch:

```ts
  if (!response.ok) {
    throw new CliError(`Attach failed (${response.status}).`, 2)
  }
```

with:

```ts
  if (!response.ok) {
    throw new CliError(`Attach failed (${response.status}): ${await describeErrorBody(response)}`, 2)
  }
```

and append this helper at the end of the file, after `collectHeader`:

```ts
/**
 * Agent Protocol error bodies carry a machine code under `error.details.code`
 * (`thread_not_found`, `thread_route_unknown`, `run_in_flight`, …). Surfacing
 * it is what makes a failed attach diagnosable without reaching for curl.
 */
async function describeErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  try {
    const body = JSON.parse(text) as {
      error?: { details?: { code?: unknown }; message?: unknown }
    }
    const message = typeof body.error?.message === "string" ? body.error.message : text
    const code = body.error?.details?.code
    return typeof code === "string" ? `${message} [${code}]` : message
  } catch {
    return text.length > 0 ? text : response.statusText
  }
}
```

- [ ] **Step 4: Run the integration test and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/threads-tail-command.test.ts
  ```
  Expect `Tests 6 passed`.

- [ ] **Step 5: Run the whole CLI suite to confirm nothing regressed.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli test
  ```
  Expect all files passing. The disconnect-does-not-abort pins in `test/runtime-fetch-parity.test.ts` and the heartbeat `clearInterval` counts in `test/run-cancellation.test.ts` must stay green — nothing in this PR touches the server, so a failure there means an unrelated regression.

- [ ] **Step 6: Format and lint the package.** (Package-scoped only — never a bare repo-root `biome check --write`.)
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test && pnpm --filter @dawn-ai/cli lint
  ```
  Expect no diagnostics.

- [ ] **Step 7: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add packages/cli/src/commands/threads.ts packages/cli/test/threads-tail-command.test.ts && git commit -m "$(cat <<'EOF'
test(cli): drive dawn threads tail against a real server

Covers the live path, the durable path with its reconnect hint, an unknown
thread, middleware gating through --header, NDJSON output, and an unreachable
server. Failed attaches now surface the Agent Protocol error code so a 404 or
409 is diagnosable without reaching for curl.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 9: Documentation — the attach endpoint page

**Files:**
- Create: `apps/web/content/docs/stream-reattach.mdx`
- Create: `apps/web/app/docs/stream-reattach/page.tsx`
- Modify: `apps/web/app/components/docs/nav.ts` (the `Tooling` section item list)
- Test: `node scripts/check-docs.mjs`

> Docs guardrails baked into this task: `scripts/check-docs.mjs` requires every nav entry to have BOTH a `.mdx` content file and an `app/docs/<slug>/page.tsx` wrapper, requires every `/docs/...` link to resolve to a known nav page, and bans a set of marketing phrases. Do **not** write "byte-identical", "without translation", or "What works locally works in production" anywhere in these files.

- [ ] **Step 1: Create the content page.** Create `apps/web/content/docs/stream-reattach.mdx` with exactly:

````mdx
# Stream Reattachment

Agent Protocol runs keep going when the client disconnects — a browser reload, a network blip, or a laptop sleep loses the viewer, not the run. `GET /threads/{thread_id}/runs/stream` is how a client rejoins one.

Reattachment is resumable **state**, not a resumable stream. Checkpoints stay the single durable source of truth; the server also keeps a bounded in-memory digest of the turn currently streaming, anchored to an immutable checkpoint. There are no cursors, no `Last-Event-ID`, no run ids, and no retention window: every reconnect takes a fresh snapshot, and every degraded case is repaired by reconnecting again.

Because it is a GET with no body, this is the one Dawn stream a stock `EventSource` can consume.

## Attaching

```bash
curl -N http://127.0.0.1:3001/threads/$THREAD_ID/runs/stream
```

Or from the CLI, which is the reference client:

```bash
dawn threads tail $THREAD_ID --url http://127.0.0.1:3001
```

Attach never claims the thread's run slot, so it never returns `409 run_in_flight` and any number of viewers can watch the same run (up to a per-thread cap).

## The wire contract

The response is `200 text/event-stream` with the same headers as the POST run streams. The first frame is always `event: state`:

```
event: state
data: {
  "status": "busy",
  "live": true,
  "anchor": "1f0a…",
  "run_started_at": "2026-08-09T12:00:00.000Z",
  "resume": false,
  "values": { "messages": [ … ] },
  "input": { "messages": [ { "role": "user", "content": "…" } ] },
  "turn": [ { "type": "chunk", "data": "partial text so far" } ],
  "interrupts": []
}
```

| Field | Meaning |
|---|---|
| `status` | The thread's stored status: `busy`, `idle`, or `interrupted`. |
| `live` | Whether a streaming turn is attachable **in this process**. |
| `anchor` | The checkpoint id `values` was read at, or `null`. |
| `run_started_at` | When this live turn claimed the run slot, or `null`. |
| `resume` | True when the live turn is a continuation started by `POST /resume`. |
| `values` | Checkpoint channel values — the transcript so far. |
| `input` | The payload that started the live turn. |
| `turn` | The turn's frames so far, in emission order, coalesced. |
| `turn_truncated` | Present and `true` only when the digest overflowed; `turn` is then `null`. |
| `interrupts` | Parked interrupts with their renderable `value` — see [below](#interrupted-means-cancelled-or-parked). |

**When `live` is true**, live frames follow with the same event types as `POST /runs/stream` (`chunk`, `tool_call`, `tool_result`, `interrupt`, `plan_update`, `subagent.*`), terminated by the turn's own `done` frame. A `POST /threads/{id}/cancel` is visible in-band as `done` with `{"output":{"cancelled":true}}`. A park ends the stream the way the original client saw it: the `interrupt` frame, then a normal `done`.

**When `live` is false** — the durable path — the state frame carries the latest checkpoint and any parked interrupts, then the server sends an immediate `done` with `{"output":null}` plus a `retry:` hint and closes.

<Callout type="warn" title="done is the end of the stream">
Every attach client MUST treat `done` as end-of-stream and stop reading. The server closes right after it, and on the durable path `state` + `done` is the entire response. `dawn threads tail` models this: it exits on `done`.
</Callout>

`live: false` with `status: "busy"` is deliberately **not** an HTTP error — an error status would break `EventSource`'s reconnect loop. It covers three honest cases: a crashed process left a stale `busy`, the attach landed on a replica that is not running the thread, or the run is an in-process `/runs/wait` call (wait runs hold the run slot but produce no chunk stream). A stock `EventSource` sees the stream close, honours the `retry:` hint, and degrades to snapshot polling at a sane cadence.

## The reducer contract

A client renders an attach stream in exactly this order:

<Steps>
  <Step title="Render values.messages">
    The transcript at the anchor checkpoint. This is the durable history.
  </Step>
  <Step title="Apply input — only when resume is false">
    On a fresh turn, `input` is the payload that started it, so it belongs in the transcript as the user's message. On a resume turn (`resume: true`) `input` is the human's interrupt answer, echoed for correlation and debugging only. Applying it there would inject a permission decision into the conversation.
  </Step>
  <Step title="Feed turn[] through the same reducer you use for live frames">
    Each `turn[]` entry is a stream chunk in the same shape the live tail delivers: a chunk whose only field besides `type` is `data` carries that value directly; every other chunk carries its remaining named fields. Replaying the digest and then handling the live tail through one code path is what makes the two concatenate without a gap or a duplicate.
  </Step>
  <Step title="Stop at done">
    Then close the connection.
  </Step>
</Steps>

The digest is bounded and coalesced: consecutive text chunks merge into one entry, and per-token `subagent.message` frames merge per subagent call. Replay is therefore coarser than the original token stream — the same text, fewer frames.

<Callout type="warn" title="Do not merge an attach snapshot with GET /state">
The attach stream is self-contained. Its `values` are read at `anchor`, an immutable checkpoint captured before the turn started; `GET /threads/{id}/state` returns the **latest** checkpoint, which advances mid-run. Merging the two double-counts messages the run has already written. Pick one: attach for a live view, `/state` for a point-in-time read.
</Callout>

## Degraded cases

| Case | What you see | Recovery |
|---|---|---|
| Digest overflowed during the turn | `turn: null` with `turn_truncated: true` | Nothing to do — `values` plus the live tail are still correct, just coarser. |
| Viewer too slow to keep up | `event: detached` with `{"reason":"overflow"}`, then close | Reconnect. |
| Too many viewers on one thread | `event: detached` with `{"reason":"capacity"}`, then close | Reconnect later. |
| Unknown thread | `404` with `error.details.code` of `thread_not_found` | Check the thread id. |
| Thread has never run | `409` with `error.details.code` of `thread_route_unknown` | Start a run first — attach is gated by the thread's route, and Dawn fails closed rather than letting route-gating middleware fall through. |

Every degraded case has the same repair: reconnect for a fresh snapshot.

## `interrupted` means cancelled or parked

A thread's `status` is `"interrupted"` after a cancellation **and** after a human-in-the-loop park. The two are distinguished by the interrupts, not the status:

```bash
curl http://127.0.0.1:3001/threads/$THREAD_ID/pending_interrupts
# -> { "interrupts": [ { "interruptId": "…", "resumeKey": "…", "value": { … } } ] }
```

A non-empty list means the agent is waiting on a human; an empty list means the run was cancelled. The same enriched entries are embedded in the attach state frame's `interrupts` on the durable path, so a reloaded UI can re-render a permission prompt from the attach stream alone — no second request. Answer them with [`POST /threads/{id}/resume`](/docs/dev-server).

This overload is deliberate: a distinct status member would be a schema change for a distinction that `pending_interrupts` already answers exactly.

## Access control

Attach exposes everything the POST run stream exposes — channel values, the run input, live tokens, interrupt payloads — so it is gated identically. `src/middleware.ts` runs on both new GET endpoints with `method: "GET"` and the route identity Dawn recorded for the thread (the in-memory map first, then the thread's stored metadata). A thread with no resolvable route is refused rather than allowed through. See [Middleware](/docs/middleware).

## Restarts, edge runtimes, and replicas

<Callout type="info" title="What survives what">
  - **Server restart or crash.** The run dies with the process, so there is no buffer to lose — the only buffer was the current turn of a run that no longer exists. Attach then serves the durable path: the last completed checkpoint plus any durable interrupts. Nothing pretends the run survived.
  - **Edge and serverless targets.** The durable path is the supported path there: one checkpoint read and two frames, with no cross-request state. A live tail is possible when the attach lands on the isolate whose streaming response is still holding the run, but that is best effort — the durable path is the guarantee.
  - **Multiple replicas.** Any replica serves a correct durable snapshot and the correct interrupts. Only the live tail needs the replica that owns the run, the same single-replica constraint that already applies to `POST /cancel`. Session affinity restores it.
</Callout>

## Related

<RelatedCards items={[
  { href: "/docs/dev-server", title: "Dev Server", subtitle: "the full Agent Protocol endpoint reference" },
  { href: "/docs/cli", title: "CLI", subtitle: "dawn threads tail flags" },
  { href: "/docs/middleware", title: "Middleware", subtitle: "how attach is gated" },
  { href: "/docs/permissions", title: "Permissions", subtitle: "the interrupts a parked thread reports" },
  { href: "/docs/deployment", title: "Deployment", subtitle: "edge targets and replica counts" },
]} />
````

- [ ] **Step 2: Create the page wrapper.** Create `apps/web/app/docs/stream-reattach/page.tsx` with exactly:

```tsx
import type { Metadata } from "next"
import Content from "../../../content/docs/stream-reattach.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Stream Reattachment" }

export default function Page() {
  return <DocsPage href="/docs/stream-reattach" Content={Content} />
}
```

- [ ] **Step 3: Add the nav entry.** In `apps/web/app/components/docs/nav.ts`, inside the `Tooling` section, replace:

```ts
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "AG-UI & Web Clients", href: "/docs/ag-ui" },
```

with:

```ts
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Stream Reattachment", href: "/docs/stream-reattach" },
      { label: "AG-UI & Web Clients", href: "/docs/ag-ui" },
```

- [ ] **Step 4: Run the docs check and read the remaining failure.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && node scripts/check-docs.mjs
  ```
  Expected at this point: **one** remaining failure, `apps/web/content/docs/cli.mdx is missing reference to command dawn threads` — that is Task 10's work, since Task 7 registered the command but the CLI reference has not been updated yet. This task's own failure classes (missing content file, missing page wrapper, unknown `/docs/...` link, banned phrase) must be zero. After Task 10 the whole check passes.

- [ ] **Step 5: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add apps/web/content/docs/stream-reattach.mdx apps/web/app/docs/stream-reattach/page.tsx apps/web/app/components/docs/nav.ts && git commit -m "$(cat <<'EOF'
docs: document Agent Protocol stream reattachment

Covers the attach wire contract, the client reducer contract, the caveat
against merging an attach snapshot with a /state read, the cancelled-or-parked
meaning of the interrupted status, and what edge runtimes and multiple
replicas actually guarantee.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 10: Documentation — dev-server and CLI reference

**Files:**
- Modify: `apps/web/content/docs/dev-server.mdx` (the endpoint-list intro, the `Tabs` block, the Middleware section, the Related cards)
- Modify: `apps/web/content/docs/cli.mdx` (intro command list; new `## \`dawn threads\`` section)
- Test: `node scripts/check-docs.mjs`

- [ ] **Step 1: Drop the stale endpoint count and name attach.** In `apps/web/content/docs/dev-server.mdx`, replace this paragraph:

```mdx
The dev server exposes eight endpoints organized around a thread lifecycle: create thread → run (wait or stream) → read state → resume. Anything else returns 404. Thread state persists in SQLite under `.dawn/` and survives server restarts — see [Configuration](/docs/configuration) for the `checkpointer` and `threadsStore` defaults and override options.
```

with:

```mdx
The dev server exposes a set of endpoints organized around a thread lifecycle: create thread → run (wait or stream) → attach → read state → resume. Anything else returns 404. Thread state persists in SQLite under `.dawn/` and survives server restarts — see [Configuration](/docs/configuration) for the `checkpointer` and `threadsStore` defaults and override options.
```

- [ ] **Step 2: Add the two new endpoints to the Tabs block.** In the same file, immediately after the closing `</Tab>` of the `/runs/stream` tab (the tab whose body ends with the SSE event-types table) and before the `<Tab label="GET /threads/:thread_id/state">` line, insert:

````mdx
  <Tab label="GET /runs/stream (attach)">
    Rejoin a run that is already in flight, or take a durable snapshot when there is nothing live here. Same path as the POST run, as a body-less GET — the one Dawn stream a stock `EventSource` can consume.

    ```
    GET /threads/:thread_id/runs/stream
    -> 200 text/event-stream
    -> 404 if the thread does not exist (error.details.code: thread_not_found)
    -> 409 if the thread has never run (error.details.code: thread_route_unknown)
    ```

    The first frame is always `event: state`, carrying the checkpoint values, the run input, and the current turn's frames so far. Live frames follow when a turn is attachable in this process; otherwise an immediate `event: done` with `{"output":null}` and a `retry:` hint close the stream. `done` is always end-of-stream.

    Attach never claims the thread's run slot, so it never returns `run_in_flight`. Full contract: [Stream Reattachment](/docs/stream-reattach).
  </Tab>
  <Tab label="GET /pending_interrupts">
    Read the human-in-the-loop interrupts currently parked on a thread, with the payload needed to re-render the prompt.

    ```
    GET /threads/:thread_id/pending_interrupts
    -> 200 { "interrupts": [ { "interruptId", "resumeKey", "value" } ] }
    -> 404 if the thread does not exist (error.details.code: thread_not_found)
    ```

    Checkpoint-backed, so it works across restarts, replicas, and serverless. A thread whose `status` is `"interrupted"` is **parked** when this list is non-empty and **cancelled** when it is empty — the status alone does not distinguish them.
  </Tab>
````

- [ ] **Step 3: Correct the middleware-coverage sentence.** In the same file, replace:

```mdx
`src/middleware.ts` (default-exporting a function returned by `defineMiddleware`) gates Agent Protocol `/runs/stream`, `/runs/wait`, and `/resume` execution plus AG-UI route execution under both `dawn dev` and the built runtime served by `dawn start`. Thread create, read, delete, and state endpoints do not invoke middleware. It can short-circuit execution with `reject(status, body?)`, or continue with `allow(context?)` — the optional `context` flows to every tool as `ctx.middleware` (a `Readonly<Record<string, unknown>>`).
```

with:

```mdx
`src/middleware.ts` (default-exporting a function returned by `defineMiddleware`) gates Agent Protocol `/runs/stream` (both the POST run and the GET attach), `/runs/wait`, `/resume`, and `/pending_interrupts` execution plus AG-UI route execution under both `dawn dev` and the built runtime served by `dawn start`. Thread create, read, delete, and state endpoints do not invoke middleware. It can short-circuit execution with `reject(status, body?)`, or continue with `allow(context?)` — the optional `context` flows to every tool as `ctx.middleware` (a `Readonly<Record<string, unknown>>`).

The two GET endpoints resolve their route identity from the thread (the in-memory route map first, then the thread's stored metadata) and are refused with `409 thread_route_unknown` when no route can be resolved, so a route-gating middleware can never be bypassed by attaching instead of running. `MiddlewareRequest.method` is `"GET"` on those two — a middleware that branches on the method must account for it.
```

- [ ] **Step 4: Link the new page from the disconnect section.** In the same file, replace:

```mdx
To actually stop a run, call `POST /threads/:thread_id/cancel`.
```

with:

```mdx
To actually stop a run, call `POST /threads/:thread_id/cancel`. To rejoin one after a reload, attach with `GET /threads/:thread_id/runs/stream` — see [Stream Reattachment](/docs/stream-reattach).
```

- [ ] **Step 5: Add a Related card.** In the same file, in the `<RelatedCards items={[ … ]}>` list, insert as the first entry:

```mdx
  { href: "/docs/stream-reattach", title: "Stream Reattachment", subtitle: "rejoin a run after a reload" },
```

- [ ] **Step 6: Update the CLI reference intro.** In `apps/web/content/docs/cli.mdx`, replace:

```mdx
Dawn ships a single `dawn` binary with fourteen commands: `add`, `build`, `check`, `dev`, `docs`, `eval`, `inspect`, `memory`, `routes`, `run`, `start`, `test`, `typegen`, and `verify`.
```

with:

```mdx
Dawn ships a single `dawn` binary with fifteen commands: `add`, `build`, `check`, `dev`, `docs`, `eval`, `inspect`, `memory`, `routes`, `run`, `start`, `test`, `threads`, `typegen`, and `verify`.
```

- [ ] **Step 7: Document the command.** In `apps/web/content/docs/cli.mdx`, insert the following immediately before the existing `dawn memory` section heading (currently at line 210):

````mdx
## `dawn threads`

Inspect Agent Protocol threads on a running Dawn server.

```
dawn threads tail <thread-id> --url <baseUrl> [--json] [--header <name:value>] [--connect-timeout <ms>]
```

`dawn threads tail` attaches to `GET /threads/<thread-id>/runs/stream` and prints the run until it ends. It is the reference client for [stream reattachment](/docs/stream-reattach): it renders the state frame (the checkpoint transcript, then the turn input, then the turn's frames so far), tails live frames through the same reducer, and exits on the terminal `done` frame.

Flags:
- `--url <baseUrl>` — base URL of the running Dawn server (required), e.g. `http://127.0.0.1:3001`.
- `--json` — print raw `{event, data}` frames as NDJSON instead of rendered transcript lines.
- `--header <name:value>` — extra request header; repeat the flag for more than one. Use it when `src/middleware.ts` gates the endpoint.
- `--connect-timeout <ms>` — how long to wait for the attach response headers (default `30000`).

```bash
dawn threads tail t-42 --url http://127.0.0.1:3001
# state status=busy live=true resume=false anchor=1f0a… run_started_at=2026-08-09T12:00:00.000Z
# user: Summarize the corpus
# assistant: The corpus makes three claims…
# done {"messages":[…]}
```

Exit codes: `0` on a terminal `done`, `1` when the server detaches the viewer (viewer cap or a slow reader — reconnect), `2` on a transport or protocol failure. When there is no live turn to attach to, the command prints the durable snapshot, a reconnect hint, and exits `0`.
````

- [ ] **Step 8: Run the docs check and see it pass.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && node scripts/check-docs.mjs
  ```
  Expect `Docs completeness check passed.` A failure naming `dawn threads` means step 6/7 did not land; a failure naming a `/docs/...` link means a typo in a link target.

- [ ] **Step 9: Rebuild the bundled CLI docs and confirm the new topic ships.** `packages/cli/docs/` is generated during the CLI build and is gitignored, so nothing is committed — this only proves the generator handles the new page.
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm --filter @dawn-ai/cli build && ls packages/cli/docs/stream-reattach.md
  ```
  Expect the file to exist.

- [ ] **Step 10: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add apps/web/content/docs/dev-server.mdx apps/web/content/docs/cli.mdx && git commit -m "$(cat <<'EOF'
docs: document the attach and pending-interrupt endpoints

Adds both GET endpoints to the dev-server reference, corrects the middleware
coverage sentence now that two GET endpoints are gated (with method "GET" as a
new middleware input), and documents dawn threads tail with its flags and exit
codes in the CLI reference.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 11: Amend the cancellation spec's deferred-reattach note

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-ap-run-cancellation.md` (the `## Non-goals` list, around lines 127–130)

- [ ] **Step 1: Replace the non-goal bullet.** In `docs/superpowers/specs/2026-08-06-ap-run-cancellation.md`, replace:

```md
- **`on_disconnect: "cancel"|"continue"`.** LangGraph-compatible, but with an explicit cancel
  endpoint shipped and no reattach endpoint to pair it with, it buys nothing today. Revisit
  alongside run reattachment.
```

with:

```md
- **`on_disconnect: "cancel"|"continue"`.** LangGraph-compatible, but with an explicit cancel
  endpoint shipped and no reattach endpoint to pair it with, it bought nothing at the time.
  **Resolved 2026-08-09:** reattachment shipped as `GET /threads/{thread_id}/runs/stream`
  (design: `docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md`; user docs:
  `apps/web/content/docs/stream-reattach.mdx`), together with
  `GET /threads/{thread_id}/pending_interrupts` and the `dawn threads tail` reference client.
  The disconnect default now has the paired reattach path this bullet was waiting on, so
  `on_disconnect` is revisitable on its own merits — it remains an explicit non-goal of the
  reattachment spec.
```

- [ ] **Step 2: Confirm the docs check still passes.** `docs/superpowers/` is excluded from the banned-phrase walk, but the link check runs over `docs/`, so a mistyped `/docs/...` link would fail here.
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && node scripts/check-docs.mjs
  ```
  Expect `Docs completeness check passed.`

- [ ] **Step 3: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add docs/superpowers/specs/2026-08-06-ap-run-cancellation.md && git commit -m "$(cat <<'EOF'
docs: point the deferred reattach note at the shipped endpoint

The cancellation spec deferred on_disconnect until a reattach endpoint existed
to pair with it. That endpoint now exists, so the note records where it landed
instead of describing an open gap.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 12: Changeset

**Files:**
- Create: `.changeset/ap-threads-tail.md`

> **Fixed 0.x group:** a `minor` changeset takes every one of the 21 published packages to 1.0.0. This must be `patch`. Changeset prose becomes CHANGELOG prose verbatim and is scanned by `scripts/check-docs.mjs`, so it must not contain any banned marketing phrase (notably "byte-identical", "without translation", "What works locally works in production", or provider-prefixed model ids).

- [ ] **Step 1: Write the changeset.** Create `.changeset/ap-threads-tail.md` with exactly:

```md
---
"@dawn-ai/cli": patch
---

Add `dawn threads tail <thread-id>`, the reference client for Agent Protocol
stream reattachment. It attaches to `GET /threads/{thread_id}/runs/stream`,
renders the state frame (checkpoint transcript, then the turn input, then the
turn's frames so far), tails live frames through the same reducer, and exits on
the terminal `done` frame. Flags: `--url`, `--json`, `--header`, and
`--connect-timeout`.
```

- [ ] **Step 2: Verify the changeset gate.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && node scripts/check-changesets.mjs && node scripts/check-docs.mjs
  ```
  Expect both to pass. A docs failure here means a banned phrase reached the changeset — rewrite the prose, do not exempt the file.

- [ ] **Step 3: Commit.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && git add .changeset/ap-threads-tail.md && git commit -m "$(cat <<'EOF'
chore: record the dawn threads tail changeset

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 13: Real-browser (Chrome) smoke

**Files:** none (no commit; findings go in the PR description)

> This is the standing real-browser verification requirement. It runs against `examples/research/server`, which has subagents, HITL permissions with a deliberately non-allow-listed command, and a fixed port (3002). The example web UIs speak AG-UI, not Agent Protocol, so the browser client here is a stock `EventSource` driven from a page served by the dev server itself — that keeps the requests same-origin, so no CORS setup is needed. Record each assertion's actual observed value in the PR description.

### Setup

- [ ] **Step 1: Build and prepare the example.**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && nvm use 24 && pnpm install && pnpm build
  ```
  Ensure `examples/research/server/.env` contains a working `OPENAI_API_KEY` (the smoke needs real token streaming and real subagent activity).

- [ ] **Step 2: Start the dev server (terminal 1).**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a/examples/research/server && pnpm dev
  ```
  Wait for `Dawn dev ready at http://127.0.0.1:3002`.

### Scenario A — reload mid-run recovers partial text and subagent activity

- [ ] **Step 3: Start a long run and then disconnect (terminal 2).**
  ```bash
  export THREAD_A="t-smoke-a-$(date +%s)"
  curl -N -X POST "http://127.0.0.1:3002/threads/$THREAD_A/runs/stream" \
    -H 'content-type: application/json' \
    -d '{"route":"/research#agent","input":{"messages":[{"role":"user","content":"Research the bundled corpus and summarize its three main claims. Delegate the reading to subagents."}]}}'
  ```
  Wait until you have seen at least one `event: subagent.start` and several `event: chunk` frames, then press **Ctrl-C**. Copy the assistant text printed so far into a scratch file — it is the comparison baseline. Ctrl-C is a client disconnect, which does **not** cancel the run.

- [ ] **Step 4: Confirm the CLI client recovers it (terminal 3).**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm exec dawn threads tail "$THREAD_A" --url http://127.0.0.1:3002
  ```
  **Assert:** the first line is `state status=busy live=true resume=false anchor=<non-empty> run_started_at=<ISO>`; the `user:` line matches the prompt you sent; the recovered `assistant:` text **starts with** the baseline text from step 3; `subagent.start` / `subagent.message` lines are present; live frames continue to arrive; the process exits `0` right after a `done …` line. Check `echo $?` is `0`.

- [ ] **Step 5: Open Chrome on the server's own origin.** Navigate a Chrome tab to `http://127.0.0.1:3002/healthz`. It renders `{"status":"ready"}`. This page is only there to give the `EventSource` a same-origin document.

- [ ] **Step 6: Start a second long run and disconnect it (terminal 2).** Repeat step 3 with a new `THREAD_B` (`export THREAD_B="t-smoke-b-$(date +%s)"`), Ctrl-C after some `chunk` frames.

- [ ] **Step 7: Attach from the browser.** In the Chrome tab's console (or via the browser automation tool's JavaScript evaluation), run — substituting the real `THREAD_B` value:
  ```js
  window.__dawn = { frames: [] }
  const es = new EventSource("/threads/THREAD_B/runs/stream")
  for (const type of ["state","chunk","tool_call","tool_result","interrupt","plan_update",
      "subagent.start","subagent.message","subagent.tool_call","subagent.tool_result","subagent.end",
      "done","detached"]) {
    es.addEventListener(type, (e) => window.__dawn.frames.push({ at: Date.now(), data: e.data, type }))
  }
  es.addEventListener("done", () => es.close())
  window.__dawnEs = es
  "attached"
  ```
  **Assert** after a few seconds:
  ```js
  JSON.stringify({
    first: window.__dawn.frames[0].type,
    state: JSON.parse(window.__dawn.frames[0].data),
    liveTypes: [...new Set(window.__dawn.frames.slice(1).map((f) => f.type))],
  })
  ```
  `first` is `"state"`; `state.live` is `true`; `state.anchor` is a non-empty string; `state.turn` contains at least one `{"type":"chunk"}` entry whose text starts with the terminal baseline, and at least one `subagent.*` entry; `liveTypes` is non-empty (live frames really are arriving).

- [ ] **Step 8: Reload the tab and re-attach.** Press **Cmd-R** (a genuine browser reload — the exact event this feature exists for), then re-run the step 7 snippet.
  **Assert:** the new `state` frame has the **same** `anchor` and the **same** `run_started_at` as before the reload (same live turn), and its concatenated `turn` chunk text is **longer** than the pre-reload one. That is reload recovery of partial text and subagent activity, observed in a real browser.

### Scenario B — reload while parked re-renders the permission prompt from the state frame alone

- [ ] **Step 9: Drive the run into a permission park (terminal 2).**
  ```bash
  export THREAD_C="t-smoke-c-$(date +%s)"
  curl -N -X POST "http://127.0.0.1:3002/threads/$THREAD_C/runs/stream" \
    -H 'content-type: application/json' \
    -d '{"route":"/research#agent","input":{"messages":[{"role":"user","content":"Fetch the external source with node scripts/fetch-source.mjs and cite it."}]}}'
  ```
  Wait for `event: interrupt` followed by `event: done`, then let the stream close.

- [ ] **Step 10: Confirm the status honesty.**
  ```bash
  curl -s "http://127.0.0.1:3002/threads/$THREAD_C" | python3 -m json.tool
  curl -s "http://127.0.0.1:3002/threads/$THREAD_C/pending_interrupts" | python3 -m json.tool
  ```
  **Assert:** thread `status` is `"interrupted"`, and `interrupts` is **non-empty** with a `value` that contains the renderable permission payload (the blocked command). This is the parked half of the documented overload.

- [ ] **Step 11: Reload Chrome and attach to the parked thread.** Reload the tab, then run the step 7 snippet against `THREAD_C`.
  **Assert:** exactly two frames arrive before the stream closes — a `state` with `live:false`, `status:"interrupted"`, `anchor:null`, `turn:null`, and `interrupts[0].value` carrying the same payload `pending_interrupts` returned; then `done` with `{"output":null}`. The permission prompt is re-renderable **from the attach stream alone**, with no second request.

- [ ] **Step 12: Confirm the CLI shows the same thing (terminal 3).**
  ```bash
  cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a && pnpm exec dawn threads tail "$THREAD_C" --url http://127.0.0.1:3002; echo "exit=$?"
  ```
  **Assert:** a `state status=interrupted live=false` line, an `interrupt <id> {…}` line with the permission payload, a `done null` line, and `exit=0`.

### Scenario C — EventSource polling cadence on the `live:false` path

- [ ] **Step 13: Measure the reconnect cadence.** In the Chrome tab, attach to `THREAD_C` **without** closing on `done` (a stock `EventSource` auto-reconnects when the stream closes, which is the behaviour the `retry:` hint is there to pace):
  ```js
  window.__cadence = []
  const poll = new EventSource("/threads/THREAD_C/runs/stream")
  poll.addEventListener("state", () => window.__cadence.push(Date.now()))
  window.__poll = poll
  "polling"
  ```
  Wait ~15 seconds, then evaluate:
  ```js
  const gaps = window.__cadence.slice(1).map((t, i) => t - window.__cadence[i])
  window.__poll.close()
  JSON.stringify({ count: window.__cadence.length, gaps })
  ```
  **Assert:** at least 4 samples; **every** gap is ≥ 1400 ms and ≤ 3000 ms (the 2000 ms ± 500 hint plus browser scheduling), and no gap is under a second. A tight reconnect loop here would be a real defect — the `live:false` path must not become a hot spin for stock `EventSource` clients.

- [ ] **Step 14: Confirm the cancelled-vs-parked discriminator end to end.**
  ```bash
  export THREAD_D="t-smoke-d-$(date +%s)"
  curl -N -X POST "http://127.0.0.1:3002/threads/$THREAD_D/runs/stream" \
    -H 'content-type: application/json' \
    -d '{"route":"/research#agent","input":{"messages":[{"role":"user","content":"Write a very long survey of the corpus."}]}}' &
  sleep 8
  curl -s -X POST "http://127.0.0.1:3002/threads/$THREAD_D/cancel"
  curl -s "http://127.0.0.1:3002/threads/$THREAD_D" | python3 -m json.tool
  curl -s "http://127.0.0.1:3002/threads/$THREAD_D/pending_interrupts" | python3 -m json.tool
  ```
  **Assert:** thread `status` is `"interrupted"` and `interrupts` is `[]` — cancelled, not parked. Together with step 10 this is the documented discriminator, observed both ways.

- [ ] **Step 15: Record the results.** Paste the observed values (anchors, run_started_at, turn lengths, interrupt payload shape, the cadence gaps array, and both status/interrupts pairs) into the PR description under a "Chrome smoke" heading. Stop both servers.

---

## Verification

Run the full local gate from the repo root on **Node 24** before opening the PR:

```bash
cd /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a
nvm use 24
pnpm lint                       # NEVER run bare `biome check --write` — it mass-reformats the repo
pnpm build                      # must precede typecheck and test (tests import ../../testing/dist/*)
pnpm typecheck
pnpm --filter @dawn-ai/cli test
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
pnpm test                       # full workspace suite
pnpm pack:check
```

If anything needs autofixing, use the repo scripts — `pnpm lint:fix`, or `pnpm --filter @dawn-ai/cli exec biome check --write --config-path ../config-biome/biome.json src test` — never a bare `biome check --write` at the repo root.

Targeted re-runs while iterating:

```bash
# every new file in this PR
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/threads-sse-frames.test.ts test/threads-attach-frames.test.ts \
  test/threads-tail-reducer.test.ts test/threads-consume-attach-stream.test.ts \
  test/threads-resolve-tail-request.test.ts test/threads-command-parsing.test.ts \
  test/threads-tail-command.test.ts

# the server-side pins this PR must not disturb
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/runtime-fetch-parity.test.ts test/run-cancellation.test.ts test/resume-endpoint.test.ts
```

Optional but recommended before merge (slow, spawns real servers):

```bash
pnpm test:runtime
pnpm verify:harness:self-test
```

Finally, complete Task 13's Chrome smoke and record its observations — the plan is not done without it.

---

## PR notes

**The PR description must call out:**

1. **This is PR3 of three.** It depends on PR1 (`GET /pending_interrupts` + parked-status honesty) and PR2 (`LiveTurnHub` + `GET /threads/{id}/runs/stream`) already being merged. PR3 adds **no server code** — only the CLI client and documentation.
2. **New command: `dawn threads tail <thread-id>`** with `--url` (required), `--json`, `--header` (repeatable), `--connect-timeout`. Exit codes: `0` on terminal `done`, `1` on a server-sent `detached` frame, `2` on transport or protocol failure.
3. **`done` is a mandatory end-of-stream for attach clients.** The command models it by exiting; note this explicitly so reviewers know it is contract, not convenience.
4. **The client parses the wire structurally** rather than importing PR2's frame types — deliberate, so a server-side wire change breaks a test instead of silently type-checking. Point reviewers at `packages/cli/src/lib/threads/attach-frames.ts`.
5. **The resume rule.** `input` is applied to the transcript only when `resume` is false; on a resume turn it is the human's interrupt answer and applying it would inject a permission decision into the conversation. Pinned by `test/threads-tail-reducer.test.ts`.
6. **Docs changes** — new `/docs/stream-reattach` page (wire contract, reducer contract, do-not-merge-with-`/state` caveat, the cancelled-or-parked meaning of `"interrupted"`, edge/multi-replica honesty); `dev-server.mdx` gains both GET endpoints, loses its stale endpoint count, and its middleware-coverage sentence is corrected — **`MiddlewareRequest.method` is now `"GET"` on two endpoints**, which is an observable middleware input change (it was first introduced in PR2; repeat the callout here because this is where it becomes documented).
7. **Spec amendment.** `docs/superpowers/specs/2026-08-06-ap-run-cancellation.md`'s `on_disconnect` non-goal now records that the reattach endpoint it was waiting on has shipped.
8. **Chrome smoke results** — paste the observed anchors, `run_started_at` values, pre/post-reload turn lengths, the parked interrupt payload shape, the `EventSource` reconnect-gap array, and both `status` + `pending_interrupts` pairs from Task 13.
9. End the PR body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

**The changeset (`.changeset/ap-threads-tail.md`) must:**

- Be **`patch`** for `@dawn-ai/cli`. A `minor` on this fixed 0.x group promotes all 21 published packages to 1.0.0.
- Name the new command and every flag it adds, since changeset prose becomes the published CHANGELOG verbatim.
- Avoid every phrase `scripts/check-docs.mjs` bans — in particular "byte-identical" (which appears in the design spec and must **not** be copied into the changeset), "without translation", "What works locally works in production", `dawn-ai.org`, `agent.bindTools`, `.dawn/generated`, "auto-bound"/"auto-registered", and provider-prefixed model ids. A banned phrase in a changeset reddens the release long after the PR merges.
- Not restate PR1's status-change callout or PR2's `method: "GET"` callout as new behavior — those changesets already shipped; the PR description references them for context only.
