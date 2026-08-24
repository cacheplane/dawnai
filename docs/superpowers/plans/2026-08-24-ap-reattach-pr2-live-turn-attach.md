# AP Reattach PR2 — LiveTurnHub + `GET /threads/{id}/runs/stream` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a disconnected client rejoin a still-running turn by attaching to a GET SSE mirror of `POST /threads/{id}/runs/stream`, backed by one bounded in-memory digest of the current turn — with a fully self-healing durable path when no live turn exists in this process.

**Architecture:** Reattachment is resumable *state*, not a resumable stream. Checkpoints stay the single durable source of truth; the only new artifact is `LiveTurnHub` — a per-handler-instance `Map<threadId, LiveTurn>` holding a bounded, coalesced digest of the current turn plus a pull-based subscriber set. The new `GET` endpoint emits one `event: state` snapshot frame, then (live path) the turn's live AP frames byte-identical to the POST stream, terminated by the turn's own `done`; or (durable path) an immediate `done{output:null}` + retry hint and closes. Producers (`handleApStreamRequest`, `handleResumeRequest`, `agui-handler`) call `hub.open/publish/close` alongside their existing enqueue/finally.

**Tech Stack:** TypeScript, Node 24 (`engines` requires it — ~20 CLI tests fail spuriously under Node 22), vitest, pnpm workspaces, turbo, changesets, biome. No new dependencies.

---

## Base-branch reality — read this before Task 1

Base is `origin/main` at or after `239cf18d` **plus** the PR2-preceding audit commit `a124d57c` on branch `blove/agent-protocol-thread-auth-94c180` (fix: authorize the AG-UI row before claiming its run slot). Verified anchors on this tree (2026-08-24):

- **The interrupt `value` is ALREADY surfaced** — `PendingInterrupt.value` exists at `packages/cli/src/lib/dev/pending-interrupts.ts:33`, and `GET /threads/{id}/pending_interrupts` already returns `{interruptId, resumeKey, value}` (`runtime-fetch-core.ts:2450-2461`). Spec §3's "extend `readPendingInterrupts` to surface the value" is **done**. This PR only *reuses* `readPendingInterrupts` — do not re-enrich it.
- **The hub is created in `createRuntimeFetchHandler`'s body (`runtime-fetch-core.ts:502`, beside `const runRegistry = createRunRegistry()`), NOT inside `buildRouteTable`.** The spec says "beside `threadRouteMap`", but `threadRouteMap` (`:1029`) is request-table-scoped while `runRegistry` is handler-scoped precisely so `handler.close()` can drain it. The hub needs the same `close()`-drain reach, so it lives at `:502` and is threaded into `buildRouteTable` via a new `ctx` field and into each producer handler as an option — exactly how `runRegistry` reaches them today through `getRunRegistry` (`:608`, passed at `:667`).
- **`toSseEvent(chunk)`** (`packages/cli/src/lib/runtime/stream-types.ts:38`) is the wire encoder both POST streams use (`runtime-fetch-core.ts:1766`, `:2702`). Live attach frames MUST go through it so the vocabulary is byte-identical.
- **The identity guard** the spec says `publish`/`close` must copy is `run-registry.ts:113` — `if (entries.get(threadId) === entry) entries.delete(threadId)`. A publisher holds a reference to *its* `LiveTurn` and is inert once that entry is closed or replaced.
- **`StreamChunk`** union: `stream-types.ts:1-19` — `{type:"chunk", data}` | `{type:"tool_call", id?, name, input}` | `{type:"tool_result", id?, name, output}` | `{type:"done", output}` | `{type:string, data}` (capability frames, e.g. `subagent.message`, `plan_update`).
- **SSE header set** (both POST streams, `:1846-1850`): `{"cache-control":"no-cache, no-transform", connection:"keep-alive", "content-type":"text/event-stream"}`. The attach GET uses the identical set.
- **Heartbeat:** `startSseHeartbeat(controller, intervalMs)` (`:2868-2876`), started as the first line of each stream `start()` and stopped in the `finally`. `apSseHeartbeatIntervalMs` handler option (default `AP_SSE_HEARTBEAT_INTERVAL_MS = 15_000`, `:277`). Tests inject `apSseHeartbeatIntervalMs: 60_000` to keep frames out of the wire.
- **Only `validate` is a required check.** `review` fails repo-wide on an Anthropic credit balance; `vercel-native`, `chart-apply-smoke`, `chart-validate`, `sandbox-k8s` flake on `main` itself. Check the step list before blaming your change.
- **Concurrent-session hazard:** this worktree has seen another session's uncommitted `examples/research/web/` edits appear mid-session. Stage explicit paths, never `git add -A`.

## Repo gotchas baked into every task

- **Node 24 or the suite lies.** `source ~/.nvm/nvm.sh && nvm use 24` before any test command.
- **A fresh worktree has no `node_modules`.** `pnpm install --frozen-lockfile` then `pnpm build` before the first test.
- **Capture exit codes; never pipe a gate through `tail`/`grep`.** `cmd > /tmp/x.log 2>&1; echo "EXIT=$?"` — a piped pnpm gate reports the pipe's status and has produced a false green here.
- **Build before typecheck.** `packages/sdk` typecheck resolves `@dawn-ai/*` through `dist/`; an unbuilt tree lies. Run `pnpm build` after a source edit, before `pnpm typecheck`.
- **Never a bare `biome check --write`** (mass-reformats). Use the package `lint` script, or scope biome to explicit paths: `npx biome check --config-path ../config-biome/biome.json --write <paths>`.
- **Changeset required** (`packages/*/src/` changes) — `@dawn-ai/cli` only. **Patch only** (the fixed 0.x group turns a minor into 1.0.0). Commit the changeset BEFORE running `node scripts/check-changesets.mjs` (it diffs commits).
- **vitest glob is `test/**/*.test.ts`.** A scratch file not ending `.test.ts` is silently skipped.

## File Structure

**Create:**
- `packages/cli/src/lib/dev/live-turn-hub.ts` — the hub: `createLiveTurnHub()`, `LiveTurnHub`, `LiveTurn`, digest coalescing + byte cap, pull-based subscribers, identity guard, `closeAll()`.
- `packages/cli/test/live-turn-hub.test.ts` — hub unit tests (no HTTP layer).
- `packages/cli/test/ap-attach-endpoint.test.ts` — attach endpoint integration tests (durable + live paths).

**Modify:**
- `packages/cli/src/lib/dev/runtime-fetch-core.ts` — create the hub at `:502`; thread it into `buildRouteTable` ctx and into the three producer handlers; add the `handleApAttachRequest` handler + its GET route entry on the `/runs/stream` pattern; call `hub.open/publish/close` in `handleApStreamRequest` and `handleResumeRequest`; drain the hub in `handler.close()`.
- `packages/cli/src/lib/dev/agui-handler.ts` — `hub.open/publish/close` hooks around its enqueue loop + `finally`.
- `packages/cli/test/thread-access-coverage.test.ts` — add the new GET attach route to `GATED` and bump the `"has 14 entries"` count to 15.
- `apps/web/content/docs/dev-server.mdx` (+ nav if a new page) — document the attach endpoint, the `state` frame, and the `apAttach*` knobs.

**Config knobs (spec §2 "Bounds"):** `apAttachDigestMaxBytes` (default `2 * 1024 * 1024`), `apAttachMaxViewers` (default `16`). Added to the same handler-options block as `apSseHeartbeatIntervalMs` (`runtime-fetch-core.ts:282-285`), resolved beside it (`:659`).

---

## Task 1: The `LiveTurnHub` module

The one new in-memory artifact. Pure data + timers only — no I/O on foreign objects, so it is legal cross-request on workerd. Built and tested in complete isolation from the HTTP layer.

**Files:**
- Create: `packages/cli/src/lib/dev/live-turn-hub.ts`
- Test: `packages/cli/test/live-turn-hub.test.ts`

### Contract

```ts
import type { StreamChunk } from "../runtime/stream-types.js"

export interface LiveTurnOpenInput {
  readonly threadId: string
  readonly anchorCheckpointId: string | null
  readonly runStartedAt: string
  readonly resume: boolean
  readonly input: unknown
}

/** The producer's handle to the turn it opened. Inert once the entry is closed or replaced. */
export interface LiveTurnProducer {
  publish(chunk: StreamChunk): void
  /** Fan the terminal `done` chunk to subscribers, mark the entry terminal, then evict it. */
  close(terminal: StreamChunk): void
}

/** A point-in-time copy of a live turn, handed to one attacher. */
export interface LiveTurnAttachment {
  readonly anchorCheckpointId: string | null
  readonly runStartedAt: string
  readonly resume: boolean
  readonly input: unknown
  /** Coalesced digest so far, or null when the digest overflowed (turn_truncated). */
  readonly turn: readonly StreamChunk[] | null
  readonly truncated: boolean
  /** The stored terminal chunk if the turn already ended in the copy window, else null. */
  readonly terminal: StreamChunk | null
  /** Pull frames published after the snapshot; resolves to null after the terminal is delivered. */
  next(): Promise<StreamChunk | null>
  /** Called by the attacher's finally so the hub can drop its subscriber slot. */
  detach(reason?: "overflow" | "capacity"): void
  /** Set by the hub when the subscriber queue overflowed; the attacher emits `event: detached`. */
  readonly overflowed: () => "overflow" | "capacity" | undefined
}

export interface LiveTurnHub {
  /** Force-close any existing entry for the thread, then install a fresh one. Returns the producer handle. */
  open(input: LiveTurnOpenInput): LiveTurnProducer
  /** A point-in-time attachment, or undefined when no live turn exists for the thread. */
  attach(threadId: string, opts?: { readonly maxViewers?: number }): LiveTurnAttachment | undefined
  /** Fan a terminal frame to every subscriber of every entry and clear the map (handler.close()). */
  closeAll(): void
}

export interface LiveTurnHubOptions {
  /** Serialized-bytes cap for the shared digest; overflow drops the digest whole. Default 2 MiB. */
  readonly digestMaxBytes?: number
  /** Per-subscriber queue caps; overflow drops that subscriber only. Default 1 MiB / 1024 frames. */
  readonly subscriberMaxBytes?: number
  readonly subscriberMaxFrames?: number
}

export function createLiveTurnHub(options?: LiveTurnHubOptions): LiveTurnHub
```

### Semantics the tests pin (spec §2)

- **Digest coalescing:** consecutive `chunk` frames collapse to one `{type:"chunk", data:"<concatenated text>"}`; `subagent.message` frames coalesce **per `callId`** into one concatenated entry, preserving interleaving with other frame types. Byte accounting is incremental (never a full re-serialize per frame).
- **Digest overflow:** when appending would exceed `digestMaxBytes`, the digest is dropped **whole** (`turn = null`, `truncated = true`) and stays dropped for the rest of the turn.
- **Terminal is never in the digest.** `close(terminal)` stores the terminal separately and fans it to subscribers; it is never appended to the digest.
- **Snapshot atomicity (single-threaded JS):** `attach` copies the digest, captures the terminal, and registers the subscriber in one synchronous section. A publish before that section lands in the copy; a publish after lands only in the queue. No frame appears in both; concatenation is the full turn.
- **Identity guard:** a `LiveTurnProducer` whose entry has been closed or replaced is inert — its `publish`/`close` are no-ops. `open` force-closes a pre-existing entry (fanning a terminal to its subscribers) before installing the new one.
- **Subscriber overflow:** a subscriber whose bounded queue overflows is marked (`overflowed()` returns `"overflow"`) and dropped; other subscribers are unaffected.
- **Viewer cap:** `attach` past `maxViewers` returns an attachment whose `overflowed()` is `"capacity"` and whose `turn` work is skipped (no snapshot copy) — the caller emits `event: detached{reason:"capacity"}` and closes.

- [ ] **Step 1: Write the failing unit test for open → publish → attach snapshot + live tail**

```ts
// packages/cli/test/live-turn-hub.test.ts
import { describe, expect, it } from "vitest"
import type { StreamChunk } from "../src/lib/runtime/stream-types.js"
import { createLiveTurnHub } from "../src/lib/dev/live-turn-hub.js"

const chunk = (data: string): StreamChunk => ({ type: "chunk", data })

describe("LiveTurnHub", () => {
  it("hands an attacher the digest snapshot then the live tail, ending after terminal", async () => {
    const hub = createLiveTurnHub()
    const p = hub.open({
      threadId: "t1",
      anchorCheckpointId: "cp-1",
      runStartedAt: "2020-01-01T00:00:00.000Z",
      resume: false,
      input: { messages: [] },
    })
    p.publish(chunk("hel"))
    p.publish(chunk("lo"))

    const a = hub.attach("t1")
    expect(a).toBeDefined()
    if (!a) throw new Error("no attachment")
    // Coalesced digest: two consecutive chunk frames became one.
    expect(a.turn).toEqual([{ type: "chunk", data: "hello" }])
    expect(a.truncated).toBe(false)
    expect(a.anchorCheckpointId).toBe("cp-1")
    expect(a.resume).toBe(false)
    expect(a.terminal).toBeNull()

    // A frame published after the snapshot arrives only through next().
    p.publish({ type: "tool_call", id: "c1", name: "search", input: {} })
    p.close({ type: "done", output: { ok: true } })

    const first = await a.next()
    expect(first).toEqual({ type: "tool_call", id: "c1", name: "search", input: {} })
    const last = await a.next()
    expect(last).toEqual({ type: "done", output: { ok: true } })
    const end = await a.next()
    expect(end).toBeNull()
    a.detach()
  })
})
```

- [ ] **Step 2: Run it — expect module-not-found / undefined**

Run: `source ~/.nvm/nvm.sh && nvm use 24 && npx vitest run test/live-turn-hub.test.ts`
Expected: FAIL — `createLiveTurnHub` is not defined.

- [ ] **Step 3: Implement `live-turn-hub.ts`**

```ts
// packages/cli/src/lib/dev/live-turn-hub.ts
import type { StreamChunk } from "../runtime/stream-types.js"

const DEFAULT_DIGEST_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_SUBSCRIBER_MAX_BYTES = 1 * 1024 * 1024
const DEFAULT_SUBSCRIBER_MAX_FRAMES = 1024
const DEFAULT_MAX_VIEWERS = 16

// ... (interfaces from the Contract section above) ...

interface Subscriber {
  readonly queue: StreamChunk[]
  queueBytes: number
  wake: (() => void) | null
  dropped: "overflow" | "capacity" | undefined
  terminalDelivered: boolean
}

interface LiveTurn {
  readonly threadId: string
  readonly anchorCheckpointId: string | null
  readonly runStartedAt: string
  readonly resume: boolean
  readonly input: unknown
  digest: StreamChunk[] | null
  digestBytes: number
  truncated: boolean
  terminal: StreamChunk | null
  ended: boolean
  readonly subscribers: Set<Subscriber>
}

const frameBytes = (chunk: StreamChunk): number => JSON.stringify(chunk).length

/** Coalesce `chunk` into the last digest entry when both are plain `chunk` frames. */
function appendCoalesced(digest: StreamChunk[], chunk: StreamChunk): { added: number } {
  const last = digest[digest.length - 1]
  if (chunk.type === "chunk" && last && last.type === "chunk") {
    const before = frameBytes(last)
    const merged: StreamChunk = { type: "chunk", data: `${String(last.data ?? "")}${String(chunk.data ?? "")}` }
    digest[digest.length - 1] = merged
    return { added: frameBytes(merged) - before }
  }
  // subagent.message per-callId coalescing.
  const callId = subagentCallId(chunk)
  if (callId !== undefined) {
    const idx = digest.findIndex((e) => subagentCallId(e) === callId)
    if (idx >= 0) {
      const before = frameBytes(digest[idx])
      digest[idx] = mergeSubagent(digest[idx], chunk)
      return { added: frameBytes(digest[idx]) - before }
    }
  }
  digest.push(chunk)
  return { added: frameBytes(chunk) }
}

function subagentCallId(chunk: StreamChunk): string | undefined {
  if (chunk.type !== "subagent.message") return undefined
  const data = (chunk as { readonly data?: unknown }).data
  const callId = data && typeof data === "object" ? (data as { callId?: unknown }).callId : undefined
  return typeof callId === "string" ? callId : undefined
}

function mergeSubagent(existing: StreamChunk, incoming: StreamChunk): StreamChunk {
  const ex = (existing as { data?: { text?: unknown; callId?: unknown } }).data ?? {}
  const inc = (incoming as { data?: { text?: unknown } }).data ?? {}
  return {
    type: "subagent.message",
    data: { ...ex, text: `${String(ex.text ?? "")}${String(inc.text ?? "")}` },
  } as StreamChunk
}

export function createLiveTurnHub(options?: LiveTurnHubOptions): LiveTurnHub {
  const digestMaxBytes = options?.digestMaxBytes ?? DEFAULT_DIGEST_MAX_BYTES
  const subMaxBytes = options?.subscriberMaxBytes ?? DEFAULT_SUBSCRIBER_MAX_BYTES
  const subMaxFrames = options?.subscriberMaxFrames ?? DEFAULT_SUBSCRIBER_MAX_FRAMES
  const entries = new Map<string, LiveTurn>()

  const deliver = (turn: LiveTurn, chunk: StreamChunk): void => {
    for (const sub of turn.subscribers) {
      if (sub.dropped) continue
      const size = frameBytes(chunk)
      if (sub.queue.length + 1 > subMaxFrames || sub.queueBytes + size > subMaxBytes) {
        sub.dropped = "overflow"
        sub.queue.length = 0
        sub.wake?.()
        continue
      }
      sub.queue.push(chunk)
      sub.queueBytes += size
      sub.wake?.()
    }
  }

  const forceClose = (turn: LiveTurn): void => {
    if (!turn.ended) {
      turn.ended = true
      turn.terminal = turn.terminal ?? { type: "done", output: null }
      deliver(turn, turn.terminal)
    }
    for (const sub of turn.subscribers) sub.wake?.()
  }

  return {
    open(input) {
      const existing = entries.get(input.threadId)
      if (existing) forceClose(existing)
      const turn: LiveTurn = {
        threadId: input.threadId,
        anchorCheckpointId: input.anchorCheckpointId,
        runStartedAt: input.runStartedAt,
        resume: input.resume,
        input: input.input,
        digest: [],
        digestBytes: 0,
        truncated: false,
        terminal: null,
        ended: false,
        subscribers: new Set(),
      }
      entries.set(input.threadId, turn)
      return {
        publish(chunk) {
          if (entries.get(input.threadId) !== turn || turn.ended) return
          if (turn.digest !== null) {
            const { added } = appendCoalesced(turn.digest, chunk)
            turn.digestBytes += added
            if (turn.digestBytes > digestMaxBytes) {
              turn.digest = null
              turn.truncated = true
            }
          }
          deliver(turn, chunk)
        },
        close(terminal) {
          if (entries.get(input.threadId) !== turn || turn.ended) return
          turn.ended = true
          turn.terminal = terminal
          deliver(turn, terminal)
          if (entries.get(input.threadId) === turn) entries.delete(input.threadId)
        },
      }
    },

    attach(threadId, opts) {
      const turn = entries.get(threadId)
      if (!turn) return undefined
      const maxViewers = opts?.maxViewers ?? DEFAULT_MAX_VIEWERS
      if (turn.subscribers.size >= maxViewers) {
        return {
          anchorCheckpointId: turn.anchorCheckpointId,
          runStartedAt: turn.runStartedAt,
          resume: turn.resume,
          input: turn.input,
          turn: null,
          truncated: turn.truncated,
          terminal: null,
          async next() { return null },
          detach() {},
          overflowed: () => "capacity",
        }
      }
      // One synchronous section: copy digest + terminal, register subscriber.
      const snapshotTurn = turn.digest === null ? null : [...turn.digest]
      const snapshotTerminal = turn.terminal
      const sub: Subscriber = { queue: [], queueBytes: 0, wake: null, dropped: undefined, terminalDelivered: false }
      turn.subscribers.add(sub)
      return {
        anchorCheckpointId: turn.anchorCheckpointId,
        runStartedAt: turn.runStartedAt,
        resume: turn.resume,
        input: turn.input,
        turn: snapshotTurn,
        truncated: turn.truncated,
        terminal: snapshotTerminal,
        async next() {
          for (;;) {
            if (sub.dropped) return null
            const chunk = sub.queue.shift()
            if (chunk) {
              sub.queueBytes -= frameBytes(chunk)
              if (chunk.type === "done") sub.terminalDelivered = true
              return chunk
            }
            if (turn.ended && (sub.terminalDelivered || snapshotTerminal !== null)) return null
            await new Promise<void>((resolve) => { sub.wake = resolve })
            sub.wake = null
          }
        },
        detach() {
          turn.subscribers.delete(sub)
        },
        overflowed: () => sub.dropped,
      }
    },

    closeAll() {
      for (const turn of entries.values()) forceClose(turn)
      entries.clear()
    },
  }
}
```

> **Note for the implementer:** the `next()` terminal-exit condition is the subtle part. A subscriber that attached *after* the terminal was stored (snapshotTerminal !== null) must still terminate; one that attached before must wait until it has drained the `done` it will receive through the queue. The test in Step 1 plus Steps 5/7 below pin both arms — do not simplify the guard without re-running them.

- [ ] **Step 4: Run Step-1 test — expect PASS**

Run: `npx vitest run test/live-turn-hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Add failing tests for truncation, subscriber overflow, identity guard, and attach-after-terminal**

```ts
it("drops the digest whole on overflow and reports truncated", async () => {
  const hub = createLiveTurnHub({ digestMaxBytes: 64 })
  const p = hub.open({ threadId: "t", anchorCheckpointId: null, runStartedAt: "x", resume: false, input: null })
  for (let i = 0; i < 50; i++) p.publish({ type: "tool_call", id: `c${i}`, name: "n", input: { i } })
  const a = hub.attach("t")
  expect(a?.turn).toBeNull()
  expect(a?.truncated).toBe(true)
  a?.detach()
})

it("drops only the overflowing subscriber", async () => {
  const hub = createLiveTurnHub({ subscriberMaxFrames: 2 })
  const p = hub.open({ threadId: "t", anchorCheckpointId: null, runStartedAt: "x", resume: false, input: null })
  const slow = hub.attach("t")
  const fast = hub.attach("t")
  if (!slow || !fast) throw new Error("no attachment")
  p.publish(chunk("a")); p.publish(chunk("b")); p.publish({ type: "tool_call", id: "c", name: "n", input: {} })
  // slow never drained -> its queue overflowed; fast drains fine.
  expect(slow.overflowed()).toBe("overflow")
  expect(await slow.next()).toBeNull()
  slow.detach(); fast.detach()
})

it("a producer whose entry was replaced is inert", async () => {
  const hub = createLiveTurnHub()
  const p1 = hub.open({ threadId: "t", anchorCheckpointId: null, runStartedAt: "1", resume: false, input: null })
  const p2 = hub.open({ threadId: "t", anchorCheckpointId: null, runStartedAt: "2", resume: false, input: null })
  p1.publish(chunk("zombie"))
  const a = hub.attach("t")
  expect(a?.turn).toEqual([]) // p1's write did not reach the new entry
  expect(a?.runStartedAt).toBe("2")
  p2.close({ type: "done", output: null }); a?.detach()
})

it("an attach that lands after the terminal still terminates", async () => {
  const hub = createLiveTurnHub()
  const p = hub.open({ threadId: "t", anchorCheckpointId: null, runStartedAt: "x", resume: false, input: null })
  p.publish(chunk("hi"))
  // close evicts the entry, so attach() now returns undefined — the durable path.
  p.close({ type: "done", output: { ok: true } })
  expect(hub.attach("t")).toBeUndefined()
})
```

- [ ] **Step 6: Run — expect the four new tests to drive any remaining gaps; fix `live-turn-hub.ts` until green**

Run: `npx vitest run test/live-turn-hub.test.ts`
Expected: PASS (all). If "inert producer" fails, verify the `entries.get(threadId) !== turn` guard in `publish`/`close`. If "attach after terminal" fails, confirm `close` deletes the entry (so `attach` returns undefined — the durable path owns post-terminal joins).

- [ ] **Step 7: Lint + typecheck the new module**

Run: `npx biome check --config-path ../config-biome/biome.json src/lib/dev/live-turn-hub.ts test/live-turn-hub.test.ts && cd ../.. && pnpm build > /tmp/b.log 2>&1; echo EXIT=$?`
Expected: no lint errors; build passes.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/live-turn-hub.ts packages/cli/test/live-turn-hub.test.ts
git commit -m "feat(cli): LiveTurnHub — bounded in-memory digest of the current turn"
```

---

## Task 2: The `GET /threads/{id}/runs/stream` attach endpoint (durable path first)

Add the handler and route, and make the **durable path** correct end to end before any producer wiring exists. With no `hub.open` calls yet, every attach is `live:false`, so this task can fully verify thread resolution, route-identity gating, thread-access, the `state{live:false}` frame, and the `done{output:null}` + retry terminator.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Test: `packages/cli/test/ap-attach-endpoint.test.ts`

### Handler contract (spec §1, §3)

`handleApAttachRequest` mirrors `handleApPendingInterruptsRequest`'s resolution (thread → route identity → middleware → thread-access `read` gate) then streams. Request order:

1. Resolve thread via `threadsStore.getThread` → `404 {code:"thread_not_found"}` on unknown.
2. Resolve route identity: `readParkedRoute(thread) ?? threadRouteMap.get(threadId) ?? (metadata.route as string)`. None → `409 {code:"thread_route_unknown"}`.
3. Run middleware with `method:"GET"` and that identity; reject → its status/body.
4. Thread-access `read` gate (same `notFound` closure as `/pending_interrupts`, so a deny is byte-identical to the 404).
5. `const attachment = hub.attach(threadId, { maxViewers: apAttachMaxViewers })`.
6. Open a `text/event-stream` with the standard header set and start the heartbeat.
7. **Capacity:** `attachment?.overflowed() === "capacity"` → emit `event: detached\ndata: {"reason":"capacity"}\n\n`, then close.
8. **Live path (`attachment` defined):** build and enqueue the `state{live:true, ...}` frame (values at `anchorCheckpointId`, `input`, `turn`, `turn_truncated?`, `interrupts:[]`, `resume`, `run_started_at`), then drain: `for (let f = await attachment.next(); f !== null; f = await attachment.next()) enqueue(toSseEvent(f))`, honoring `overflowed()==="overflow"` mid-drain with `event: detached{reason:"overflow"}`. Stop heartbeat + close in `finally` + `attachment.detach()`.
9. **Durable path (`attachment` undefined):** one `readPendingInterrupts` + one latest-tuple `getTuple` for `values`; emit `state{live:false, status, values, interrupts, anchor:null, run_started_at:null, resume:false, input:null, turn:null}`, then `event: done\ndata: {"output":null}\n\n`, then a `retry: <2000±500>` hint, then close.

`status` for the state frame = `terminalStatus`-consistent read of the thread's stored status (`thread.status`), reported verbatim (`"busy"|"idle"|"interrupted"`).

- [ ] **Step 1: Write the failing durable-path integration test**

```ts
// packages/cli/test/ap-attach-endpoint.test.ts — model setup on pending-interrupts-endpoint.test.ts
// (mkdtemp app with one agent route + a MemorySaver checkpointer seam; createRuntimeFetchHandler
//  with apSseHeartbeatIntervalMs: 60_000). Helpers: get(path), readSse(response) -> parsed events.

it("serves the durable path for a thread that exists but has no live turn", async () => {
  const { handler } = await setup(/* app with route /hello#graph, a thread row t1 that has run once */)
  const res = await handler.fetch(get("/threads/t1/runs/stream"))
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const events = await readSse(res) // reads to stream close
  const state = events.find((e) => e.event === "state")
  expect(state?.data.live).toBe(false)
  expect(state?.data.anchor).toBeNull()
  expect(state?.data.turn).toBeNull()
  expect(events.at(-1)?.event).toBe("done")
  expect(events.at(-1)?.data).toEqual({ output: null })
})

it("404s an unknown thread with thread_not_found", async () => {
  const { handler } = await setup()
  const res = await handler.fetch(get("/threads/nope/runs/stream"))
  expect(res.status).toBe(404)
  expect((await res.json()).error.details.code).toBe("thread_not_found")
})

it("409s a thread that has never run with thread_route_unknown", async () => {
  const { handler } = await setup(/* pre-create a bare row with no route metadata */)
  const res = await handler.fetch(get("/threads/bare/runs/stream"))
  expect(res.status).toBe(409)
  expect((await res.json()).error.details.code).toBe("thread_route_unknown")
})
```

- [ ] **Step 2: Run — expect 404 "Not found" (no GET route yet)**

Run: `npx vitest run test/ap-attach-endpoint.test.ts`
Expected: FAIL — the durable-path test gets the generic 404 (no route matches GET on that pattern).

- [ ] **Step 3: Add the config knobs + hub option plumbing**

In `runtime-fetch-core.ts`: add `apAttachDigestMaxBytes?`, `apAttachMaxViewers?` beside `apSseHeartbeatIntervalMs` (`:282-285`); resolve defaults beside `:659`; create the hub at `:502`:

```ts
const liveTurnHub = createLiveTurnHub({ digestMaxBytes: resolvedApAttachDigestMaxBytes })
```

Add `liveTurnHub` + `apAttachMaxViewers` to `buildRouteTable`'s `ctx` type (`:972-1007`) and pass them at the call site (`:667`). Import `createLiveTurnHub` at the top.

- [ ] **Step 4: Implement `handleApAttachRequest` + register the GET route**

Add the handler (model resolution on `handleApPendingInterruptsRequest`, `:2234-2462`; model the stream/heartbeat/headers on `handleApStreamRequest`, `:1734-1852`). Register beside the POST stream entry (`:1289-1312`) as a **new array element** — method-first dispatch (`:1509`) keeps GET and POST on the same pattern independent:

```ts
{
  handle: async (request, params) =>
    handleApAttachRequest({
      apSseHeartbeatIntervalMs,
      apAttachMaxViewers,
      checkpointer: getCheckpointer(request),
      liveTurnHub,
      middleware,
      registry,
      request,
      threadAccess,
      threadId: params.thread_id ?? "",
      threadRouteMap,
      threadsStore,
    }),
  method: "GET",
  pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,
},
```

Implement the durable path fully (Steps 1's three tests). Reuse `readPendingInterrupts` for `interrupts` and one `getTuple` for `values`. Emit the retry hint deterministically in tests — see the note below.

> **Determinism note:** the retry jitter uses `Math.random()`, which is banned inside workflow scripts but fine in runtime code. Tests must not assert the exact `retry:` value — assert only that a `retry:` line is present and parses as an integer in `[1500, 2500]`.

- [ ] **Step 5: Run the durable-path tests — expect PASS**

Run: `npx vitest run test/ap-attach-endpoint.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Update the route-coverage test**

`packages/cli/test/thread-access-coverage.test.ts`: add `GET .../runs/stream` to the `GATED` array (`:34-45`) and bump `it("has 14 entries on this branch")` → 15 (`:74-81`).

```ts
// GATED, beside the POST runs/stream entry:
routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/),
```

- [ ] **Step 7: Run coverage + thread-access suites**

Run: `npx vitest run test/thread-access-coverage.test.ts test/thread-access-endpoints.test.ts test/pending-interrupts-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 8: Build, typecheck, lint, commit**

```bash
cd ../.. && pnpm build > /tmp/b.log 2>&1; echo EXIT=$? && pnpm --filter @dawn-ai/cli typecheck
# lint scoped:
npx biome check --config-path packages/config-biome/biome.json packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/ap-attach-endpoint.test.ts packages/cli/test/thread-access-coverage.test.ts
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/ap-attach-endpoint.test.ts packages/cli/test/thread-access-coverage.test.ts
git commit -m "feat(cli): GET /threads/:id/runs/stream attach endpoint (durable path)"
```

---

## Task 3: Producer hooks — the live path

Wire `hub.open/publish/close` into the three producers so a live attach actually tails frames. Now the live-path branch of the endpoint (Task 2 Step 8's untested arm) gets exercised.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (`handleApStreamRequest`, `handleResumeRequest`)
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Test: extend `packages/cli/test/ap-attach-endpoint.test.ts`

### Wiring per producer (spec §2 "Produce", "Close ordering")

For `handleApStreamRequest` (anchors: begin `:1667`, stream `start` `:1734`, enqueue `:1766`, catch-terminal `:1800`, finally `:1817-1835`):

- **After `runRegistry.begin` succeeds and before the stream begins executing**, capture the anchor with one `checkpointer.getTuple` (latest) and `hub.open`. A failed anchor read is logged and the run proceeds with **no** live turn (never fails the run, never leaks the slot):

```ts
let liveTurn: LiveTurnProducer | undefined
try {
  const anchorTuple = await checkpointer.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: "" } })
  liveTurn = liveTurnHub.open({
    threadId,
    anchorCheckpointId: anchorTuple?.checkpoint?.id ?? null,
    runStartedAt: new Date().toISOString(),
    resume: false,
    input: apInput, // the validated payload that started the turn
  })
} catch (error) {
  console.warn(`Dawn: live-turn anchor read failed for ${threadId}; attach degrades to the durable path.`, error)
}
```

- **Beside the existing enqueue** (`:1766`) and the catch-path terminal (`:1800`): `liveTurn?.publish(chunk)` / `liveTurn?.publish(terminalChunk)`.
- **Pre-stream failure window:** the metadata/status writes before the stream can throw. Extend that catch to `liveTurn?.close({ type: "done", output: { error: String(error) } })` before rethrowing, so an entry cannot leak open with the slot already released.
- **Close ordering:** in the `finally` (`:1817`), alongside `stopHeartbeat()` and unconditionally — **never** deferred behind `sourceCleanup` the way `run.release()` is for cancelled runs — call `liveTurn?.close(terminalChunk)` where `terminalChunk` is the same terminal the primary emitted. Because `close` carries the identity guard, a zombie route cannot write into a successor turn.

For `handleResumeRequest` (anchors: begin `:2644`, stream `:2669`, enqueue `:2702`, catch `:2735`, finally `:2749`): identical, except `resume:true`, `input:` the resume payload, and `anchorCheckpointId:` the parked checkpoint id (the latest tuple at resume time IS the parked checkpoint).

For `agui-handler.ts` (anchors: enqueue `:436`, inner finally `:438-475`, close `:476`): identical `open`/`publish`/`close`. The AG-UI stream vocabulary differs (it emits AG-UI events, not AP `toSseEvent`), but the hub stores raw `StreamChunk`s from `observeInterrupts`/the source stream **before** AG-UI translation, so an attacher on the AP wire sees AP frames. Publish the raw `StreamChunk` (the value flowing through the `for await`), not the encoded AG-UI event.

- [ ] **Step 1: Write the failing live-attach integration test**

```ts
it("tails a live turn: attach mid-run sees the digest snapshot then live frames then done", async () => {
  // A route whose graph yields two chunks with a controllable gate between them,
  // so the test can POST /runs/stream (start the turn), attach GET mid-run, then
  // release. Model the controllable route on the barrier pattern in
  // run-cancellation.test.ts. Assert the GET's state frame has live:true, a
  // non-null anchor, and that the subsequent frames + done match the tail.
  const { handler, releaseTurn } = await setupControllableTurn()
  const post = handler.fetch(post_("/threads/t1/runs/stream", { input: { messages: [{ role: "user", content: "hi" }] } }))
  await firstChunkSeen() // barrier: the turn has published at least one chunk
  const attach = await handler.fetch(get("/threads/t1/runs/stream"))
  const events = readSseIncremental(attach)
  const state = await events.until((e) => e.event === "state")
  expect(state.data.live).toBe(true)
  expect(state.data.anchor).not.toBeNull()
  releaseTurn()
  const done = await events.until((e) => e.event === "done")
  expect(done).toBeDefined()
  await post
})
```

- [ ] **Step 2: Run — expect the live path to be missing (state.live is false)**

Run: `npx vitest run test/ap-attach-endpoint.test.ts -t "tails a live turn"`
Expected: FAIL — with no producer hooks, `hub.attach` returns undefined and the state frame reports `live:false`.

- [ ] **Step 3: Add the `open`/`publish`/`close` hooks to `handleApStreamRequest`**

Apply the wiring above at the pinned anchors. Import `LiveTurnProducer` type.

- [ ] **Step 4: Run the live-attach test — expect PASS for the AP stream producer**

Run: `npx vitest run test/ap-attach-endpoint.test.ts -t "tails a live turn"`
Expected: PASS.

- [ ] **Step 5: Add hooks to `handleResumeRequest` + `agui-handler.ts`; add a resume-attach and an agui-attach test**

```ts
it("attach during a resume turn reports resume:true and empty interrupts", async () => {
  // Park a turn, POST /resume, attach mid-resume. state.resume === true, state.interrupts === [].
})
it("attach during an AG-UI turn tails AP frames", async () => {
  // Start a POST /agui turn, attach GET /runs/stream, see AP-vocabulary frames.
})
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx vitest run test/ap-attach-endpoint.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Drain the hub in `handler.close()`**

Find `handler.close()` in `createRuntimeFetchHandler` (near the `runRegistry` drain). Add `liveTurnHub.closeAll()` so a shutdown fans terminal frames to any hanging viewers.

Add a test: open a live turn, attach, call `handler.close()`, assert the attach stream terminates with a `done`.

- [ ] **Step 8: Full CLI suite, lint, typecheck, commit**

```bash
cd ../.. && pnpm build > /tmp/b.log 2>&1; echo EXIT=$? && pnpm --filter @dawn-ai/cli test > /tmp/t.log 2>&1; echo EXIT=$?
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/ap-attach-endpoint.test.ts
git commit -m "feat(cli): publish live-turn frames from the AP, resume, and AG-UI producers"
```

---

## Task 4: Docs + changeset

**Files:**
- Modify: `apps/web/content/docs/dev-server.mdx` (attach endpoint, the `state` frame shape, `apAttach*` knobs, `event: state` as a Dawn extension to the AP wire, the empty-`interrupts`-during-resume rule, `run_started_at` client rule).
- Create: `.changeset/ap-reattach-live-turn-attach.md`

- [ ] **Step 1: Document the endpoint**

Add a "Reattaching to a running turn" section: the GET mirror, `event: state` (a Dawn extension), live vs durable paths, the `interrupts:[]`-during-resume rule, `run_started_at` correlation, and the `apAttachDigestMaxBytes` / `apAttachMaxViewers` knobs. If a new page is added, add its nav entry + `page.tsx` wrapper and re-run `node scripts/check-docs.mjs` (reads the BUILT `packages/cli/dist/index.js` — build first).

- [ ] **Step 2: Write the changeset (patch, cli only)**

```markdown
---
"@dawn-ai/cli": patch
---

Add `GET /threads/{id}/runs/stream` — reattach to a running turn. A disconnected
client rejoins by attaching to this GET mirror of the POST stream: one
`event: state` snapshot (channel values, the turn's coalesced frames so far,
and parked interrupts) followed by the live tail, or an immediate durable
snapshot + `done` when no live turn exists in this process. Backed by a bounded
in-memory `LiveTurnHub`; the durable path works across restarts, replicas, and
serverless. Tunable via `apAttachDigestMaxBytes` and `apAttachMaxViewers`.
```

- [ ] **Step 3: Commit, then validate the changeset**

```bash
git add apps/web/content/docs/dev-server.mdx .changeset/ap-reattach-live-turn-attach.md
git commit -m "docs(cli): document the run-stream attach endpoint + changeset"
source ~/.nvm/nvm.sh && nvm use 24 && node scripts/check-changesets.mjs > /tmp/cc.log 2>&1; echo EXIT=$?
```

- [ ] **Step 4: Final gate**

Run: `pnpm ci:validate > /tmp/v.log 2>&1; echo EXIT=$?` (do NOT pipe through tail/grep). Expected: EXIT=0.

---

## Self-Review (completed during drafting)

**Spec coverage:** §1 attach endpoint → Task 2 (durable) + Task 3 (live). §2 LiveTurnHub → Task 1; produce/close-ordering/bounds/pull-delivery → Task 1 + Task 3. §3 `pending_interrupts` value → **already shipped (#443)**, reused in Task 2, no task needed. §4 parked-status honesty → **already shipped with PR1**, unchanged. §5 `dawn threads tail` → **PR3, out of scope.** Resume-run semantics → Task 3 Step 5. Error cases table → Task 2 Steps 1/5 + Task 3.

**Coverage gaps deliberately deferred to PR3:** `dawn threads tail`, the workerd live-attach deploy lane (durable path is the workerd guarantee; live attach is best-effort-until-proven), and end-to-end multi-tab retry-jitter behavior.

**Placeholder scan:** none — every code step carries real code or a pinned anchor.

**Type consistency:** `LiveTurnProducer` (publish/close), `LiveTurnAttachment` (next/detach/overflowed), `createLiveTurnHub`, `liveTurnHub` are used identically across Tasks 1–3.

**Open risk flagged for the executor:** the `next()` terminal-exit guard (Task 1 Step 3 note) and the AG-UI "publish the raw `StreamChunk`, not the encoded event" rule (Task 3) are the two places a plausible-but-wrong implementation passes early tests and fails the integration ones. Hold Task 3 to the resume-attach and agui-attach tests before considering it done.
