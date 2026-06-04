---
"@dawn-ai/core": minor
"@dawn-ai/langchain": minor
"@dawn-ai/cli": minor
---

Add opt-in conversation summarization (Phase 3 sub-project 6b). When a thread's history exceeds a token threshold, the agent is fed a condensed view — a running summary of older turns plus the most recent turns verbatim — while the **full history stays intact in the checkpoint**. This is non-destructive: summarization runs as a LangGraph `preModelHook` that returns `llmInputMessages` for the turn only and never rewrites saved `messages`, so `GET /threads/:id/state`, resume, and restart always see the complete history (and there is no tool-call/result pairing hazard).

Enable it in `dawn.config.ts`:

```ts
export default {
  summarization: {
    enabled: true,           // default false
    maxTokens: 12_000,       // threshold over which older turns are summarized
    keepRecentTurns: 6,      // most-recent turns kept verbatim
    // model defaults to the route's model
    // tokenCounter defaults to a lazy gpt-tokenizer (o200k_base) counter
    // summarize defaults to a built-in single-LLM-call running-summary fold
  },
}
```

Both the token counter and the summarizer are pluggable (`tokenCounter`, `summarize`). The running summary is cached in agent state and refreshed incrementally — each turn folds only the newly-aged messages, so cost stays bounded. The turn-boundary split is pairing-safe (a tool-call message is never separated from its results). When summarization is disabled (the default), behavior is unchanged and `gpt-tokenizer` is never loaded. If the summarizer call fails on a given turn, the agent falls back to the full history for that turn rather than failing the run.
