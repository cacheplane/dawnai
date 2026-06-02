# Phase 3 Sub-project 6a — Tool-Output Offloading (Design)

**Status:** Approved for planning
**Date:** 2026-05-29
**Roadmap:** Phase 3 sub-project 6 (final piece). Decomposed into **6a — tool-output offloading** (this spec) and **6b — conversation summarization** (deferred to its own spec).

## Problem

In Dawn, a tool's return value becomes a `ToolMessage` appended to conversation state (persisted in `.dawn/checkpoints.sqlite` since sub-project 7). On every subsequent turn the entire message history — including every prior tool output — is re-sent to the model. Large tool outputs (a 50KB file read, a verbose `runBash`, a 200-result search) are the largest, least-reused content in that history. As they accumulate they cause:

1. **Context exhaustion** — a few large outputs blow the window; the run fails or history is truncated unpredictably.
2. **Cost + latency** — providers bill per input token; re-sending a 40K-token blob across N turns is N× the cost for content read once.
3. **Attention dilution** — large stale content degrades model focus ("lost in the middle", Liu et al. 2023).

Today a tool author has no recourse: Dawn faithfully stuffs the full payload into state forever. This is a framework concern — Dawn owns the tool-result → `ToolMessage` path and (since #4/#7) has durable storage to park full outputs.

## Goal

When a tool returns a large output, persist the full payload to the workspace and let only a compact stub (preview + path + size) enter the message history. The agent retrieves the full content on demand with the `readFile` tool it already has. Bound the on-disk footprint with a cap so the workspace doesn't grow without limit.

## Ecosystem grounding (research, 2026-05-29)

Two research passes (harness mechanisms; retention/GC) informed this design.

**Offload pattern.** The recoverable, deterministic pattern — used by **deepagents** (the library Dawn's harness is modeled on) and Cursor — is *offload + pointer + preview*: write the full output to storage, replace the in-context slot with a path + short preview, retrieve on demand. deepagents offloads tool responses over **20,000 tokens** to its filesystem with a **10-line preview**; the agent reads back with standard filesystem tools. Nobody LLM-summarizes *individual* tool outputs — summarization is reserved for whole-conversation compaction (6b). This confirms a deterministic preview (not an LLM summary) for 6a.

**Retention.** Every harness studied *leaks*: Claude Code's task `.output` files reached **537 GB** in one session (auto-cleanup closed "not planned"); deepagents has **no GC** (persistent backends grow unbounded); Cline checkpoints hit **120 GB+**. Shipping a cap puts Dawn ahead of the field. The consensus bounded-cache pattern (DiskCache, cachem): **total-size cap + TTL backstop**, **throttled evict-on-write** (not a background thread — avoids the delete-between-pointer-and-open race), **LRU by last-access** implemented by touching `mtime` on read (filesystem `atime` is unreliable under `relatime`/NFS). LRU-by-access directly mitigates the "agent holds a pointer that gets evicted" hazard, since recently re-read outputs stay freshest.

## Architecture

### Interception point — at tool-result creation (no pairing hazard)

A pure unit `offloadToolOutput` lives in `@dawn-ai/langchain`:

```ts
interface OffloadContext {
  readonly toolName: string
  readonly thresholdChars: number
  readonly previewLines: number
  readonly store: OffloadStore
}

async function offloadToolOutput(content: string, ctx: OffloadContext): Promise<string>
// returns `content` unchanged when under threshold; otherwise writes the full
// payload via ctx.store, runs throttled GC, and returns a stub string.
```

It is invoked inside `convertToolToLangChain`'s `func`, immediately after `unwrapToolResult` produces the string `content`, for **both** return paths:
- plain return → the returned string becomes the `ToolMessage` content,
- `{ result, state }` Command return → the `content` embedded in the `ToolMessage` inside the `Command.update.messages`.

Because the stub replaces `content` **before** the `ToolMessage` is constructed, the large payload never enters message state — there is **zero tool-call/result pairing hazard** (the failure class that plagues `RemoveMessage`/`SummarizationNode` rewrite-in-state approaches and that bit sub-project 7).

`convertToolToLangChain` gains an optional `offload?: (content: string, toolName: string) => Promise<string>` parameter. When absent (no workspace), it is a pure pass-through — existing behavior is unchanged.

### Wiring

`packages/cli/src/lib/runtime/execute-route.ts` constructs the `offload` callback **only when the workspace capability is active** (i.e. `<process.cwd()>/workspace/` exists — the same detection as sub-project 4). It binds:
- the workspace `FilesystemBackend` (for writes, listing, stat, delete) into an `OffloadStore`,
- `thresholdChars` / `previewLines` / cap settings from `dawn.config.ts`,

and passes the callback through to `convertToolToLangChain` for every tool — user-authored and capability-contributed (`runBash`, `readFile`, `writeTodos`, …). When there is no workspace, no callback is wired and offloading is a no-op.

### Storage + retrieval

Full payloads are written through the workspace `FilesystemBackend` to a dedicated subdirectory:

```
workspace/tool-outputs/<toolName>-<unix-ts>-<short-rand>.txt
```

The `ToolMessage` content becomes a self-describing stub:

```
[Tool output offloaded — 48,213 chars exceeded the 40,000-char limit.
Full output saved to: tool-outputs/search-1730000000-a1b2.txt
Preview (first 10 lines):
<line 1>
…
<line 10>
Read the full output with the readFile tool at the path above.]
```

Retrieval needs **no new tool**: the agent uses the workspace `readFile` with the path from the stub. The stub is self-explanatory, so no system-prompt fragment is added (YAGNI; revisit if models don't reliably act on it).

### Cap / garbage collection

The `OffloadStore` enforces a bounded directory:

- **Size cap + TTL backstop.** Defaults: `maxBytes` ≈ 256 MB, `ttlMs` ≈ 3h. Both configurable. No count cap — offloaded file sizes are unbounded, so total size is the correct primary guard; the TTL reclaims orphaned outputs from abandoned tasks.
- **Throttled evict-on-write.** On each offload write, if more than `gcThrottleMs` (≈ 10s) has elapsed since the last scan, list `tool-outputs/`, delete files older than `ttlMs`, then delete oldest-by-`mtime` until total size is under `maxBytes`. A module-level timestamp throttles full scans during write bursts. GC is synchronous with the write path (no background thread), avoiding the delete-between-pointer-and-open race.
- **LRU by last-access.** The workspace `readFile` touches `mtime` (`utimes`) when the read path is under `tool-outputs/` — and only then, never for user files. This keeps recently re-read outputs freshest so they survive eviction.

### Backend interface

The cap requires the `FilesystemBackend` (in `@dawn-ai/workspace`) to support: write, list-with-mtime (or list + stat), and delete. If the current interface lacks `stat`/`remove`/mtime-bearing list entries, this spec **adds them** to the interface and the `localFilesystem` implementation, plus a `touch(path)` (utimes) for the LRU bump. These are minimal, well-scoped additions in service of the feature.

## Units

- `offloadToolOutput(content, ctx)` — pure decision + stub builder; delegates persistence/GC to `ctx.store`. (`@dawn-ai/langchain`)
- `OffloadStore` — wraps a `FilesystemBackend` + cap config; `write(payload) → relPath`, runs throttled GC. (`@dawn-ai/langchain`, or a small shared module)
- `buildStub(content, { previewLines, relPath, totalChars, thresholdChars })` — pure string builder.
- `runGc(store, { maxBytes, ttlMs, throttleMs })` — pure-ish eviction over backend list/stat/delete.
- `convertToolToLangChain` — gains optional `offload` param (existing file, minimal change).
- `execute-route.ts` — constructs and threads the callback when workspace is active.
- workspace `readFile` — touches `mtime` for `tool-outputs/` paths (small addition).

## Config

`dawn.config.ts`:

```ts
toolOutput?: {
  offloadThresholdChars?: number  // default 40_000
  previewLines?: number           // default 10
  maxBytes?: number               // default 268_435_456 (256 MB)
  ttlMs?: number                  // default 10_800_000 (3h)
  gcThrottleMs?: number           // default 10_000 (10s)
}
```

## Error handling / edge cases

- **Under threshold** → return `content` unchanged (pass-through).
- **No workspace** → no callback wired; pass-through.
- **Write failure** → catch, log a warning, return the original `content` (never break a tool because offloading failed).
- **Preview shorter than `previewLines`** → show whole content (it wouldn't exceed the threshold anyway).
- **Evicted pointer** → `readFile` on a missing offload file returns its normal not-found error. The structured `tool-output-evicted` error + system-prompt note is **deferred** (LRU-by-access makes eviction of a still-referenced output rare); see Out of Scope.
- **GC delete failure on one file** → skip it, continue; never throw out of the write path.

## Out of scope

- **6b — conversation summarization** (LLM-based whole-history compaction; separate spec, needs a custom pairing-safe guard around LangGraph's known-buggy `SummarizationNode`).
- **Structured "tool-output-evicted, re-run" `readFile` error + system-prompt note** (deferred; LRU-by-access mitigates the need).
- **Token-accurate thresholds** (character count is the chosen metric).
- **Offloading when no workspace exists** (no retrievable home for the payload).
- **Cross-thread/global GC** beyond the single workspace `tool-outputs/` directory.

## Testing

**Unit — `@dawn-ai/langchain`:**
- `offloadToolOutput`: under threshold (pass-through), over threshold (writes + returns stub), stub format + preview line count, preview-shorter-than-N, write-failure → original content + no throw.
- `runGc`: size-cap eviction (oldest-by-mtime until under), TTL eviction (deletes aged files), throttle (no scan within `gcThrottleMs`), single-file-delete-failure tolerated.
- `convertToolToLangChain`: a >threshold return produces a stub `ToolMessage` content in **both** the plain and `{result,state}` paths; under-threshold unchanged.

**Unit — `@dawn-ai/workspace`:** `FilesystemBackend` additions (`stat`/list-with-mtime/`remove`/`touch`) on the `localFilesystem` impl; `readFile` bumps `mtime` for `tool-outputs/` paths and leaves user-file mtimes untouched.

**Integration:** real `convertToolToLangChain` + a `localFilesystem` workspace backend → a tool returning >40K chars writes `tool-outputs/<…>.txt`, the message carries the stub, `readFile(path)` returns the full original payload, and GC evicts the oldest file once the size cap is crossed.
