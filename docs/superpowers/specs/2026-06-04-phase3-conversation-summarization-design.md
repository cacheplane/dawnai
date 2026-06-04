# Phase 3 Sub-project 6b — Conversation Summarization (Design)

**Status:** Approved for planning
**Date:** 2026-06-04
**Roadmap:** Phase 3 sub-project 6b — the second half of sub-project 6 (6a = tool-output offloading, shipped in #186). This is the final Phase-3 feature.

## Problem

Even with tool-output offloading (6a) keeping individual large outputs out of context, a long-running conversation accumulates many turns. On every turn the full message history is re-sent to the model. Past a point the history alone approaches the model's context window, causing context exhaustion (failed runs / unpredictable truncation), rising cost, and "lost in the middle" attention dilution. Offloading bounds single outputs; it does not bound *conversation length*. Summarization condenses old turns so a thread can continue indefinitely.

## Goal

When a thread's history exceeds a token threshold, feed the model a condensed view — a running summary of older turns plus recent turns verbatim — while preserving the full history in the checkpoint. Opt-in, token-accurate, and pluggable (swap the token counter or the summarizer).

## Architecture — non-destructive `preModelHook` + `llmInputMessages`

Dawn's agent runs on `createReactAgent` (`@langchain/langgraph@1.3.0`). That version natively supports `preModelHook` and a built-in `llmInputMessages` channel. **When a `preModelHook` returns `{ llmInputMessages }`, LangGraph uses that list as the LLM input for the turn and does NOT update `messages` in saved state** (verified against the installed `react_agent_executor.d.ts` and LangGraph docs).

So summarization is a `preModelHook` that returns a condensed `llmInputMessages` while the real `messages` (full history) stay untouched in the SQLite checkpoint. This is decisive:

- **No tool-call/result pairing hazard on persisted state.** We construct the condensed list ourselves; if a boundary is wrong it's a per-turn input bug we fully control, never a corrupted checkpoint. (This is the exact failure class that deferred 6b — LangGraph's stock `SummarizationNode`-as-`preModelHook` has documented orphaning bugs because it mutates state. We avoid mutation entirely.)
- **Composes with everything.** Full history stays in the checkpoint → `GET /threads/{id}/state`, resume, and restart all see complete history. 6a's offloaded stubs are already small within that history. The summary is a *derived view*, never a destructive rewrite.
- **Matches production consensus** (Letta tiered memory, deepagents, Claude Code `/compact`): keep a source of truth, derive the condensed view.

Running summary is cached in a state field and refreshed **incrementally** (only newly-aged messages are folded in each turn) so cost stays bounded.

## Configuration

Opt-in via `dawn.config.ts` (tsx-evaluated, so it can carry functions like the backends fields):

```ts
summarization?: {
  /** Enable summarization. Default false. */
  readonly enabled?: boolean
  /** Token threshold over which the older history is summarized. Default 12_000. */
  readonly maxTokens?: number
  /** Number of most-recent turns kept verbatim. Default 6. (A "turn" = a HumanMessage and everything up to the next HumanMessage.) */
  readonly keepRecentTurns?: number
  /** Model id for the summary LLM call. Default: the route's own model. */
  readonly model?: string
  /** Token counter. Default: a lazy gpt-tokenizer (o200k_base) counter. Swap for model-accurate counting. */
  readonly tokenCounter?: (text: string) => number
  /** Summary generator. Default: a built-in single-LLM-call summarizer. Bring your own. */
  readonly summarize?: (args: {
    readonly messages: readonly BaseMessage[]
    readonly model: string
    readonly previousSummary?: string
    readonly signal: AbortSignal
  }) => Promise<string>
}
```

## Components (small, focused units)

All new code lives in `packages/langchain/src/summarization/`.

1. **`estimateTokens` (default token counter)** — `defaultTokenCounter(text): number`. Lazily `import("gpt-tokenizer/encoding/o200k_base")` on first use (single encoding, not the whole package), caches the `encode` fn, returns `encode(text).length`. `gpt-tokenizer` is a regular dependency of `@dawn-ai/langchain` (pure JS, no native deps), but is only imported when summarization is enabled and no custom `tokenCounter` is supplied — apps with 6b off never load the ~1–2 MB tables.

2. **`countMessagesTokens(messages, counter)`** — serializes each message's content (and tool-call payloads) to text and sums `counter(text)` across the list. Pure given an injected counter.

3. **`splitForSummary(messages, keepRecentTurns)`** — **pure, pairing-safe.** Returns `{ toSummarize, recent }`. The `recent` window is the last `keepRecentTurns` turns, where a turn boundary is a `HumanMessage`. Critically: `recent` must begin on a clean boundary so it never starts in the middle of a tool round (an `AIMessage` with `tool_calls` must keep its following `ToolMessage`s; the split point is moved earlier to a `HumanMessage` if needed). `toSummarize` is everything before that boundary. The system prompt is not part of `messages` (createReactAgent supplies it via `prompt`), so it is never summarized.

4. **`summarizeMessages` (default summarizer)** — `defaultSummarize({ messages, model, previousSummary, signal })`: builds one chat-model call (via `createChatModel`) with a summarization prompt that folds `previousSummary` (if any) and the new `messages` into an updated running summary; returns the summary string. Swappable via `config.summarize`.

5. **`buildSummarizationHook(config, routeModel)`** → a `preModelHook`:
   - `counter = config.tokenCounter ?? defaultTokenCounter`
   - if `countMessagesTokens(state.messages, counter) <= maxTokens` → return `{}` (no-op; model sees full history).
   - else: read cached `state.runningSummary` (`{ summary, coveredCount }`); `splitForSummary` the messages beyond `coveredCount`; fold the newly-aged `toSummarize` into the summary via `summarize({ previousSummary, ... })`; update the cache; return `{ llmInputMessages: [summaryMessage, ...recent], runningSummary: { summary, coveredCount: newCovered } }`.
   - `summaryMessage` is a `HumanMessage` (role-safe across providers) prefixed e.g. `"Summary of earlier conversation:\n<summary>"`. createReactAgent still prepends the route system prompt, so the LLM sees: system prompt → summary → recent turns.

6. **State field** `runningSummary?: { summary: string; coveredCount: number }` — added to the agent's `stateSchema` only when summarization is enabled. Cached so each turn summarizes only the delta (bounded cost) and the summary persists across turns/restarts.

## Wiring

- `packages/langchain/src/agent-adapter.ts` — when summarization is enabled, pass `preModelHook: buildSummarizationHook(config, descriptor.model)` to `createReactAgent` and merge the `runningSummary` field into `stateSchema`.
- `packages/cli/src/lib/runtime/execute-route.ts` — read `config.summarization` from `dawn.config.ts`, resolve the effective settings (defaults + route model), and thread them to the agent adapter (alongside how `offload` is already threaded).

## Error handling / edge cases

- **Summarizer LLM call fails** → log a warning and return `{}` (fall back to full history for that turn); never break the run because summarization failed. (Risk: a failed summary on an over-threshold turn may itself exceed the window — acceptable v1 behavior; the alternative, hard-failing, is worse.)
- **Under threshold** → no summary LLM call and `llmInputMessages` is not set (model sees full history). The token counter still runs each turn to measure (that's the only per-turn cost when under threshold); with the default counter this lazy-loads `gpt-tokenizer` on the first measured turn. (When summarization is *disabled*, the counter never runs and `gpt-tokenizer` is never loaded.)
- **`splitForSummary` can't find a clean boundary** (e.g. one enormous tool round) → keep everything in `recent` (summarize nothing this turn); summarization simply doesn't help that pathological case, but never orphans.
- **Disabled (default)** → no `preModelHook`, no state field, zero behavior change. Existing agents are unaffected.

## Testing

**Unit (`packages/langchain`):**
- `splitForSummary`: respects `keepRecentTurns`; never cuts between an `AIMessage`-with-`tool_calls` and its `ToolMessage`s (construct a history with tool rounds straddling the boundary and assert the split moves to a `HumanMessage`); handles the no-clean-boundary case.
- `defaultTokenCounter`: lazy-imports, counts a known string within tolerance; `countMessagesTokens` sums across messages including tool-call content.
- `buildSummarizationHook`: under threshold → `{}` (fake counter); over threshold → returns `llmInputMessages` = `[summary, ...recent]` and a `runningSummary`, using a fake `summarize` + fake counter (no real LLM); incremental — a second call only folds new messages (assert the fake `summarize` receives only the delta + `previousSummary`); summarizer-throws → `{}` fallback.

**aimock e2e (runtime lane, CI-safe, no key — reuses the PR #190 harness):**
- A scripted multi-turn conversation (via aimock fixtures) long enough to cross a low `maxTokens` set in the probe app's `dawn.config.ts`. Assert: (a) the saved state (`GET /state`) contains the FULL history; (b) the run completes coherently across the threshold (no orphaned-tool-call error); (c) `runningSummary` is populated in state. Use a small `maxTokens` so a few scripted turns trigger it deterministically.

## Out of scope

- **Destructive checkpoint compaction / storage bounding.** Non-destructive keeps full history in the checkpoint (grows over a very long thread). Bounding *storage* is a separate concern from bounding *context* and gets its own follow-up if it ever bites; it must not compromise this in-context architecture.
- **%-of-context-window auto-sizing.** Use an absolute `maxTokens` + swappable counter rather than a per-model context-window table.
- **Semantic/structured summaries** (e.g. extracting entities, decisions) — v1 is a single free-text running summary; a structured-summary `summarize` impl can be plugged in later.
- **Summarizing the system prompt or offloaded file contents** — only conversation `messages` are summarized.
