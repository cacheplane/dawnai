# Agent Protocol Live-Turn Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: PROVISIONAL — re-verify before executing.** This plan was drafted against the tree *before* PR1 landed, so its `runtime-fetch-core.ts` line numbers and find/replace anchors are stale by construction, and a verification pass found four blockers of exactly that kind (non-unique edit anchors, a two-space indentation mismatch, a PR1-existence gate that cannot detect PR1, and fixture release-file paths that never reach the route). It also inverts TDD across Tasks 2–7 (one task ships the whole hub; five later tasks have no failing-test step) and has six spec-coverage gaps: an in-process `/runs/wait` attach, the park wire sequence (`interrupt` frame then terminal `done`) seen by an attacher, a live-during-resume test that actually executes the live branch, handler-scoped isolation between two concurrent handler instances, integration reach for the per-subscriber byte cap, and a digest-cap gate that really drives `examples/research`. Re-run the plan-writing and verification pass against the post-PR1 tree before executing a single step.

**Goal:** Ship PR2 of the stream-reattachment spec — a `LiveTurnHub` plus `GET /threads/{thread_id}/runs/stream`, so a disconnected Agent Protocol client can rejoin a run in flight and recover the partial turn, and falls back to a checkpoint-backed snapshot everywhere else.

**Architecture:** One new pure in-memory module (`live-turn-hub.ts`) holds a bounded, coalesced digest of the *current* turn per thread, anchored to an immutable checkpoint. Producers (the POST stream handler and the resume handler) read that anchor once before the route starts, open a turn, publish each chunk beside the existing `safeEnqueue`, and close the turn unconditionally at client-visible stream end. Delivery is **pull, not push**: `publish` only mutates data and resolves wake promises, and every attacher drains its own queue inside its own response stream — which is what makes the queue caps enforceable and keeps the whole thing legal on workerd, where I/O objects cannot be shared across requests. **This plan assumes PR1 has already landed:** `readPendingInterrupts` surfaces each interrupt's `value`, a pure `parsePendingInterrupts(tuple)` is exported from `pending-interrupts.ts`, `GET /threads/{id}/pending_interrupts` exists, and both stream handlers already track a `sawInterrupt` flag so a parked turn writes thread status `"interrupted"` instead of `"idle"`. Nothing in PR2 changes `RunRegistry`, the storage packages, or AG-UI.

**Tech Stack:** TypeScript 7 (NodeNext ESM, `exactOptionalPropertyTypes`), Web `ReadableStream` / `Response` / `TextEncoder`, Server-Sent Events, LangGraph checkpointers (`@dawn-ai/sqlite-storage`, `@dawn-ai/postgres-storage`), Vitest 4, aimock fixtures from `@dawn-ai/testing`, pnpm 10 + Turbo, Node 24.

---

## File Structure

**Created**

| File | Single responsibility |
|---|---|
| `packages/cli/src/lib/dev/live-turn-hub.ts` | The only new runtime artifact: `createLiveTurnHub()` — per-thread live turn registry, coalesced bounded digest, pull-model subscribers, identity-guarded publish/close. Pure in-memory, zero `node:` imports. |
| `packages/cli/test/live-turn-hub.test.ts` | Unit contract suite for the hub. No HTTP, no filesystem. |
| `packages/cli/test/helpers/ap-attach-fixture.ts` | Shared integration fixtures: the app-on-disk builders, aimock wiring, SSE frame parser, and request builders used by every attach integration test. |
| `packages/cli/test/ap-attach.test.ts` | Attach integration suite against the real fetch handler (sqlite checkpointer). |
| `packages/cli/test/ap-attach-postgres.test.ts` | The same attach contract against a real Postgres checkpointer, gated on `DAWN_TEST_PGSTORAGE=1`. |
| `examples/research/server/test/attach-digest-cap.test.ts` | Pass/fail gate: a full deep-research turn must fit under the default 2 MiB digest cap after coalescing. |
| `.changeset/ap-attach-live-turn.md` | Patch changeset for `@dawn-ai/cli`. |

**Modified**

| File | What changes |
|---|---|
| `packages/cli/src/lib/runtime/stream-types.ts` | Add the attach wire types (`AttachStateFrame`, `AttachInterrupt`, `AttachDetachedFrame`, `AttachDetachReason`) and `toSseFrame(event, payload)` — a verbatim named-frame serializer for payloads that are not `StreamChunk`s. `StreamChunk` and `toSseEvent` are untouched. |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | New handler options + defaults; instantiate the hub beside `threadRouteMap`; register `GET /threads/:thread_id/runs/stream`; add `handleApAttachRequest` + `writeDurableAttachFrames` + the `checkpointIdOf` / `channelValuesOf` accessors + one shared `apSseResponse` helper; producer hooks (anchor read, `hub.open`, `publish`, unconditional `close`, extended pre-stream catch) in `handleApStreamRequest` and `handleResumeRequest`. |
| `packages/cli/src/runtime-exports.ts` | Export `createLiveTurnHub` + its types and the new attach frame types on `@dawn-ai/cli/runtime`. |
| `packages/cli/test/runtime-exports.test.ts` | Pin the new exported symbol. |
| `packages/cli/test/stream-types.test.ts` | Pin `toSseFrame` serialization for the `state` and `detached` frames. |
| `packages/cli/package.json` | Add `@dawn-ai/postgres-storage` as a devDependency for the gated attach lane. |

---

## Task 0: Establish the runtime and a green baseline

**Files:**
- No source changes.

- [ ] **Step 1: Select Node 24**

Node 22 makes roughly eight `dawn verify` tests fail spuriously in a way that looks
pre-existing. From the worktree root `/Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a`:

```bash
nvm use 24
node --version
pnpm --version
```

Expected: Node prints `v24.x.x`, pnpm prints `10.33.0`. Every later command block
assumes this shell. If a fresh shell is used, run `nvm use 24` again first.

- [ ] **Step 2: Install and build**

`packages/cli/test/*.test.ts` import built artifacts from `packages/testing/dist`,
so the build must run before any test.

```bash
pnpm install --frozen-lockfile
pnpm build
```

Expected: install completes, `turbo run build` finishes with every package built.

- [ ] **Step 3: Record the baseline for the suites this PR touches**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/run-cancellation.test.ts test/resume-endpoint.test.ts \
  test/runtime-fetch-parity.test.ts test/runtime-fetch-handler.test.ts \
  test/stream-types.test.ts test/pending-interrupts.test.ts
```

Expected: all files pass. If any fail here, stop — PR1 is not correctly landed and
this plan's assumptions do not hold.

---

## Task 1: Attach wire types and the named-frame serializer

The attach endpoint emits two frames that are **not** `StreamChunk`s: `event: state`
and `event: detached`. They must not go through `toSseEvent`, whose data-only branch
would unwrap a `{type, data}` shape one level too far.

**Files:**
- Modify: `packages/cli/src/lib/runtime/stream-types.ts` (append after line 59)
- Test: `packages/cli/test/stream-types.test.ts` (append a new `describe`)

- [ ] **Step 1: Write the failing test**

Append this to the end of `packages/cli/test/stream-types.test.ts`:

```ts
describe("toSseFrame", () => {
  it("serializes an attach state frame verbatim, with no data unwrapping", () => {
    const frame: AttachStateFrame = {
      anchor: "ckpt-1",
      input: { messages: [{ content: "hi", role: "user" }] },
      interrupts: [],
      live: true,
      resume: false,
      run_started_at: "2026-08-09T00:00:00.000Z",
      status: "busy",
      turn: [{ data: "Hel", type: "chunk" }],
      values: { messages: [] },
    }

    const text = toSseFrame("state", frame)
    expect(text.startsWith("event: state\ndata: ")).toBe(true)
    expect(text.endsWith("\n\n")).toBe(true)
    const payload = JSON.parse(text.slice("event: state\ndata: ".length, -2)) as AttachStateFrame
    expect(payload).toEqual(frame)
  })

  it("omits turn_truncated unless the digest overflowed", () => {
    const truncated: AttachStateFrame = {
      anchor: null,
      input: null,
      interrupts: [],
      live: true,
      resume: false,
      run_started_at: "2026-08-09T00:00:00.000Z",
      status: "busy",
      turn: null,
      turn_truncated: true,
      values: null,
    }
    const payload = JSON.parse(
      toSseFrame("state", truncated).slice("event: state\ndata: ".length, -2),
    ) as Record<string, unknown>
    expect(payload.turn_truncated).toBe(true)
    expect(payload.turn).toBeNull()
  })

  it("serializes a detached frame with only its reason", () => {
    const frame: AttachDetachedFrame = { reason: "overflow" }
    expect(toSseFrame("detached", frame)).toBe('event: detached\ndata: {"reason":"overflow"}\n\n')
  })

  it("carries a durable-path interrupt payload through unchanged", () => {
    const interrupt: AttachInterrupt = {
      interruptId: "perm-1",
      resumeKey: "3336d0e0a2d4f198ef9aecd09cd7ac27",
      value: { detail: { command: "ls" }, kind: "command", type: "permission-request" },
    }
    const payload = JSON.parse(
      toSseFrame("state", { interrupts: [interrupt] }).slice("event: state\ndata: ".length, -2),
    ) as { interrupts: AttachInterrupt[] }
    expect(payload.interrupts[0]).toEqual(interrupt)
  })
})
```

And replace the existing first import line of that file with:

```ts
import {
  type AttachDetachedFrame,
  type AttachInterrupt,
  type AttachStateFrame,
  type StreamChunk,
  toNdjsonLine,
  toSseEvent,
  toSseFrame,
} from "../src/lib/runtime/stream-types.js"
```

- [ ] **Step 2: Run the test and see it fail**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/stream-types.test.ts
```

Expected: FAIL — `SyntaxError: The requested module '../src/lib/runtime/stream-types.js' does not provide an export named 'toSseFrame'` (vitest reports it as a transform/import error before any test runs).

- [ ] **Step 3: Add the types and the serializer**

Append to `packages/cli/src/lib/runtime/stream-types.ts`:

```ts
// ---------------------------------------------------------------------------
// Attach frames — GET /threads/{thread_id}/runs/stream
//
// Deliberately NOT members of `StreamChunk`: they are envelope frames, not
// agent output, and `toSseEvent`'s data-only branch would unwrap a `{type,
// data}` shape one level too far. They go through `toSseFrame` instead, which
// serializes the payload verbatim.
// ---------------------------------------------------------------------------

/** Why a viewer's attach stream ended before the turn it was watching did. */
export type AttachDetachReason = "capacity" | "overflow"

/** A durable pending interrupt, with the payload a client needs to re-render it. */
export interface AttachInterrupt {
  readonly interruptId: string
  readonly resumeKey: string | null
  readonly value: unknown
}

/**
 * The one snapshot frame every attach stream opens with.
 *
 * `live: true` means a streaming turn is attachable in this process: `values`
 * is the checkpoint at `anchor` (the instant the run claimed its slot), `input`
 * is the payload that started the turn, `turn` is that turn's chunks so far in
 * emission order (coalesced), and `interrupts` is always `[]` — a live turn is
 * by definition not parked, and echoing the latest tuple's pending writes
 * during a resume run would re-render an already-answered prompt.
 *
 * `live: false` is the durable path: `values` is the latest checkpoint,
 * `interrupts` carries the parked interrupts with their payloads, and
 * `anchor` / `run_started_at` / `input` / `turn` are all null with `resume`
 * false and `turn_truncated` absent.
 */
export interface AttachStateFrame {
  readonly anchor: string | null
  readonly input: unknown
  readonly interrupts: readonly AttachInterrupt[]
  readonly live: boolean
  readonly resume: boolean
  readonly run_started_at: string | null
  readonly status: "busy" | "idle" | "interrupted"
  readonly turn: readonly StreamChunk[] | null
  /** Present only when the digest overflowed and was dropped whole. */
  readonly turn_truncated?: true
  readonly values: Record<string, unknown> | null
}

/** Sent immediately before an attach stream closes early. */
export interface AttachDetachedFrame {
  readonly reason: AttachDetachReason
}

/**
 * Format a named SSE frame whose payload is serialized verbatim.
 *
 * `toSseEvent` exists for `StreamChunk`s and deliberately unwraps a lone `data`
 * field; these envelope frames have named fields and must survive unchanged.
 */
export function toSseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}
```

- [ ] **Step 4: Run the test and see it pass**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/stream-types.test.ts
```

Expected: PASS, all cases green (the pre-existing `toSseEvent` / `toNdjsonLine` cases included).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/stream-types.ts packages/cli/test/stream-types.test.ts
git commit -m "feat(cli): add Agent Protocol attach frame types" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: The hub — open, peek, attach, close

**Files:**
- Create: `packages/cli/src/lib/dev/live-turn-hub.ts`
- Test: `packages/cli/test/live-turn-hub.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/live-turn-hub.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createLiveTurnHub, type LiveTurnHub } from "../src/lib/dev/live-turn-hub.js"

/** A hub with generous bounds — individual suites tighten what they exercise. */
function hub(overrides: { digestMaxBytes?: number; maxViewers?: number } = {}): LiveTurnHub {
  return createLiveTurnHub({
    digestMaxBytes: overrides.digestMaxBytes ?? 1_000_000,
    maxViewers: overrides.maxViewers ?? 16,
  })
}

const OPEN = {
  anchorCheckpointId: "ckpt-1",
  input: { messages: [{ content: "hi", role: "user" }] },
  resume: false,
  runStartedAt: "2026-08-09T00:00:00.000Z",
}

describe("createLiveTurnHub — turn lifecycle", () => {
  it("reports no live turn for a thread that has never run", () => {
    const h = hub()
    expect(h.peek("t1")).toBeUndefined()
    expect(h.attach("t1")).toEqual({ kind: "absent" })
  })

  it("exposes the turn identity after open, without registering a viewer", () => {
    const h = hub()
    h.open("t1", OPEN)
    expect(h.peek("t1")).toEqual({
      anchorCheckpointId: "ckpt-1",
      atCapacity: false,
      input: OPEN.input,
      resume: false,
      runStartedAt: "2026-08-09T00:00:00.000Z",
    })
    // peek registered nothing, so the first real attach still gets a slot.
    expect(h.attach("t1").kind).toBe("live")
  })

  it("carries a resume turn's own identity", () => {
    const h = hub()
    h.open("t1", {
      anchorCheckpointId: "ckpt-parked",
      input: [{ interruptId: "perm-1", payload: "once", status: "resolved" }],
      resume: true,
      runStartedAt: "2026-08-09T00:00:05.000Z",
    })
    expect(h.peek("t1")?.resume).toBe(true)
    expect(h.peek("t1")?.anchorCheckpointId).toBe("ckpt-parked")
    expect(h.peek("t1")?.runStartedAt).toBe("2026-08-09T00:00:05.000Z")
  })

  it("makes the turn unattachable once closed", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    turn.close()
    expect(h.peek("t1")).toBeUndefined()
    expect(h.attach("t1")).toEqual({ kind: "absent" })
  })

  it("close is idempotent", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    turn.close()
    turn.close()
    expect(h.peek("t1")).toBeUndefined()
  })

  it("keeps turns on different threads independent", () => {
    const h = hub()
    const a = h.open("t1", OPEN)
    h.open("t2", OPEN)
    a.close()
    expect(h.peek("t1")).toBeUndefined()
    expect(h.peek("t2")).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test and see it fail**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/live-turn-hub.test.ts
```

Expected: FAIL — `Failed to load url ../src/lib/dev/live-turn-hub.js` (the module does not exist yet).

- [ ] **Step 3: Create the hub module**

Create `packages/cli/src/lib/dev/live-turn-hub.ts` with the complete file below. Later
tasks fill in coalescing, bounds and delivery; this version already carries the whole
public shape so no signature changes ripple later.

```ts
import type { StreamChunk } from "../runtime/stream-types.js"

/**
 * Process-local registry of the CURRENT turn of each in-flight run, keyed by
 * thread id — the one new in-memory artifact behind
 * `GET /threads/{thread_id}/runs/stream`.
 *
 * Checkpoints stay the single durable source of truth. What lives here is a
 * bounded, coalesced digest of the chunks the current turn has emitted, anchored
 * to the immutable checkpoint that existed before the route started. Reconnect
 * always re-snapshots: there are no cursors, no retention, no run identity, and
 * every failure mode is self-healed by reconnecting.
 *
 * Handler-scoped, never a module singleton — the same rule the run registry
 * follows, for the same reason (`run-registry.ts`).
 *
 * DELIVERY IS PULL, NOT PUSH. `publish` only appends to plain data structures
 * and resolves wake promises; it never touches a foreign stream controller. Each
 * attacher runs its own drain loop inside its own response stream, in its own
 * request context. That is what makes the per-viewer queue cap enforceable (an
 * overflow is detected at append), and it is what keeps live attach legal on
 * workerd, where I/O objects may not be shared across requests.
 *
 * Rationale: docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md
 */

/** Why a viewer's stream ended before the turn it was watching did. */
export type DetachReason = "capacity" | "overflow"

export interface LiveTurnOpenOptions {
  /** Checkpoint the run is anchored to; `null` on a brand-new thread. */
  readonly anchorCheckpointId: string | null
  /** The validated payload that started this turn (resume entries on a resume turn). */
  readonly input: unknown
  /** True when `POST /threads/:id/resume` started this turn. */
  readonly resume: boolean
  /** ISO wall-clock instant this turn claimed the run slot. */
  readonly runStartedAt: string
}

/** Everything the attach state frame needs that is not read from a checkpoint. */
export interface LiveTurnIdentity {
  readonly anchorCheckpointId: string | null
  /** True when the viewer cap is already taken — refuse before doing snapshot work. */
  readonly atCapacity: boolean
  readonly input: unknown
  readonly resume: boolean
  readonly runStartedAt: string
}

export interface LiveTurnSnapshot {
  /** Accounted serialized size of the digest, in bytes. Zero once truncated. */
  readonly bytes: number
  /** A terminal `done` published before this viewer registered, if any. */
  readonly terminal: StreamChunk | undefined
  /** True when the digest was dropped whole; the state frame sets `turn_truncated`. */
  readonly truncated: boolean
  /** The turn's chunks so far, coalesced. `null` when truncated. */
  readonly turn: readonly StreamChunk[] | null
}

export type LiveTurnDelivery =
  | { readonly kind: "frames"; readonly frames: readonly StreamChunk[] }
  | { readonly kind: "detached"; readonly reason: "overflow" }
  | { readonly kind: "end" }

export interface LiveTurnSubscription {
  /** Resolves as soon as there is something to write; parks otherwise. */
  next(): Promise<LiveTurnDelivery>
  /** Idempotent; frees this viewer's slot. Safe from a `finally`. */
  close(): void
}

export type AttachResult =
  | { readonly kind: "absent" }
  | { readonly kind: "capacity" }
  | {
      readonly kind: "live"
      readonly identity: LiveTurnIdentity
      readonly snapshot: LiveTurnSnapshot
      readonly subscription: LiveTurnSubscription
    }

export interface LiveTurn {
  /**
   * Record a chunk. A `done` chunk becomes the turn's terminal — fanned out to
   * viewers and stored for a late attacher, but NEVER appended to the digest, so
   * `turn[]` can never smuggle the terminator.
   */
  publish(chunk: StreamChunk): void
  /** End the turn for every viewer. Idempotent, and inert once this entry was replaced. */
  close(terminal?: StreamChunk): void
}

export interface LiveTurnHubOptions {
  /** Serialized bytes of digest before it is dropped whole. */
  readonly digestMaxBytes: number
  /** Viewers allowed per thread. */
  readonly maxViewers: number
  /** Frames a single viewer may fall behind by before it is dropped. */
  readonly queueMaxFrames?: number
  /** Serialized bytes a single viewer may fall behind by before it is dropped. */
  readonly queueMaxBytes?: number
}

export interface LiveTurnHub {
  open(threadId: string, options: LiveTurnOpenOptions): LiveTurn
  /** Identity only — registers nothing and copies nothing. */
  peek(threadId: string): LiveTurnIdentity | undefined
  /** Register a viewer AND copy the digest, in one synchronous section. */
  attach(threadId: string): AttachResult
}

const DEFAULT_QUEUE_MAX_FRAMES = 1024
const DEFAULT_QUEUE_MAX_BYTES = 1_048_576

/** Handed to viewers of an entry that a newer run replaced. */
const REPLACED_TERMINAL: StreamChunk = {
  output: { error: "Live turn replaced by a newer run on this thread" },
  type: "done",
}

const textEncoder = new TextEncoder()

function serializedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length
}

/**
 * Bytes `JSON.stringify` grows by when `text` is appended to an existing JSON
 * string. JSON escaping is per-character, so the delta is exactly the escaped
 * text minus its two quotes — O(delta), never O(accumulated). This is what
 * makes the digest accounting incremental instead of quadratic.
 */
function appendedTextBytes(text: string): number {
  return textEncoder.encode(JSON.stringify(text)).length - 2
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The coalescing key for a chunk, or undefined when it must stand alone.
 *
 * `chunk` frames carry model text one token at a time; `subagent.message`
 * frames carry a child's text one token at a time, keyed by `call_id`. Without
 * the per-`call_id` case a single deep-research turn blows any reasonable cap.
 */
function coalescingKeyOf(chunk: StreamChunk): string | undefined {
  const data = (chunk as { readonly data?: unknown }).data
  if (chunk.type === "chunk") return typeof data === "string" ? "chunk" : undefined
  if (chunk.type !== "subagent.message") return undefined
  if (!isRecord(data)) return undefined
  if (typeof data.chunk !== "string" || typeof data.call_id !== "string") return undefined
  return `subagent.message:${data.call_id}`
}

function coalescedTextOf(chunk: StreamChunk): string {
  const data = (chunk as { readonly data?: unknown }).data
  if (typeof data === "string") return data
  if (isRecord(data) && typeof data.chunk === "string") return data.chunk
  return ""
}

/**
 * A NEW chunk object carrying `previous` plus `delta`.
 *
 * Deliberately not an in-place mutation: `attach` hands out a shallow copy of
 * the digest array, so growing an element in place would put the same text in
 * both a viewer's snapshot and its live tail.
 */
function withAppendedText(previous: StreamChunk, delta: string): StreamChunk {
  const data = (previous as { readonly data?: unknown }).data
  if (typeof data === "string") return { data: data + delta, type: previous.type }
  const record = isRecord(data) ? data : {}
  const existing = typeof record.chunk === "string" ? record.chunk : ""
  return { data: { ...record, chunk: existing + delta }, type: previous.type }
}

interface Subscriber {
  closed: boolean
  overflowed: boolean
  queue: StreamChunk[]
  queueBytes: number
  wake: (() => void) | undefined
}

interface Entry {
  readonly anchorCheckpointId: string | null
  /** Digest index of the still-appendable entry for each coalescing key. */
  readonly coalescing: Map<string, number>
  digest: StreamChunk[]
  digestBytes: number
  ended: boolean
  readonly input: unknown
  readonly resume: boolean
  readonly runStartedAt: string
  readonly subscribers: Set<Subscriber>
  terminal: StreamChunk | undefined
  truncated: boolean
}

export function createLiveTurnHub(options: LiveTurnHubOptions): LiveTurnHub {
  const digestMaxBytes = options.digestMaxBytes
  const maxViewers = options.maxViewers
  const queueMaxFrames = options.queueMaxFrames ?? DEFAULT_QUEUE_MAX_FRAMES
  const queueMaxBytes = options.queueMaxBytes ?? DEFAULT_QUEUE_MAX_BYTES
  const entries = new Map<string, Entry>()

  const wakeAll = (entry: Entry) => {
    for (const sub of entry.subscribers) {
      const wake = sub.wake
      sub.wake = undefined
      wake?.()
    }
  }

  const fanOut = (entry: Entry, chunk: StreamChunk) => {
    for (const sub of entry.subscribers) {
      if (sub.closed || sub.overflowed) continue
      sub.queue.push(chunk)
      sub.queueBytes += serializedBytes(chunk)
      if (sub.queue.length > queueMaxFrames || sub.queueBytes > queueMaxBytes) {
        // Drop THIS viewer only: it gets a best-effort `detached` frame and
        // reconnects for a fresh snapshot. The run and every other viewer are
        // untouched.
        sub.overflowed = true
        sub.queue = []
        sub.queueBytes = 0
      }
      const wake = sub.wake
      sub.wake = undefined
      wake?.()
    }
  }

  const appendToDigest = (entry: Entry, chunk: StreamChunk) => {
    if (entry.truncated) return
    const key = coalescingKeyOf(chunk)
    if (key === undefined) {
      // A structural frame is a barrier: text published after it must never
      // migrate in front of it, so every open coalescing run closes here.
      entry.coalescing.clear()
      entry.digest.push(chunk)
      entry.digestBytes += serializedBytes(chunk)
    } else {
      const openIndex = entry.coalescing.get(key)
      const previous = openIndex === undefined ? undefined : entry.digest[openIndex]
      if (openIndex === undefined || !previous) {
        entry.coalescing.set(key, entry.digest.length)
        entry.digest.push(chunk)
        entry.digestBytes += serializedBytes(chunk)
      } else {
        const delta = coalescedTextOf(chunk)
        entry.digest[openIndex] = withAppendedText(previous, delta)
        entry.digestBytes += appendedTextBytes(delta)
      }
    }
    if (entry.digestBytes > digestMaxBytes) {
      // Drop the digest WHOLE rather than ever emitting misleading
      // partial-middle text: the state frame degrades to values + live tail.
      entry.coalescing.clear()
      entry.digest = []
      entry.digestBytes = 0
      entry.truncated = true
    }
  }

  const closeEntry = (threadId: string, entry: Entry, terminal?: StreamChunk) => {
    // The run-registry identity guard (`run-registry.ts:96`): never act on a
    // slot a later turn has claimed.
    if (entries.get(threadId) !== entry || entry.ended) return
    if (terminal && !entry.terminal) {
      entry.terminal = terminal
      fanOut(entry, terminal)
    }
    entry.ended = true
    entries.delete(threadId)
    wakeAll(entry)
  }

  const identityOf = (entry: Entry): LiveTurnIdentity => ({
    anchorCheckpointId: entry.anchorCheckpointId,
    atCapacity: entry.subscribers.size >= maxViewers,
    input: entry.input,
    resume: entry.resume,
    runStartedAt: entry.runStartedAt,
  })

  const subscriptionFor = (entry: Entry, sub: Subscriber): LiveTurnSubscription => ({
    close() {
      if (sub.closed) return
      sub.closed = true
      entry.subscribers.delete(sub)
      const wake = sub.wake
      sub.wake = undefined
      wake?.()
    },
    async next(): Promise<LiveTurnDelivery> {
      for (;;) {
        if (sub.closed) return { kind: "end" }
        // Queued frames always drain first — including after the turn ended, so
        // the terminal `done` is delivered before the stream closes.
        if (sub.queue.length > 0) {
          const frames = sub.queue
          sub.queue = []
          sub.queueBytes = 0
          return { frames, kind: "frames" }
        }
        if (sub.overflowed) {
          sub.closed = true
          entry.subscribers.delete(sub)
          return { kind: "detached", reason: "overflow" }
        }
        if (entry.ended) {
          sub.closed = true
          entry.subscribers.delete(sub)
          return { kind: "end" }
        }
        await new Promise<void>((resolve) => {
          sub.wake = resolve
        })
      }
    },
  })

  return {
    attach(threadId) {
      const entry = entries.get(threadId)
      if (!entry || entry.ended) return { kind: "absent" }
      if (entry.subscribers.size >= maxViewers) return { kind: "capacity" }
      const sub: Subscriber = {
        closed: false,
        overflowed: false,
        queue: [],
        queueBytes: 0,
        wake: undefined,
      }
      // ONE synchronous section: register, copy the digest, capture the stored
      // terminal. Single-threaded JS makes it atomic against `publish`, so no
      // frame lands in both the copy and the queue, and their concatenation is
      // the full turn — the gap/dup invariant, with zero sequence numbers.
      entry.subscribers.add(sub)
      return {
        identity: identityOf(entry),
        kind: "live",
        snapshot: {
          bytes: entry.digestBytes,
          terminal: entry.terminal,
          truncated: entry.truncated,
          turn: entry.truncated ? null : [...entry.digest],
        },
        subscription: subscriptionFor(entry, sub),
      }
    },
    open(threadId, openOptions) {
      const existing = entries.get(threadId)
      // Belt-and-braces: a leaked entry's viewers get a terminal frame instead
      // of hanging on heartbeats forever.
      if (existing) closeEntry(threadId, existing, REPLACED_TERMINAL)
      const entry: Entry = {
        anchorCheckpointId: openOptions.anchorCheckpointId,
        coalescing: new Map(),
        digest: [],
        digestBytes: 0,
        ended: false,
        input: openOptions.input,
        resume: openOptions.resume,
        runStartedAt: openOptions.runStartedAt,
        subscribers: new Set(),
        terminal: undefined,
        truncated: false,
      }
      entries.set(threadId, entry)
      return {
        close(terminal) {
          closeEntry(threadId, entry, terminal)
        },
        publish(chunk) {
          // Identity guard: a cancelled route can still be unwinding while a
          // new run opens a new entry on the same thread. A zombie publisher
          // must never write into its successor's turn.
          if (entries.get(threadId) !== entry || entry.ended) return
          if (chunk.type === "done") {
            entry.terminal = chunk
            fanOut(entry, chunk)
            return
          }
          appendToDigest(entry, chunk)
          fanOut(entry, chunk)
        },
      }
    },
    peek(threadId) {
      const entry = entries.get(threadId)
      if (!entry || entry.ended) return undefined
      return identityOf(entry)
    },
  }
}
```

- [ ] **Step 4: Run the test and see it pass**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/live-turn-hub.test.ts
```

Expected: PASS — 6 tests in `createLiveTurnHub — turn lifecycle`.

- [ ] **Step 5: Typecheck and lint the new module**

```bash
pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
```

Expected: both exit 0. Never run bare `biome check --write` — it mass-reformats the repo.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/live-turn-hub.ts packages/cli/test/live-turn-hub.test.ts
git commit -m "feat(cli): add the live-turn hub" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Hub — chunk and per-`call_id` coalescing with incremental byte accounting

**Files:**
- Test: `packages/cli/test/live-turn-hub.test.ts` (append)
- Modify: `packages/cli/src/lib/dev/live-turn-hub.ts` (no change expected — Task 2 shipped the implementation; this task proves it and fixes anything the tests expose)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/live-turn-hub.test.ts`:

```ts
/** The text a coalesced or raw chunk carries, whatever its shape. */
function textOf(chunk: StreamChunk): string {
  const data = (chunk as { readonly data?: unknown }).data
  if (typeof data === "string") return data
  if (data && typeof data === "object" && typeof (data as { chunk?: unknown }).chunk === "string") {
    return (data as { chunk: string }).chunk
  }
  return ""
}

function token(text: string): StreamChunk {
  return { data: text, type: "chunk" }
}

function subagentToken(callId: string, text: string): StreamChunk {
  return {
    data: { call_id: callId, chunk: text, depth: 1, route_id: "/research", subagent: "researcher" },
    type: "subagent.message",
  }
}

/** Snapshot the digest of the live turn on `threadId`. */
function digestOf(h: LiveTurnHub, threadId: string): readonly StreamChunk[] {
  const attached = h.attach(threadId)
  if (attached.kind !== "live") throw new Error(`expected a live turn, got ${attached.kind}`)
  attached.subscription.close()
  if (!attached.snapshot.turn) throw new Error("expected an untruncated digest")
  return attached.snapshot.turn
}

function digestBytesOf(h: LiveTurnHub, threadId: string): number {
  const attached = h.attach(threadId)
  if (attached.kind !== "live") throw new Error(`expected a live turn, got ${attached.kind}`)
  attached.subscription.close()
  return attached.snapshot.bytes
}

describe("createLiveTurnHub — coalescing", () => {
  it("collapses consecutive chunk frames into one entry with the exact text", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    for (const t of ["Hel", "lo, ", "world"]) turn.publish(token(t))

    const digest = digestOf(h, "t1")
    expect(digest).toEqual([{ data: "Hello, world", type: "chunk" }])
  })

  it("treats a non-text frame as a barrier so later text never migrates in front of it", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    turn.publish(token("before"))
    turn.publish({ input: { path: "." }, name: "listDir", type: "tool_call" })
    turn.publish(token("after"))

    const digest = digestOf(h, "t1")
    expect(digest).toEqual([
      { data: "before", type: "chunk" },
      { input: { path: "." }, name: "listDir", type: "tool_call" },
      { data: "after", type: "chunk" },
    ])
  })

  it("coalesces subagent.message per call_id while preserving interleaving", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    turn.publish(subagentToken("call-a", "A1"))
    turn.publish(subagentToken("call-b", "B1"))
    turn.publish(subagentToken("call-a", "A2"))
    turn.publish(subagentToken("call-b", "B2"))

    const digest = digestOf(h, "t1")
    expect(digest).toHaveLength(2)
    expect(textOf(digest[0] as StreamChunk)).toBe("A1A2")
    expect(textOf(digest[1] as StreamChunk)).toBe("B1B2")
    expect((digest[0] as { data: { call_id: string } }).data.call_id).toBe("call-a")
    // The rest of the child identity survives coalescing.
    expect((digest[0] as { data: { subagent: string } }).data.subagent).toBe("researcher")
  })

  it("reopens a coalescing run after a barrier instead of reaching back past it", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    turn.publish(subagentToken("call-a", "A1"))
    turn.publish({ name: "searchCorpus", output: ["doc"], type: "tool_result" })
    turn.publish(subagentToken("call-a", "A2"))

    const digest = digestOf(h, "t1")
    expect(digest).toHaveLength(3)
    expect(textOf(digest[0] as StreamChunk)).toBe("A1")
    expect(textOf(digest[2] as StreamChunk)).toBe("A2")
  })

  it("replaces coalesced entries rather than mutating an already-copied snapshot", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    turn.publish(token("one"))
    const first = h.attach("t1")
    if (first.kind !== "live") throw new Error("expected a live turn")
    turn.publish(token("two"))
    // The snapshot taken before "two" must NOT have grown.
    expect(first.snapshot.turn).toEqual([{ data: "one", type: "chunk" }])
    first.subscription.close()
  })

  it("accounts bytes incrementally and exactly", () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    turn.publish(token("héllo"))
    turn.publish(token(' "quoted"\n'))
    turn.publish({ input: {}, name: "listDir", type: "tool_call" })
    turn.publish(subagentToken("call-a", "A1"))
    turn.publish(subagentToken("call-a", "A2"))

    const digest = digestOf(h, "t1")
    const expected = digest.reduce(
      (total, chunk) => total + new TextEncoder().encode(JSON.stringify(chunk)).length,
      0,
    )
    expect(digestBytesOf(h, "t1")).toBe(expected)
  })
})
```

Add `StreamChunk` to the test file's imports — replace the import block at the top of
`packages/cli/test/live-turn-hub.test.ts` with:

```ts
import { describe, expect, it } from "vitest"
import { createLiveTurnHub, type LiveTurnHub } from "../src/lib/dev/live-turn-hub.js"
import type { StreamChunk } from "../src/lib/runtime/stream-types.js"
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/live-turn-hub.test.ts -t "coalescing"
```

Expected: PASS if Task 2's implementation is correct. If any case fails, the failure
message names the exact property (`expected [ { data: 'Hel' }, … ] to deeply equal
[ { data: 'Hello, world' } ]` for a coalescing bug, or `expected 214 to be 217` for a
byte-accounting bug) — fix `appendToDigest` / `appendedTextBytes` in
`packages/cli/src/lib/dev/live-turn-hub.ts` until it passes. Do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/live-turn-hub.test.ts packages/cli/src/lib/dev/live-turn-hub.ts
git commit -m "test(cli): pin live-turn digest coalescing and byte accounting" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Hub — digest overflow drops the digest whole

**Files:**
- Test: `packages/cli/test/live-turn-hub.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/live-turn-hub.test.ts`:

```ts
describe("createLiveTurnHub — digest cap", () => {
  it("drops the digest whole and flags truncation once the cap is passed", () => {
    const h = hub({ digestMaxBytes: 200 })
    const turn = h.open("t1", OPEN)
    turn.publish(token("x".repeat(150)))
    const before = h.attach("t1")
    if (before.kind !== "live") throw new Error("expected a live turn")
    before.subscription.close()
    expect(before.snapshot.truncated).toBe(false)
    expect(before.snapshot.turn).not.toBeNull()

    turn.publish(token("y".repeat(150)))

    const after = h.attach("t1")
    if (after.kind !== "live") throw new Error("expected a live turn")
    after.subscription.close()
    expect(after.snapshot.truncated).toBe(true)
    expect(after.snapshot.turn).toBeNull()
    expect(after.snapshot.bytes).toBe(0)
  })

  it("stays truncated for the rest of the turn instead of refilling", () => {
    const h = hub({ digestMaxBytes: 50 })
    const turn = h.open("t1", OPEN)
    turn.publish(token("z".repeat(100)))
    turn.publish(token("small"))
    turn.publish({ input: {}, name: "listDir", type: "tool_call" })

    const after = h.attach("t1")
    if (after.kind !== "live") throw new Error("expected a live turn")
    after.subscription.close()
    expect(after.snapshot.truncated).toBe(true)
    expect(after.snapshot.turn).toBeNull()
    expect(after.snapshot.bytes).toBe(0)
  })

  it("keeps delivering the live tail to viewers after the digest is dropped", async () => {
    const h = hub({ digestMaxBytes: 50 })
    const turn = h.open("t1", OPEN)
    turn.publish(token("z".repeat(100)))

    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")
    expect(attached.snapshot.turn).toBeNull()

    turn.publish(token("tail"))
    const delivery = await attached.subscription.next()
    expect(delivery).toEqual({ frames: [{ data: "tail", type: "chunk" }], kind: "frames" })
    attached.subscription.close()
  })
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/live-turn-hub.test.ts -t "digest cap"
```

Expected: PASS. If the third case hangs instead, `fanOut` is being skipped once
`entry.truncated` is set — the truncation branch must only stop *digesting*, never
stop *delivering*.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/live-turn-hub.test.ts
git commit -m "test(cli): pin whole-digest drop on live-turn overflow" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Hub — pull delivery and the atomicity invariant

**Files:**
- Test: `packages/cli/test/live-turn-hub.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/live-turn-hub.test.ts`:

```ts
describe("createLiveTurnHub — pull delivery", () => {
  it("parks until something is published, then delivers it", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")

    let settled = false
    const pending = attached.subscription.next().then((delivery) => {
      settled = true
      return delivery
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    turn.publish(token("hi"))
    await expect(pending).resolves.toEqual({
      frames: [{ data: "hi", type: "chunk" }],
      kind: "frames",
    })
    attached.subscription.close()
  })

  it("batches everything published between two pulls", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")

    turn.publish(token("a"))
    turn.publish(token("b"))
    const delivery = await attached.subscription.next()
    expect(delivery).toEqual({
      frames: [
        { data: "a", type: "chunk" },
        { data: "b", type: "chunk" },
      ],
      kind: "frames",
    })
    attached.subscription.close()
  })

  it("delivers queued frames before reporting the end of the turn", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")

    turn.publish(token("last"))
    turn.close()

    expect(await attached.subscription.next()).toEqual({
      frames: [{ data: "last", type: "chunk" }],
      kind: "frames",
    })
    expect(await attached.subscription.next()).toEqual({ kind: "end" })
  })

  it("no frame is in both the snapshot and the queue, and their concatenation is the full turn", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const published: string[] = []
    const emit = (text: string) => {
      published.push(text)
      turn.publish(token(text))
    }

    emit("one ")
    emit("two ")
    // Attach exactly here — publishes before this land in the copy, publishes
    // after it land only in the queue.
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")
    emit("three ")
    emit("four")
    turn.close()

    const snapshotText = (attached.snapshot.turn ?? []).map(textOf).join("")
    let tailText = ""
    for (;;) {
      const delivery = await attached.subscription.next()
      if (delivery.kind !== "frames") break
      tailText += delivery.frames.map(textOf).join("")
    }

    expect(snapshotText).toBe("one two ")
    expect(tailText).toBe("three four")
    expect(snapshotText + tailText).toBe(published.join(""))
  })

  it("holds the invariant when publishes race an attacher's own await", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const published: string[] = []
    for (const text of ["a", "b", "c"]) {
      published.push(text)
      turn.publish(token(text))
    }
    // Model the anchor read: an await between deciding to attach and attaching.
    await Promise.resolve()
    published.push("d")
    turn.publish(token("d"))
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")
    published.push("e")
    turn.publish(token("e"))
    turn.close()

    const snapshotText = (attached.snapshot.turn ?? []).map(textOf).join("")
    let tailText = ""
    for (;;) {
      const delivery = await attached.subscription.next()
      if (delivery.kind !== "frames") break
      tailText += delivery.frames.map(textOf).join("")
    }
    expect(snapshotText + tailText).toBe(published.join(""))
  })

  it("wakes a parked pull when the subscription is closed", async () => {
    const h = hub()
    h.open("t1", OPEN)
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")
    const pending = attached.subscription.next()
    attached.subscription.close()
    await expect(pending).resolves.toEqual({ kind: "end" })
  })
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/live-turn-hub.test.ts -t "pull delivery"
```

Expected: PASS. A hang on the last case means `close()` is not resolving the parked
wake promise; a mismatch on the invariant cases means `attach` is mutating rather than
copying, or `appendToDigest` is mutating a digest element in place.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/live-turn-hub.test.ts
git commit -m "test(cli): pin the live-turn snapshot/tail invariant" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Hub — slow-viewer overflow and the viewer cap

**Files:**
- Test: `packages/cli/test/live-turn-hub.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/live-turn-hub.test.ts`:

```ts
describe("createLiveTurnHub — viewer bounds", () => {
  it("drops only the viewer that overflows its queue", async () => {
    const h = createLiveTurnHub({
      digestMaxBytes: 1_000_000,
      maxViewers: 16,
      queueMaxFrames: 2,
    })
    const turn = h.open("t1", OPEN)
    const slow = h.attach("t1")
    const fast = h.attach("t1")
    if (slow.kind !== "live" || fast.kind !== "live") throw new Error("expected live turns")

    turn.publish(token("a"))
    turn.publish(token("b"))
    // `fast` drains; `slow` never pulls.
    expect(await fast.subscription.next()).toEqual({
      frames: [
        { data: "a", type: "chunk" },
        { data: "b", type: "chunk" },
      ],
      kind: "frames",
    })
    turn.publish(token("c"))

    expect(await slow.subscription.next()).toEqual({ kind: "detached", reason: "overflow" })
    expect(await fast.subscription.next()).toEqual({
      frames: [{ data: "c", type: "chunk" }],
      kind: "frames",
    })
    turn.close()
    expect(await fast.subscription.next()).toEqual({ kind: "end" })
  })

  it("drops a viewer that overflows the queue byte cap", async () => {
    const h = createLiveTurnHub({
      digestMaxBytes: 1_000_000,
      maxViewers: 16,
      queueMaxBytes: 64,
    })
    const turn = h.open("t1", OPEN)
    const slow = h.attach("t1")
    if (slow.kind !== "live") throw new Error("expected a live turn")
    turn.publish(token("x".repeat(200)))
    expect(await slow.subscription.next()).toEqual({ kind: "detached", reason: "overflow" })
  })

  it("refuses an attach past the viewer cap", () => {
    const h = createLiveTurnHub({ digestMaxBytes: 1_000_000, maxViewers: 2 })
    h.open("t1", OPEN)
    expect(h.attach("t1").kind).toBe("live")
    const second = h.attach("t1")
    expect(second.kind).toBe("live")
    expect(h.peek("t1")?.atCapacity).toBe(true)
    expect(h.attach("t1")).toEqual({ kind: "capacity" })
    if (second.kind === "live") second.subscription.close()
    // Closing a viewer frees its slot.
    expect(h.peek("t1")?.atCapacity).toBe(false)
    expect(h.attach("t1").kind).toBe("live")
  })

  it("frees the slot of a viewer dropped for overflow", async () => {
    const h = createLiveTurnHub({
      digestMaxBytes: 1_000_000,
      maxViewers: 1,
      queueMaxFrames: 1,
    })
    const turn = h.open("t1", OPEN)
    const slow = h.attach("t1")
    if (slow.kind !== "live") throw new Error("expected a live turn")
    turn.publish(token("a"))
    turn.publish(token("b"))
    expect(await slow.subscription.next()).toEqual({ kind: "detached", reason: "overflow" })
    expect(h.attach("t1").kind).toBe("live")
  })
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/live-turn-hub.test.ts -t "viewer bounds"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/live-turn-hub.test.ts
git commit -m "test(cli): pin live-turn viewer queue and capacity bounds" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Hub — terminal frames, the identity guard, and leaked entries

**Files:**
- Test: `packages/cli/test/live-turn-hub.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/live-turn-hub.test.ts`:

```ts
describe("createLiveTurnHub — terminals and identity", () => {
  it("fans out a done chunk and stores it, but never digests it", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")

    turn.publish(token("hi"))
    turn.publish({ output: { ok: true }, type: "done" })

    let frames: StreamChunk[] = []
    for (;;) {
      const delivery = await attached.subscription.next()
      if (delivery.kind !== "frames") break
      frames = frames.concat(delivery.frames)
      if (frames.some((f) => f.type === "done")) break
    }
    expect(frames).toEqual([
      { data: "hi", type: "chunk" },
      { output: { ok: true }, type: "done" },
    ])

    // A later attacher sees the terminal on the snapshot, and never in turn[].
    const late = h.attach("t1")
    if (late.kind !== "live") throw new Error("expected a live turn")
    expect(late.snapshot.turn).toEqual([{ data: "hi", type: "chunk" }])
    expect(late.snapshot.terminal).toEqual({ output: { ok: true }, type: "done" })
    late.subscription.close()
    attached.subscription.close()
  })

  it("makes a replaced turn's publisher inert", () => {
    const h = hub()
    const stale = h.open("t1", OPEN)
    h.open("t1", { ...OPEN, runStartedAt: "2026-08-09T00:00:09.000Z" })
    stale.publish(token("zombie"))
    stale.close({ output: { cancelled: true }, type: "done" })

    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")
    attached.subscription.close()
    expect(attached.snapshot.turn).toEqual([])
    expect(attached.snapshot.terminal).toBeUndefined()
    // The successor is still open: the zombie's close() did not end it.
    expect(h.peek("t1")?.runStartedAt).toBe("2026-08-09T00:00:09.000Z")
  })

  it("terminates a leaked entry's viewers when a new turn opens", async () => {
    const h = hub()
    h.open("t1", OPEN)
    const orphan = h.attach("t1")
    if (orphan.kind !== "live") throw new Error("expected a live turn")

    h.open("t1", { ...OPEN, runStartedAt: "2026-08-09T00:00:09.000Z" })

    const delivery = await orphan.subscription.next()
    expect(delivery.kind).toBe("frames")
    if (delivery.kind !== "frames") throw new Error("expected frames")
    expect(delivery.frames).toEqual([
      { output: { error: "Live turn replaced by a newer run on this thread" }, type: "done" },
    ])
    expect(await orphan.subscription.next()).toEqual({ kind: "end" })
  })

  it("closes with an explicit terminal when the producer never published one", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")
    turn.close({ output: { error: "boom" }, type: "done" })

    expect(await attached.subscription.next()).toEqual({
      frames: [{ output: { error: "boom" }, type: "done" }],
      kind: "frames",
    })
    expect(await attached.subscription.next()).toEqual({ kind: "end" })
  })

  it("does not double-deliver a terminal that was already published", async () => {
    const h = hub()
    const turn = h.open("t1", OPEN)
    const attached = h.attach("t1")
    if (attached.kind !== "live") throw new Error("expected a live turn")
    turn.publish({ output: { ok: true }, type: "done" })
    turn.close({ output: { ok: true }, type: "done" })

    expect(await attached.subscription.next()).toEqual({
      frames: [{ output: { ok: true }, type: "done" }],
      kind: "frames",
    })
    expect(await attached.subscription.next()).toEqual({ kind: "end" })
  })
})
```

- [ ] **Step 2: Run the whole hub suite**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/live-turn-hub.test.ts
```

Expected: PASS — every describe block in the file.

- [ ] **Step 3: Typecheck and lint**

```bash
pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/live-turn-hub.test.ts
git commit -m "test(cli): pin live-turn terminals and the identity guard" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Handler options, hub instantiation, and one shared SSE response helper

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (imports ~1-46; constants ~170-181; `buildRouteTable` call site ~494-512; `buildRouteTable` signature/destructure ~745-796; the two `new Response(stream, …)` literals at ~1357-1364 and ~1825-1832)
- Test: `packages/cli/test/runtime-fetch-handler.test.ts` (existing header pins must stay green)

- [ ] **Step 1: Add the constants and the factory options**

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, replace:

```ts
/** How long close() waits for in-flight requests before proceeding anyway. */
const CLOSE_DRAIN_DEADLINE_MS = 30_000
const AP_SSE_HEARTBEAT_INTERVAL_MS = 15_000
const AP_SSE_HEARTBEAT = new TextEncoder().encode(": ping\n\n")
```

with:

```ts
/** How long close() waits for in-flight requests before proceeding anyway. */
const CLOSE_DRAIN_DEADLINE_MS = 30_000
const AP_SSE_HEARTBEAT_INTERVAL_MS = 15_000
const AP_SSE_HEARTBEAT = new TextEncoder().encode(": ping\n\n")
/** Serialized bytes of live-turn digest held per ACTIVE run, attached or not. */
const AP_ATTACH_DIGEST_MAX_BYTES = 2 * 1024 * 1024
/** Attach viewers allowed per thread. */
const AP_ATTACH_MAX_VIEWERS = 16
/** Frames one attach viewer may fall behind by before it is dropped. */
const AP_ATTACH_SUBSCRIBER_QUEUE_MAX_FRAMES = 1024
```

Then replace the factory's option intersection:

```ts
export async function createRuntimeFetchHandler(
  options: StartRuntimeServerOptions & {
    /** Internal/test hook: override the close() drain deadline (default 30s). */
    readonly drainDeadlineMs?: number
    /** Internal/test hook: override AP SSE heartbeat interval (default 15s). */
    readonly apSseHeartbeatIntervalMs?: number
  },
): Promise<RuntimeFetchHandler> {
```

with:

```ts
export async function createRuntimeFetchHandler(
  options: StartRuntimeServerOptions & {
    /** Internal/test hook: override the close() drain deadline (default 30s). */
    readonly drainDeadlineMs?: number
    /** Internal/test hook: override AP SSE heartbeat interval (default 15s). */
    readonly apSseHeartbeatIntervalMs?: number
    /**
     * Tuning/test hook: serialized bytes of live-turn digest kept per active
     * run before it is dropped whole (default 2 MiB). Deliberately on this
     * factory rather than `StartRuntimeServerOptions` — like `drainDeadlineMs`,
     * it is a runtime bound, not app configuration.
     */
    readonly apAttachDigestMaxBytes?: number
    /** Tuning/test hook: attach viewers allowed per thread (default 16). */
    readonly apAttachMaxViewers?: number
    /** Internal/test hook: frames one viewer may fall behind by (default 1024). */
    readonly apAttachSubscriberQueueMaxFrames?: number
  },
): Promise<RuntimeFetchHandler> {
```

- [ ] **Step 2: Thread the options into `buildRouteTable`**

Replace the `buildRouteTable({…})` call site:

```ts
  const apSseHeartbeatIntervalMs = options.apSseHeartbeatIntervalMs ?? AP_SSE_HEARTBEAT_INTERVAL_MS
  const routes = buildRouteTable({
    appRoot: options.appRoot,
    apSseHeartbeatIntervalMs,
    boot,
```

with:

```ts
  const apSseHeartbeatIntervalMs = options.apSseHeartbeatIntervalMs ?? AP_SSE_HEARTBEAT_INTERVAL_MS
  const routes = buildRouteTable({
    apAttachDigestMaxBytes: options.apAttachDigestMaxBytes ?? AP_ATTACH_DIGEST_MAX_BYTES,
    apAttachMaxViewers: options.apAttachMaxViewers ?? AP_ATTACH_MAX_VIEWERS,
    apAttachSubscriberQueueMaxFrames:
      options.apAttachSubscriberQueueMaxFrames ?? AP_ATTACH_SUBSCRIBER_QUEUE_MAX_FRAMES,
    appRoot: options.appRoot,
    apSseHeartbeatIntervalMs,
    boot,
```

- [ ] **Step 3: Accept the options in `buildRouteTable` and create the hub**

Replace:

```ts
function buildRouteTable(ctx: {
  readonly appRoot: string
  readonly apSseHeartbeatIntervalMs: number
  readonly boot: RouteBoot
```

with:

```ts
function buildRouteTable(ctx: {
  readonly apAttachDigestMaxBytes: number
  readonly apAttachMaxViewers: number
  readonly apAttachSubscriberQueueMaxFrames: number
  readonly appRoot: string
  readonly apSseHeartbeatIntervalMs: number
  readonly boot: RouteBoot
```

Replace the destructure:

```ts
  const {
    appRoot,
    apSseHeartbeatIntervalMs,
    boot,
```

with:

```ts
  const {
    apAttachDigestMaxBytes,
    apAttachMaxViewers,
    apAttachSubscriberQueueMaxFrames,
    appRoot,
    apSseHeartbeatIntervalMs,
    boot,
```

Replace the `threadRouteMap` declaration block:

```ts
  // Server-scoped map: thread_id → last routeKey used for that thread.
  // Populated by runs/stream and runs/wait; read by the resume endpoint so it
  // can re-invoke the correct route without requiring the client to repeat it.
  const threadRouteMap = new Map<string, string>()

  return [
```

with:

```ts
  // Server-scoped map: thread_id → last routeKey used for that thread.
  // Populated by runs/stream and runs/wait; read by the resume endpoint so it
  // can re-invoke the correct route without requiring the client to repeat it.
  const threadRouteMap = new Map<string, string>()

  // Server-scoped for exactly the same reason: the current turn of each
  // in-flight run, for GET /threads/:thread_id/runs/stream. Never a module
  // singleton — a second handler in the same process must not see this one's
  // turns. RunRegistry is untouched; attach never claims a run slot.
  const hub = createLiveTurnHub({
    digestMaxBytes: apAttachDigestMaxBytes,
    maxViewers: apAttachMaxViewers,
    queueMaxFrames: apAttachSubscriberQueueMaxFrames,
  })

  return [
```

- [ ] **Step 4: Add the imports**

In the import block at the top of `packages/cli/src/lib/dev/runtime-fetch-core.ts`,
replace:

```ts
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
```

with:

```ts
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"
```

replace:

```ts
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
```

with:

```ts
import type { Thread, ThreadsStore, ThreadStatus } from "@dawn-ai/sqlite-storage"
```

replace:

```ts
import { type StreamChunk, toSseEvent } from "../runtime/stream-types.js"
```

with:

```ts
import {
  type AttachStateFrame,
  type StreamChunk,
  toSseEvent,
  toSseFrame,
} from "../runtime/stream-types.js"
```

and add, in import-sorted position immediately after the `./abortable-iterable.js`
import:

```ts
import {
  createLiveTurnHub,
  type LiveTurn,
  type LiveTurnHub,
  type LiveTurnSubscription,
} from "./live-turn-hub.js"
```

- [ ] **Step 5: Introduce the one AP SSE response helper**

Append to the "Shared utilities" section of `packages/cli/src/lib/dev/runtime-fetch-core.ts`,
directly after `safeClose`:

```ts
/**
 * The ONE Agent Protocol SSE header set — POST /runs/stream, POST /resume, and
 * GET /runs/stream. `content-type` must stay exactly `text/event-stream` (no
 * charset) or `isEventStream` stops tracking the body and close() can release
 * stores mid-stream.
 */
function apSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    },
    status: 200,
  })
}
```

Then replace the return at the end of `handleApStreamRequest`:

```ts
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    },
    status: 200,
  })
}

// ---------------------------------------------------------------------------
// AP wait handler
// ---------------------------------------------------------------------------
```

with:

```ts
  return apSseResponse(stream)
}

// ---------------------------------------------------------------------------
// AP wait handler
// ---------------------------------------------------------------------------
```

and the one in `handleResumeRequest`:

```ts
    claimTransferredToStream = true
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
      status: 200,
    })
```

with:

```ts
    claimTransferredToStream = true
    return apSseResponse(stream)
```

- [ ] **Step 6: Run the header pins and typecheck**

```bash
pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/runtime-fetch-handler.test.ts test/run-cancellation.test.ts
```

Expected: typecheck exits 0 (`hub` is declared but unused until Task 9 — it is
referenced by the route added there, so if typecheck reports `'hub' is declared but
its value is never read`, proceed to Task 9 and re-run; do not delete it). Both suites
PASS, including the `cache-control: no-cache, no-transform` / `connection: keep-alive`
assertions, proving the refactor changed no bytes on the wire.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts
git commit -m "refactor(cli): share the Agent Protocol SSE response shape" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: `GET /threads/:thread_id/runs/stream` — refusals and the durable path

Covers spec test-strategy scenario 3 (attach after done, on an empty thread, on an
unknown thread, on an unresolvable route) and the durable half of scenario 2.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (route table ~929-954; new handler after `handleApStreamRequest`; shared utilities)
- Create: `packages/cli/test/helpers/ap-attach-fixture.ts`
- Create: `packages/cli/test/ap-attach.test.ts`

- [ ] **Step 1: Write the shared integration fixture helper**

Create `packages/cli/test/helpers/ap-attach-fixture.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createAimock, script } from "../../../testing/dist/index.js"
import { createRuntimeFetchHandler } from "../../src/lib/dev/runtime-fetch-handler.js"
import type { RuntimeFetchHandler } from "../../src/lib/dev/runtime-fetch-core.js"

/** Cleanups the owning test file drains in its own afterEach. */
export const cleanup: Array<() => Promise<void> | void> = []

export async function runCleanups(): Promise<void> {
  for (const fn of cleanup.splice(0).reverse()) await fn()
}

/** A route that blocks until its release file appears, then returns. */
const BLOCKING_ROUTE = [
  'import { readFile, writeFile } from "node:fs/promises"',
  "export const graph = async (",
  "  input: { startedFile?: string; releaseFile?: string } | undefined,",
  "  _ctx: { signal: AbortSignal },",
  ") => {",
  "  if (input?.startedFile) await writeFile(input.startedFile, 'started')",
  "  const deadline = Date.now() + 15000",
  "  while (Date.now() < deadline) {",
  "    if (!input?.releaseFile) break",
  "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
  "    await new Promise((r) => setTimeout(r, 25))",
  "  }",
  "  return { ok: true }",
  "}",
  "",
].join("\n")

const QUICK_ROUTE = ["export const graph = async () => ({ ok: true })", ""].join("\n")

/** An agent route whose tool blocks, so a turn can be attached to mid-stream. */
const AGENT_ROUTE = [
  'import { agent } from "@dawn-ai/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are helpful.",',
  "})",
  "",
].join("\n")

function blockingTool(startedFile: string, releaseFile: string): string {
  return [
    'import { readFile, writeFile } from "node:fs/promises"',
    `const STARTED_FILE = ${JSON.stringify(startedFile)}`,
    `const RELEASE_FILE = ${JSON.stringify(releaseFile)}`,
    "export default {",
    '  name: "waitForRelease",',
    '  description: "Block until the release file appears",',
    "  run: async () => {",
    "    await writeFile(STARTED_FILE, 'started')",
    "    const deadline = Date.now() + 15000",
    "    while (Date.now() < deadline) {",
    "      try { await readFile(RELEASE_FILE, 'utf8'); break } catch {}",
    "      await new Promise((r) => setTimeout(r, 25))",
    "    }",
    "    return { released: true }",
    "  },",
    "}",
    "",
  ].join("\n")
}

export interface AttachFixture {
  readonly appRoot: string
  readonly handler: RuntimeFetchHandler
  readonly releaseFile: string
  readonly releaseRoute: () => Promise<void>
  readonly startedFile: string
}

export interface AttachFixtureOptions {
  readonly apAttachDigestMaxBytes?: number
  readonly apAttachMaxViewers?: number
  readonly apAttachSubscriberQueueMaxFrames?: number
  readonly apSseHeartbeatIntervalMs?: number
  /** Extra files merged into the fixture app. */
  readonly files?: Record<string, string>
  /** Assistant text the aimock model replies with after the blocking tool. */
  readonly reply?: string
  /** Assistant text the aimock model streams BEFORE calling the blocking tool. */
  readonly prelude?: string
}

/**
 * A fixture app with:
 *  - `/blocking#graph`  — a non-agent route that blocks on the release file
 *  - `/quick#graph`     — a non-agent route that returns immediately
 *  - `/chat` (agent)    — an agent route whose `waitForRelease` tool blocks
 *
 * A short `drainDeadlineMs` is mandatory: these fixtures deliberately leave a
 * route running, and close() waits for in-flight runs.
 */
export async function createAttachFixture(
  options: AttachFixtureOptions = {},
): Promise<AttachFixture> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-ap-attach-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))

  const startedFile = join(appRoot, "started.json")
  const releaseFile = join(appRoot, "release.json")

  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "ap-attach-fixture", "type": "module" }\n',
    "src/app/blocking/index.ts": BLOCKING_ROUTE,
    "src/app/chat/index.ts": AGENT_ROUTE,
    "src/app/chat/tools/waitForRelease.ts": blockingTool(startedFile, releaseFile),
    "src/app/quick/index.ts": QUICK_ROUTE,
    ...options.files,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }

  await withAimock(
    script()
      .user("hello")
      .callsTool("waitForRelease", {})
      .replies(options.reply ?? "All done, friend.")
      .build(),
  )

  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    ...(options.apAttachDigestMaxBytes !== undefined
      ? { apAttachDigestMaxBytes: options.apAttachDigestMaxBytes }
      : {}),
    ...(options.apAttachMaxViewers !== undefined
      ? { apAttachMaxViewers: options.apAttachMaxViewers }
      : {}),
    ...(options.apAttachSubscriberQueueMaxFrames !== undefined
      ? { apAttachSubscriberQueueMaxFrames: options.apAttachSubscriberQueueMaxFrames }
      : {}),
    ...(options.apSseHeartbeatIntervalMs !== undefined
      ? { apSseHeartbeatIntervalMs: options.apSseHeartbeatIntervalMs }
      : {}),
  })
  cleanup.push(() => handler.close())

  return {
    appRoot,
    handler,
    releaseFile,
    releaseRoute: async () => {
      await writeFile(releaseFile, "release")
    },
    startedFile,
  }
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for this test. */
export async function withAimock(fixtures: unknown): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures as never)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function postRunRequest(
  threadId: string,
  route: string,
  input: Record<string, unknown> = {},
): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({ input, route }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

export function attachRequest(threadId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, { headers, method: "GET" })
}

export function cancelRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/cancel`, { method: "POST" })
}

export function threadRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}`)
}

// ---------------------------------------------------------------------------
// SSE reading
// ---------------------------------------------------------------------------

export interface SseFrame {
  readonly data: unknown
  readonly event: string
  readonly retry?: number
}

/** Parses SSE text, KEEPING the event name (unlike the older test parsers). */
export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of text.split("\n\n")) {
    let event: string | undefined
    let data: string | undefined
    let retry: number | undefined
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length)
      else if (line.startsWith("data: ")) data = line.slice("data: ".length)
      else if (line.startsWith("retry: ")) retry = Number(line.slice("retry: ".length))
    }
    if (data === undefined) {
      if (retry !== undefined) frames.push({ data: null, event: "retry", retry })
      continue
    }
    frames.push({ data: JSON.parse(data) as unknown, event: event ?? "message" })
  }
  return frames
}

/** Reads an SSE response to completion and returns its parsed frames. */
export async function readFrames(response: Response): Promise<SseFrame[]> {
  return parseSseFrames(await readSseText(response))
}

export async function readSseText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
}

/** Reads the body to completion and discards it, so close() can drain. */
export async function drain(response: Response): Promise<void> {
  await readSseText(response)
}

export async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(path, "utf8")
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`probe file never appeared: ${path}`)
}

/** The `state` frame of an attach stream, typed for assertions. */
export interface StateFrameData {
  readonly anchor: string | null
  readonly input: unknown
  readonly interrupts: ReadonlyArray<{
    readonly interruptId: string
    readonly resumeKey: string | null
    readonly value: unknown
  }>
  readonly live: boolean
  readonly resume: boolean
  readonly run_started_at: string | null
  readonly status: string
  readonly turn: ReadonlyArray<Record<string, unknown>> | null
  readonly turn_truncated?: true
  readonly values: Record<string, unknown> | null
}

export function stateFrameOf(frames: readonly SseFrame[]): StateFrameData {
  const frame = frames.find((f) => f.event === "state")
  if (!frame) throw new Error(`no state frame in: ${JSON.stringify(frames)}`)
  return frame.data as StateFrameData
}

/** Concatenated text of every `chunk` frame in a list of SSE frames. */
export function textOfFrames(frames: readonly SseFrame[]): string {
  return frames
    .filter((f) => f.event === "chunk")
    .map((f) => (typeof f.data === "string" ? f.data : ""))
    .join("")
}

/** Concatenated text of every `chunk` entry in a state frame's turn. */
export function textOfTurn(turn: ReadonlyArray<Record<string, unknown>> | null): string {
  if (!turn) return ""
  return turn
    .filter((entry) => entry.type === "chunk")
    .map((entry) => (typeof entry.data === "string" ? entry.data : ""))
    .join("")
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/cli/test/ap-attach.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"

import {
  attachRequest,
  createAttachFixture,
  drain,
  postRunRequest,
  readFrames,
  runCleanups,
  stateFrameOf,
} from "./helpers/ap-attach-fixture.js"

afterEach(runCleanups)

describe("GET /threads/:thread_id/runs/stream — refusals", () => {
  it("404s an unknown thread with a coded body", async () => {
    const { handler } = await createAttachFixture()
    const response = await handler.fetch(attachRequest("t-nope"))
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe("thread_not_found")
  })

  it("409s a thread that has never run, with thread_route_unknown", async () => {
    const { handler } = await createAttachFixture()
    const created = await handler.fetch(
      new Request("http://localhost/threads", {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    const thread = (await created.json()) as { thread_id: string }

    const response = await handler.fetch(attachRequest(thread.thread_id))
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe("thread_route_unknown")
  })
})

describe("GET /threads/:thread_id/runs/stream — durable path", () => {
  it("serves a snapshot and closes after the run finished", async () => {
    const { handler } = await createAttachFixture()
    const threadId = "t-durable-after-done"
    await drain(await handler.fetch(postRunRequest(threadId, "/quick#graph")))

    const response = await handler.fetch(attachRequest(threadId))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("connection")).toBe("keep-alive")

    const frames = await readFrames(response)
    const state = stateFrameOf(frames)
    expect(state.live).toBe(false)
    expect(state.status).toBe("idle")
    expect(state.anchor).toBeNull()
    expect(state.run_started_at).toBeNull()
    expect(state.resume).toBe(false)
    expect(state.input).toBeNull()
    expect(state.turn).toBeNull()
    expect(state).not.toHaveProperty("turn_truncated")
    expect(state.interrupts).toEqual([])

    const done = frames.find((f) => f.event === "done")
    expect(done?.data).toEqual({ output: null })

    const retry = frames.find((f) => f.event === "retry")
    expect(retry?.retry).toBeGreaterThanOrEqual(1500)
    expect(retry?.retry).toBeLessThanOrEqual(2500)

    // `done` is the app-level terminator and the stream really closed.
    expect(frames.at(-1)?.event === "done" || frames.at(-1)?.event === "retry").toBe(true)
  }, 30_000)

  it("serves the durable path with null values for a route that never checkpointed", async () => {
    const { handler } = await createAttachFixture()
    const threadId = "t-durable-no-checkpoint"
    await drain(await handler.fetch(postRunRequest(threadId, "/quick#graph")))

    const state = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    expect(state.live).toBe(false)
    expect(state.values).toBeNull()
  }, 30_000)
})
```

- [ ] **Step 3: Run the test and see it fail**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts
```

Expected: FAIL — every case reports `expected 404 to be 200` / `expected undefined to be
'thread_not_found'`, because `GET /threads/:id/runs/stream` is not registered and
`dispatch` falls through to its generic `Response.json(createRequestErrorBody("Not found"), { status: 404 })`.

- [ ] **Step 4: Add the tuple accessors**

Append to the "Shared utilities" section of `packages/cli/src/lib/dev/runtime-fetch-core.ts`,
directly after `apSseResponse`. Both go in now even though only `channelValuesOf` is
used in this task — `checkpointIdOf` is used by Task 10's producer hook, and splitting
them across two commits would leave the file with a mismatched pair. If biome flags
`checkpointIdOf` as unused before Task 10 lands, finish Task 10 rather than deleting it:

```ts
/**
 * The checkpoint id a tuple is addressed by, or null.
 *
 * Defensive about shape on purpose: test fixtures inject hand-rolled
 * checkpointers whose tuples carry only `pendingWrites`, and an anchor read
 * must degrade rather than throw.
 */
function checkpointIdOf(tuple: CheckpointTuple | undefined): string | null {
  const configurable = (
    tuple as { readonly config?: { readonly configurable?: Record<string, unknown> } } | undefined
  )?.config?.configurable
  const checkpointId = configurable?.checkpoint_id
  return typeof checkpointId === "string" ? checkpointId : null
}

/**
 * A tuple's channel values: `null` when there is no checkpoint at all, `{}`
 * when there is one but it carries no values. The distinction is what the
 * attach state frame's `values: null` means — "this thread has no state yet".
 */
function channelValuesOf(tuple: CheckpointTuple | undefined): Record<string, unknown> | null {
  if (!tuple) return null
  const values = (tuple as { readonly checkpoint?: { readonly channel_values?: unknown } })
    .checkpoint?.channel_values
  return isRecord(values) ? (values as Record<string, unknown>) : {}
}
```

- [ ] **Step 5: Add the durable-path writer and the attach handler**

Insert this block into `packages/cli/src/lib/dev/runtime-fetch-core.ts` immediately
after `handleApStreamRequest` ends (that is, after its closing `}` and before the
`// AP wait handler` banner):

```ts
// ---------------------------------------------------------------------------
// AP attach handler — GET /threads/:thread_id/runs/stream
// ---------------------------------------------------------------------------

/**
 * The durable path: one latest-tuple read serves BOTH `values` and the
 * pending-interrupt parse, then `state{live:false}` + `done{output:null}` +
 * a jittered retry hint. No heartbeat, no subscriber machinery.
 *
 * Deliberately not an HTTP error even when the thread reads "busy": an error
 * status breaks EventSource's reconnect loop, and this case legitimately covers
 * a crashed process's stale status, a wrong-replica attach, and an in-process
 * `/runs/wait` run (wait runs hold the run slot but open no live turn).
 */
async function writeDurableAttachFrames(options: {
  readonly checkpointer: BaseCheckpointSaver
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly encoder: TextEncoder
  readonly status: ThreadStatus
  readonly threadId: string
}): Promise<void> {
  const { checkpointer, controller, encoder, status, threadId } = options
  const tuple = await checkpointer.getTuple({
    configurable: { checkpoint_ns: "", thread_id: threadId },
  })
  const pending = parsePendingInterrupts(tuple)
  const frame: AttachStateFrame = {
    anchor: null,
    input: null,
    interrupts: (pending?.interrupts ?? []).map((interrupt) => ({
      interruptId: interrupt.interruptId,
      resumeKey: interrupt.resumeKey,
      value: interrupt.value,
    })),
    live: false,
    resume: false,
    run_started_at: null,
    status,
    turn: null,
    values: channelValuesOf(tuple),
  }
  safeEnqueue(controller, encoder.encode(toSseFrame("state", frame)))
  safeEnqueue(controller, encoder.encode(toSseEvent({ output: null, type: "done" })))
  // 2000 ms ± 500, jittered so multi-tab EventSource clients do not resync in
  // lockstep.
  const retryMs = 1500 + Math.floor(Math.random() * 1001)
  safeEnqueue(controller, encoder.encode(`retry: ${retryMs}\n\n`))
}

async function handleApAttachRequest(options: {
  readonly apSseHeartbeatIntervalMs: number
  readonly checkpointer: BaseCheckpointSaver
  readonly hub: LiveTurnHub
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    apSseHeartbeatIntervalMs,
    checkpointer,
    hub,
    middleware,
    registry,
    request,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  // Thread first: an unknown thread is a 404 with the same code POST /cancel
  // and POST /resume use.
  const thread = await threadsStore.getThread(threadId)
  if (!thread) {
    return Response.json(
      createRequestErrorBody("Thread not found", { code: "thread_not_found" }),
      { status: 404 },
    )
  }

  // Route identity, in the same priority order the resume endpoint uses:
  // in-memory map (this server session) then durable thread metadata. There is
  // no client-supplied override — a GET has no body.
  const persistedRoute = thread.metadata.route
  const routeKey =
    threadRouteMap.get(threadId) ??
    (typeof persistedRoute === "string" ? persistedRoute : undefined)
  const route = routeKey ? registry.lookup(routeKey) : undefined
  if (!route) {
    // Fail closed. Attach exposes everything the POST stream exposes — channel
    // values, run input, live tokens, interrupt payloads — so it must be gated
    // identically, and route-gating middleware cannot gate what has no route.
    return Response.json(
      createRequestErrorBody(
        `Cannot attach: no resolvable route recorded for thread "${threadId}"`,
        { code: "thread_route_unknown" },
      ),
      { status: 409 },
    )
  }

  const requestUrl = new URL(request.url)
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: headersToRecord(request.headers),
    method: "GET",
    params: {},
    routeId: route.routeId,
    url: `${requestUrl.pathname}${requestUrl.search}`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    return statusResponse(mwResult.status, mwResult.body)
  }

  const encoder = new TextEncoder()
  const identity = hub.peek(threadId)

  if (identity?.atCapacity) {
    return apSseResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          safeEnqueue(controller, encoder.encode(toSseFrame("detached", { reason: "capacity" })))
          safeClose(controller)
        },
      }),
    )
  }

  if (!identity) {
    return apSseResponse(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            await writeDurableAttachFrames({
              checkpointer,
              controller,
              encoder,
              status: thread.status,
              threadId,
            })
          } finally {
            safeClose(controller)
          }
        },
      }),
    )
  }

  const anchorCheckpointId = identity.anchorCheckpointId
  // Declared out here so `cancel()` can free the viewer slot the moment the
  // client disconnects, instead of waiting for the turn to end.
  let subscription: LiveTurnSubscription | undefined
  return apSseResponse(
    new ReadableStream<Uint8Array>({
      cancel() {
        // A viewer disconnect must never touch the run: attach holds no run
        // slot. This only frees the viewer's own slot and unparks its drain.
        subscription?.close()
      },
      async start(controller) {
        const stopHeartbeat = startSseHeartbeat(controller, apSseHeartbeatIntervalMs)
        try {
          // Old checkpoints are immutable, so this id-addressed read races
          // nothing the run is doing.
          const anchorTuple = anchorCheckpointId
            ? await checkpointer.getTuple({
                configurable: {
                  checkpoint_id: anchorCheckpointId,
                  checkpoint_ns: "",
                  thread_id: threadId,
                },
              })
            : undefined

          // ── ONE synchronous section from here to the state-frame enqueue ──
          const attached = hub.attach(threadId)
          if (attached.kind === "capacity") {
            safeEnqueue(
              controller,
              encoder.encode(toSseFrame("detached", { reason: "capacity" })),
            )
            return
          }
          if (attached.kind === "absent") {
            // The turn ended while its anchor was read. Serve the durable
            // snapshot rather than a stale live one; the client reconnects.
            await writeDurableAttachFrames({
              checkpointer,
              controller,
              encoder,
              status: thread.status,
              threadId,
            })
            return
          }
          subscription = attached.subscription
          const frame: AttachStateFrame = {
            anchor: attached.identity.anchorCheckpointId,
            input: attached.identity.input,
            // Always empty on a live turn: during a resume run the latest tuple
            // still holds the ALREADY-ANSWERED interrupt, and echoing it would
            // make clients re-render a resolved prompt.
            interrupts: [],
            live: true,
            resume: attached.identity.resume,
            run_started_at: attached.identity.runStartedAt,
            status: thread.status,
            turn: attached.snapshot.turn,
            ...(attached.snapshot.truncated ? { turn_truncated: true } : {}),
            values: channelValuesOf(anchorTuple),
          }
          safeEnqueue(controller, encoder.encode(toSseFrame("state", frame)))
          // ── end of the synchronous section ──

          // An attach that landed between the terminal publish and close
          // re-emits the stored terminal here, so turn[] never carries it.
          if (attached.snapshot.terminal) {
            safeEnqueue(controller, encoder.encode(toSseEvent(attached.snapshot.terminal)))
          }

          for (;;) {
            const delivery = await attached.subscription.next()
            if (delivery.kind === "frames") {
              for (const chunk of delivery.frames) {
                safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
              }
              continue
            }
            if (delivery.kind === "detached") {
              safeEnqueue(
                controller,
                encoder.encode(toSseFrame("detached", { reason: delivery.reason })),
              )
            }
            break
          }
        } finally {
          stopHeartbeat()
          subscription?.close()
          safeClose(controller)
        }
      },
    }),
  )
}
```

Add `parsePendingInterrupts` to the existing `./pending-interrupts.js` import — replace:

```ts
import {
  createPendingResumeClaims,
  type DawnResumeEntry,
  type PendingResumeClaims,
  readPendingInterrupts,
  resolvePendingResume,
} from "./pending-interrupts.js"
```

with:

```ts
import {
  createPendingResumeClaims,
  type DawnResumeEntry,
  parsePendingInterrupts,
  type PendingResumeClaims,
  readPendingInterrupts,
  resolvePendingResume,
} from "./pending-interrupts.js"
```

- [ ] **Step 6: Register the route**

In `buildRouteTable`, immediately after the `POST /threads/:thread_id/runs/stream`
entry (the one ending `pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,`
with `method: "POST"`), insert:

```ts
    // ------------------------------------------------------------------
    // GET /threads/:thread_id/runs/stream — attach to the thread's live turn
    // ------------------------------------------------------------------
    // Same pattern as the POST above; `dispatch` filters on method first, so
    // the pair coexists. Thread-scoped, not run-scoped: with one run per
    // thread enforced, the thread IS the run identity — and a thread-scoped
    // attach survives HITL park/resume boundaries where a run id would go
    // stale.
    {
      handle: async (request, params) =>
        handleApAttachRequest({
          apSseHeartbeatIntervalMs,
          checkpointer: getCheckpointer(request),
          hub,
          middleware,
          registry,
          request,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
        }),
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,
    },
```

- [ ] **Step 7: Run the test and see it pass**

```bash
pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts
```

Expected: typecheck exits 0; all four cases PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/ap-attach.test.ts \
  packages/cli/test/helpers/ap-attach-fixture.ts
git commit -m "feat(cli): add the Agent Protocol attach endpoint" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: Producer hooks in the stream handler + the live attach path

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (`handleApStreamRequest`, ~1141-1365)
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
import {
  cancelRequest,
  textOfFrames,
  textOfTurn,
  waitForFile,
} from "./helpers/ap-attach-fixture.js"

describe("GET /threads/:thread_id/runs/stream — live path", () => {
  it("attaches mid-run, snapshots the turn so far, and tails to the run's own done", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      reply: "All done, friend.",
    })
    const threadId = "t-live-attach"

    const primary = handler.fetch(
      postRunRequest(threadId, "/chat#agent", {
        messages: [{ content: "hello", role: "user" }],
      }),
    )
    await waitForFile(startedFile)

    const attachResponse = await handler.fetch(attachRequest(threadId))
    expect(attachResponse.status).toBe(200)
    expect(attachResponse.headers.get("content-type")).toBe("text/event-stream")

    await releaseRoute()
    const attachFrames = await readFrames(attachResponse)
    const primaryFrames = await readFrames(await primary)

    const state = attachFrames[0]
    expect(state?.event).toBe("state")
    const stateData = stateFrameOf(attachFrames)
    expect(stateData.live).toBe(true)
    expect(stateData.status).toBe("busy")
    expect(stateData.resume).toBe(false)
    expect(stateData.interrupts).toEqual([])
    expect(stateData.run_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(stateData.input).toEqual({ messages: [{ content: "hello", role: "user" }] })
    expect(stateData).not.toHaveProperty("turn_truncated")

    // The attacher ends on the run's own terminal, not on an EOF.
    const attachDone = attachFrames.at(-1)
    expect(attachDone?.event).toBe("done")

    // Snapshot + tail reconstruct the primary's text exactly.
    expect(textOfTurn(stateData.turn) + textOfFrames(attachFrames)).toBe(
      textOfFrames(primaryFrames),
    )
  }, 30_000)

  it("keeps producing for an attacher after the primary client disconnects", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const threadId = "t-live-primary-disconnects"

    const primary = await handler.fetch(
      postRunRequest(threadId, "/chat#agent", {
        messages: [{ content: "hello", role: "user" }],
      }),
    )
    await waitForFile(startedFile)
    const attachResponse = await handler.fetch(attachRequest(threadId))

    // The documented durable-surface behavior: a disconnect is a lost viewer,
    // not a lost intent.
    await primary.body?.cancel()

    await releaseRoute()
    const frames = await readFrames(attachResponse)
    expect(stateFrameOf(frames).live).toBe(true)
    expect(frames.at(-1)?.event).toBe("done")
  }, 30_000)

  it("reports the durable path once the run has finished", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const threadId = "t-live-then-durable"

    const primary = handler.fetch(
      postRunRequest(threadId, "/chat#agent", {
        messages: [{ content: "hello", role: "user" }],
      }),
    )
    await waitForFile(startedFile)
    await releaseRoute()
    await drain(await primary)

    const state = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    expect(state.live).toBe(false)
    expect(state.status).toBe("idle")
    expect(state.turn).toBeNull()
  }, 30_000)
})
```

- [ ] **Step 2: Run the test and see it fail**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "live path"
```

Expected: FAIL — the first two cases report `expected false to be true` on
`stateData.live`, because nothing ever calls `hub.open`, so `hub.peek` returns
undefined and the endpoint serves the durable path.

- [ ] **Step 3: Accept the hub in the stream handler and take the anchor**

In `handleApStreamRequest`, replace the option-bag line:

```ts
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly middleware: DawnMiddleware | undefined
```

with:

```ts
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly hub: LiveTurnHub
  readonly middleware: DawnMiddleware | undefined
```

and the destructure line:

```ts
    getMemoryStore,
    middleware,
    permissionsStore,
```

with:

```ts
    getMemoryStore,
    hub,
    middleware,
    permissionsStore,
```

Then, immediately after the run-slot claim block (the one ending with the
`{ status: 409 }` return for `run_in_flight`) and BEFORE the
`// Record which route last ran on this thread` comment, insert:

```ts
  // Anchor the live turn to the checkpoint that exists BEFORE the route runs.
  // The run's own puts cannot race a read that completes before it starts, so
  // an attacher's `values` never double-counts messages its `turn[]` also
  // carries. A failed read is logged and the run proceeds WITHOUT a live turn —
  // attach degrades to the durable path; it never fails the run and never
  // leaks the run slot.
  let liveTurn: LiveTurn | undefined
  try {
    const anchorTuple = await checkpointer.getTuple({
      configurable: { checkpoint_ns: "", thread_id: threadId },
    })
    liveTurn = hub.open(threadId, {
      anchorCheckpointId: checkpointIdOf(anchorTuple),
      input,
      resume: false,
      runStartedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error(
      `Dawn runtime: live-turn anchor read failed for thread "${threadId}" — attach will serve the durable path.`,
      error,
    )
  }
```

- [ ] **Step 4: Extend the pre-stream failure window**

Replace, in `handleApStreamRequest`:

```ts
  } catch (error) {
    // The stream's finally has not been armed yet, so nothing else would ever
    // free this slot — without an explicit release the thread would 409 for the
    // remaining life of the process.
    run.release()
    throw error
  }
```

with:

```ts
  } catch (error) {
    // The stream's finally has not been armed yet, so nothing else would ever
    // free this slot — without an explicit release the thread would 409 for the
    // remaining life of the process. The live turn is closed for exactly the
    // same reason: an entry opened above would otherwise leak with no producer
    // and no way to end its viewers.
    liveTurn?.close()
    run.release()
    throw error
  }
```

- [ ] **Step 5: Publish beside the existing enqueues and close in the finally**

Replace, in `handleApStreamRequest` (note the 10-space indentation of `for await` —
the resume handler's twin is indented 12 and must not be touched here):

```ts
          for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
            sourceCleanup = p
          })) {
            if (chunk.type === "interrupt") sawInterrupt = true
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
```

with:

```ts
          for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
            sourceCleanup = p
          })) {
            if (chunk.type === "interrupt") sawInterrupt = true
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
            // The primary client is served first and is never blocked by
            // viewers. The adapter's silent streamEvents retry is safe here:
            // its `hasYielded` guard means a retry can only happen when nothing
            // was published.
            liveTurn?.publish(chunk)
          }
```

Replace (again, the 10-space-indented copy in `handleApStreamRequest`):

```ts
          safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
          await threadsStore
```

with:

```ts
          safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
          liveTurn?.publish(terminalChunk)
          await threadsStore
```

Replace:

```ts
      } finally {
        stopHeartbeat()
        // The client's stream ends here regardless — safeClose below fires on
        // this same tick either way, so cancellation still looks instant to
        // the caller. What differs is when the run SLOT frees.
```

with:

```ts
      } finally {
        stopHeartbeat()
        // UNCONDITIONAL, and deliberately NOT deferred behind sourceCleanup the
        // way run.release() is below for a cancelled run: viewers share the
        // client-visible RESPONSE lifetime, not the run-slot lifetime, so they
        // must see the terminal frame at the instant the primary client does.
        // A park closes the live turn too — a reload-while-parked attach is
        // always the durable path.
        liveTurn?.close()
        // The client's stream ends here regardless — safeClose below fires on
        // this same tick either way, so cancellation still looks instant to
        // the caller. What differs is when the run SLOT frees.
```

- [ ] **Step 6: Pass the hub from the route table**

In `buildRouteTable`, in the `POST /threads/:thread_id/runs/stream` entry, replace:

```ts
          getMemoryStore: () => getMemoryStoreFor(request),
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          request,
          ...(sandboxManager ? { sandboxManager } : {}),
          runRegistry: getRunRegistry(request),
          signal: getShutdownSignal(request),
          ...(staticModules ? { staticModules } : {}),
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
        }),
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,
```

with:

```ts
          getMemoryStore: () => getMemoryStoreFor(request),
          hub,
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          request,
          ...(sandboxManager ? { sandboxManager } : {}),
          runRegistry: getRunRegistry(request),
          signal: getShutdownSignal(request),
          ...(staticModules ? { staticModules } : {}),
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
        }),
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,
```

- [ ] **Step 7: Run the test and see it pass**

```bash
pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts
```

Expected: typecheck exits 0; every case in the file PASSES.

- [ ] **Step 8: Re-run the pins the producer hooks could break**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/run-cancellation.test.ts test/runtime-fetch-parity.test.ts \
  test/runtime-fetch-handler.test.ts
```

Expected: PASS. In particular `AP stream: client disconnect does not abort the run
(deliberate)` and `keeps the heartbeat until a disconnected /runs/stream route ends`
(which asserts `clearInterval` was called exactly once) must both stay green — the
attach stream starts its own heartbeat, but no test in these files attaches.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/ap-attach.test.ts
git commit -m "feat(cli): publish the Agent Protocol stream turn to attachers" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: Producer hooks in the resume handler

Covers spec test-strategy scenario 5 (attach during a resume run).

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (`handleResumeRequest`, ~1600-1836)
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
/**
 * A fixture whose checkpointer reports one pending interrupt on every read, so
 * `/resume` runs without needing a live agent to park first. Plain JS only:
 * `dawn.config.ts` is transpiled by tsx from a scratch dir with no node_modules.
 */
const RESUME_INTERRUPT_ID = "perm-1"
const RESUME_CHECKPOINTER_CONFIG = [
  "export default {",
  "  checkpointer: {",
  "    getTuple: async () => ({",
  '      config: { configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "ckpt-parked" } },',
  "      checkpoint: { channel_values: { messages: [] } },",
  "      pendingWrites: [[",
  '        "33a12321-3ec2-56a7-b4d7-0337886c4386",',
  '        "__interrupt__",',
  "        {",
  '          id: "3336d0e0a2d4f198ef9aecd09cd7ac27",',
  `          value: { interruptId: ${JSON.stringify(RESUME_INTERRUPT_ID)}, kind: "command" },`,
  "        },",
  "      ]],",
  "    }),",
  "  },",
  "};",
  "",
].join("\n")

function resumeRequest(threadId: string, route: string): Request {
  return new Request(`http://localhost/threads/${threadId}/resume`, {
    body: JSON.stringify({
      resume: [{ interruptId: RESUME_INTERRUPT_ID, payload: "once", status: "resolved" }],
      route,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

describe("GET /threads/:thread_id/runs/stream — resume runs", () => {
  it("marks a resume turn with resume:true, the parked anchor, and no interrupts", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "dawn.config.ts": RESUME_CHECKPOINTER_CONFIG },
    })
    const threadId = "t-resume-attach"
    // Record the route on the thread so attach can resolve it.
    await drain(await handler.fetch(postRunRequest(threadId, "/blocking#graph", {})))

    const resumed = handler.fetch(resumeRequest(threadId, "/blocking#graph"))
    // The resumed route is invoked with `input: {}`, so it does not block —
    // attach immediately and accept either the live or the durable path for
    // liveness, but pin the resume-specific fields when it IS live.
    const attachResponse = await handler.fetch(attachRequest(threadId))
    await releaseRoute()
    const frames = await readFrames(attachResponse)
    await drain(await resumed)

    const state = stateFrameOf(frames)
    if (state.live) {
      expect(state.resume).toBe(true)
      expect(state.anchor).toBe("ckpt-parked")
      // The latest tuple still reports the ALREADY-ANSWERED interrupt; a live
      // turn must never echo it.
      expect(state.interrupts).toEqual([])
      expect(state.input).toEqual([
        { interruptId: RESUME_INTERRUPT_ID, payload: "once", status: "resolved" },
      ])
    } else {
      // Durable fallback still reports the parked interrupt with its payload.
      expect(state.interrupts.map((i) => i.interruptId)).toEqual([RESUME_INTERRUPT_ID])
    }
  }, 30_000)

  it("gives a resume turn a fresh run_started_at", async () => {
    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "dawn.config.ts": RESUME_CHECKPOINTER_CONFIG },
    })
    const threadId = "t-resume-fresh-start"
    await drain(await handler.fetch(postRunRequest(threadId, "/blocking#graph", {})))

    const first = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    await drain(await handler.fetch(resumeRequest(threadId, "/blocking#graph")))
    const second = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))

    // Both are post-run durable snapshots here; what must hold is that the
    // durable path never claims a live turn or a run start.
    expect(first.live).toBe(false)
    expect(second.live).toBe(false)
    expect(first.run_started_at).toBeNull()
    expect(second.run_started_at).toBeNull()
  }, 30_000)
})
```

- [ ] **Step 2: Run the test and see it fail**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "resume runs"
```

Expected: FAIL — the first case reports `expected undefined to deeply equal [ … ]` or
`expected false to be true` depending on timing, because `handleResumeRequest` never
opens a live turn. (The second case may already pass; the first is the gate.)

- [ ] **Step 3: Collapse the resume handler to one tuple read and take the anchor from it**

In `handleResumeRequest`, replace:

```ts
  let claimTransferredToStream = false
  try {
    const pendingInterrupts = await readPendingInterrupts(checkpointer, threadId)
    if (!pendingInterrupts) {
```

with:

```ts
  let claimTransferredToStream = false
  try {
    // ONE read serves the interrupt parse AND the live-turn anchor. Splitting
    // it would double this endpoint's checkpoint reads — `resume-endpoint.test.ts`
    // pins that it reads exactly once.
    const anchorTuple = await checkpointer.getTuple({
      configurable: { checkpoint_ns: "", thread_id: threadId },
    })
    const pendingInterrupts = parsePendingInterrupts(anchorTuple)
    if (!pendingInterrupts) {
```

- [ ] **Step 4: Accept the hub, open the turn, and hook the stream**

Replace the resume handler's option-bag line:

```ts
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly middleware: DawnMiddleware | undefined
  readonly permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly resumeClaims: PendingResumeClaims
```

with:

```ts
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly hub: LiveTurnHub
  readonly middleware: DawnMiddleware | undefined
  readonly permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly resumeClaims: PendingResumeClaims
```

and its destructure:

```ts
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    resumeClaims,
```

with:

```ts
    getMemoryStore,
    hub,
    middleware,
    permissionsStore,
    registry,
    resumeClaims,
```

Replace the resume handler's status-write block:

```ts
    try {
      await threadsStore.updateStatus(threadId, "busy")
    } catch (error) {
      run.release()
      throw error
    }
```

with:

```ts
    // A resume turn's anchor is the PARKED checkpoint, and its input is the
    // resume payload — echoed for correlation and debugging only. No try/catch
    // around hub.open: the tuple was already read above, and open() does no I/O.
    const liveTurn: LiveTurn = hub.open(threadId, {
      anchorCheckpointId: checkpointIdOf(anchorTuple),
      input: body.resume,
      resume: true,
      runStartedAt: new Date().toISOString(),
    })

    try {
      await threadsStore.updateStatus(threadId, "busy")
    } catch (error) {
      liveTurn.close()
      run.release()
      throw error
    }
```

Replace the resume handler's loop body (12-space indentation — this is the resume
copy, not the stream handler's):

```ts
            for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
              sourceCleanup = p
            })) {
              if (chunk.type === "interrupt") sawInterrupt = true
              safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
            }
```

with:

```ts
            for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
              sourceCleanup = p
            })) {
              if (chunk.type === "interrupt") sawInterrupt = true
              safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
              liveTurn.publish(chunk)
            }
```

Replace the resume handler's catch enqueue:

```ts
              safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
              await threadsStore
```

with:

```ts
              safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
              liveTurn.publish(terminalChunk)
              await threadsStore
```

Replace the resume handler's finally:

```ts
        } finally {
          stopHeartbeat()
          // The client's stream ends here regardless — response lifetime and run
          // lifetime are deliberately different; see handleApStreamRequest.
```

with:

```ts
        } finally {
          stopHeartbeat()
          // Unconditional and never deferred behind sourceCleanup — see
          // handleApStreamRequest for why viewers track response lifetime.
          liveTurn.close()
          // The client's stream ends here regardless — response lifetime and run
          // lifetime are deliberately different; see handleApStreamRequest.
```

- [ ] **Step 5: Pass the hub from the route table**

In `buildRouteTable`, in the `POST /threads/:thread_id/resume` entry, replace:

```ts
          getMemoryStore: () => getMemoryStoreFor(request),
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          resumeClaims,
```

with:

```ts
          getMemoryStore: () => getMemoryStoreFor(request),
          hub,
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          resumeClaims,
```

- [ ] **Step 6: Run the tests and see them pass**

```bash
pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/ap-attach.test.ts test/resume-endpoint.test.ts test/run-cancellation.test.ts \
  test/subagent-interrupts.test.ts
```

Expected: typecheck exits 0; all four files PASS. `resume-endpoint.test.ts`'s
`reads > 1 ⇒ throw` checkpointer fixture is the specific pin proving Step 3 kept the
resume endpoint at exactly one checkpoint read.

- [ ] **Step 7: Check for an unused import**

`readPendingInterrupts` may now be unused in `runtime-fetch-core.ts`. Run:

```bash
pnpm --filter @dawn-ai/cli lint
```

If biome reports `readPendingInterrupts` as an unused import, remove it from the
`./pending-interrupts.js` import block, leaving:

```ts
import {
  createPendingResumeClaims,
  type DawnResumeEntry,
  parsePendingInterrupts,
  type PendingResumeClaims,
  resolvePendingResume,
} from "./pending-interrupts.js"
```

Then re-run `pnpm --filter @dawn-ai/cli lint` and expect exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/ap-attach.test.ts
git commit -m "feat(cli): publish resume turns to Agent Protocol attachers" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: Transcript equivalence at randomized attach points (scenario 1)

**Files:**
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
describe("attach transcript equivalence", () => {
  it.each([0, 1, 2, 3, 4])(
    "reconstructs the primary transcript when attaching at randomized point %i",
    async (seed) => {
      const { handler, startedFile, releaseRoute } = await createAttachFixture({
        apSseHeartbeatIntervalMs: 60_000,
        reply: `Reply number ${seed} with enough text to stream several tokens.`,
      })
      const threadId = `t-equivalence-${seed}`

      const primary = handler.fetch(
        postRunRequest(threadId, "/chat#agent", {
          messages: [{ content: "hello", role: "user" }],
        }),
      )
      await waitForFile(startedFile)
      // Randomize WHEN the viewer lands relative to the blocked tool.
      await new Promise((resolve) => setTimeout(resolve, seed * 17))

      const attachResponse = await handler.fetch(attachRequest(threadId))
      await releaseRoute()

      const attachFrames = await readFrames(attachResponse)
      const primaryFrames = await readFrames(await primary)
      const state = stateFrameOf(attachFrames)

      // Text equivalence: coalesced snapshot text + tailed text === primary text.
      expect(textOfTurn(state.turn) + textOfFrames(attachFrames)).toBe(
        textOfFrames(primaryFrames),
      )

      // Structural equivalence at node granularity: the same tool calls and
      // results appear once, across the snapshot and the tail combined.
      const structuralOf = (entries: ReadonlyArray<{ type?: unknown; name?: unknown }>) =>
        entries
          .filter((e) => e.type === "tool_call" || e.type === "tool_result")
          .map((e) => `${String(e.type)}:${String(e.name)}`)
      const attachStructural = [
        ...structuralOf((state.turn ?? []) as ReadonlyArray<{ type?: unknown; name?: unknown }>),
        ...attachFrames
          .filter((f) => f.event === "tool_call" || f.event === "tool_result")
          .map((f) => `${f.event}:${String((f.data as { name?: unknown }).name)}`),
      ]
      const primaryStructural = primaryFrames
        .filter((f) => f.event === "tool_call" || f.event === "tool_result")
        .map((f) => `${f.event}:${String((f.data as { name?: unknown }).name)}`)
      expect(attachStructural).toEqual(primaryStructural)

      // `resume` is false, so a client applies `input` to the transcript: it is
      // the user message the run started with, exactly once.
      expect(state.resume).toBe(false)
      expect(state.input).toEqual({ messages: [{ content: "hello", role: "user" }] })
    },
    30_000,
  )
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "transcript equivalence"
```

Expected: PASS, all five parameterized cases. A failure of the form
`expected 'Hello world' to be 'Hello Hello world'` means a digest element was mutated
in place after being copied — fix `withAppendedText` usage in
`packages/cli/src/lib/dev/live-turn-hub.ts` (it must assign a NEW object into the
digest slot, never mutate). A failure of the form `expected '' to be 'Hello world'`
means the attach landed after the turn closed; raise the blocking tool's window rather
than weakening the assertion.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/ap-attach.test.ts
git commit -m "test(cli): pin attach transcript equivalence" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: Anchor correctness and anchor-read degradation (scenario 7)

**Files:**
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
/**
 * A checkpointer whose LATEST tuple always carries one more message than the
 * anchored one. If the state frame read the latest tuple instead of the anchor,
 * `values.messages` would contain the in-flight message the digest also carries
 * — the double-count this fixture exists to catch.
 */
const ANCHOR_CHECKPOINTER_CONFIG = [
  "export default {",
  "  checkpointer: {",
  "    getTuple: async (config) => {",
  "      const id = config?.configurable?.checkpoint_id",
  '      if (id === "ckpt-anchor") {',
  "        return {",
  '          config: { configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "ckpt-anchor" } },',
  '          checkpoint: { channel_values: { messages: ["anchored"] } },',
  "          pendingWrites: [],",
  "        }",
  "      }",
  "      return {",
  '        config: { configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "ckpt-anchor" } },',
  '        checkpoint: { channel_values: { messages: ["anchored", "in-flight"] } },',
  "        pendingWrites: [],",
  "      }",
  "    },",
  "  },",
  "};",
  "",
].join("\n")

/** A checkpointer whose reads always throw — attach must degrade, not fail. */
const FAILING_CHECKPOINTER_CONFIG = [
  "export default {",
  "  checkpointer: {",
  "    getTuple: async () => { throw new Error('checkpoint read failed') },",
  "  },",
  "};",
  "",
].join("\n")

describe("attach anchor correctness", () => {
  it("reads values at the anchor, not the latest checkpoint", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "dawn.config.ts": ANCHOR_CHECKPOINTER_CONFIG },
    })
    const threadId = "t-anchor"

    const primary = handler.fetch(
      postRunRequest(threadId, "/blocking#graph", {
        releaseFile: `${startedFile}.release`,
        startedFile,
      }),
    )
    await waitForFile(startedFile)

    const attachResponse = await handler.fetch(attachRequest(threadId))
    await releaseRoute()
    const state = stateFrameOf(await readFrames(attachResponse))
    await drain(await primary)

    expect(state.live).toBe(true)
    expect(state.anchor).toBe("ckpt-anchor")
    expect(state.values).toEqual({ messages: ["anchored"] })
  }, 30_000)

  it("degrades to the durable path when the anchor read fails, without failing the run", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "dawn.config.ts": FAILING_CHECKPOINTER_CONFIG },
    })
    const threadId = "t-anchor-fails"

    const primary = handler.fetch(
      postRunRequest(threadId, "/blocking#graph", {
        releaseFile: `${startedFile}.release`,
        startedFile,
      }),
    )
    await waitForFile(startedFile)

    // The run itself is unaffected — it started and will complete.
    const attachResponse = await handler.fetch(attachRequest(threadId))
    const frames = await readFrames(attachResponse)
    const state = stateFrameOf(frames)
    expect(state.live).toBe(false)
    expect(state.values).toBeNull()
    expect(frames.some((f) => f.event === "done")).toBe(true)

    await releaseRoute()
    const primaryFrames = await readFrames(await primary)
    expect(primaryFrames.at(-1)?.event).toBe("done")
    expect(primaryFrames.at(-1)?.data).toEqual({ output: { ok: true } })
  }, 30_000)

  it("does not leak the run slot when the anchor read fails", async () => {
    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "dawn.config.ts": FAILING_CHECKPOINTER_CONFIG },
    })
    const threadId = "t-anchor-fails-slot"

    await drain(await handler.fetch(postRunRequest(threadId, "/quick#graph")))
    // A second run on the same thread is admitted, so no slot leaked.
    const second = await handler.fetch(postRunRequest(threadId, "/quick#graph"))
    expect(second.status).toBe(200)
    await drain(second)
  }, 30_000)
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "anchor correctness"
```

Expected: PASS. A failure `expected { messages: [ 'anchored', 'in-flight' ] } to deeply
equal { messages: [ 'anchored' ] }` means the attach handler is reading the latest tuple
rather than the id-addressed one — check the `checkpoint_id` in the live path's
`getTuple` config. A 500 on the degradation case means the anchor read is not wrapped
in its own try/catch in `handleApStreamRequest`.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/ap-attach.test.ts
git commit -m "test(cli): pin attach anchor correctness and degradation" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: Parked attach, interrupt payloads, and status honesty (scenarios 2 and 9)

**Files:**
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
describe("attach while parked", () => {
  it("re-renders the permission prompt from the state frame alone", async () => {
    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "dawn.config.ts": RESUME_CHECKPOINTER_CONFIG },
    })
    const threadId = "t-parked-attach"
    await drain(await handler.fetch(postRunRequest(threadId, "/blocking#graph", {})))

    const state = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    expect(state.live).toBe(false)
    expect(state.interrupts).toHaveLength(1)
    expect(state.interrupts[0]?.interruptId).toBe(RESUME_INTERRUPT_ID)
    expect(state.interrupts[0]?.resumeKey).toBe("3336d0e0a2d4f198ef9aecd09cd7ac27")
    // The renderable payload — without this, a reloaded client cannot draw the
    // prompt and the agent waits forever on a human who cannot see it.
    expect(state.interrupts[0]?.value).toEqual({
      interruptId: RESUME_INTERRUPT_ID,
      kind: "command",
    })
  }, 30_000)

  it("matches GET /pending_interrupts for the same thread", async () => {
    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "dawn.config.ts": RESUME_CHECKPOINTER_CONFIG },
    })
    const threadId = "t-parked-parity"
    await drain(await handler.fetch(postRunRequest(threadId, "/blocking#graph", {})))

    const state = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    const pendingResponse = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/pending_interrupts`),
    )
    expect(pendingResponse.status).toBe(200)
    const pending = (await pendingResponse.json()) as {
      interrupts: ReadonlyArray<Record<string, unknown>>
    }
    expect(state.interrupts).toEqual(pending.interrupts)
  }, 30_000)
})

describe("interrupted means cancelled-or-parked", () => {
  it("reports interrupted with no pending interrupts after a cancel", async () => {
    const { handler, startedFile } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const threadId = "t-cancel-discriminator"

    const primary = await handler.fetch(
      postRunRequest(threadId, "/blocking#graph", {
        releaseFile: `${startedFile}.never`,
        startedFile,
      }),
    )
    await waitForFile(startedFile)
    expect((await handler.fetch(cancelRequest(threadId))).status).toBe(200)
    await drain(primary)

    const threadResponse = await handler.fetch(threadRequest(threadId))
    expect(((await threadResponse.json()) as { status: string }).status).toBe("interrupted")

    // The discriminator: cancelled means interrupted AND nothing pending.
    const state = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    expect(state.status).toBe("interrupted")
    expect(state.interrupts).toEqual([])
  }, 30_000)

  it("still attaches via the durable path when a stale busy status survives a restart", async () => {
    const { appRoot, handler, startedFile } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const threadId = "t-stale-busy"

    const primary = await handler.fetch(
      postRunRequest(threadId, "/blocking#graph", {
        releaseFile: `${startedFile}.never`,
        startedFile,
      }),
    )
    await waitForFile(startedFile)
    // Abandon the response and drop the handler: the thread row stays "busy"
    // with no live turn anywhere, exactly like a crashed process.
    await primary.body?.cancel()
    await handler.close()

    const restarted = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => restarted.close())
    const state = stateFrameOf(await readFrames(await restarted.fetch(attachRequest(threadId))))
    expect(state.live).toBe(false)
    // Deliberately in-band, not an HTTP error: an error status would break
    // EventSource's reconnect loop.
    expect(state.status).toBe("busy")
  }, 30_000)
})
```

Extend the test file's helper import to cover the new symbols — replace the import
block at the top of `packages/cli/test/ap-attach.test.ts` with:

```ts
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import {
  attachRequest,
  cancelRequest,
  cleanup,
  createAttachFixture,
  drain,
  postRunRequest,
  readFrames,
  runCleanups,
  stateFrameOf,
  textOfFrames,
  textOfTurn,
  threadRequest,
  waitForFile,
} from "./helpers/ap-attach-fixture.js"
```

and delete the two partial `import { … } from "./helpers/ap-attach-fixture.js"`
statements added in Tasks 10 and 12.

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "parked"
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "cancelled-or-parked"
```

Expected: PASS. If the pending-interrupt parity case fails with
`expected [] to deeply equal [ { interruptId: 'perm-1', … } ]`, PR1's
`parsePendingInterrupts` is not surfacing `value` — that is a PR1 regression, fix it
there before continuing.

- [ ] **Step 3: Add the park-writes-interrupted assertion**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
describe("parked turns report interrupted", () => {
  it("writes interrupted from the stream handler when the turn parks", async () => {
    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: {
        "dawn.config.ts": RESUME_CHECKPOINTER_CONFIG,
        "src/app/parks/index.ts": [
          "export const graph = async function* () {",
          '  yield { type: "interrupt", data: { interruptId: "perm-1" } }',
          '  yield { type: "done", output: { parked: true } }',
          "}",
          "",
        ].join("\n"),
      },
    })
    const threadId = "t-park-status"
    await drain(await handler.fetch(postRunRequest(threadId, "/parks#graph", {})))

    const thread = (await (await handler.fetch(threadRequest(threadId))).json()) as {
      status: string
    }
    expect(thread.status).toBe("interrupted")
  }, 30_000)
})
```

- [ ] **Step 4: Run it**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "parked turns report interrupted"
```

Expected: PASS — PR1 landed the `sawInterrupt` flag in both handlers. If it reports
`expected 'idle' to be 'interrupted'`, PR1's §4 change is missing or the generator
route shape above is not producing an `interrupt` chunk; check
`packages/cli/src/lib/runtime/execute-route-core.ts` for how non-agent route streams
are normalized before adjusting the fixture.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/ap-attach.test.ts
git commit -m "test(cli): pin parked attach and interrupted-status honesty" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 15: Multiple viewers, a slow viewer, and the viewer cap (scenario 4)

**Files:**
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
describe("attach concurrency", () => {
  it("serves two concurrent viewers without affecting each other or the run", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      reply: "Two viewers see the same thing.",
    })
    const threadId = "t-two-viewers"

    const primary = handler.fetch(
      postRunRequest(threadId, "/chat#agent", {
        messages: [{ content: "hello", role: "user" }],
      }),
    )
    await waitForFile(startedFile)

    const first = await handler.fetch(attachRequest(threadId))
    const second = await handler.fetch(attachRequest(threadId))
    await releaseRoute()

    const [firstFrames, secondFrames, primaryFrames] = await Promise.all([
      readFrames(first),
      readFrames(second),
      readFrames(await primary),
    ])

    for (const frames of [firstFrames, secondFrames]) {
      const state = stateFrameOf(frames)
      expect(state.live).toBe(true)
      expect(textOfTurn(state.turn) + textOfFrames(frames)).toBe(textOfFrames(primaryFrames))
      expect(frames.at(-1)?.event).toBe("done")
    }
  }, 30_000)

  it("drops only the slow viewer, with detached{reason:overflow}", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apAttachSubscriberQueueMaxFrames: 1,
      apSseHeartbeatIntervalMs: 60_000,
      reply: "A reply long enough to produce several streamed frames in a row.",
    })
    const threadId = "t-slow-viewer"

    const primary = handler.fetch(
      postRunRequest(threadId, "/chat#agent", {
        messages: [{ content: "hello", role: "user" }],
      }),
    )
    await waitForFile(startedFile)

    const slow = await handler.fetch(attachRequest(threadId))
    await releaseRoute()
    const slowFrames = await readFrames(slow)
    const primaryFrames = await readFrames(await primary)

    // The viewer was dropped, and said so, instead of hanging or corrupting.
    const detached = slowFrames.find((f) => f.event === "detached")
    expect(detached?.data).toEqual({ reason: "overflow" })
    // The run itself completed normally.
    expect(primaryFrames.at(-1)?.event).toBe("done")

    // A fresh attach after the run still works — the documented recovery.
    const recovered = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    expect(recovered.live).toBe(false)
  }, 30_000)

  it("refuses a viewer past the cap with detached{reason:capacity}", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apAttachMaxViewers: 1,
      apSseHeartbeatIntervalMs: 60_000,
    })
    const threadId = "t-viewer-cap"

    const primary = handler.fetch(
      postRunRequest(threadId, "/blocking#graph", {
        releaseFile: `${startedFile}.release`,
        startedFile,
      }),
    )
    await waitForFile(startedFile)

    const first = await handler.fetch(attachRequest(threadId))
    const refused = await handler.fetch(attachRequest(threadId))
    // Not an HTTP error — an in-band frame, so EventSource keeps its loop.
    expect(refused.status).toBe(200)
    const refusedFrames = await readFrames(refused)
    expect(refusedFrames).toEqual([{ data: { reason: "capacity" }, event: "detached" }])

    await releaseRoute()
    await drain(first)
    await drain(await primary)
  }, 30_000)
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "attach concurrency"
```

Expected: PASS. If the slow-viewer case sees no `detached` frame, the attach handler is
draining eagerly enough that the queue never exceeds one frame — lower
`apAttachSubscriberQueueMaxFrames` is already at 1, so instead lengthen `reply` so
more frames arrive in a single tick. Do not remove the assertion.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/ap-attach.test.ts
git commit -m "test(cli): pin attach viewer concurrency and bounds" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 16: Cancel mid-attach and the zombie publisher (scenario 6)

**Files:**
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
describe("attach across producer exits", () => {
  it("shows a cancel in band as done{output:{cancelled:true}}", async () => {
    const { handler, startedFile } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const threadId = "t-cancel-in-band"

    const primary = await handler.fetch(
      postRunRequest(threadId, "/blocking#graph", {
        releaseFile: `${startedFile}.never`,
        startedFile,
      }),
    )
    await waitForFile(startedFile)
    const attachResponse = await handler.fetch(attachRequest(threadId))

    expect((await handler.fetch(cancelRequest(threadId))).status).toBe(200)

    const frames = await readFrames(attachResponse)
    expect(stateFrameOf(frames).live).toBe(true)
    expect(frames.at(-1)?.event).toBe("done")
    expect(frames.at(-1)?.data).toEqual({ output: { cancelled: true } })
    await drain(primary)
  }, 30_000)

  it("shows a run failure in band as done{output:{error}}", async () => {
    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: {
        "src/app/boom/index.ts": [
          "export const graph = async () => { throw new Error('boom') }",
          "",
        ].join("\n"),
      },
    })
    const threadId = "t-error-in-band"
    // The run is over before the attach lands, so this is the durable path —
    // what must hold is that the primary reported the error terminal and the
    // hub did not swallow it.
    const frames = await readFrames(await handler.fetch(postRunRequest(threadId, "/boom#graph")))
    expect(frames.at(-1)?.data).toEqual({ output: { error: "boom" } })

    const state = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    expect(state.live).toBe(false)
  }, 30_000)

  it("a cancelled route still unwinding cannot publish into the successor turn", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const threadId = "t-zombie-publisher"

    // Run 1: the blocking route ignores ctx.signal, so cancelling detaches it
    // while it keeps running — the exact zombie the identity guard exists for.
    const first = await handler.fetch(
      postRunRequest(threadId, "/blocking#graph", {
        releaseFile: `${startedFile}.release`,
        startedFile,
      }),
    )
    await waitForFile(startedFile)
    expect((await handler.fetch(cancelRequest(threadId))).status).toBe(200)
    await drain(first)

    // Run 2 on the same thread, admitted once the zombie's slot frees.
    let second: Response | undefined
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const attempt = await handler.fetch(postRunRequest(threadId, "/quick#graph"))
      if (attempt.status === 200) {
        second = attempt
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!second) throw new Error("the run slot never freed after cancellation")

    const secondFrames = await readFrames(second)
    // Nothing from run 1 leaked into run 2's stream.
    expect(secondFrames.map((f) => f.event)).toEqual(["done"])
    expect(secondFrames[0]?.data).toEqual({ output: { ok: true } })

    await releaseRoute()
  }, 30_000)
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "producer exits"
```

Expected: PASS. If the cancel case hangs, `liveTurn?.close()` is being deferred behind
`sourceCleanup` in `handleApStreamRequest`'s `finally` — it must fire unconditionally,
immediately after `stopHeartbeat()`.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/ap-attach.test.ts
git commit -m "test(cli): pin attach behavior at every producer exit" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 17: Digest overflow end to end (scenario 8)

**Files:**
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

A one-byte cap makes this deterministic: the very first published chunk overflows, so
the digest is dropped whole before any attach can observe it.

```ts
describe("attach digest overflow", () => {
  it("degrades to values plus live tail with turn:null and turn_truncated", async () => {
    const { handler, startedFile, releaseRoute } = await createAttachFixture({
      // One byte: the very first published chunk overflows, so the digest is
      // dropped whole before any attach can see it.
      apAttachDigestMaxBytes: 1,
      apSseHeartbeatIntervalMs: 60_000,
      reply: "Enough text to stream a few frames.",
    })
    const threadId = "t-digest-overflow"

    const primary = handler.fetch(
      postRunRequest(threadId, "/chat#agent", {
        messages: [{ content: "hello", role: "user" }],
      }),
    )
    await waitForFile(startedFile)

    const attachResponse = await handler.fetch(attachRequest(threadId))
    await releaseRoute()
    const frames = await readFrames(attachResponse)
    const primaryFrames = await readFrames(await primary)
    const state = stateFrameOf(frames)

    expect(state.live).toBe(true)
    expect(state.turn).toBeNull()
    expect(state.turn_truncated).toBe(true)
    // Values are still served, and the live tail is still transcript-consistent
    // at node granularity: the same tool call and result, once each.
    expect(
      frames
        .filter((f) => f.event === "tool_call" || f.event === "tool_result")
        .map((f) => `${f.event}:${String((f.data as { name?: unknown }).name)}`),
    ).toEqual(["tool_result:waitForRelease"])
    expect(
      primaryFrames
        .filter((f) => f.event === "tool_call" || f.event === "tool_result")
        .map((f) => `${f.event}:${String((f.data as { name?: unknown }).name)}`),
    ).toEqual(["tool_call:waitForRelease", "tool_result:waitForRelease"])
    expect(frames.at(-1)?.event).toBe("done")
  }, 30_000)
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "digest overflow"
```

Expected: PASS. If the tail's tool-event list does not match, the attach landed before
or after the blocked tool — adjust only which events the attacher is expected to see in
the tail (the primary's list is the invariant), never the `turn: null` /
`turn_truncated: true` assertions.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/ap-attach.test.ts
git commit -m "test(cli): pin attach digest overflow degradation" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 18: Middleware gating parity (scenario 10)

**Files:**
- Test: `packages/cli/test/ap-attach.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/ap-attach.test.ts`:

```ts
/**
 * Route-gating middleware: rejects everything without the header, and records
 * the method it observed so the GET-method contract is pinned.
 */
const GATING_MIDDLEWARE = [
  "import { writeFileSync, readFileSync } from 'node:fs'",
  "const LOG = process.env.DAWN_TEST_MW_LOG ?? ''",
  "export default async (req) => {",
  "  if (LOG) {",
  "    let seen = []",
  "    try { seen = JSON.parse(readFileSync(LOG, 'utf8')) } catch {}",
  "    seen.push({ method: req.method, routeId: req.routeId, url: req.url })",
  "    writeFileSync(LOG, JSON.stringify(seen))",
  "  }",
  "  if (req.headers['x-dawn-test-auth'] !== 'ok') {",
  "    return { action: 'reject', status: 401, body: { error: 'Unauthorized' } }",
  "  }",
  "  return { action: 'continue' }",
  "}",
  "",
].join("\n")

describe("attach middleware gating", () => {
  it("rejects and allows attach exactly as it does the POST stream", async () => {
    const logPath = join(tmpdir(), `dawn-mw-log-${Math.random().toString(36).slice(2)}.json`)
    process.env.DAWN_TEST_MW_LOG = logPath
    cleanup.push(() => {
      delete process.env.DAWN_TEST_MW_LOG
      return rm(logPath, { force: true })
    })

    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "src/middleware.ts": GATING_MIDDLEWARE },
    })
    const threadId = "t-mw-gating"

    // POST is rejected without the header.
    const rejectedPost = await handler.fetch(postRunRequest(threadId, "/quick#graph"))
    expect(rejectedPost.status).toBe(401)

    // POST allowed with the header — build the request by hand so the header rides along.
    const allowedPost = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/runs/stream`, {
        body: JSON.stringify({ input: {}, route: "/quick#graph" }),
        headers: { "content-type": "application/json", "x-dawn-test-auth": "ok" },
        method: "POST",
      }),
    )
    expect(allowedPost.status).toBe(200)
    await drain(allowedPost)

    // Attach is gated identically.
    const rejectedAttach = await handler.fetch(attachRequest(threadId))
    expect(rejectedAttach.status).toBe(401)
    expect(await rejectedAttach.json()).toEqual({ error: "Unauthorized" })

    const allowedAttach = await handler.fetch(
      attachRequest(threadId, { "x-dawn-test-auth": "ok" }),
    )
    expect(allowedAttach.status).toBe(200)
    await drain(allowedAttach)

    // `method: "GET"` is a new observable middleware input.
    const seen = JSON.parse(await readFile(logPath, "utf8")) as Array<{
      method: string
      routeId: string
      url: string
    }>
    const attachCalls = seen.filter((entry) => entry.method === "GET")
    expect(attachCalls.length).toBeGreaterThanOrEqual(2)
    expect(attachCalls[0]?.routeId).toBe("/quick")
    expect(attachCalls[0]?.url).toBe(`/threads/${threadId}/runs/stream`)
  }, 30_000)

  it("refuses attach before middleware when the thread has no resolvable route", async () => {
    const { handler } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      files: { "src/middleware.ts": GATING_MIDDLEWARE },
    })
    const created = await handler.fetch(
      new Request("http://localhost/threads", {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    const thread = (await created.json()) as { thread_id: string }

    // Fails CLOSED with 409, not 401 and not a silent pass-through.
    const response = await handler.fetch(
      attachRequest(thread.thread_id, { "x-dawn-test-auth": "ok" }),
    )
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe("thread_route_unknown")
  }, 30_000)
})
```

Add the node imports this describe needs to the top of
`packages/cli/test/ap-attach.test.ts`, directly under the `vitest` import:

```ts
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach.test.ts -t "middleware gating"
```

Expected: PASS. If the GET calls are missing from the log, the attach handler is not
running middleware; if `routeId` is empty, it is not resolving the route before the
middleware call.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/ap-attach.test.ts
git commit -m "test(cli): pin attach middleware gating parity" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 19: Export the hub and re-run the existing pins (scenario 11)

**Files:**
- Modify: `packages/cli/src/runtime-exports.ts`
- Test: `packages/cli/test/runtime-exports.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/runtime-exports.test.ts`, inside the existing `it` body,
directly before its closing `})`:

```ts
  expect(typeof rt.createLiveTurnHub).toBe("function")
```

- [ ] **Step 2: Run it and see it fail**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/runtime-exports.test.ts
```

Expected: FAIL — `expected 'undefined' to be 'function'`.

- [ ] **Step 3: Export the hub and the attach frame types**

In `packages/cli/src/runtime-exports.ts`, add — in import-sorted position, immediately
before the `export { runMemoryCommand } …` line's following block for
`./lib/dev/pending-interrupts.js`:

```ts
export {
  type AttachResult,
  createLiveTurnHub,
  type DetachReason,
  type LiveTurn,
  type LiveTurnDelivery,
  type LiveTurnHub,
  type LiveTurnHubOptions,
  type LiveTurnIdentity,
  type LiveTurnSnapshot,
  type LiveTurnSubscription,
} from "./lib/dev/live-turn-hub.js"
```

and replace:

```ts
export type { StreamChunk } from "./lib/runtime/stream-types.js"
```

with:

```ts
export type {
  AttachDetachedFrame,
  AttachDetachReason,
  AttachInterrupt,
  AttachStateFrame,
  StreamChunk,
} from "./lib/runtime/stream-types.js"
```

- [ ] **Step 4: Run it and see it pass**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/runtime-exports.test.ts
```

Expected: PASS.

- [ ] **Step 5: Re-run every existing pin this PR could disturb**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/run-cancellation.test.ts test/resume-endpoint.test.ts \
  test/runtime-fetch-parity.test.ts test/runtime-fetch-handler.test.ts \
  test/agui-endpoint.test.ts test/subagent-interrupts.test.ts \
  test/pending-interrupts.test.ts test/middleware.test.ts \
  test/static-middleware.test.ts test/edge-bundle-purity.test.ts \
  test/fetch-entry-purity.test.ts
```

Expected: all PASS. The two purity suites are the gate proving `live-turn-hub.ts`
introduced no `node:` import into the edge module graph — a failure there names the
offending specifier.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/runtime-exports.ts packages/cli/test/runtime-exports.test.ts
git commit -m "feat(cli): export the live-turn hub on the runtime surface" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 20: The same attach contract against a real Postgres checkpointer (env-gated)

The spec requires the integration suite to run against **both** checkpointer backends,
with Postgres env-gated in the conformance-kit style. `@dawn-ai/postgres-storage` is not
yet reachable from `packages/cli`'s tests.

**Files:**
- Modify: `packages/cli/package.json` (devDependencies)
- Create: `packages/cli/test/ap-attach-postgres.test.ts`

- [ ] **Step 1: Add the devDependency**

Edit `packages/cli/package.json` and add to `devDependencies`, keeping the block
alphabetically sorted (it goes immediately after `"@dawn-ai/config-typescript"`):

```json
    "@dawn-ai/postgres-storage": "workspace:*",
```

Then:

```bash
pnpm install
pnpm build
```

Expected: `pnpm-lock.yaml` gains the workspace link and the build succeeds. Re-fetch
`main` immediately before merging this PR — a stale `pnpm-lock.yaml` fails at Install
and reds every CI job at once.

- [ ] **Step 2: Write the gated test**

Create `packages/cli/test/ap-attach-postgres.test.ts`:

```ts
import { postgresCheckpointer } from "@dawn-ai/postgres-storage/node"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import {
  attachRequest,
  cleanup,
  createAttachFixture,
  drain,
  postRunRequest,
  readFrames,
  runCleanups,
  stateFrameOf,
  textOfFrames,
  textOfTurn,
  waitForFile,
} from "./helpers/ap-attach-fixture.js"

// Gated exactly like the storage packages' own real-Postgres lanes: needs
// Docker, so it is opt-in and CI runs it on the job that has a daemon.
const enabled = process.env.DAWN_TEST_PGSTORAGE === "1"

let container: StartedPostgreSqlContainer
let connectionString: string

afterEach(runCleanups)

describe.skipIf(!enabled)("Agent Protocol attach against a Postgres checkpointer", () => {
  beforeAll(async () => {
    // A loaded runner can take minutes to pull postgres:16 and accept the first
    // connection; the honest lever is the startup timeout, not a blanket retry.
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    connectionString = container.getConnectionUri()
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  it("serves the durable path from Postgres after a run completes", async () => {
    const { appRoot } = await createAttachFixture({ apSseHeartbeatIntervalMs: 60_000 })
    const checkpointer = postgresCheckpointer({
      connectionString,
      tablePrefix: `t_${Math.random().toString(36).slice(2)}`,
    })
    const handler = await createRuntimeFetchHandler({
      appRoot,
      checkpointer,
      drainDeadlineMs: 250,
    })
    cleanup.push(() => handler.close())

    const threadId = "t-pg-durable"
    await drain(await handler.fetch(postRunRequest(threadId, "/quick#graph")))

    const state = stateFrameOf(await readFrames(await handler.fetch(attachRequest(threadId))))
    expect(state.live).toBe(false)
    expect(state.status).toBe("idle")
    expect(state.interrupts).toEqual([])
  }, 240_000)

  it("attaches to a live turn and reconstructs the primary transcript", async () => {
    const { appRoot, startedFile, releaseRoute } = await createAttachFixture({
      apSseHeartbeatIntervalMs: 60_000,
      reply: "Postgres-backed reply with enough text to stream.",
    })
    const checkpointer = postgresCheckpointer({
      connectionString,
      tablePrefix: `t_${Math.random().toString(36).slice(2)}`,
    })
    const handler = await createRuntimeFetchHandler({
      appRoot,
      checkpointer,
      drainDeadlineMs: 250,
    })
    cleanup.push(() => handler.close())

    const threadId = "t-pg-live"
    const primary = handler.fetch(
      postRunRequest(threadId, "/chat#agent", {
        messages: [{ content: "hello", role: "user" }],
      }),
    )
    await waitForFile(startedFile)

    const attachResponse = await handler.fetch(attachRequest(threadId))
    await releaseRoute()
    const attachFrames = await readFrames(attachResponse)
    const primaryFrames = await readFrames(await primary)
    const state = stateFrameOf(attachFrames)

    expect(state.live).toBe(true)
    // The anchor is a real Postgres checkpoint id, addressed by id on read.
    expect(typeof state.anchor === "string" || state.anchor === null).toBe(true)
    expect(textOfTurn(state.turn) + textOfFrames(attachFrames)).toBe(
      textOfFrames(primaryFrames),
    )
  }, 240_000)
})
```

- [ ] **Step 3: Confirm it skips without the gate**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/ap-attach-postgres.test.ts
```

Expected: `2 skipped` — no Docker required on the default path.

- [ ] **Step 4: Run it with the gate and Docker available**

```bash
DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/ap-attach-postgres.test.ts
```

Expected: both cases PASS. If Docker is unavailable on this machine, record that the
lane was not executed locally and say so explicitly in the PR description — do not
claim it passed.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json pnpm-lock.yaml packages/cli/test/ap-attach-postgres.test.ts
git commit -m "test(cli): add a Postgres-backed attach lane" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 21: The `examples/research` digest-cap pass/fail gate

The 2 MiB default is only defensible if the flagship workload fits under it *after*
coalescing. This task turns that into a test that fails when it stops being true.

**Files:**
- Create: `examples/research/server/test/attach-digest-cap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `examples/research/server/test/attach-digest-cap.test.ts`:

```ts
import { fileURLToPath } from "node:url"

import { createLiveTurnHub, streamResolvedRoute } from "@dawn-ai/cli/runtime"
import type { StreamChunk } from "@dawn-ai/cli/runtime"
import { createAimock, script } from "@dawn-ai/testing"
import { afterAll, beforeAll, expect, it } from "vitest"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const DIGEST_MAX_BYTES = 2 * 1024 * 1024

let mock: Awaited<ReturnType<typeof createAimock>>
let prevBaseUrl: string | undefined
let prevKey: string | undefined

/** Long enough per message that a real deep-research turn is represented. */
const PARAGRAPH =
  "Agent architectures fall into a few recurring shapes, each with different " +
  "tradeoffs around latency, controllability and cost. [corpus/agent-architectures.md] "

beforeAll(async () => {
  mock = await createAimock({
    fixtures: script()
      .user("Research agent architectures across the corpus")
      .callsTool("task", { input: "What are common agent architectures?", subagent: "researcher" })
      .callsTool("task", { input: "How do agents manage context?", subagent: "researcher" })
      .callsTool("task", { input: "What are the cost tradeoffs?", subagent: "researcher" })
      .replies(PARAGRAPH.repeat(20))
      .user("What are common agent architectures?")
      .callsTool("searchCorpus", { query: "agent architectures" })
      .replies(PARAGRAPH.repeat(40))
      .user("How do agents manage context?")
      .callsTool("readDoc", { path: "corpus/context-windows-and-offloading.md" })
      .replies(PARAGRAPH.repeat(40))
      .user("What are the cost tradeoffs?")
      .callsTool("searchCorpus", { query: "cost tradeoffs" })
      .replies(PARAGRAPH.repeat(40))
      .build(),
  })
  prevBaseUrl = process.env.OPENAI_BASE_URL
  prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = mock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
})

afterAll(async () => {
  await mock.close()
  if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = prevBaseUrl
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = prevKey
})

it("a full deep-research turn fits under the default attach digest cap", async () => {
  const hub = createLiveTurnHub({ digestMaxBytes: DIGEST_MAX_BYTES, maxViewers: 16 })
  const turn = hub.open("t-digest-cap", {
    anchorCheckpointId: null,
    input: { messages: [{ content: "Research agent architectures", role: "user" }] },
    resume: false,
    runStartedAt: new Date().toISOString(),
  })

  let rawChunks = 0
  for await (const chunk of streamResolvedRoute({
    appRoot,
    input: { messages: [{ content: "Research agent architectures", role: "user" }] },
    routeFile: `${appRoot}src/app/research/index.ts`,
    routeId: "/research#agent",
    routePath: "src/app/research/index.ts",
    threadId: "t-digest-cap",
  })) {
    rawChunks += 1
    turn.publish(chunk as StreamChunk)
  }

  const attached = hub.attach("t-digest-cap")
  if (attached.kind !== "live") throw new Error(`expected a live turn, got ${attached.kind}`)
  attached.subscription.close()

  // THE GATE: the flagship workload must not overflow the shipped default.
  expect(attached.snapshot.truncated).toBe(false)
  expect(attached.snapshot.turn).not.toBeNull()
  expect(attached.snapshot.bytes).toBeLessThan(DIGEST_MAX_BYTES)

  // And coalescing is what makes it fit: the digest holds far fewer entries
  // than the stream emitted frames. Without per-call_id subagent coalescing
  // this ratio collapses toward 1 and the cap stops holding.
  const digestEntries = attached.snapshot.turn?.length ?? 0
  expect(rawChunks).toBeGreaterThan(digestEntries * 4)

  // Report the measured size so a future regression is diagnosable from CI logs.
  console.log(
    `attach digest: ${attached.snapshot.bytes} bytes, ${digestEntries} entries from ${rawChunks} frames`,
  )
}, 180_000)
```

- [ ] **Step 2: Run it and see it fail**

```bash
pnpm --filter @dawn-example/research-server exec vitest run test/attach-digest-cap.test.ts
```

Expected: FAIL — `SyntaxError: The requested module '@dawn-ai/cli/runtime' does not
provide an export named 'createLiveTurnHub'` if Task 19's export or the build is stale.
Run `pnpm build` and re-run; the test should then execute and either pass or report a
concrete overflow.

- [ ] **Step 3: Make it pass**

If the gate fails with `expected true to be false` on `truncated`, the coalescing is not
covering a frame type the research route emits at token granularity. Inspect the digest:

```bash
pnpm --filter @dawn-example/research-server exec vitest run test/attach-digest-cap.test.ts --reporter=verbose
```

Then extend `coalescingKeyOf` in `packages/cli/src/lib/dev/live-turn-hub.ts` to cover
that frame type — it must key on a stable per-emitter id inside `data` and concatenate a
string field, exactly as the `subagent.message` case keys on `data.call_id` and
concatenates `data.chunk`. Add a matching unit case to
`packages/cli/test/live-turn-hub.test.ts` before changing the implementation.

If the gate fails only on the `rawChunks > digestEntries * 4` ratio, the fixture is too
short to be representative — increase the `PARAGRAPH.repeat(n)` counts rather than
lowering the ratio.

- [ ] **Step 4: Run it and see it pass**

```bash
pnpm --filter @dawn-example/research-server exec vitest run test/attach-digest-cap.test.ts
```

Expected: PASS, with a `attach digest: … bytes, … entries from … frames` line in the
output. Record that number in the PR description.

- [ ] **Step 5: Commit**

```bash
git add examples/research/server/test/attach-digest-cap.test.ts
git commit -m "test(research): gate the attach digest cap on a deep-research turn" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 22: Changeset

**Files:**
- Create: `.changeset/ap-attach-live-turn.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/ap-attach-live-turn.md`:

```md
---
"@dawn-ai/cli": patch
---

Add `GET /threads/{thread_id}/runs/stream`, the Agent Protocol attach endpoint. A
client that lost its connection can rejoin the run in flight: the stream opens with
one `state` frame carrying the anchored checkpoint values, the payload that started
the turn, and the turn's chunks so far, then tails live frames through to the run's
own terminal `done`. When no live turn is available in this process — after a
restart, on another replica, or for a `/runs/wait` run — the endpoint serves a
checkpoint-backed snapshot with any pending interrupt payloads, emits
`done` with a reconnect hint, and closes.

Middleware now runs for this endpoint with `method: "GET"`, which is a new
observable middleware input for apps that branch on the request method. The
endpoint resolves the thread's recorded route first and refuses a thread with no
resolvable route, so attach is gated exactly as the matching POST stream is.
```

Note: `patch`, never `minor` — the fixed 0.x group turns a `minor` into `1.0.0` for
all 21 packages. Do not use phrases `scripts/check-docs.mjs` bans (they reach the
generated CHANGELOG and red the release): no "byte-identical", no provider-prefixed
model ids, no `dawn-ai.org`, no `agent.bindTools`, no `.dawn/generated`, no
"auto-bound"/"auto-registered", no "speaks the LangSmith protocol natively".

- [ ] **Step 2: Verify the changeset gate**

```bash
node scripts/check-changesets.mjs
node scripts/check-docs.mjs
```

Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add .changeset/ap-attach-live-turn.md
git commit -m "chore: record the Agent Protocol attach endpoint" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification

Run all of this from the repo root on Node 24 before opening the PR. Do not claim any
of it passed without having seen the output.

- [ ] **1. Node and a clean build**

```bash
nvm use 24
node --version          # v24.x
pnpm install --frozen-lockfile
pnpm build
```

- [ ] **2. Typecheck and lint (never bare `biome check --write`)**

```bash
pnpm typecheck
pnpm lint
```

- [ ] **3. The suites this PR owns**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/live-turn-hub.test.ts test/ap-attach.test.ts test/stream-types.test.ts \
  test/runtime-exports.test.ts
```

- [ ] **4. Every pin this PR could disturb**

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/run-cancellation.test.ts test/resume-endpoint.test.ts \
  test/runtime-fetch-parity.test.ts test/runtime-fetch-handler.test.ts \
  test/runtime-request-listener.test.ts test/agui-endpoint.test.ts \
  test/subagent-interrupts.test.ts test/pending-interrupts.test.ts \
  test/middleware.test.ts test/static-middleware.test.ts \
  test/edge-bundle-purity.test.ts test/fetch-entry-purity.test.ts \
  test/memory-endpoints.test.ts
```

- [ ] **5. The full package suite, then the whole repo**

```bash
pnpm --filter @dawn-ai/cli test
pnpm test
```

- [ ] **6. The flagship gate and the research example**

```bash
pnpm --filter @dawn-example/research-server test
```

- [ ] **7. Docs, packaging, changesets**

```bash
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
pnpm pack:check
```

- [ ] **8. The gated lanes**

```bash
# Needs Docker. If unavailable locally, say so in the PR — do not claim a pass.
DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/ap-attach-postgres.test.ts

# The real-runtime Agent Protocol lane (spawns servers).
pnpm test:runtime
```

- [ ] **9. The full local gate CI runs**

```bash
pnpm ci:validate
```

- [ ] **10. Real-browser verification (standing instruction)**

Start a scratch app against a `dawn dev` server and confirm, in Chrome:
reloading mid-run recovers the partial assistant text and subagent activity from the
`state` frame plus the live tail; reloading while a turn is parked re-renders the
permission prompt from `state.interrupts` alone; and a stock `EventSource` on a
finished thread polls at the jittered ~2 s cadence from the `retry:` hint rather than
hot-looping. Do not commit the scratch app.

---

## PR notes

**The PR description must call out:**

1. **New endpoint.** `GET /threads/{thread_id}/runs/stream` — thread-scoped, never
   claims a run slot, no 409 from concurrency. Wire contract: one `event: state` frame,
   then either live AP frames terminated by the run's own `done` (`live: true`) or an
   immediate `done{output:null}` plus a jittered `retry:` hint and close
   (`live: false`). Consumers MUST treat `done` as end-of-stream.
2. **`method: "GET"` is a new observable middleware input.** Apps that branch on
   `req.method` will now see `GET` for this endpoint. Attach resolves the thread's
   recorded route (`threadRouteMap` then thread metadata) and fails closed with
   `409 {code:"thread_route_unknown"}` when it cannot — attach exposes everything the
   POST stream exposes and must be gated identically.
3. **New error codes on the wire:** `thread_not_found` (404, parity with `POST /cancel`
   and `POST /resume`) and `thread_route_unknown` (409). Deliberately distinct from the
   resume endpoint's existing `route_not_found`.
4. **Two new runtime bounds**, `apAttachDigestMaxBytes` (2 MiB) and
   `apAttachMaxViewers` (16), plus the internal
   `apAttachSubscriberQueueMaxFrames` test hook — all on `createRuntimeFetchHandler`,
   not on `StartRuntimeServerOptions`, and deliberately not exposed in `dawn.config.ts`
   in this slice. Up to `apAttachDigestMaxBytes` is held per **active** run whether or
   not anyone is attached; report the measured `examples/research` digest size from
   Task 21 as evidence the default holds.
5. **Close ordering is the concurrency-sensitive seam.** `hub.close()` fires at
   client-visible stream end for every producer exit — normal done, error, park,
   cancel — and is never deferred behind `sourceCleanup` the way `run.release()`
   deliberately is for a cancelled run. Publish and close carry the run-registry
   identity guard, so a cancelled route still unwinding cannot write into a successor
   turn.
6. **One extra checkpoint read per streaming run** in `handleApStreamRequest` (the
   anchor). The resume handler gained none: its existing interrupt read now also serves
   the anchor, which is why `resume-endpoint.test.ts`'s read-exactly-once fixture stays
   green.
7. **Single-replica live tail, as with cancel.** Any replica serves a correct durable
   snapshot; only the live tail needs the owning replica. workerd live attach is legal
   by construction under the pull model but remains unproven until the deploy-anywhere
   PR3 lane exists — docs promise only the durable path there.
8. **Deliberate divergences from the AP base spec:** thread-scoped rather than
   `run_id`-scoped join, and the `state` frame is a Dawn extension. No `id:` fields, no
   `Last-Event-ID`, no cursors, no retention — reconnect always re-snapshots.
9. **Deferred to PR3:** `dawn threads tail`, the docs pages (attach endpoint, the
   `"interrupted"` disambiguation, the do-not-merge-`/state`-with-attach caveat), and
   the amendment to the cancellation spec's deferred-reattach note.
10. **State plainly** whether the `DAWN_TEST_PGSTORAGE=1` lane and `pnpm test:runtime`
    were actually executed locally, and whether the Chrome verification was done.

**The changeset (`.changeset/ap-attach-live-turn.md`) must:**

- Be `patch` for `@dawn-ai/cli` only. A `minor` on this fixed 0.x group takes all 21
  packages to `1.0.0`.
- Describe the new endpoint and both of its paths.
- Call out `method: "GET"` as a new middleware input.
- Avoid every phrase `scripts/check-docs.mjs` bans — a banned phrase in a changeset
  reaches the generated CHANGELOG and reds the release.

**Before merging:** re-fetch `main` and re-run `pnpm install` so `pnpm-lock.yaml` (which
Task 20 touches) is not stale — a stale lockfile fails at Install and reds every job at
once.
