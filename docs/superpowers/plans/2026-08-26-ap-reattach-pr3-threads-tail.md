# AP Reattach PR3 — `dawn threads tail` + docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `dawn threads tail <thread-id>` — the first first-party Agent Protocol SSE client — so the attach wire contract PR2 shipped has a real consumer that proves the client-side reducer contract, plus the CLI reference docs for it.

**Architecture:** PR3 adds **no server code**. The client is deliberately *structural*: it parses the wire JSON defensively and never imports PR2's internal frame types, so the CLI is a genuine third-party consumer of the documented contract rather than a compile-time-coupled sibling. Four small pure modules under `packages/cli/src/lib/threads/` (SSE frame parser → defensive state parse + `toSseEvent` inverse → line renderer → stream driver) sit behind a thin commander command that does option validation, `fetch`, and HTTP error mapping. The **same renderer** handles `turn[]` and the live tail, which is what makes "snapshot + tail concatenate cleanly" observable rather than asserted.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes: true`), Node 24, commander 15, Vitest 4, Biome 2.4 (line width 100, double quotes, no semicolons), changesets (fixed 0.x group — **patch only**).

---

## Base-branch reality — read this before Task 1

Base is `blove/agent-protocol-thread-auth-94c180` at or after the `origin/main` merge (`eedf3c8c`). PR2 is present in this tree; do not re-implement any of it. Anchors verified 2026-08-26:

- **The attach endpoint exists**: `handleApAttachRequest`, `packages/cli/src/lib/dev/runtime-fetch-core.ts:2572`; GET route registered at `:1345-1366` on `/^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/`.
- **Wire, exactly as the server emits it** (the client must match this and nothing more):
  - Response headers `:2804-2811` — `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `connection: keep-alive`.
  - **Live** `state` frame `:2722-2737`: `{anchor, input, interrupts: [], live: true, resume, run_started_at, status, turn, values}` plus `turn_truncated: true` **only when** the digest overflowed.
  - Live tail `:2739-2745`: frames formatted by `toSseEvent`, terminated by the turn's own `done`. **The live path emits no synthetic `done` and no `retry:`.**
  - **Durable** `state` frame `:2761-2775`: `{anchor: null, input: null, interrupts, live: false, resume: false, run_started_at: null, status, turn: null, values}`, where `interrupts` items are `{interruptId, resumeKey, value}`. Then `event: done` `{"output":null}`, then a bare `retry: <1500..2500>` block with **no `data:` line**.
  - `detached` frames have exactly two reasons: `{"reason":"capacity"}` (emitted **before** any state frame, `:2689-2695`) and `{"reason":"overflow"}` (emitted **after** the tail, `:2746-2753`).
  - HTTP errors: `404 {code:"thread_not_found"}` `:2609-2612`; `409 {code:"thread_route_unknown"}` `:2639-2646` and `:2654-2660`; middleware rejection passes through its own status/body `:2675-2677`.
  - **Heartbeats**: `startSseHeartbeat` `:2686` emits `: ping\n\n` comment blocks. The client MUST tolerate them.
- **`toSseEvent`** (`packages/cli/src/lib/runtime/stream-types.ts:40-59`) splits two ways and the client's inverse must mirror it: a chunk whose only non-`type` own key is `data` emits that `data` **unwrapped**; every other chunk (`tool_call`, `tool_result`, `done`) emits its remaining named fields as an object. So `event: tool_result` carries `{id?, name, output}` while `event: plan_update` carries the raw payload, *not* `{data: …}`.
- **No first-party SSE client exists** anywhere in `src/` — only server-side pumps and test-local parsers. The best reference parser is `createSseReader` in `packages/cli/test/ap-attach-endpoint.test.ts:246-291`; **do not lift it verbatim** — it assumes exactly one `data:` line per block and ignores `id:`. The production parser must fold multi-line `data:` per the SSE spec.

### Repo gotchas baked into every task

- **Node 24 or the suite lies**: `source ~/.nvm/nvm.sh && nvm use 24` before any test/build command.
- **Capture exit codes; never pipe a gate through `tail`/`grep`**: `<cmd> > /tmp/x.log 2>&1; echo "EXIT=$?"`.
- **`check-docs.mjs` reads the BUILT `packages/cli/dist/index.js`** — run `pnpm build` (or `pnpm --filter @dawn-ai/cli build`) *before* `node scripts/check-docs.mjs`, or its CLI-surface check cannot see your command.
- **Never a bare `biome check --write`**; scope it: from `packages/cli`, `npx biome check --config-path ../config-biome/biome.json --write <paths>`.
- **Commit the changeset BEFORE running `node scripts/check-changesets.mjs`** — it diffs commits, not the working tree.
- **Patch changesets only** (the fixed 0.x group turns a minor into 1.0.0). `@dawn-ai/cli` only.
- Stage explicit paths; **never `git add -A`** (this repo has concurrent sessions).

### Two scope decisions already made — do not revisit

1. **No new docs page.** PR2 already documented the attach wire contract in `apps/web/content/docs/dev-server/agent-protocol.mdx` ("Reattaching to a running turn"). A new page would cost five coordinated files including a **hardcoded mirror list inside `scripts/check-docs.mjs`** (`expectedNavDocEntries`, `:4022`), and would duplicate that section. PR3 documents the *command* in `cli.mdx` and cross-links to the existing wire section.
2. **No new `DAWN_E` error code.** Adding one requires a nav entry, a docs page, a `page.tsx` wrapper and a regenerated `errors.mdx`. This command needs none: it maps failures onto the existing exit-code table in `cli.mdx` (`0` success, `1` validation/stream failure, `2` configuration/runtime error) via plain `CliError`.

---

## File Structure

| File | Create/Modify | Single responsibility |
|---|---|---|
| `packages/cli/src/lib/threads/sse-frames.ts` | Create | Incremental SSE text → `{event, data, retry}` frames. Folds multi-line `data:`, drops comment/heartbeat lines, surfaces bare `retry:` blocks. |
| `packages/cli/src/lib/threads/attach-state.ts` | Create | Defensive parse of the `state` payload into `AttachState`, plus `projectTurnChunk` — the inverse of the server's `toSseEvent` data-only/named-fields split. |
| `packages/cli/src/lib/threads/tail-render.ts` | Create | Pure rendering: snapshot → lines, one frame → lines. The single code path `turn[]` and the live tail both flow through. |
| `packages/cli/src/lib/threads/tail-stream.ts` | Create | Drive a response body through parser + renderer; stop at `done`; classify the outcome (`done` / `detached` / `truncated`). |
| `packages/cli/src/commands/threads.ts` | Create | Commander registration, the pure `resolveTailRequest` option validator, `fetch`, HTTP error mapping, exit codes. |
| `packages/cli/src/index.ts` | Modify | Register `registerThreadsCommand(program, io)`. |
| `packages/cli/test/threads-sse-frames.test.ts` | Create | Parser unit suite. |
| `packages/cli/test/threads-attach-state.test.ts` | Create | State parse + `projectTurnChunk` unit suite. |
| `packages/cli/test/threads-tail-render.test.ts` | Create | Renderer contract, incl. the resume-does-not-apply-`input` rule. |
| `packages/cli/test/threads-tail-stream.test.ts` | Create | Stream driving over canned `ReadableStream`s. |
| `packages/cli/test/threads-command-parsing.test.ts` | Create | Drives the real `createProgram` so every declared flag survives commander. |
| `packages/cli/test/threads-tail-command.test.ts` | Create | Integration against a real bound `startRuntimeServer` — durable path, live tail, 404, header gating. |
| `apps/web/content/docs/cli.mdx` | Modify | `## dawn threads` section + its flags (required by the CLI-surface check). |
| `.changeset/ap-threads-tail.md` | Create | Patch changeset for `@dawn-ai/cli`. |

### The client contract these modules implement (spec §1, §5)

Rendering rules, in order, for a snapshot:
1. Render `values.messages` (the committed transcript).
2. Apply `input` as a user message **only when `resume` is false**. When `resume` is true, `input` is the resume payload — echoed for correlation, never applied to the transcript.
3. Feed `turn[]` through **the same renderer used for live frames**.
4. If `turn_truncated` is true, warn that the in-flight turn's history was dropped and the live tail continues.

`run_started_at` is the turn-replacement discriminator: a client comparing it across reconnects detects that a *different* turn now owns the thread; `anchor` correlates a resume turn back to the run it continues. `dawn threads tail` prints both in its header line so the docs example shows them.

Exit codes: `0` when the stream ends with `done`; `1` when it ends without `done` or via `detached`; `2` for transport/HTTP failures (unreachable server, `thread_not_found`, `thread_route_unknown`, middleware rejection).

---

## Task 1: The SSE frame parser

**Files:** Create `packages/cli/src/lib/threads/sse-frames.ts`; Test `packages/cli/test/threads-sse-frames.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/threads-sse-frames.test.ts
import { describe, expect, it } from "vitest"
import { createSseFrameParser } from "../src/lib/threads/sse-frames.js"

describe("createSseFrameParser", () => {
  it("emits a frame per complete block and buffers partial ones", () => {
    const parser = createSseFrameParser()
    expect(parser.push('event: state\ndata: {"live":false}\n\n')).toEqual([
      { event: "state", data: { live: false } },
    ])
    // A block split across two chunks yields nothing until it completes.
    expect(parser.push('event: chunk\ndata: "he')).toEqual([])
    expect(parser.push('llo"\n\n')).toEqual([{ event: "chunk", data: "hello" }])
  })

  it("ignores comment heartbeats and surfaces a bare retry block", () => {
    const parser = createSseFrameParser()
    expect(parser.push(": ping\n\n")).toEqual([])
    expect(parser.push("retry: 2100\n\n")).toEqual([{ event: "message", retry: 2100 }])
  })

  it("folds multi-line data per the SSE spec", () => {
    const parser = createSseFrameParser()
    // Two data: lines join with \n before parsing — the server does not emit this
    // today, but a spec-correct client must not silently drop the first line.
    expect(parser.push('event: note\ndata: "a\ndata: b"\n\n')).toEqual([
      { event: "note", data: "a\nb" },
    ])
  })

  it("reports unparseable data rather than throwing", () => {
    const parser = createSseFrameParser()
    expect(parser.push("event: state\ndata: {not json}\n\n")).toEqual([
      { event: "state", raw: "{not json}", malformed: true },
    ])
  })
})
```

- [ ] **Step 2: Run it — expect module-not-found**

Run: `cd packages/cli && npx vitest run test/threads-sse-frames.test.ts` → FAIL.

- [ ] **Step 3: Implement `sse-frames.ts`**

```ts
/**
 * Incremental Server-Sent Events parser for the Agent Protocol attach stream.
 *
 * Deliberately structural: it knows the SSE framing and nothing about Dawn's
 * frame vocabulary, so `dawn threads tail` consumes the documented wire the way
 * any third-party client would rather than importing the server's own types.
 */
export interface SseFrame {
  /** The `event:` name, or SSE's default `"message"` when the block omits one. */
  readonly event: string
  /** Parsed `data:` payload. Absent on a bare `retry:` block. */
  readonly data?: unknown
  /** Present on a block carrying `retry:`. */
  readonly retry?: number
  /** The raw data text, present only when it could not be parsed as JSON. */
  readonly raw?: string
  readonly malformed?: boolean
}

export interface SseFrameParser {
  /** Feed decoded text; returns every frame completed by this chunk. */
  push(text: string): SseFrame[]
}

export function createSseFrameParser(): SseFrameParser {
  let buffer = ""
  return {
    push(text) {
      buffer += text
      const frames: SseFrame[] = []
      for (;;) {
        const end = buffer.indexOf("\n\n")
        if (end === -1) return frames
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)

        let event: string | undefined
        let retry: number | undefined
        const dataLines: string[] = []
        for (const line of block.split("\n")) {
          // A leading colon is a comment — this is how the server's keepalive
          // (`: ping`) arrives. Never a frame.
          if (line.startsWith(":")) continue
          if (line.startsWith("event:")) event = line.slice("event:".length).trimStart()
          else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart())
          else if (line.startsWith("retry:")) {
            const value = Number(line.slice("retry:".length).trim())
            if (Number.isFinite(value)) retry = value
          }
          // `id:` and unknown fields are ignored: this wire carries no ids, and
          // reconnect is a fresh snapshot rather than a cursor resume.
        }
        if (dataLines.length === 0 && retry === undefined) continue

        const name = event ?? "message"
        if (dataLines.length === 0) {
          frames.push({ event: name, retry })
          continue
        }
        // Multi-line data folds with newlines before parsing (SSE spec).
        const raw = dataLines.join("\n")
        try {
          const parsed: unknown = JSON.parse(raw)
          frames.push(retry === undefined ? { event: name, data: parsed } : { event: name, data: parsed, retry })
        } catch {
          frames.push({ event: name, malformed: true, raw })
        }
      }
    },
  }
}
```

> **Note:** `exactOptionalPropertyTypes` is on. Build frame objects with the conditional spread shown rather than assigning `undefined` to an optional property, or `tsc` will reject it.

- [ ] **Step 4: Run — expect PASS.** Fix until green.
- [ ] **Step 5: Lint + commit**

```bash
cd packages/cli && npx biome check --config-path ../config-biome/biome.json --write src/lib/threads/sse-frames.ts test/threads-sse-frames.test.ts
git add packages/cli/src/lib/threads/sse-frames.ts packages/cli/test/threads-sse-frames.test.ts
git commit -m "feat(cli): incremental SSE frame parser for the attach stream"
```

---

## Task 2: State parsing and the `toSseEvent` inverse

**Files:** Create `packages/cli/src/lib/threads/attach-state.ts`; Test `packages/cli/test/threads-attach-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { parseStateFrame, projectTurnChunk } from "../src/lib/threads/attach-state.js"

describe("parseStateFrame", () => {
  it("reads the durable-path frame", () => {
    const state = parseStateFrame({
      anchor: null, input: null, interrupts: [{ interruptId: "i1", resumeKey: "r1", value: { q: "ok?" } }],
      live: false, resume: false, run_started_at: null, status: "interrupted", turn: null, values: { messages: [] },
    })
    expect(state.live).toBe(false)
    expect(state.status).toBe("interrupted")
    expect(state.interrupts).toHaveLength(1)
    expect(state.interrupts[0]?.interruptId).toBe("i1")
    expect(state.turn).toBeNull()
    expect(state.truncated).toBe(false)
  })

  it("reads the live-path frame including truncation", () => {
    const state = parseStateFrame({
      anchor: "cp-1", input: { messages: [] }, interrupts: [], live: true, resume: true,
      run_started_at: "2020-01-01T00:00:00.000Z", status: "busy", turn: null, turn_truncated: true, values: null,
    })
    expect(state.live).toBe(true)
    expect(state.resume).toBe(true)
    expect(state.anchor).toBe("cp-1")
    expect(state.runStartedAt).toBe("2020-01-01T00:00:00.000Z")
    expect(state.truncated).toBe(true)
  })

  it("tolerates a garbage payload instead of throwing", () => {
    const state = parseStateFrame("not an object")
    expect(state.live).toBe(false)
    expect(state.interrupts).toEqual([])
    expect(state.turn).toBeNull()
  })
})

describe("projectTurnChunk", () => {
  it("re-wraps a data-only chunk and passes named-field chunks through", () => {
    // Mirrors the server's toSseEvent split: `chunk` carries its payload
    // unwrapped, `tool_result` carries named fields.
    expect(projectTurnChunk({ type: "chunk", data: "hi" })).toEqual({ event: "chunk", data: "hi" })
    expect(projectTurnChunk({ type: "tool_result", id: "c1", name: "ping", output: "pong" })).toEqual({
      event: "tool_result",
      data: { id: "c1", name: "ping", output: "pong" },
    })
  })
})
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `attach-state.ts`**

Export `AttachState` (`{live, status, anchor, runStartedAt, resume, values, input, turn, truncated, interrupts}`), `parseStateFrame(payload: unknown): AttachState` — every field read defensively with `typeof`/`Array.isArray` guards and a safe default, never throwing — and `projectTurnChunk(chunk: unknown): {event: string; data: unknown}` implementing the inverse of `toSseEvent`: if the chunk's only non-`type` own key is `data`, emit that value unwrapped; otherwise emit the remaining own keys as an object. Read `type` with `Object.hasOwn` and build the rest from `Object.entries`, so a `__proto__` key in wire JSON cannot influence the projection.

- [ ] **Step 4: Run — expect PASS.** **Step 5: Lint + commit.**

---

## Task 3: The renderer

**Files:** Create `packages/cli/src/lib/threads/tail-render.ts`; Test `packages/cli/test/threads-tail-render.test.ts`

The contract that makes the whole design observable: `renderSnapshot` must emit `turn[]` through **exactly** the same per-frame function the live tail uses.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { parseStateFrame } from "../src/lib/threads/attach-state.js"
import { renderFrame, renderSnapshot } from "../src/lib/threads/tail-render.js"

const base = {
  anchor: null, input: null, interrupts: [], live: false, resume: false,
  run_started_at: null, status: "idle", turn: null, values: null,
}

describe("renderSnapshot", () => {
  it("renders committed messages, then applies input when this is not a resume", () => {
    const lines = renderSnapshot(parseStateFrame({
      ...base, live: true, status: "busy", anchor: "cp-1", run_started_at: "T0",
      input: { messages: [{ role: "user", content: "run it" }] },
      values: { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hi there" }] },
      turn: [{ type: "chunk", data: "wor" }, { type: "chunk", data: "king" }],
    }))
    const text = lines.join("\n")
    expect(text).toContain("hi there")
    expect(text).toContain("run it")     // applied: resume is false
    expect(text).toContain("working")    // turn[] rendered through renderFrame
  })

  it("does NOT apply input to the transcript during a resume turn", () => {
    const lines = renderSnapshot(parseStateFrame({
      ...base, live: true, resume: true, status: "busy", anchor: "cp-1", run_started_at: "T0",
      input: { resume: [{ interruptId: "i1", status: "resolved" }] },
      values: { messages: [{ role: "user", content: "hi" }] },
    }))
    const text = lines.join("\n")
    expect(text).toContain("hi")
    expect(text).not.toContain('"resolved"') // echoed for correlation only, never applied
  })

  it("warns when the digest was truncated", () => {
    const lines = renderSnapshot(parseStateFrame({ ...base, live: true, turn: null, turn_truncated: true }))
    expect(lines.join("\n")).toMatch(/truncat/i)
  })

  it("lists parked interrupts on the durable path", () => {
    const lines = renderSnapshot(parseStateFrame({
      ...base, status: "interrupted",
      interrupts: [{ interruptId: "i1", resumeKey: "r1", value: { tool: "deployProd" } }],
    }))
    expect(lines.join("\n")).toContain("i1")
  })
})

describe("renderFrame", () => {
  it("renders each frame kind", () => {
    expect(renderFrame({ event: "chunk", data: "tok" }).join("")).toContain("tok")
    expect(renderFrame({ event: "tool_call", data: { name: "ping", input: {} } }).join("")).toContain("ping")
    expect(renderFrame({ event: "done", data: { output: null } }).join("")).toMatch(/done/i)
  })
})
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement.** Keep it line-oriented and plain-text (no ANSI dependency); `renderSnapshot` calls `renderFrame` for each projected `turn[]` entry. **Step 4: green. Step 5: lint + commit.**

---

## Task 4: The stream driver

**Files:** Create `packages/cli/src/lib/threads/tail-stream.ts`; Test `packages/cli/test/threads-tail-stream.test.ts`

- [ ] **Step 1: Write the failing test** — drive canned `ReadableStream`s and assert the outcome classification:

```ts
import { describe, expect, it } from "vitest"
import { consumeAttachStream } from "../src/lib/threads/tail-stream.js"

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({ start(c) { c.enqueue(encoder.encode(text)); c.close() } })
}
const DURABLE =
  'event: state\ndata: {"live":false,"status":"idle","interrupts":[],"turn":null,"values":null}\n\n' +
  'event: done\ndata: {"output":null}\n\n' +
  "retry: 2100\n\n"

describe("consumeAttachStream", () => {
  it("ends cleanly on done and reports the retry hint", async () => {
    const out: string[] = []
    const result = await consumeAttachStream({ body: bodyOf(DURABLE), write: (l) => out.push(l) })
    expect(result.outcome).toBe("done")
    expect(result.retryMs).toBe(2100)
    expect(out.join("\n")).toContain("idle")
  })

  it("reports a stream that ends without done as truncated", async () => {
    const result = await consumeAttachStream({
      body: bodyOf('event: state\ndata: {"live":true,"turn":[]}\n\n'),
      write: () => {},
    })
    expect(result.outcome).toBe("truncated")
  })

  it("reports a detached stream with its reason", async () => {
    const result = await consumeAttachStream({
      body: bodyOf('event: detached\ndata: {"reason":"capacity"}\n\n'),
      write: () => {},
    })
    expect(result.outcome).toBe("detached")
    expect(result.reason).toBe("capacity")
  })

  it("emits raw frames when json mode is on", async () => {
    const out: string[] = []
    await consumeAttachStream({ body: bodyOf(DURABLE), json: true, write: (l) => out.push(l) })
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({ event: "state" })
  })
})
```

- [ ] **Step 2: FAIL. Step 3: Implement** `consumeAttachStream({body, write, json?})` → `{outcome: "done" | "detached" | "truncated", reason?, retryMs?}`. Read the body with `getReader()` + `TextDecoder({stream: true})`, feed `createSseFrameParser`, and: on `state` → `renderSnapshot`; on `detached` → record reason and stop; on `done` → render and stop; otherwise → `renderFrame`. In `json` mode write `JSON.stringify(frame)` per frame instead of rendered lines. **Step 4: green. Step 5: lint + commit.**

---

## Task 5: The command

**Files:** Create `packages/cli/src/commands/threads.ts`; Modify `packages/cli/src/index.ts`; Test `packages/cli/test/threads-command-parsing.test.ts`

Follow the `memory` exemplar (`packages/cli/src/commands/memory.ts:25-54`): a single `program.command("threads [subcommand] [args...]")` with a `USAGE` block via `.addHelpText("after", …)` and a `switch` dispatch, so future subcommands slot in. **Declare `--url`, `--header` and `--json` as real commander options** (not manually parsed) so they are validated and so the docs check sees them. Do **not** use `.passThroughOptions()` — that exists for memory's hand-parsed flags and would stop commander from binding these.

`CliError` comes from `../lib/output.js`. Register with `registerThreadsCommand(program, io)` in `packages/cli/src/index.ts` after `registerTestCommand` (`:76`).

- [ ] **Step 1: Write the failing parsing test** — drive the real `createProgram` (mirror `packages/cli/test/memory-command-parsing.test.ts`) and assert `dawn threads tail t1 --url http://127.0.0.1:9/ --header 'x-a: 1' --header 'x-b: 2' --json` parses, that repeated `--header` accumulates, that a bad `--header` (no colon) is a `CliError`, and that a missing thread id is a `CliError` naming the usage.
- [ ] **Step 2: FAIL. Step 3: Implement**, exporting the pure validator for direct unit assertions:

```ts
export interface TailRequest {
  readonly url: URL
  readonly headers: Record<string, string>
  readonly json: boolean
}

/** Pure option validation — no I/O, so the failure modes are unit-testable. */
export function resolveTailRequest(threadId: string, options: ThreadsOptions): TailRequest
```

`resolveTailRequest` builds `new URL(`/threads/${encodeURIComponent(threadId)}/runs/stream`, base)` (base defaults to `http://127.0.0.1:3000`), parses each `--header` on the **first** `:` only (values may contain colons), rejects a header with no colon or an empty name, and throws `CliError(msg, 2)` for an unparseable `--url`.

The action then `fetch`es with `accept: text/event-stream`, and maps failures **before** streaming:
- transport throw → `CliError("Cannot reach the Dawn server at <base>: <cause>", 2)` (unwrap `error.cause`, since undici's own message is only `fetch failed`),
- `404` → `CliError("Thread \"<id>\" not found.", 2)`,
- `409 thread_route_unknown` → `CliError` explaining the thread has never run, exit `2`,
- any other non-2xx → `CliError` with the server's message, exit `2`,
- missing body → `CliError(…, 2)`.

On success it calls `consumeAttachStream` and maps the outcome: `done` → return (exit 0); `detached` → `CliError("Detached (<reason>). Reconnect for a fresh snapshot.", 1)`; `truncated` → `CliError("The attach stream ended without a terminal done frame.", 1)`.

- [ ] **Step 4: green. Step 5: Build + lint + commit** (build so later `check-docs` sees the command).

---

## Task 6: Integration against a real server

**Files:** Create `packages/cli/test/threads-tail-command.test.ts`

Use `startRuntimeServer({ appRoot })` (`packages/cli/src/lib/dev/runtime-server.ts:197-232`) — no `port` gives an ephemeral bound port and `server.url`. Close every server in `afterEach`. Reuse the fixtures from `packages/cli/test/ap-attach-endpoint.test.ts`: `fixtureApp` (`:87-102`), `SLOW_PING_TOOL` + `waitForFile` (`:47-63`, `:122-132`) for the barrier, and `withAimock` (`:106-120`) for the model.

> **The race the previous plan shipped:** it fired the attach GET before the POST had created the thread, so the test hit `404`/`409` nondeterministically. Sequence correctly: run a **warm-up turn to completion** (this also establishes the checkpoint that becomes the anchor — without it `anchor` is legitimately `null`), then start the blocking turn, then `await waitForFile(startedFile)`, and only then attach. Give live tests a 60s timeout, as `ap-attach-endpoint.test.ts` does.

- [ ] **Step 1: Write the failing tests** — call the command's exported runner with a captured `CommandIo`:
  1. **Durable path**: seed a thread with a completed run, tail it, assert output shows the committed transcript and the run exits 0.
  2. **Live tail**: warm-up turn → blocking turn → `waitForFile` → tail; assert the snapshot renders, then release the barrier and assert a live `tool_result` and terminal `done` appear, exit 0.
  3. **Unknown thread** → exit code 2 and a message naming the thread id.
  4. **Middleware gating** → a fixture with `src/middleware.ts` rejecting without a header; assert tailing without `--header` fails with the middleware's status, and passing `--header` succeeds.
- [ ] **Step 2: FAIL → Step 3: fix the command until green → Step 4: commit.**

---

## Task 7: Docs + changeset

**Files:** Modify `apps/web/content/docs/cli.mdx`; Create `.changeset/ap-threads-tail.md`

The CLI-surface check (`scripts/check-docs.mjs:4743-4790`) imports the **built** `createProgram` and requires `cli.mdx` to contain the literal `dawn threads` plus every declared long flag (`--url`, `--header`, `--json`).

- [ ] **Step 1: Add the `## \`dawn threads\`` section** to `cli.mdx`, immediately before `## Exit codes`, mirroring the existing heading + fenced-usage + `Flags:` shape (see `## dawn memory`, `:212-305`). Cover: what tailing is for (rejoining a run after a disconnect), the durable-vs-live distinction, that the command exits when the turn emits `done`, and a link to the wire contract at `/docs/dev-server/agent-protocol`. Document each flag, and state the exit codes (`1` detached/truncated, `2` unreachable/unknown thread) consistently with the existing table.
- [ ] **Step 2: Write the changeset** (patch, `@dawn-ai/cli` only) describing the new command and that it is the first first-party AP stream client. **Avoid the phrase `byte-identical`** — `check-docs.mjs` bans it (`:4702-4706`).
- [ ] **Step 3: Commit both, THEN validate** (both gates read committed/built state):

```bash
git add apps/web/content/docs/cli.mdx .changeset/ap-threads-tail.md
git commit -m "docs(cli): document dawn threads tail + changeset"
source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @dawn-ai/cli build > /tmp/b.log 2>&1; echo "BUILD=$?"
node scripts/check-docs.mjs > /tmp/cd.log 2>&1; echo "DOCS=$?"
node scripts/check-changesets.mjs > /tmp/cc.log 2>&1; echo "CHANGESETS=$?"
```

- [ ] **Step 4: Final gate** — `pnpm ci:validate > /tmp/v.log 2>&1; echo "EXIT=$?"` (never piped). Expect 0. Two known load-induced flakes may appear under full-suite concurrency (`render-route-types` in `@dawn-ai/core`, `api-reference-inventory` in `web`); both pass in isolation and are unrelated — re-run those two files individually to confirm rather than treating them as regressions.

---

## Self-Review (completed during drafting)

**Spec coverage:** §5 (`dawn threads tail`) → Tasks 1–6. The client reducer contract (render `values.messages`, apply `input` only when not resuming, feed `turn[]` through the live-frame path) → Task 3, asserted in two tests. `run_started_at` / `anchor` client rules → Task 3's header line, documented in Task 7. `turn_truncated` → Task 3. `detached` (both reasons) and the `retry:` hint → Task 4. The durable-vs-live distinction → Tasks 4, 6, 7.

**Previously-flagged gaps now closed:** `event: state` as a Dawn wire extension, the digest/viewer bounds, the empty-`interrupts`-during-resume rule, and the `run_started_at` rule were all documented in PR2's `agent-protocol.mdx` section — PR3 cross-links rather than duplicating. The old plan's `examples/research` digest-cap gate is **dropped**: the bounds are internal defaults with unit coverage in `live-turn-hub.test.ts`, and driving a 2 MiB overflow through a real research app would be a slow, flaky end-to-end assertion of an already-unit-tested rule.

**Blockers from the provisional plan, each fixed here:** the attach-before-create race (Task 6's explicit sequencing note), the changeset gate ordering (Task 7 Step 3 commits first), and the docs gate reading built `dist` (called out in the gotchas and in Task 7).

**Placeholder scan:** none — every code step carries real code or a pinned anchor.

**Type consistency:** `SseFrame`/`createSseFrameParser` (Task 1) → `parseStateFrame`/`projectTurnChunk`/`AttachState` (Task 2) → `renderSnapshot`/`renderFrame` (Task 3) → `consumeAttachStream` (Task 4) → `resolveTailRequest`/`registerThreadsCommand` (Task 5) are used under those exact names throughout.

**Open risk for the executor:** commander's `enablePositionalOptions()` is set on the program for `memory`'s sake. Verify in Task 5's parsing test that `dawn threads tail t1 --json` actually binds `--json` to the `threads` command rather than being treated as a positional — if it does not, the fix is to declare the options and adjust argument order in the test, *not* to add `.passThroughOptions()` (which would hide the flags from the docs check).
