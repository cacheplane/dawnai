---
"@dawn-ai/core": patch
"@dawn-ai/langchain": patch
"@dawn-ai/ag-ui": patch
---

Carry the model's tool-call ID from a tool execution into the capability
stream: `StreamTransformerInput` gains an optional `toolCallId`, and the
planning capability echoes it as `tool_call_id` on `plan_update`. Child
capability events keep their subagent's tool-call ID internal. This is the
correlation plumbing behind presenting built-in orchestration work once; the
presentation change that consumes it ships in this same release.
