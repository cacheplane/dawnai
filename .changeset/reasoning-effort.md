---
"@dawn-ai/sdk": minor
"@dawn-ai/langchain": minor
---

`agent({...})` now accepts an optional `reasoning: { effort }` field. Maps to OpenAI's `reasoningEffort` parameter (`none | minimal | low | medium | high | xhigh`). Non-reasoning models silently ignore it. Useful for tool-use-heavy agents that aren't following directives at the default reasoning depth.
