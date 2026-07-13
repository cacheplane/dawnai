---
"@dawn-ai/sdk": patch
"@dawn-ai/langchain": patch
---

Add a `recursionLimit` option to `agent()`. It maps to LangGraph's per-run
super-step ceiling (default 25), so deep agents — a coordinator that dispatches
subagents and makes many tool calls — can raise the limit instead of aborting
with a recursion error.
